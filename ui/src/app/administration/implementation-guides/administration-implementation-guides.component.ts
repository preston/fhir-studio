// Author: Preston Lee

import { Component, OnInit, inject, signal, computed } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { RouterLink } from '@angular/router';
import { form, FormField, required, submit } from '@angular/forms/signals';
import type { ImplementationGuideSummary, CreateImplementationGuidePayload } from '@fhir-studio/core';
import { AdministrationService } from '../../core/services/administration.service.js';
import { FhirReleasesService, type FhirReleaseId } from '../../core/services/fhir-releases.service.js';

export type IgSortField = 'packageId' | 'title' | 'fhirVersion' | 'category';

/** Signal Forms require non-optional field types for [formField] bindings. */
interface IgFormModel {
  packageId: string;
  version: string;
  title: string;
  description: string;
  fhirVersion: string;
  category: string;
  canonicalUrl: string;
  url: string;
  author: string;
  tarballUrl: string;
}

const EMPTY_IG_FORM: IgFormModel = {
  packageId: '',
  version: '',
  title: '',
  description: '',
  fhirVersion: '4.0.1',
  category: 'General',
  canonicalUrl: '',
  url: '',
  author: '',
  tarballUrl: '',
};

function toIgPayload(model: IgFormModel): CreateImplementationGuidePayload {
  return {
    packageId: model.packageId,
    version: model.version,
    title: model.title,
    description: model.description || null,
    fhirVersion: model.fhirVersion,
    category: model.category,
    canonicalUrl: model.canonicalUrl || null,
    url: model.url || null,
    author: model.author || null,
    tarballUrl: model.tarballUrl || null,
  };
}

@Component({
  selector: 'app-administration-implementation-guides',
  standalone: true,
  imports: [CommonModule, FormsModule, FormField, RouterLink],
  templateUrl: './administration-implementation-guides.component.html',
})
export class AdministrationImplementationGuidesComponent implements OnInit {
  public readonly administrationService = inject(AdministrationService);
  public readonly fhirReleases = inject(FhirReleasesService);

  public readonly implementationGuides = signal<ImplementationGuideSummary[]>([]);
  public readonly loading = signal<boolean>(false);
  public readonly successMessage = signal<string | null>(null);
  public readonly errorMessage = signal<string | null>(null);

  // Filters, Sort & Pagination State
  public readonly search = signal<string>('');
  public readonly selectedCategory = signal<string>('all');
  public readonly selectedFhirVersion = signal<string>('all');
  public readonly sortBy = signal<IgSortField>('packageId');
  public readonly sortOrder = signal<'asc' | 'desc'>('asc');
  public readonly page = signal<number>(1);
  public readonly limit = signal<number>(10);

  // Modal & Form State
  public readonly showIgModal = signal<boolean>(false);
  public readonly isEditing = signal<boolean>(false);
  public readonly fetchingRegistry = signal<boolean>(false);
  public currentIgId: string | null = null;

  // Install-to-HAPI modal
  public readonly showInstallModal = signal<boolean>(false);
  public readonly installTarget = signal<ImplementationGuideSummary | null>(null);
  public readonly installReleases = signal<FhirReleaseId[]>([]);
  public readonly installExcludeExamples = signal<boolean>(true);
  public readonly installing = signal<boolean>(false);

  public readonly igModel = signal<IgFormModel>({ ...EMPTY_IG_FORM });
  public readonly igForm = form(this.igModel, (s) => {
    required(s.packageId, { message: 'Package ID is required' });
    required(s.version, { message: 'Version is required' });
    required(s.title, { message: 'Title is required' });
  });

  public readonly categories: Array<{ id: string; label: string }> = [
    { id: 'General', label: 'General' },
    { id: 'US_CORE', label: 'US Core' },
    { id: 'SMART', label: 'SMART on FHIR' },
    { id: 'CLINICAL', label: 'Clinical' },
    { id: 'FINANCIAL', label: 'Financial / Payers' },
    { id: 'DAVINCI', label: 'Da Vinci' },
    { id: 'INTERNATIONAL', label: 'International' },
    { id: 'OTHER', label: 'Other' },
  ];

