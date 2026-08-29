// Author: Preston Lee

import { Component, OnInit, inject, signal, computed, effect, untracked } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { ActivatedRoute } from '@angular/router';
import { SandboxService } from '../core/services/sandbox.service.js';
import { FhirService, type FhirOperationOutcome } from '../core/services/fhir.service.js';
import type {
  FhirCapabilityStatement,
  FhirCapabilityStatementResource,
  FhirCapabilityStatementSearchParam,
} from '@fhir-studio/core';

export interface FreetextOption {
  key: string;
  label: string;
  description?: string;
  type?: string;
}

const STANDARD_GLOBAL_SEARCH_PARAMS: FhirCapabilityStatementSearchParam[] = [
  { name: '_id', type: 'token', documentation: 'Logical id of the resource' },
  { name: '_lastUpdated', type: 'date', documentation: 'When the resource version was last changed' },
  { name: '_tag', type: 'token', documentation: 'Tags applied to the resource' },
  { name: '_profile', type: 'uri', documentation: 'Profiles this resource claims to conform to' },
  { name: '_security', type: 'token', documentation: 'Security labels applied to the resource' },
  { name: '_content', type: 'string', documentation: 'Search across all textual and coded content in the resource' },
  { name: '_text', type: 'string', documentation: 'Search narrative XHTML div text content' },
];

@Component({
  selector: 'app-data-manager',
  standalone: true,
  imports: [CommonModule, FormsModule],
  templateUrl: './data-manager.component.html',
})
export class DataManagerComponent implements OnInit {
  private readonly route = inject(ActivatedRoute);
  public readonly sandboxService = inject(SandboxService);
  private readonly fhirService = inject(FhirService);

  // Metadata & CapabilityStatement State
  public readonly capabilityStatement = signal<FhirCapabilityStatement | null>(null);
  public readonly loadingMetadata = signal<boolean>(false);
  public readonly selectedResourceType = signal<string>('Patient');

  // Search Parameter Controls
  public readonly freetextParam = signal<string>('_content');
  public readonly freetextValue = signal<string>('');
  public readonly dynamicParams = signal<Record<string, string>>({});
  public readonly customParamKey = signal<string>('');
  public readonly customParamValue = signal<string>('');
  public readonly searchCount = signal<number>(20);
  public readonly searchSort = signal<string>('');
  public readonly isParamsExpanded = signal<boolean>(false);
  public readonly paramFilterQuery = signal<string>('');
  public readonly copiedPreview = signal<boolean>(false);

  // Results & UI State
  public readonly queryResults = signal<Record<string, any>[]>([]);
  public readonly totalResults = signal<number>(0);
  public readonly loading = signal<boolean>(false);
  public readonly validating = signal<boolean>(false);
  public readonly rawBundleJson = signal<string | null>(null);

  // Resource Detail & Editor
  public readonly selectedResource = signal<Record<string, any> | null>(null);
  public readonly editedJson = signal<string>('');
  public readonly isNewResource = signal<boolean>(false);
  public readonly validationOutcome = signal<FhirOperationOutcome | null>(null);
  public readonly successMessage = signal<string | null>(null);
  public readonly errorMessage = signal<string | null>(null);

  // Computed Properties Driven by Server Metadata
  public readonly availableResourceTypes = computed<string[]>(() => {
    const cs = this.capabilityStatement();
    const resources = cs?.rest?.[0]?.resource;
    if (resources && resources.length > 0) {
      const types = resources.map((r) => r.type).filter(Boolean);
      return Array.from(new Set(types)).sort();
    }
    return [];
  });

  public readonly currentResourceCapability = computed<FhirCapabilityStatementResource | null>(() => {
    const cs = this.capabilityStatement();
    const type = this.selectedResourceType();
    const resources = cs?.rest?.[0]?.resource;
    return resources?.find((r) => r.type === type) || null;
  });

  public readonly supportedSearchParams = computed<FhirCapabilityStatementSearchParam[]>(() => {
    const resCap = this.currentResourceCapability();
    const params: FhirCapabilityStatementSearchParam[] = [];
    const seen = new Set<string>();

    if (resCap?.searchParam && resCap.searchParam.length > 0) {
      for (const sp of resCap.searchParam) {
        if (!seen.has(sp.name)) {
          seen.add(sp.name);
          params.push(sp);
        }
      }
    }

    // Add standard global params if not already present
    for (const gp of STANDARD_GLOBAL_SEARCH_PARAMS) {
      if (!seen.has(gp.name)) {
        seen.add(gp.name);
        params.push(gp);
      }
    }

    return params;
  });

