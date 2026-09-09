// Author: Preston Lee

import { Component, OnInit, computed, inject, signal } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { RouterLink } from '@angular/router';
import { firstValueFrom } from 'rxjs';
import { gunzipSync } from 'fflate';
import { isHapiNonPartitionableResourceType } from '@fhir-studio/core';
import { AuthService } from '../core/services/auth.service.js';
import { SandboxService } from '../core/services/sandbox.service.js';
import { FhirService } from '../core/services/fhir.service.js';
import {
  ImplementationGuideService,
  type RegistryCatalogSearchResult,
} from '../core/services/implementation-guide.service.js';

export interface PackageResourceItem {
  key: string;
  path: string;
  resourceType: string;
  id: string;
  url: string;
  resource: Record<string, unknown>;
  selected: boolean;
  isExample: boolean;
  isConformance: boolean;
}

export interface ImportFailureDetail {
  resourceType: string;
  id: string;
  status: string;
  diagnostics: string;
}

export interface ImportTypeResult {
  resourceType: string;
  successful: number;
  failed: number;
}

@Component({
  selector: 'app-registry-importer',
  standalone: true,
  imports: [CommonModule, FormsModule, RouterLink],
  templateUrl: './registry-importer.component.html',
  styleUrls: ['./registry-importer.component.scss'],
})
export class RegistryImporterComponent implements OnInit {
  public readonly auth = inject(AuthService);
  public readonly sandboxService = inject(SandboxService);
  private readonly fhirService = inject(FhirService);
  private readonly igService = inject(ImplementationGuideService);

  public readonly searchQuery = signal<string>('');
  public readonly searchResults = signal<RegistryCatalogSearchResult[]>([]);
  public readonly isSearching = signal<boolean>(false);

  public readonly isPreparing = signal<boolean>(false);
  public readonly isImporting = signal<boolean>(false);
  public readonly importProgress = signal<number>(0);
  public readonly importStatusText = signal<string>('');
  public readonly importLogs = signal<string[]>([]);
  public readonly successMessage = signal<string | null>(null);
  public readonly errorMessage = signal<string | null>(null);

  public readonly previewItems = signal<PackageResourceItem[]>([]);
  public readonly previewPackageLabel = signal<string | null>(null);
  public readonly includeExamples = signal<boolean>(false);
  public readonly includeConformance = signal<boolean>(false);
  public readonly expandedTypes = signal<Record<string, boolean>>({});

  public readonly lastTypeResults = signal<ImportTypeResult[]>([]);
  public readonly lastFailures = signal<ImportFailureDetail[]>([]);
  public readonly lastWroteConformanceToDefault = signal<boolean>(false);

  public readonly selectedCount = computed(
    () => this.previewItems().filter((item) => item.selected).length,
  );

  public readonly typeSummaries = computed(() => {
    const map = new Map<
      string,
      { resourceType: string; total: number; selected: number; examples: number; conformance: number }
    >();
    for (const item of this.previewItems()) {
      const existing = map.get(item.resourceType) || {
        resourceType: item.resourceType,
        total: 0,
        selected: 0,
        examples: 0,
        conformance: 0,
      };
      existing.total += 1;
      if (item.selected) existing.selected += 1;
      if (item.isExample) existing.examples += 1;
      if (item.isConformance) existing.conformance += 1;
      map.set(item.resourceType, existing);
    }
    return [...map.values()].sort((a, b) => a.resourceType.localeCompare(b.resourceType));
  });

