// Author: Preston Lee

import { Component, computed, effect, inject, input, model, output, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { switchMap, timer } from 'rxjs';
import { FhirService } from '../../core/services/fhir.service.js';
import { SandboxService } from '../../core/services/sandbox.service.js';

interface FhirNamedResource {
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

export interface FhirResourceSearchResult {
  id: string;
  name: string;
}

@Component({
  selector: 'app-fhir-resource-search-input',
  standalone: true,
  imports: [FormsModule],
  templateUrl: './fhir-resource-search-input.component.html',
})
export class FhirResourceSearchInputComponent {
  private readonly fhirService = inject(FhirService);
  public readonly sandboxService = inject(SandboxService);

  public readonly inputId = input.required<string>();
  public readonly label = input.required<string>();
  public readonly resourceType = input.required<string>();
  public readonly searchBy = input.required<'id' | 'name'>();
  public readonly placeholder = input('');
  public readonly value = model('');
  public readonly resourceSelected = output<FhirResourceSearchResult>();

  public readonly open = signal(false);
  public readonly searching = signal(false);
  public readonly searchError = signal<string | null>(null);
  public readonly results = signal<FhirResourceSearchResult[]>([]);
  public readonly activeIndex = signal(-1);
  public readonly activeOptionId = computed(() =>
    this.open() && this.activeIndex() >= 0 ? `${this.inputId()}-option-${this.activeIndex()}` : null,
  );

  constructor() {
    effect((onCleanup) => {
      const sandbox = this.sandboxService.activeSandbox();
      const query = this.value().trim();
      const searchBy = this.searchBy();
      const resourceType = this.resourceType();
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
        .pipe(switchMap(() => this.fhirService.search<FhirNamedResource>(
          sandbox.sandboxId, sandbox.fhirVersion, resourceType, params,
        )))
        .subscribe({
          next: (bundle) => {
            const resources = new Map<string, FhirResourceSearchResult>();
            for (const entry of bundle.entry || []) {
              const resource = entry.resource;
              if (resource.resourceType !== resourceType || !resource.id) continue;
              const name = resource.name?.find((item) => item.use === 'official')
                || resource.name?.find((item) => item.use === 'usual') || resource.name?.[0];
              const displayName = name?.text?.trim() || [
                ...(name?.prefix || []), ...(name?.given || []), name?.family, ...(name?.suffix || []),
              ].filter(Boolean).join(' ').trim();
              resources.set(resource.id, { id: resource.id, name: displayName || `${resourceType} ${resource.id}` });
            }
            this.results.set([...resources.values()]);
            this.searching.set(false);
          },
          error: () => {
            this.searchError.set(`${resourceType} search is unavailable. You can still enter a custom value.`);
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

  public selectResource(resource: FhirResourceSearchResult): void {
    this.open.set(false);
    this.resourceSelected.emit(resource);
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
      const resource = this.results()[this.activeIndex()];
      if (resource) {
        event.preventDefault();
        this.selectResource(resource);
      }
    }
  }
}