  public readonly filteredSearchParams = computed<FhirCapabilityStatementSearchParam[]>(() => {
    const q = this.paramFilterQuery().trim().toLowerCase();
    const all = this.supportedSearchParams();
    if (!q) return all;
    return all.filter(
      (p) =>
        p.name.toLowerCase().includes(q) ||
        (p.type && p.type.toLowerCase().includes(q)) ||
        (p.documentation && p.documentation.toLowerCase().includes(q)),
    );
  });

  public readonly supportedFreetextOptions = computed<FreetextOption[]>(() => {
    const type = this.selectedResourceType();
    const allParams = this.supportedSearchParams();
    const options: FreetextOption[] = [
      { key: '_content', label: 'Full Text (_content)', description: 'Search all textual, coded, and narrative fields in resource' },
      { key: '_text', label: 'Narrative Text (_text)', description: 'Search narrative XHTML text' },
    ];

    const stringOrTextParams = allParams.filter(
      (p) =>
        p.name !== '_content' &&
        p.name !== '_text' &&
        (p.type === 'string' ||
          p.type === 'token' ||
          ['name', 'family', 'given', 'code', 'title', 'description', 'identifier', 'address', 'telecom', 'subject:Patient.name'].includes(p.name)),
    );

    for (const p of stringOrTextParams) {
      options.push({
        key: p.name,
        label: `${p.name} (${p.type || 'string'})`,
        description: p.documentation || `Search ${type} by ${p.name}`,
        type: p.type,
      });
    }

    return options;
  });

  public readonly topQuickParams = computed<FhirCapabilityStatementSearchParam[]>(() => {
    const all = this.supportedSearchParams();
    const preferredNames = ['name', 'code', 'status', 'identifier', 'subject', 'patient', 'date', 'category', 'type'];
    const matches: FhirCapabilityStatementSearchParam[] = [];

    for (const name of preferredNames) {
      const found = all.find((p) => p.name === name);
      if (found && !matches.includes(found)) {
        matches.push(found);
      }
    }

    // Fill up to 5 params
    for (const p of all) {
      if (matches.length >= 6) break;
      if (!p.name.startsWith('_') && !matches.includes(p)) {
        matches.push(p);
      }
    }

    return matches;
  });

  public readonly activeFilterCount = computed<number>(() => {
    let count = 0;
    if (this.freetextValue().trim()) count++;
    for (const val of Object.values(this.dynamicParams())) {
      if (val && val.trim()) count++;
    }
    if (this.customParamKey().trim() && this.customParamValue().trim()) count++;
    return count;
  });

  public readonly previewUrl = computed<string>(() => {
    const current = this.sandboxService.activeSandbox();
    if (!current) return '';

    const params = new URLSearchParams();
    params.set('_count', String(this.searchCount()));

    if (this.searchSort().trim()) {
      params.set('_sort', this.searchSort().trim());
    }

    const ftVal = this.freetextValue().trim();
    const ftKey = this.freetextParam().trim();
    if (ftVal && ftKey) {
      params.set(ftKey, ftVal);
    }

    for (const [key, val] of Object.entries(this.dynamicParams())) {
      if (val && val.trim()) {
        params.set(key, val.trim());
      }
    }

    const cKey = this.customParamKey().trim();
    const cVal = this.customParamValue().trim();
    if (cKey && cVal) {
      params.set(cKey, cVal);
    }

    const queryStr = params.toString();
    return `/api/sandboxes/${current.sandboxId}/fhir/${current.fhirVersion.toLowerCase()}/${this.selectedResourceType()}${queryStr ? '?' + queryStr : ''}`;
  });

  public readonly supportsCreate = computed<boolean>(() => {
    const resCap = this.currentResourceCapability();
    if (!resCap || !resCap.interaction) return true;
    return resCap.interaction.some((i) => i.code === 'create');
  });

  public readonly supportsUpdate = computed<boolean>(() => {
    const resCap = this.currentResourceCapability();
    if (!resCap || !resCap.interaction) return true;
    return resCap.interaction.some((i) => i.code === 'update');
  });

  public readonly supportsDelete = computed<boolean>(() => {
    const resCap = this.currentResourceCapability();
    if (!resCap || !resCap.interaction) return true;
    return resCap.interaction.some((i) => i.code === 'delete');
  });

