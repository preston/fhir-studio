// Author: Preston Lee

import { Component, OnInit, inject, signal, computed, DestroyRef } from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { RouterLink } from '@angular/router';
import { Subject, of } from 'rxjs';
import { debounceTime, distinctUntilChanged, switchMap, catchError } from 'rxjs/operators';
import { ToastrService } from 'ngx-toastr';
import { SandboxService, type Sandbox, type SandboxCollaborator } from '../core/services/sandbox.service.js';
import { AuthService } from '../core/services/auth.service.js';
import { FhirReleasesService, type FhirReleaseId } from '../core/services/fhir-releases.service.js';

export type SandboxSortField = 'name' | 'sandboxId' | 'fhirVersion' | 'createdAt' | 'lastAccessedAt';
export type SandboxAccessFilter = 'all' | 'secured' | 'open';
export type SandboxVisibilityFilter = 'all' | 'PUBLIC' | 'PRIVATE';

@Component({
  selector: 'app-sandboxes-list',
  standalone: true,
  imports: [CommonModule, FormsModule, RouterLink],
  templateUrl: './sandboxes-list.component.html',
  styleUrls: ['./sandboxes-list.component.scss'],
})
export class SandboxesListComponent implements OnInit {
  public readonly sandboxService = inject(SandboxService);
  public readonly auth = inject(AuthService);
  public readonly fhirReleases = inject(FhirReleasesService);
  private readonly destroyRef = inject(DestroyRef);
  private readonly toastr = inject(ToastrService);

  public readonly sandboxes = this.sandboxService.sandboxes;
  public readonly loading = signal<boolean>(false);
  public readonly errorMessage = signal<string | null>(null);
  public readonly successMessage = signal<string | null>(null);

  // Search, filter & sort
  public readonly search = signal<string>('');
  public readonly fhirVersionFilter = signal<'all' | FhirReleaseId>('all');
  public readonly accessFilter = signal<SandboxAccessFilter>('all');
  public readonly visibilityFilter = signal<SandboxVisibilityFilter>('all');
  public readonly sortBy = signal<SandboxSortField>('name');
  public readonly sortOrder = signal<'asc' | 'desc'>('asc');

  // Slug validation and auto-generation state
  public readonly slugManuallyEdited = signal<boolean>(false);
  public readonly slugChecking = signal<boolean>(false);
  public readonly slugAvailable = signal<boolean | null>(null);
  public readonly slugValidationMessage = signal<string | null>(null);
  private readonly slugSubject = new Subject<string>();

  // New Sandbox Form
  public readonly showCreateModal = signal<boolean>(false);
  public newSandbox = {
    name: '',
    sandboxId: '',
    description: '',
    fhirVersion: 'R4' as FhirReleaseId,
    allowOpenAccess: false,
    visibility: 'PRIVATE' as 'PUBLIC' | 'PRIVATE',
    isShared: false,
    seedData: true,
  };

  // Collaborator Modal
  public readonly showCollaboratorModal = signal<boolean>(false);
  public readonly selectedSandboxForCollab = signal<Sandbox | null>(null);
  public newCollaboratorEmail = '';
  public newCollaboratorRole = 'READ_WRITE';

  // Sandbox Settings Modal
  public readonly showSettingsModal = signal<boolean>(false);
  public readonly selectedSandboxForSettings = signal<Sandbox | null>(null);
  public readonly savingSettings = signal<boolean>(false);
  public settingsForm = {
    name: '',
    description: '',
    allowOpenAccess: false,
    visibility: 'PRIVATE' as 'PUBLIC' | 'PRIVATE',
    isShared: false,
  };

  public readonly enabledReleases = this.fhirReleases.enabledReleases;

  public readonly filteredSandboxes = computed(() => {
    let list = this.sandboxes();
    const query = this.search().trim().toLowerCase();
    const fhirFilter = this.fhirVersionFilter();
    const access = this.accessFilter();
    const visibility = this.visibilityFilter();

    if (query) {
      list = list.filter((s) => {
        const name = s.name.toLowerCase();
        const slug = s.sandboxId.toLowerCase();
        const desc = (s.description || '').toLowerCase();
        return name.includes(query) || slug.includes(query) || desc.includes(query);
      });
    }

    if (fhirFilter !== 'all') {
      list = list.filter((s) => s.fhirVersion === fhirFilter);
    }

    if (access === 'secured') {
      list = list.filter((s) => !s.allowOpenAccess);
    } else if (access === 'open') {
      list = list.filter((s) => s.allowOpenAccess);
    }

    if (visibility !== 'all') {
      list = list.filter((s) => s.visibility === visibility);
    }

    const field = this.sortBy();
    const order = this.sortOrder() === 'asc' ? 1 : -1;

    return [...list].sort((a, b) => {
      let valA: string | number = '';
      let valB: string | number = '';

      switch (field) {
        case 'name':
          valA = a.name.toLowerCase();
          valB = b.name.toLowerCase();
          break;
        case 'sandboxId':
          valA = a.sandboxId.toLowerCase();
          valB = b.sandboxId.toLowerCase();
          break;
        case 'fhirVersion':
          valA = a.fhirVersion;
          valB = b.fhirVersion;
          break;
        case 'createdAt':
          valA = a.createdAt || '';
          valB = b.createdAt || '';
          break;
        case 'lastAccessedAt':
          valA = a.lastAccessedAt || '';
          valB = b.lastAccessedAt || '';
          break;
      }

      if (valA < valB) return -1 * order;
      if (valA > valB) return 1 * order;
      return 0;
    });
  });

