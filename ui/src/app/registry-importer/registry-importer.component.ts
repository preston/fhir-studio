// Author: Preston Lee

import { Component, OnInit, inject, signal } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { HttpClient } from '@angular/common/http';
import { firstValueFrom } from 'rxjs';
import { gunzipSync } from 'fflate';
import { SandboxService } from '../core/services/sandbox.service.js';
import { FhirService } from '../core/services/fhir.service.js';

export interface PopularPackage {
  name: string;
  version: string;
  title: string;
  description: string;
  fhirVersion: string;
}

export interface RegistrySearchResult {
  name: string;
  description?: string;
  title?: string;
  version?: string;
  'dist-tags'?: { latest?: string };
}

@Component({
  selector: 'app-registry-importer',
  standalone: true,
  imports: [CommonModule, FormsModule],
  templateUrl: './registry-importer.component.html',
  styleUrls: ['./registry-importer.component.scss'],
})
export class RegistryImporterComponent implements OnInit {
  private readonly http = inject(HttpClient);
  public readonly sandboxService = inject(SandboxService);
  private readonly fhirService = inject(FhirService);

  public readonly popularPackages: PopularPackage[] = [
    {
      name: 'hl7.fhir.us.core',
      version: '6.1.0',
      title: 'US Core Implementation Guide',
      description: 'US Realm conformance profiles and synthetic data definitions.',
      fhirVersion: '4.0.1',
    },
    {
      name: 'hl7.fhir.us.mcode',
      version: '3.0.0',
      title: 'mCODE (Minimal Common Oncology Data Elements)',
      description: 'Standardized oncology clinical data models for cancer research.',
      fhirVersion: '4.0.1',
    },
    {
      name: 'hl7.fhir.us.qicore',
      version: '5.0.0',
      title: 'QI-Core Implementation Guide',
      description: 'Quality Improvement Core framework for electronic clinical quality measures.',
      fhirVersion: '4.0.1',
    },
    {
      name: 'hl7.fhir.uv.smart-app-launch',
      version: '2.2.0',
      title: 'SMART App Launch IG',
      description: 'SMART on FHIR application launch framework definitions and capabilities.',
      fhirVersion: '4.0.1',
    },
  ];

  public readonly searchQuery = signal<string>('');
  public readonly searchResults = signal<RegistrySearchResult[]>([]);
  public readonly isSearching = signal<boolean>(false);

  // Upload / Import State
  public readonly isImporting = signal<boolean>(false);
  public readonly importProgress = signal<number>(0);
  public readonly importStatusText = signal<string>('');
  public readonly importLogs = signal<string[]>([]);
  public readonly successMessage = signal<string | null>(null);
  public readonly errorMessage = signal<string | null>(null);

  ngOnInit(): void {
    if (this.sandboxService.sandboxes().length === 0) {
      this.sandboxService.getSandboxes().subscribe();
    }
  }

  public searchRegistry(): void {
    const q = this.searchQuery().trim();
    if (!q) return;

    this.isSearching.set(true);
    const url = `https://packages.fhir.org/catalog?name=${encodeURIComponent(q)}`;

    this.http.get<RegistrySearchResult[]>(url).subscribe({
      next: (res) => {
        this.searchResults.set(Array.isArray(res) ? res : []);
        this.isSearching.set(false);
      },
      error: () => {
        // Fallback filter over popular packages
        const filtered = this.popularPackages
          .filter((p) =>
            p.name.toLowerCase().includes(q.toLowerCase()) ||
            p.title.toLowerCase().includes(q.toLowerCase()),
          )
          .map((p) => ({
            name: p.name,
            version: p.version,
            title: p.title,
            description: p.description,
          }));
        this.searchResults.set(filtered);
        this.isSearching.set(false);
      },
    });
  }

  public onFileSelected(event: Event): void {
    const input = event.target as HTMLInputElement;
    if (input.files && input.files[0]) {
      const file = input.files[0];
      const reader = new FileReader();
      reader.onload = () => {
        if (reader.result instanceof ArrayBuffer) {
          this.processTarballBytes(reader.result, file.name);
        }
      };
      reader.readAsArrayBuffer(file);
    }
  }

