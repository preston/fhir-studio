// Author: Preston Lee

import { Component, OnInit, inject, signal } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { ToastrService } from 'ngx-toastr';
import type {
  AdministrationSandboxFilter,
  SandboxSummary,
  SandboxSortField,
} from '@fhir-studio/core';
import { AdministrationService } from '../../core/services/administration.service.js';
import type { Sandbox } from '../../core/services/sandbox.service.js';
import { FhirReleasesService } from '../../core/services/fhir-releases.service.js';

@Component({
  selector: 'app-admin-purge',
  standalone: true,
  imports: [CommonModule, FormsModule],
  templateUrl: './admin-purge.component.html',
})
export class AdminPurgeComponent implements OnInit {
  public readonly administrationService = inject(AdministrationService);
  public readonly fhirReleases = inject(FhirReleasesService);
  private readonly toastr = inject(ToastrService);

  public readonly purgeSandboxes = signal<SandboxSummary[]>([]);
  public readonly purgeTotal = signal<number>(0);
  public readonly purgeTotalPages = signal<number>(1);
  public readonly purgeLoading = signal<boolean>(false);
  public readonly successMessage = signal<string | null>(null);
  public readonly errorMessage = signal<string | null>(null);

  public readonly purgeFilters = signal<AdministrationSandboxFilter>({
    search: '',
    user: '',
    fhirVersion: 'all',
    agePreset: 'all',
    lastUsedPreset: 'all',
    sortBy: 'createdAt',
    sortOrder: 'desc',
    page: 1,
    limit: 10,
  });

  ngOnInit(): void {
    this.fhirReleases.ensureLoaded().subscribe();
    this.loadPurgeSandboxes();
  }

  public loadPurgeSandboxes(): void {
    this.purgeLoading.set(true);
    this.administrationService.getAdminSandboxes(this.purgeFilters()).subscribe({
      next: (res) => {
        this.purgeSandboxes.set(res.sandboxes);
        this.purgeTotal.set(res.total);
        this.purgeTotalPages.set(res.totalPages);
        this.purgeLoading.set(false);
      },
      error: (err) => {
        this.errorMessage.set(err?.error?.error || 'Failed to load sandboxes for purge.');
        this.purgeLoading.set(false);
      },
    });
  }

  public purgeSandbox(sandbox: Sandbox | SandboxSummary): void {
    if (confirm(`CRITICAL: Permanently purge sandbox '${sandbox.name}' and delete its HAPI FHIR JPA partition? This action is irreversible.`)) {
      this.administrationService.purgeSandbox(sandbox.sandboxId).subscribe({
        next: (res) => {
          this.toastr.info(
            res.message ||
              `Sandbox '${sandbox.name}' will be purged asynchronously and may not disappear immediately.`,
            'Sandbox purge queued',
            { timeOut: 8000 },
          );
        },
        error: (err) => {
          this.errorMessage.set(err?.error?.error || 'Purge failed.');
        },
      });
    }
  }

  public onPurgeSearchChange(search: string): void {
    this.purgeFilters.update((f) => ({ ...f, search, page: 1 }));
    this.loadPurgeSandboxes();
  }

  public onPurgeUserChange(user: string): void {
    this.purgeFilters.update((f) => ({ ...f, user, page: 1 }));
    this.loadPurgeSandboxes();
  }

  public onPurgeFhirVersionChange(fhirVersion: string): void {
    this.purgeFilters.update((f) => ({ ...f, fhirVersion, page: 1 }));
    this.loadPurgeSandboxes();
  }

  public onAgePresetChange(agePreset: any): void {
    this.purgeFilters.update((f) => ({ ...f, agePreset, page: 1 }));
    this.loadPurgeSandboxes();
  }

  public onLastUsedPresetChange(lastUsedPreset: any): void {
    this.purgeFilters.update((f) => ({ ...f, lastUsedPreset, page: 1 }));
    this.loadPurgeSandboxes();
  }

  public setPurgeSort(field: SandboxSortField): void {
    this.purgeFilters.update((f) => {
      const isCurrent = f.sortBy === field;
      const nextOrder = isCurrent && f.sortOrder === 'asc' ? 'desc' : 'asc';
      return { ...f, sortBy: field, sortOrder: nextOrder, page: 1 };
    });
    this.loadPurgeSandboxes();
  }

  public setPurgePage(page: number): void {
    if (page < 1 || page > this.purgeTotalPages()) return;
    this.purgeFilters.update((f) => ({ ...f, page }));
    this.loadPurgeSandboxes();
  }

  public setPurgeLimit(limit: number): void {
    this.purgeFilters.update((f) => ({ ...f, limit: Number(limit), page: 1 }));
    this.loadPurgeSandboxes();
  }

  public resetPurgeFilters(): void {
    this.purgeFilters.set({
      search: '',
      user: '',
      fhirVersion: 'all',
      agePreset: 'all',
      lastUsedPreset: 'all',
      sortBy: 'createdAt',
      sortOrder: 'desc',
      page: 1,
      limit: 10,
    });
    this.loadPurgeSandboxes();
  }

  public getPurgeShowingStart(): number {
    if (this.purgeTotal() === 0) return 0;
    const page = this.purgeFilters().page || 1;
    const limit = this.purgeFilters().limit || 10;
    return (page - 1) * limit + 1;
  }

  public getPurgeShowingEnd(): number {
    const page = this.purgeFilters().page || 1;
    const limit = this.purgeFilters().limit || 10;
    return Math.min(page * limit, this.purgeTotal());
  }
}