  public readonly hasActiveFilters = computed(
    () =>
      this.search().trim().length > 0 ||
      this.fhirVersionFilter() !== 'all' ||
      this.accessFilter() !== 'all' ||
      this.visibilityFilter() !== 'all',
  );

  constructor() {
    this.slugSubject
      .pipe(
        takeUntilDestroyed(this.destroyRef),
        debounceTime(250),
        distinctUntilChanged(),
        switchMap((rawSlug) => {
          const cleaned = this.slugify(rawSlug);
          if (!cleaned) {
            this.slugChecking.set(false);
            this.slugAvailable.set(null);
            this.slugValidationMessage.set(null);
            return of(null);
          }

          if (cleaned.length < 2) {
            this.slugChecking.set(false);
            this.slugAvailable.set(false);
            this.slugValidationMessage.set('Sandbox ID must be at least 2 characters long.');
            return of(null);
          }

          this.slugChecking.set(true);
          return this.sandboxService.checkSlugAvailability(cleaned).pipe(
            catchError((err) =>
              of({
                available: false,
                slug: cleaned,
                reason: err?.error?.error || 'Failed to check availability.',
              }),
            ),
          );
        }),
      )
      .subscribe((res) => {
        this.slugChecking.set(false);
        if (res) {
          this.slugAvailable.set(res.available);
          this.slugValidationMessage.set(
            res.reason || (res.available ? 'Sandbox ID is available.' : 'Sandbox ID is unavailable.'),
          );
        }
      });
  }

  ngOnInit(): void {
    this.fhirReleases.ensureLoaded().subscribe({
      next: () => {
        const enabled = this.fhirReleases.enabledReleases();
        if (enabled.length > 0 && !enabled.includes(this.newSandbox.fhirVersion)) {
          this.newSandbox.fhirVersion = enabled[0];
        }
      },
    });
    this.loadSandboxes();
  }

  public loadSandboxes(): void {
    this.loading.set(true);
    this.sandboxService.getSandboxes().subscribe({
      next: () => {
        this.loading.set(false);
      },
      error: (err) => {
        this.errorMessage.set(err?.error?.error || 'Failed to load sandboxes.');
        this.loading.set(false);
      },
    });
  }

  public resetFilters(): void {
    this.search.set('');
    this.fhirVersionFilter.set('all');
    this.accessFilter.set('all');
    this.visibilityFilter.set('all');
    this.sortBy.set('name');
    this.sortOrder.set('asc');
  }

  public toggleSortOrder(): void {
    this.sortOrder.update((o) => (o === 'asc' ? 'desc' : 'asc'));
  }

