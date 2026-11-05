// Author: Preston Lee

import { Component, computed, effect, inject, input, model, output, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { switchMap, timer } from 'rxjs';
import { FhirService } from '../../core/services/fhir.service.js';
import { SandboxService } from '../../core/services/sandbox.service.js';

interface FhirPatient {
  resourceType: string;
  id?: string;
  name?: Array<{
    use?: string;
    text?: string;
    given?: string[];
    family?: string;
    prefix?: string[];
    suffix?: string[];
  }>;
}

export interface PatientSearchResult {
  id: string;
  name: string;
}

@Component({
  selector: 'app-patient-search-input',
  standalone: true,
  imports: [FormsModule],
  templateUrl: './patient-search-input.component.html',
})
export class PatientSearchInputComponent {
  private readonly fhirService = inject(FhirService);
  public readonly sandboxService = inject(SandboxService);

  public readonly inputId = input.required<string>();
  public readonly label = input.required<string>();
  public readonly searchBy = input.required<'id' | 'name'>();
  public readonly placeholder = input('');
  public readonly value = model('');
  public readonly patientSelected = output<PatientSearchResult>();

  public readonly open = signal(false);
  public readonly searching = signal(false);
  public readonly searchError = signal<string | null>(null);
  public readonly results = signal<PatientSearchResult[]>([]);
  public readonly activeIndex = signal(-1);
  public readonly activeOptionId = computed(() =>
    this.open() && this.activeIndex() >= 0 ? `${this.inputId()}-option-${this.activeIndex()}` : null,
  );

  constructor() {
    effect((onCleanup) => {
      const sandbox = this.sandboxService.activeSandbox();
      const query = this.value().trim();
      const searchBy = this.searchBy();
      const open = this.open();

      this.results.set([]);
      this.searchError.set(null);
      this.activeIndex.set(-1);
      this.searching.set(false);
      if (!open || !sandbox) return;

      const params: Record<string, string | number> = { _count: 10 };
      if (query) params[searchBy === 'id' ? '_id' : 'name:contains'] = query;

      this.searching.set(true);
      // Unsubscribe immediately on each edit, blur, or sandbox change, including during the debounce.
      const subscription = timer(250)
        .pipe(switchMap(() => this.fhirService.search<FhirPatient>(
          sandbox.sandboxId, sandbox.fhirVersion, 'Patient', params,
        )))
        .subscribe({
          next: (bundle) => {
            const patients = new Map<string, PatientSearchResult>();
            for (const entry of bundle.entry || []) {
              const patient = entry.resource;
              if (patient.resourceType !== 'Patient' || !patient.id) continue;
              const name = patient.name?.find((item) => item.use === 'official')
                || patient.name?.find((item) => item.use === 'usual') || patient.name?.[0];
              const displayName = name?.text?.trim() || [
                ...(name?.prefix || []), ...(name?.given || []), name?.family, ...(name?.suffix || []),
              ].filter(Boolean).join(' ').trim();
              patients.set(patient.id, { id: patient.id, name: displayName || `Patient ${patient.id}` });
            }
            this.results.set([...patients.values()]);
            this.searching.set(false);
          },
          error: () => {
            this.searchError.set('Patient search is unavailable. You can still enter a custom value.');
            this.searching.set(false);
          },
        });
      onCleanup(() => subscription.unsubscribe());
    });
  }

  public edit(value: string): void {
    this.value.set(value);
    this.open.set(true);
  }

  public selectPatient(patient: PatientSearchResult): void {
    this.open.set(false);
    this.patientSelected.emit(patient);
  }

  public onKeydown(event: KeyboardEvent): void {
    if (event.key === 'Escape') {
      event.preventDefault();
      this.open.set(false);
      return;
    }
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault();
      this.open.set(true);
      const count = this.results().length;
      if (count) {
        const index = this.activeIndex();
        this.activeIndex.set(event.key === 'ArrowDown'
          ? (index + 1) % count : (index < 0 ? count - 1 : (index + count - 1) % count));
      }
    } else if (event.key === 'Enter' && this.open()) {
      const patient = this.results()[this.activeIndex()];
      if (patient) {
        event.preventDefault();
        this.selectPatient(patient);
      }
    }
  }
}