  ngOnInit(): void {
    if (this.sandboxService.sandboxes().length === 0) {
      this.sandboxService.getSandboxes().subscribe();
    }
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
          this.clearPreview();
          this.isPreparing.set(true);
          this.errorMessage.set(null);
          this.successMessage.set(null);
          this.importProgress.set(10);
          this.importStatusText.set(`Reading ${file.name}...`);
          this.importLogs.set([`Starting local upload for ${file.name}`]);
          this.processTarballBytes(reader.result, file.name);
        }
      };
      reader.readAsArrayBuffer(file);
    }
  }

  public preparePackage(pkgName: string, version?: string, tarballUrl?: string | null): void {
    const current = this.sandboxService.activeSandbox();
    if (!current) {
      this.errorMessage.set('Please select a target sandbox before importing.');
      return;
    }

    const targetVersion = version || 'latest';
    this.clearPreview();
    this.isPreparing.set(true);
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
        this.errorMessage.set(
          `Failed to download package from registry: ${parsedMessage}. You may upload the .tgz file manually.`,
        );
        this.isPreparing.set(false);
      },
    });
  }

  public clearPreview(): void {
    this.previewItems.set([]);
    this.previewPackageLabel.set(null);
    this.expandedTypes.set({});
    this.includeExamples.set(false);
    this.includeConformance.set(false);
    this.lastTypeResults.set([]);
    this.lastFailures.set([]);
    this.lastWroteConformanceToDefault.set(false);
  }

  public selectAll(): void {
    this.previewItems.update((items) => items.map((item) => ({ ...item, selected: true })));
  }

  public deselectAll(): void {
    this.previewItems.update((items) => items.map((item) => ({ ...item, selected: false })));
  }

  public toggleType(resourceType: string, selected: boolean): void {
    this.previewItems.update((items) =>
      items.map((item) => (item.resourceType === resourceType ? { ...item, selected } : item)),
    );
  }

  public toggleItem(key: string): void {
    this.previewItems.update((items) =>
      items.map((item) => (item.key === key ? { ...item, selected: !item.selected } : item)),
    );
  }

  public isTypeExpanded(resourceType: string): boolean {
    return !!this.expandedTypes()[resourceType];
  }

  public toggleTypeExpanded(resourceType: string): void {
    this.expandedTypes.update((state) => ({
      ...state,
      [resourceType]: !state[resourceType],
    }));
  }

  public itemsForType(resourceType: string): PackageResourceItem[] {
    return this.previewItems().filter((item) => item.resourceType === resourceType);
  }

  public onIncludeExamplesChange(checked: boolean): void {
    this.includeExamples.set(checked);
    this.previewItems.update((items) =>
      items.map((item) => {
        if (!item.isExample) return item;
        return { ...item, selected: checked };
      }),
    );
  }

  public onIncludeConformanceChange(checked: boolean): void {
    this.includeConformance.set(checked);
    this.previewItems.update((items) =>
      items.map((item) => {
        if (!item.isConformance) return item;
        // Keep examples deselected unless examples are also included.
        if (item.isExample && !this.includeExamples()) {
          return { ...item, selected: false };
        }
        return { ...item, selected: checked };
      }),
    );
  }

  public runImport(): void {
    const selected = this.previewItems().filter((item) => item.selected);
    if (selected.length === 0) {
      this.errorMessage.set('Select at least one resource to import.');
      return;
    }
    void this.submitResourcesToSandbox(selected);
  }

  private processTarballBytes(arrayBuffer: ArrayBuffer, filename: string): void {
    this.importStatusText.set('Decompressing package archive...');
    this.importProgress.set(30);
    this.importLogs.update((logs) => [...logs, `Decompressing ${filename} archive...`]);

    try {
      const gz = new Uint8Array(arrayBuffer);
      const tar = gunzipSync(gz);
      const items = this.extractPackageResources(tar);

      this.importLogs.update((logs) => [...logs, `Found ${items.length} FHIR JSON resources in package.`]);
      this.importProgress.set(50);
      this.isPreparing.set(false);

      if (items.length === 0) {
        this.errorMessage.set('No valid FHIR JSON resources found in package.');
        return;
      }

      this.previewPackageLabel.set(filename);
      this.previewItems.set(items);
      this.importStatusText.set(`Review ${items.length} resources before importing.`);
      this.importLogs.update((logs) => [
        ...logs,
        'Preview ready. Examples and conformance/terminology resources are deselected by default.',
      ]);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : 'Unknown decompression error';
      this.errorMessage.set(`Error unpacking archive: ${msg}`);
      this.isPreparing.set(false);
    }
  }

  private isExampleResource(path: string, id: string): boolean {
    const normalizedPath = path.replace(/\\/g, '/').toLowerCase();
    // Match package/example/..., example/..., package/examples/..., examples/...
    if (/(^|\/)examples?\//.test(normalizedPath)) {
      return true;
    }
    return !!id && /example/i.test(id);
  }

  private extractPackageResources(tarBytes: Uint8Array): PackageResourceItem[] {
    const resources: PackageResourceItem[] = [];
    let offset = 0;
    let index = 0;

    while (offset < tarBytes.length - 512) {
      const header = tarBytes.subarray(offset, offset + 512);
      if (header.every((b) => b === 0)) break;

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

      if (
        fileSize > 0 &&
        filename.endsWith('.json') &&
        !filename.includes('package.json') &&
        !filename.includes('.index.json')
      ) {
        const fileContent = tarBytes.subarray(offset, offset + fileSize);
        try {
          const text = new TextDecoder().decode(fileContent);
          const parsed = JSON.parse(text) as Record<string, unknown>;
          const resourceType = String(parsed['resourceType'] || '');
          if (resourceType) {
            const id = parsed['id'] != null ? String(parsed['id']) : '';
            const url = parsed['url'] != null ? String(parsed['url']) : '';
            const isExample = this.isExampleResource(filename, id);
            const isConformance = isHapiNonPartitionableResourceType(resourceType);
            resources.push({
              key: `res-${index}`,
              path: filename,
              resourceType,
              id,
              url,
              resource: parsed,
              selected: !isExample && !isConformance,
              isExample,
              isConformance,
            });
            index += 1;
          }
        } catch {
          // ignore non-json or malformed
        }
      }

      offset += Math.ceil(fileSize / 512) * 512;
    }

    return resources;
  }

  private summarizeBatchResponse(
    bundle: {
      entry?: Array<{
        response?: { status?: string };
        resource?: { resourceType?: string; issue?: Array<{ diagnostics?: string }> };
      }>;
    },
    chunk: PackageResourceItem[],
  ): {
    successful: number;
    failed: number;
    failures: ImportFailureDetail[];
    byType: Map<string, { successful: number; failed: number }>;
  } {
    let successful = 0;
    let failed = 0;
    const failures: ImportFailureDetail[] = [];
    const byType = new Map<string, { successful: number; failed: number }>();

    const ensure = (resourceType: string) => {
      const existing = byType.get(resourceType) || { successful: 0, failed: 0 };
      byType.set(resourceType, existing);
      return existing;
    };

    for (let i = 0; i < chunk.length; i++) {
      const item = chunk[i];
      const entry = bundle.entry?.[i];
      const status = String(entry?.response?.status || '');
      const code = parseInt(status, 10);
      const ok = Number.isFinite(code) && code >= 200 && code < 300;
      const tallies = ensure(item.resourceType);

      if (ok) {
        successful += 1;
        tallies.successful += 1;
        continue;
      }

      failed += 1;
      tallies.failed += 1;
      const diagnostics =
        entry?.resource?.resourceType === 'OperationOutcome'
          ? entry.resource.issue?.map((issue) => issue.diagnostics).filter(Boolean).join('; ')
          : undefined;
      if (failures.length < 100) {
        failures.push({
          resourceType: item.resourceType,
          id: item.id || '(no id)',
          status: status || 'unknown',
          diagnostics: diagnostics || 'No diagnostics returned.',
        });
      }
    }

    return { successful, failed, failures, byType };
  }

  private async submitResourcesToSandbox(items: PackageResourceItem[]): Promise<void> {
    const current = this.sandboxService.activeSandbox();
    if (!current) return;

    this.isImporting.set(true);
    this.errorMessage.set(null);
    this.successMessage.set(null);
    this.lastTypeResults.set([]);
    this.lastFailures.set([]);
    this.lastWroteConformanceToDefault.set(items.some((item) => item.isConformance));

    this.importStatusText.set(`Importing ${items.length} resources into sandbox '${current.name}'...`);
    this.importLogs.update((logs) => [
      ...logs,
      `Importing ${items.length} selected resources into '${current.name}'.`,
    ]);

    const batchSize = 40;
    const totalBatches = Math.ceil(items.length / batchSize);
    let successful = 0;
    let failed = 0;
    const failures: ImportFailureDetail[] = [];
    const byType = new Map<string, { successful: number; failed: number }>();

    for (let i = 0; i < totalBatches; i++) {
      const chunk = items.slice(i * batchSize, (i + 1) * batchSize);
      const bundle = {
        resourceType: 'Bundle',
        type: 'batch',
        entry: chunk.map((item) => ({
          resource: item.resource,
          request: {
            method: item.id ? 'PUT' : 'POST',
            url: item.id ? `${item.resourceType}/${item.id}` : item.resourceType,
          },
        })),
      };

      try {
        const response = await firstValueFrom(
          this.fhirService.postTransaction<
            { resourceType: string; type?: string; entry?: unknown[] },
            {
              resourceType: 'Bundle';
              type?: string;
              entry?: Array<{
                response?: { status?: string };
                resource?: { resourceType?: string; issue?: Array<{ diagnostics?: string }> };
              }>;
            }
          >(current.sandboxId, current.fhirVersion, bundle),
        );
        const summary = this.summarizeBatchResponse(response, chunk);
        successful += summary.successful;
        failed += summary.failed;
        for (const failure of summary.failures) {
          if (failures.length < 100) failures.push(failure);
        }
        for (const [resourceType, tallies] of summary.byType) {
          const existing = byType.get(resourceType) || { successful: 0, failed: 0 };
          existing.successful += tallies.successful;
          existing.failed += tallies.failed;
          byType.set(resourceType, existing);
        }
        this.importProgress.set(
          Math.min(95, 50 + Math.round(((successful + failed) / items.length) * 45)),
        );
        this.importLogs.update((logs) => [
          ...logs,
          `Batch ${i + 1}/${totalBatches}: ${summary.successful} ok, ${summary.failed} failed (${successful + failed}/${items.length})`,
        ]);
      } catch (err: unknown) {
        failed += chunk.length;
        const msg = err instanceof Error ? err.message : 'Unknown transaction error';
        for (const item of chunk) {
          const existing = byType.get(item.resourceType) || { successful: 0, failed: 0 };
          existing.failed += 1;
          byType.set(item.resourceType, existing);
          if (failures.length < 100) {
            failures.push({
              resourceType: item.resourceType,
              id: item.id || '(no id)',
              status: 'error',
              diagnostics: msg,
            });
          }
        }
        this.importLogs.update((logs) => [...logs, `Warning: Batch ${i + 1} encountered errors: ${msg}`]);
      }
    }

    this.importProgress.set(100);
    this.isImporting.set(false);
    this.lastFailures.set(failures);
    this.lastTypeResults.set(
      [...byType.entries()]
        .map(([resourceType, tallies]) => ({
          resourceType,
          successful: tallies.successful,
          failed: tallies.failed,
        }))
        .sort((a, b) => a.resourceType.localeCompare(b.resourceType)),
    );

    if (successful === 0 && failed > 0) {
      this.errorMessage.set(
        `Import failed for all ${failed} resources.${failures[0] ? ` Sample: ${failures[0].diagnostics}` : ''}`,
      );
      return;
    }

    const suffix = failed > 0 ? ` (${failed} failed)` : '';
    const conformanceNote = this.lastWroteConformanceToDefault()
      ? ' Conformance/terminology types were stored in the shared DEFAULT partition.'
      : '';
    this.successMessage.set(
      `Imported ${successful}/${items.length} selected resources into '${current.name}'${suffix}.${conformanceNote}`,
    );
  }
}