  constructor() {
    effect(() => {
      const active = this.sandboxService.activeSandbox();
      if (active) {
        untracked(() => {
          this.loadMetadata(active.sandboxId, active.fhirVersion);
        });
      }
    });
  }

  ngOnInit(): void {
    const querySandbox = this.route.snapshot.queryParamMap.get('sandbox');
    if (this.sandboxService.sandboxes().length === 0) {
      this.sandboxService.getSandboxes().subscribe({
        next: (res) => {
          if (querySandbox && res?.sandboxes) {
            this.sandboxService.selectSandbox(querySandbox);
          }
        },
      });
    } else if (querySandbox) {
      this.sandboxService.selectSandbox(querySandbox);
    }
  }

  public loadMetadata(sandboxId: string, version: string, forceRefresh = false): void {
    this.loadingMetadata.set(true);
    this.fhirService.getCapabilityStatement(sandboxId, version, forceRefresh).subscribe({
      next: (cs) => {
        this.capabilityStatement.set(cs);
        this.loadingMetadata.set(false);
        const types = this.availableResourceTypes();
        if (types.length > 0 && !types.includes(this.selectedResourceType())) {
          this.selectedResourceType.set(types.includes('Patient') ? 'Patient' : types[0]);
        }
        this.executeQuery();
      },
      error: () => {
        this.loadingMetadata.set(false);
        this.executeQuery();
      },
    });
  }

  public onResourceTypeChange(type: string): void {
    this.selectedResourceType.set(type);
    this.dynamicParams.set({});
    this.customParamKey.set('');
    this.customParamValue.set('');
    this.freetextValue.set('');

    // Set intelligent default free-text parameter based on resource type
    if (type === 'Patient' || type === 'Practitioner' || type === 'Person') {
      this.freetextParam.set('name');
    } else if (type === 'Observation' || type === 'Condition' || type === 'Procedure' || type === 'DiagnosticReport') {
      this.freetextParam.set('code');
    } else {
      this.freetextParam.set('_content');
    }

    this.executeQuery();
  }

  public setDynamicParam(name: string, value: string): void {
    const current = { ...this.dynamicParams() };
    if (!value || !value.trim()) {
      delete current[name];
    } else {
      current[name] = value;
    }
    this.dynamicParams.set(current);
  }

  public removeDynamicParam(name: string): void {
    const current = { ...this.dynamicParams() };
    delete current[name];
    this.dynamicParams.set(current);
  }

  public clearAllFilters(): void {
    this.freetextValue.set('');
    this.dynamicParams.set({});
    this.customParamKey.set('');
    this.customParamValue.set('');
    this.searchSort.set('');
    this.executeQuery();
  }

  public executeQuery(): void {
    const current = this.sandboxService.activeSandbox();
    if (!current) return;

    this.loading.set(true);
    this.selectedResource.set(null);
    this.validationOutcome.set(null);
    this.errorMessage.set(null);

    const params: Record<string, string | number> = {
      _count: this.searchCount(),
    };

    if (this.searchSort().trim()) {
      params['_sort'] = this.searchSort().trim();
    }

    const ftVal = this.freetextValue().trim();
    const ftKey = this.freetextParam().trim();
    if (ftVal && ftKey) {
      params[ftKey] = ftVal;
    }

    for (const [key, val] of Object.entries(this.dynamicParams())) {
      if (val && val.trim()) {
        params[key] = val.trim();
      }
    }

    const cKey = this.customParamKey().trim();
    const cVal = this.customParamValue().trim();
    if (cKey && cVal) {
      params[cKey] = cVal;
    }

    this.fhirService
      .search(
        current.sandboxId,
        current.fhirVersion,
        this.selectedResourceType(),
        params,
      )
      .subscribe({
        next: (bundle) => {
          this.rawBundleJson.set(JSON.stringify(bundle, null, 2));
          this.totalResults.set(bundle.total ?? bundle.entry?.length ?? 0);
          this.queryResults.set((bundle.entry || []).map((e) => e.resource as Record<string, any>));
          this.loading.set(false);
        },
        error: (err) => {
          this.errorMessage.set(err?.error?.diagnostics || err?.message || 'FHIR query failed.');
          this.loading.set(false);
        },
      });
  }

  public inspectResource(res: Record<string, any>): void {
    this.selectedResource.set(res);
    this.isNewResource.set(false);
    this.validationOutcome.set(null);
    this.editedJson.set(JSON.stringify(res, null, 2));
  }