  public slugify(value: string): string {
    return (value || '')
      .toLowerCase()
      .trim()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/-+/g, '-')
      .replace(/^-+|-+$/g, '');
  }

  public onNameChange(): void {
    if (!this.slugManuallyEdited()) {
      const suggested = this.slugify(this.newSandbox.name);
      this.newSandbox.sandboxId = suggested;
      this.slugSubject.next(suggested);
    }
  }

  public onSlugInput(event: Event): void {
    const input = event.target as HTMLInputElement;
    const val = input.value.toLowerCase().replace(/[^a-z0-9-]/g, '-').replace(/-+/g, '-');
    if (input.value !== val) {
      input.value = val;
    }
    this.newSandbox.sandboxId = val;
    this.slugManuallyEdited.set(val.length > 0);
    this.slugSubject.next(val);
  }

  public onSlugBlur(): void {
    const clean = this.slugify(this.newSandbox.sandboxId);
    this.newSandbox.sandboxId = clean;
    if (clean) {
      this.slugSubject.next(clean);
    }
  }

  public resetSlugToSuggested(): void {
    this.slugManuallyEdited.set(false);
    const suggested = this.slugify(this.newSandbox.name);
    this.newSandbox.sandboxId = suggested;
    this.slugSubject.next(suggested);
  }

  public openCreateModal(): void {
    const defaultRelease = this.fhirReleases.enabledReleases()[0] || 'R4';
    this.newSandbox = {
      name: '',
      sandboxId: '',
      description: '',
      fhirVersion: defaultRelease,
      allowOpenAccess: false,
      visibility: 'PRIVATE',
      isShared: false,
      seedData: true,
    };
    this.slugManuallyEdited.set(false);
    this.slugChecking.set(false);
    this.slugAvailable.set(null);
    this.slugValidationMessage.set(null);
    this.showCreateModal.set(true);
  }

  public createSandbox(): void {
    const cleanSlug = this.slugify(this.newSandbox.sandboxId);
    this.newSandbox.sandboxId = cleanSlug;

    if (!this.newSandbox.name.trim() || !cleanSlug) {
      this.errorMessage.set('Name and Sandbox ID slug are required.');
      return;
    }

    if (this.slugAvailable() === false) {
      this.errorMessage.set(this.slugValidationMessage() || 'Sandbox ID is not available.');
      return;
    }

    this.loading.set(true);
    this.sandboxService
      .createSandbox({
        ...this.newSandbox,
        sandboxId: cleanSlug,
      })
      .subscribe({
        next: () => {
          this.showCreateModal.set(false);
          const seeded = this.newSandbox.seedData;
          this.successMessage.set(
            seeded
              ? `Sandbox '${this.newSandbox.name}' created. Synthetic seed data is loading asynchronously and may take a few minutes to appear.`
              : `Sandbox '${this.newSandbox.name}' created.`,
          );
          this.loadSandboxes();
        },
        error: (err) => {
          this.errorMessage.set(err?.error?.error || 'Failed to create sandbox.');
          this.loading.set(false);
        },
      });
  }

  // Sandbox Settings Methods
  public openSettingsModal(sandbox: Sandbox): void {
    this.selectedSandboxForSettings.set(sandbox);
    this.settingsForm = {
      name: sandbox.name,
      description: sandbox.description || '',
      allowOpenAccess: sandbox.allowOpenAccess,
      visibility: sandbox.visibility || 'PRIVATE',
      isShared: sandbox.isShared || false,
    };
    this.showSettingsModal.set(true);
  }

  public saveSandboxSettings(): void {
    const selected = this.selectedSandboxForSettings();
    if (!selected) return;

    if (!this.settingsForm.name.trim()) {
      this.errorMessage.set('Sandbox name cannot be empty.');
      return;
    }

    this.savingSettings.set(true);
    this.sandboxService
      .updateSandbox(selected.sandboxId, {
        name: this.settingsForm.name.trim(),
        description: this.settingsForm.description.trim() || undefined,
        allowOpenAccess: this.settingsForm.allowOpenAccess,
        visibility: this.settingsForm.visibility,
        isShared: this.settingsForm.isShared,
      })
      .subscribe({
        next: (res) => {
          this.savingSettings.set(false);
          this.showSettingsModal.set(false);
          this.successMessage.set(`Settings for '${res.sandbox.name}' updated successfully.`);
          this.loadSandboxes();
        },
        error: (err) => {
          this.savingSettings.set(false);
          this.errorMessage.set(err?.error?.error || 'Failed to update sandbox settings.');
        },
      });
  }

  public resetPartition(sandbox: Sandbox): void {
    if (confirm(`Are you sure you want to reset all FHIR data in sandbox '${sandbox.name}'?`)) {
      this.sandboxService.resetSandbox(sandbox.sandboxId).subscribe({
        next: (res) => {
          this.successMessage.set(res.message);
        },
        error: (err) => {
          this.errorMessage.set(err?.error?.error || 'Failed to reset partition.');
        },
      });
    }
  }

  public deleteSandbox(sandbox: Sandbox): void {
    if (confirm(`Are you sure you want to permanently delete sandbox '${sandbox.name}'?`)) {
      this.sandboxService.deleteSandbox(sandbox.sandboxId).subscribe({
        next: (res) => {
          this.toastr.info(
            res.message ||
              `Sandbox '${sandbox.name}' will be deleted asynchronously and may not disappear immediately.`,
            'Sandbox deletion queued',
            { timeOut: 8000 },
          );
          if (this.showSettingsModal()) {
            this.showSettingsModal.set(false);
          }
        },
        error: (err) => {
          this.errorMessage.set(err?.error?.error || 'Failed to delete sandbox.');
        },
      });
    }
  }

  public openCollaboratorsModal(sandbox: Sandbox): void {
    this.selectedSandboxForCollab.set(sandbox);
    this.newCollaboratorEmail = '';
    this.showCollaboratorModal.set(true);
  }

  public addCollaborator(): void {
    const selected = this.selectedSandboxForCollab();
    if (!selected || !this.newCollaboratorEmail) return;
    this.sandboxService
      .addCollaborator(
        selected.sandboxId,
        this.newCollaboratorEmail,
        this.newCollaboratorRole,
      )
      .subscribe({
        next: () => {
          this.successMessage.set(`Collaborator ${this.newCollaboratorEmail} added.`);
          this.newCollaboratorEmail = '';
          this.loadSandboxes();
          this.showCollaboratorModal.set(false);
        },
        error: (err) => {
          this.errorMessage.set(err?.error?.error || 'Failed to add collaborator.');
        },
      });
  }

  public removeCollaborator(sandbox: Sandbox, userId: string): void {
    this.sandboxService.removeCollaborator(sandbox.sandboxId, userId).subscribe({
      next: () => {
        this.loadSandboxes();
        if (this.selectedSandboxForCollab()?.id === sandbox.id) {
          const updated = this.sandboxes().find((s) => s.id === sandbox.id);
          if (updated) this.selectedSandboxForCollab.set(updated);
        }
      },
      error: (err) => {
        this.errorMessage.set(err?.error?.error || 'Failed to remove collaborator.');
      },
    });
  }
}
