// Author: Preston Lee

import { Component, OnInit, inject, signal, computed } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import type {
  ImplementationGuideSummary,
  CreateImplementationGuidePayload,
  UpdateImplementationGuidePayload,
} from '@fhir-studio/core';
import { AdministrationService } from '../../core/services/administration.service.js';

export type IgSortField = 'packageId' | 'title' | 'fhirVersion' | 'category' | 'recommended' | 'suggested';

@Component({
  selector: 'app-administration-implementation-guides',
  standalone: true,
  imports: [CommonModule, FormsModule],
  templateUrl: './administration-implementation-guides.component.html',
})
export class AdministrationImplementationGuidesComponent implements OnInit {
  public readonly administrationService = inject(AdministrationService);

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

  public igForm: CreateImplementationGuidePayload = {
    packageId: '',
    version: '',
    title: '',
    description: '',
    fhirVersion: '4.0.1',
    category: 'General',
    canonicalUrl: '',
    url: '',
    recommendedForCreation: false,
    isSuggested: true,
    author: '',
    tarballUrl: '',
  };

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
      let valA: any = '';
      let valB: any = '';

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
        case 'recommended':
          valA = a.recommendedForCreation ? 1 : 0;
          valB = b.recommendedForCreation ? 1 : 0;
          break;
        case 'suggested':
          valA = a.isSuggested ? 1 : 0;
          valB = b.isSuggested ? 1 : 0;
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
    this.igForm = {
      packageId: '',
      version: '',
      title: '',
      description: '',
      fhirVersion: '4.0.1',
      category: 'General',
      canonicalUrl: '',
      url: '',
      recommendedForCreation: false,
      isSuggested: true,
      author: '',
      tarballUrl: '',
    };
    this.showIgModal.set(true);
  }

  public openEditIgModal(ig: ImplementationGuideSummary): void {
    this.isEditing.set(true);
    this.currentIgId = ig.id;
    this.igForm = {
      packageId: ig.packageId,
      version: ig.version,
      title: ig.title,
      description: ig.description || '',
      fhirVersion: ig.fhirVersion,
      category: ig.category,
      canonicalUrl: ig.canonicalUrl || '',
      url: ig.url || '',
      recommendedForCreation: ig.recommendedForCreation,
      isSuggested: ig.isSuggested,
      author: ig.author || '',
      tarballUrl: ig.tarballUrl || '',
    };
    this.showIgModal.set(true);
  }

  public fetchRegistryMetadata(): void {
    if (!this.igForm.packageId.trim()) {
      this.errorMessage.set('Enter a Package ID first to fetch metadata from registry.');
      return;
    }

    this.fetchingRegistry.set(true);
    this.errorMessage.set(null);

    this.administrationService
      .fetchRegistryPackageMetadata(this.igForm.packageId.trim(), this.igForm.version.trim() || undefined)
      .subscribe({
        next: (res) => {
          const meta = res.metadata;
          if (meta) {
            if (meta.title) this.igForm.title = meta.title;
            if (meta.version) this.igForm.version = meta.version;
            if (meta.description) this.igForm.description = meta.description;
            if (meta.fhirVersion) this.igForm.fhirVersion = meta.fhirVersion;
            if (meta.canonicalUrl) this.igForm.canonicalUrl = meta.canonicalUrl;
            if (meta.url) this.igForm.url = meta.url;
            if (meta.author) this.igForm.author = meta.author;
            this.successMessage.set(`Fetched metadata for '${this.igForm.packageId}' from packages.fhir.org.`);
          }
          this.fetchingRegistry.set(false);
        },
        error: (err) => {
          this.errorMessage.set(err?.error?.error || 'Failed to fetch metadata from packages.fhir.org.');
          this.fetchingRegistry.set(false);
        },
      });
  }

  public saveImplementationGuide(): void {
    if (!this.igForm.packageId.trim() || !this.igForm.version.trim() || !this.igForm.title.trim()) {
      this.errorMessage.set('Package ID, version, and title are required.');
      return;
    }

    if (this.isEditing() && this.currentIgId) {
      this.administrationService.updateImplementationGuide(this.currentIgId, this.igForm).subscribe({
        next: () => {
          this.showIgModal.set(false);
          this.successMessage.set(`Implementation Guide '${this.igForm.packageId}@${this.igForm.version}' updated.`);
          this.loadImplementationGuides();
        },
        error: (err) => {
          this.errorMessage.set(err?.error?.error || 'Failed to update implementation guide.');
        },
      });
    } else {
      this.administrationService.createImplementationGuide(this.igForm).subscribe({
        next: () => {
          this.showIgModal.set(false);
          this.successMessage.set(`Implementation Guide '${this.igForm.packageId}@${this.igForm.version}' registered.`);
          this.loadImplementationGuides();
        },
        error: (err) => {
          this.errorMessage.set(err?.error?.error || 'Failed to register implementation guide.');
        },
      });
    }
  }

  public toggleRecommended(ig: ImplementationGuideSummary): void {
    const newVal = !ig.recommendedForCreation;
    this.administrationService.updateImplementationGuide(ig.id, { recommendedForCreation: newVal }).subscribe({
      next: () => {
        this.successMessage.set(`Updated creation recommendation for '${ig.packageId}'.`);
        this.loadImplementationGuides();
      },
      error: (err) => {
        this.errorMessage.set(err?.error?.error || 'Failed to update recommendation.');
      },
    });
  }

  public toggleSuggested(ig: ImplementationGuideSummary): void {
    const newVal = !ig.isSuggested;
    this.administrationService.updateImplementationGuide(ig.id, { isSuggested: newVal }).subscribe({
      next: () => {
        this.successMessage.set(`Updated suggested visibility for '${ig.packageId}'.`);
        this.loadImplementationGuides();
      },
      error: (err) => {
        this.errorMessage.set(err?.error?.error || 'Failed to update suggestion flag.');
      },
    });
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
