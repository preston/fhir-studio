// Author: Preston Lee

import { Component, OnInit, inject, signal, effect, untracked } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { ActivatedRoute } from '@angular/router';
import { SandboxService } from '../core/services/sandbox.service.js';
import { FhirService, type FhirOperationOutcome } from '../core/services/fhir.service.js';

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

  public readonly resourceTypes = [
    'Patient',
    'Observation',
    'Condition',
    'Encounter',
    'MedicationRequest',
    'Practitioner',
    'Organization',
    'DiagnosticReport',
    'DocumentReference',
    'Immunization',
    'Procedure',
    'AllergyIntolerance',
    'CarePlan',
    'Coverage',
    'ServiceRequest',
  ];

  public readonly selectedResourceType = signal<string>('Patient');
  public readonly queryParamKey = signal<string>('');
  public readonly queryParamValue = signal<string>('');
  public readonly searchCount = signal<number>(20);

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

  constructor() {
    effect(() => {
      const active = this.sandboxService.activeSandbox();
      if (active) {
        untracked(() => {
          this.executeQuery();
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
    const pKey = this.queryParamKey().trim();
    const pVal = this.queryParamValue().trim();
    if (pKey && pVal) {
      params[pKey] = pVal;
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
              this.successMessage.set(`Validation passed: Conforms to FHIR ${current?.fhirVersion} & US Core profile constraints.`);
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