  public readonly sortedImplementationGuides = computed(() => {
    const list = this.implementationGuides();
    const field = this.sortBy();
    const order = this.sortOrder() === 'asc' ? 1 : -1;

    return [...list].sort((a, b) => {
      let valA: string | number = '';
      let valB: string | number = '';

      switch (field) {
        case 'packageId':
          valA = a.packageId.toLowerCase();
          valB = b.packageId.toLowerCase();
          break;
        case 'title':
          valA = (a.title || '').toLowerCase();
          valB = (b.title || '').toLowerCase();
          break;
        case 'fhirVersion':
          valA = a.fhirVersion.toLowerCase();
          valB = b.fhirVersion.toLowerCase();
          break;
        case 'category':
          valA = a.category.toLowerCase();
          valB = b.category.toLowerCase();
          break;
      }

      if (valA < valB) return -1 * order;
      if (valA > valB) return 1 * order;
      return 0;
    });
  });

  public readonly totalIgsCount = computed(() => this.sortedImplementationGuides().length);

  public readonly totalPages = computed(() => {
    const total = this.totalIgsCount();
    const perPage = this.limit();
    return Math.max(1, Math.ceil(total / perPage));
  });

  public readonly paginatedImplementationGuides = computed(() => {
    const list = this.sortedImplementationGuides();
    const currentPage = Math.min(this.page(), this.totalPages());
    const perPage = this.limit();
    const start = (currentPage - 1) * perPage;
    return list.slice(start, start + perPage);
  });

  ngOnInit(): void {
    this.fhirReleases.ensureLoaded().subscribe();
    this.loadImplementationGuides();
  }

  public loadImplementationGuides(): void {
    this.loading.set(true);
    this.administrationService
      .getAdminImplementationGuides({
        search: this.search(),
        category: this.selectedCategory(),
        fhirVersion: this.selectedFhirVersion(),
      })
      .subscribe({
        next: (res) => {
          this.implementationGuides.set(res.implementationGuides);
          this.loading.set(false);
        },
        error: (err) => {
          this.errorMessage.set(err?.error?.error || 'Failed to load implementation guides.');
          this.loading.set(false);
        },
      });
  }

  public onFilterChange(): void {
    this.page.set(1);
    this.loadImplementationGuides();
  }

  public setSort(field: IgSortField): void {
    if (this.sortBy() === field) {
      this.sortOrder.update((o) => (o === 'asc' ? 'desc' : 'asc'));
    } else {
      this.sortBy.set(field);
      this.sortOrder.set('asc');
    }
    this.page.set(1);
  }

  public setPage(p: number): void {
    if (p < 1 || p > this.totalPages()) return;
    this.page.set(p);
  }

  public setLimit(l: number): void {
    this.limit.set(Number(l));
    this.page.set(1);
  }

  public resetFilters(): void {
    this.search.set('');
    this.selectedCategory.set('all');
    this.selectedFhirVersion.set('all');
    this.sortBy.set('packageId');
    this.sortOrder.set('asc');
    this.page.set(1);
    this.loadImplementationGuides();
  }

  public getShowingStart(): number {
    if (this.totalIgsCount() === 0) return 0;
    return (this.page() - 1) * this.limit() + 1;
  }

  public getShowingEnd(): number {
    return Math.min(this.page() * this.limit(), this.totalIgsCount());
  }

  public openNewIgModal(): void {
    this.isEditing.set(false);
    this.currentIgId = null;
    this.igModel.set({ ...EMPTY_IG_FORM });
    this.showIgModal.set(true);
  }

  public openEditIgModal(ig: ImplementationGuideSummary): void {
    this.isEditing.set(true);
    this.currentIgId = ig.id;
    this.igModel.set({
      packageId: ig.packageId,
      version: ig.version,
      title: ig.title,
      description: ig.description || '',
      fhirVersion: ig.fhirVersion,
      category: ig.category,
      canonicalUrl: ig.canonicalUrl || '',
      url: ig.url || '',
      author: ig.author || '',
      tarballUrl: ig.tarballUrl || '',
    });
    this.showIgModal.set(true);
  }

  public openInstallModal(ig: ImplementationGuideSummary): void {
    this.installTarget.set(ig);
    this.installExcludeExamples.set(true);
    this.showInstallModal.set(true);

    this.fhirReleases.ensureLoaded().subscribe({
      next: () => {
        const enabled = this.fhirReleases.enabledReleases();
        this.installReleases.set(enabled.length > 0 ? [...enabled] : []);
      },
      error: () => {
        this.installReleases.set([]);
      },
    });
  }

  public closeInstallModal(): void {
    this.showInstallModal.set(false);
    this.installTarget.set(null);
    this.installing.set(false);
  }

  public toggleInstallRelease(release: FhirReleaseId): void {
    this.installReleases.update((current) => {
      if (current.includes(release)) {
        return current.filter((r) => r !== release);
      }
      return [...current, release];
    });
  }