  public initNewResource(): void {
    this.isNewResource.set(true);
    this.validationOutcome.set(null);
    const template = {
      resourceType: this.selectedResourceType(),
      id: `new-${Date.now()}`,
      status: 'active',
    };
    this.selectedResource.set(template);
    this.editedJson.set(JSON.stringify(template, null, 2));
  }

  public formatJson(): void {
    try {
      const parsed = JSON.parse(this.editedJson());
      this.editedJson.set(JSON.stringify(parsed, null, 2));
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : 'Invalid JSON format';
      this.errorMessage.set(`Cannot format invalid JSON: ${msg}`);
    }
  }

  public copyPreviewUrl(): void {
    const url = this.previewUrl();
    if (!url) return;
    navigator.clipboard.writeText(url).then(() => {
      this.copiedPreview.set(true);
      setTimeout(() => this.copiedPreview.set(false), 2000);
    });
  }

  public validateCurrentResource(): void {
    const current = this.sandboxService.activeSandbox();
    if (!current) return;

    try {
      const parsed = JSON.parse(this.editedJson());
      this.validating.set(true);
      this.validationOutcome.set(null);

      this.fhirService
        .validateResource(
          current.sandboxId,
          current.fhirVersion,
          parsed.resourceType || this.selectedResourceType(),
          parsed,
        )
        .subscribe({
          next: (outcome) => {
            this.validating.set(false);
            this.validationOutcome.set(outcome);
            const issues = outcome.issue || [];
            const errors = issues.filter((i) => i.severity === 'error' || i.severity === 'fatal');
            if (errors.length === 0) {
              this.successMessage.set(`Validation passed: Conforms to FHIR ${current?.fhirVersion} constraints.`);
            } else {
              this.errorMessage.set(`Validation found ${errors.length} issue(s). See diagnostic details below.`);
            }
          },
          error: (err) => {
            this.validating.set(false);
            this.validationOutcome.set(err?.error || {
              resourceType: 'OperationOutcome',
              issue: [{ severity: 'error', code: 'invalid', diagnostics: err?.message || 'Validation request failed.' }],
            });
          },
        });
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : 'Invalid JSON format';
      this.errorMessage.set(`Invalid JSON syntax: ${msg}`);
    }
  }

  public saveResource(): void {
    const current = this.sandboxService.activeSandbox();
    if (!current) return;

    try {
      const parsed = JSON.parse(this.editedJson());
      this.loading.set(true);

      if (this.isNewResource()) {
        this.fhirService
          .createResource(
            current.sandboxId,
            current.fhirVersion,
            parsed.resourceType || this.selectedResourceType(),
            parsed,
          )
          .subscribe({
            next: (saved) => {
              this.successMessage.set(`Resource ${saved['resourceType']}/${saved['id']} created successfully.`);
              this.inspectResource(saved);
              this.executeQuery();
            },
            error: (err) => {
              this.errorMessage.set(err?.error?.diagnostics || err?.message || 'Create failed.');
              this.loading.set(false);
            },
          });
      } else {
        this.fhirService
          .updateResource(
            current.sandboxId,
            current.fhirVersion,
            parsed.resourceType || this.selectedResourceType(),
            parsed.id,
            parsed,
          )
          .subscribe({
            next: (saved) => {
              this.successMessage.set(`Resource ${saved['resourceType']}/${saved['id']} updated.`);
              this.inspectResource(saved);
              this.executeQuery();
            },
            error: (err) => {
              this.errorMessage.set(err?.error?.diagnostics || err?.message || 'Update failed.');
              this.loading.set(false);
            },
          });
      }
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : 'Invalid JSON format';
      this.errorMessage.set(`Invalid JSON syntax: ${msg}`);
    }
  }

  public deleteResource(res: Record<string, any>): void {
    const current = this.sandboxService.activeSandbox();
    if (!current) return;
    if (confirm(`Are you sure you want to delete ${res['resourceType']}/${res['id']}?`)) {
      this.fhirService
        .deleteResource(
          current.sandboxId,
          current.fhirVersion,
          res['resourceType'],
          res['id'],
        )
        .subscribe({
          next: () => {
            this.successMessage.set(`Resource ${res['resourceType']}/${res['id']} deleted.`);
            this.selectedResource.set(null);
            this.executeQuery();
          },
          error: (err) => {
            this.errorMessage.set(err?.error?.diagnostics || err?.message || 'Delete failed.');
          },
        });
    }
  }
}