  public importPackage(pkgName: string, version: string): void {
    const current = this.sandboxService.activeSandbox();
    if (!current) return;

    this.isImporting.set(true);
    this.importProgress.set(10);
    this.importStatusText.set(`Downloading ${pkgName}#${version}...`);
    this.importLogs.set([`Starting download for ${pkgName}@${version}`]);

    const tarballUrl = `https://packages.fhir.org/${pkgName}/${version}`;

    this.http.get(tarballUrl, { responseType: 'arraybuffer' }).subscribe({
      next: (arrayBuffer) => {
        this.processTarballBytes(arrayBuffer, `${pkgName}-${version}.tgz`);
      },
      error: (err) => {
        this.errorMessage.set(`Failed to download package from registry: ${err.message}. You may upload the .tgz file manually.`);
        this.isImporting.set(false);
      },
    });
  }

  private processTarballBytes(arrayBuffer: ArrayBuffer, filename: string): void {
    this.importStatusText.set('Decompressing package archive...');
    this.importProgress.set(30);
    this.importLogs.update((logs) => [...logs, `Decompressing ${filename} archive...`]);

    try {
      const gz = new Uint8Array(arrayBuffer);
      const tar = gunzipSync(gz);
      const resources = this.extractJsonResourcesFromTar(tar);

      this.importLogs.update((logs) => [...logs, `Found ${resources.length} FHIR JSON resources in package.`]);
      this.importProgress.set(50);

      if (resources.length === 0) {
        this.errorMessage.set('No valid FHIR JSON resources found in package.');
        this.isImporting.set(false);
        return;
      }

      this.submitResourcesToSandbox(resources);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : 'Unknown decompression error';
      this.errorMessage.set(`Error unpacking archive: ${msg}`);
      this.isImporting.set(false);
    }
  }

  private extractJsonResourcesFromTar(tarBytes: Uint8Array): Record<string, any>[] {
    const resources: Record<string, any>[] = [];
    let offset = 0;

    while (offset < tarBytes.length - 512) {
      const header = tarBytes.subarray(offset, offset + 512);
      if (header.every((b) => b === 0)) break; // End of archive

      let filename = '';
      for (let i = 0; i < 100; i++) {
        if (header[i] === 0) break;
        filename += String.fromCharCode(header[i]);
      }

      let sizeStr = '';
      for (let i = 124; i < 136; i++) {
        if (header[i] === 0 || header[i] === 32) break;
        sizeStr += String.fromCharCode(header[i]);
      }
      const fileSize = parseInt(sizeStr.trim(), 8) || 0;
      offset += 512;

      if (fileSize > 0 && filename.endsWith('.json') && !filename.includes('package.json') && !filename.includes('.index.json')) {
        const fileContent = tarBytes.subarray(offset, offset + fileSize);
        try {
          const text = new TextDecoder().decode(fileContent);
          const parsed = JSON.parse(text);
          if (parsed.resourceType) {
            resources.push(parsed);
          }
        } catch {
          // ignore non-json or malformed
        }
      }

      offset += Math.ceil(fileSize / 512) * 512;
    }

    return resources;
  }

  private async submitResourcesToSandbox(resources: Record<string, any>[]): Promise<void> {
    const current = this.sandboxService.activeSandbox();
    if (!current) return;

    this.importStatusText.set(`Importing ${resources.length} resources into sandbox '${current.name}'...`);
    const batchSize = 40;
    const totalBatches = Math.ceil(resources.length / batchSize);
    let successful = 0;

    for (let i = 0; i < totalBatches; i++) {
      const chunk = resources.slice(i * batchSize, (i + 1) * batchSize);
      const bundle = {
        resourceType: 'Bundle',
        type: 'batch',
        entry: chunk.map((res) => ({
          resource: res,
          request: {
            method: res['id'] ? 'PUT' : 'POST',
            url: res['id'] ? `${res['resourceType']}/${res['id']}` : res['resourceType'],
          },
        })),
      };

      try {
        await firstValueFrom(
          this.fhirService.postTransaction(
            current.sandboxId,
            current.fhirVersion,
            bundle,
          ),
        );
        successful += chunk.length;
        this.importProgress.set(Math.min(95, 50 + Math.round((successful / resources.length) * 45)));
        this.importLogs.update((logs) => [...logs, `Imported batch ${i + 1}/${totalBatches} (${successful}/${resources.length} resources)`]);
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : 'Unknown transaction error';
        this.importLogs.update((logs) => [...logs, `Warning: Batch ${i + 1} encountered errors: ${msg}`]);
      }
    }

    this.importProgress.set(100);
    this.isImporting.set(false);
    this.successMessage.set(`Package imported successfully! Processed ${successful} resources into '${current.name}'.`);
  }
}