  public isInstallReleaseSelected(release: FhirReleaseId): boolean {
    return this.installReleases().includes(release);
  }

  public confirmInstall(): void {
    const ig = this.installTarget();
    const fhirVersions = this.installReleases();
    if (!ig || fhirVersions.length === 0) {
      this.errorMessage.set('Select at least one enabled FHIR release to install into.');
      return;
    }

    this.installing.set(true);
    this.errorMessage.set(null);

    this.administrationService
      .installImplementationGuide(ig.id, {
        fhirVersions,
        excludeExamples: this.installExcludeExamples(),
      })
      .subscribe({
        next: (res) => {
          this.installing.set(false);
          this.showInstallModal.set(false);
          this.installTarget.set(null);
          this.successMessage.set(
            `${res.message} Track progress under Administration → Jobs.`,
          );
        },
        error: (err) => {
          this.installing.set(false);
          this.errorMessage.set(err?.error?.error || 'Failed to queue Implementation Guide install.');
        },
      });
  }

  public fetchRegistryMetadata(): void {
    const current = this.igModel();
    if (!current.packageId.trim()) {
      this.errorMessage.set('Enter a Package ID first to fetch metadata from registry.');
      return;
    }

    this.fetchingRegistry.set(true);
    this.errorMessage.set(null);

    this.administrationService
      .fetchRegistryPackageMetadata(current.packageId.trim(), current.version.trim() || undefined)
      .subscribe({
        next: (res) => {
          const meta = res.metadata;
          if (meta) {
            this.igModel.update((m) => ({
              ...m,
              ...(meta.title ? { title: meta.title } : {}),
              ...(meta.version ? { version: meta.version } : {}),
              ...(meta.description ? { description: meta.description } : {}),
              ...(meta.fhirVersion ? { fhirVersion: meta.fhirVersion } : {}),
              ...(meta.canonicalUrl ? { canonicalUrl: meta.canonicalUrl } : {}),
              ...(meta.url ? { url: meta.url } : {}),
              ...(meta.author ? { author: meta.author } : {}),
            }));
            this.successMessage.set(`Fetched metadata for '${current.packageId}' from packages.fhir.org.`);
          }
          this.fetchingRegistry.set(false);
        },
        error: (err) => {
          this.errorMessage.set(err?.error?.error || 'Failed to fetch metadata from packages.fhir.org.');
          this.fetchingRegistry.set(false);
        },
      });
  }

  public async saveImplementationGuide(): Promise<void> {
    try {
      const ok = await submit(this.igForm, async () => {
        const payload = toIgPayload(this.igModel());
        if (this.isEditing() && this.currentIgId) {
          await new Promise<void>((resolve, reject) => {
            this.administrationService.updateImplementationGuide(this.currentIgId!, payload).subscribe({
              next: () => {
                this.showIgModal.set(false);
                this.successMessage.set(
                  `Implementation Guide '${payload.packageId}@${payload.version}' updated.`,
                );
                this.loadImplementationGuides();
                resolve();
              },
              error: (err) => {
                this.errorMessage.set(err?.error?.error || 'Failed to update implementation guide.');
                reject(err);
              },
            });
          });
        } else {
          await new Promise<void>((resolve, reject) => {
            this.administrationService.createImplementationGuide(payload).subscribe({
              next: () => {
                this.showIgModal.set(false);
                this.successMessage.set(
                  `Implementation Guide '${payload.packageId}@${payload.version}' registered.`,
                );
                this.loadImplementationGuides();
                resolve();
              },
              error: (err) => {
                this.errorMessage.set(err?.error?.error || 'Failed to register implementation guide.');
                reject(err);
              },
            });
          });
        }
      });

      if (!ok) {
        this.errorMessage.set('Package ID, version, and title are required.');
      }
    } catch {
      // Error message already set in subscribe handler.
    }
  }

  public deleteImplementationGuide(ig: ImplementationGuideSummary): void {
    if (confirm(`Are you sure you want to delete '${ig.packageId}@${ig.version}' (${ig.title})?`)) {
      this.administrationService.deleteImplementationGuide(ig.id).subscribe({
        next: () => {
          this.successMessage.set(`Implementation Guide '${ig.packageId}@${ig.version}' deleted.`);
          this.loadImplementationGuides();
        },
        error: (err) => {
          this.errorMessage.set(err?.error?.error || 'Failed to delete implementation guide.');
        },
      });
    }
  }
}
