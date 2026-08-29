// Author: Preston Lee

import { Component, OnInit, inject, signal } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { RouterLink } from '@angular/router';
import { firstValueFrom } from 'rxjs';
import { gunzipSync } from 'fflate';
import type { ImplementationGuideSummary } from '@fhir-studio/core';
import { SandboxService } from '../core/services/sandbox.service.js';
import { FhirService } from '../core/services/fhir.service.js';
import { ImplementationGuideService, type RegistryCatalogSearchResult } from '../core/services/implementation-guide.service.js';

@Component({
  selector: 'app-registry-importer',
  standalone: true,
  imports: [CommonModule, FormsModule, RouterLink],
  templateUrl: './registry-importer.component.html',
  styleUrls: ['./registry-importer.component.scss'],
})
export class RegistryImporterComponent implements OnInit {
  public readonly sandboxService = inject(SandboxService);
  private readonly fhirService = inject(FhirService);
  private readonly igService = inject(ImplementationGuideService);

  public readonly suggestedPackages = signal<ImplementationGuideSummary[]>([]);
  public readonly loadingSuggested = signal<boolean>(false);

  public readonly searchQuery = signal<string>('');
  public readonly searchResults = signal<RegistryCatalogSearchResult[]>([]);
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
    this.loadSuggestedPackages();
  }

  public loadSuggestedPackages(): void {
    this.loadingSuggested.set(true);
    this.igService.getImplementationGuides({ isSuggested: true }).subscribe({
      next: (res) => {
        this.suggestedPackages.set(res.implementationGuides || []);
        this.loadingSuggested.set(false);
      },
      error: () => {
        this.loadingSuggested.set(false);
      },
    });
  }

  public searchRegistry(): void {
    const q = this.searchQuery().trim();
    if (!q) return;

    this.isSearching.set(true);
    this.errorMessage.set(null);

    this.igService.searchRegistry(q).subscribe({
      next: (res) => {
        this.searchResults.set(res.results || []);
        this.isSearching.set(false);
      },
      error: (err) => {
        this.errorMessage.set(err?.error?.error || 'Failed to search registry.');
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

  public importPackage(pkgName: string, version?: string, tarballUrl?: string | null): void {
    const current = this.sandboxService.activeSandbox();
    if (!current) {
      this.errorMessage.set('Please select a target sandbox before importing.');
      return;
    }

    const targetVersion = version || 'latest';
    this.isImporting.set(true);
    this.errorMessage.set(null);
    this.successMessage.set(null);
    this.importProgress.set(10);
    this.importStatusText.set(`Downloading ${pkgName}#${targetVersion}...`);
    this.importLogs.set([`Starting download for ${pkgName}@${targetVersion}`]);

    this.igService.downloadPackage(pkgName, targetVersion, tarballUrl).subscribe({
      next: (arrayBuffer) => {
        this.processTarballBytes(arrayBuffer, `${pkgName}-${targetVersion}.tgz`);
      },
      error: (err: unknown) => {
        let parsedMessage = 'Unknown network error';
        const httpErr = err as { error?: unknown; message?: string };
        if (httpErr.error instanceof ArrayBuffer) {
          try {
            const text = new TextDecoder().decode(httpErr.error);
            const parsed = JSON.parse(text);
            parsedMessage = parsed.message ? `${parsed.error}: ${parsed.message}` : (parsed.error || text);
          } catch {
            const text = new TextDecoder().decode(httpErr.error);
            if (text) parsedMessage = text;
          }
        } else if (httpErr.error && typeof httpErr.error === 'object') {
          const body = httpErr.error as { error?: string; message?: string };
          parsedMessage = body.message ? `${body.error}: ${body.message}` : (body.error || httpErr.message || parsedMessage);
        } else if (httpErr.message) {
          parsedMessage = httpErr.message;
        }
        this.errorMessage.set(`Failed to download package from registry: ${parsedMessage}. You may upload the .tgz file manually.`);
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
