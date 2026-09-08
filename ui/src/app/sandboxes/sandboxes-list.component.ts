// Author: Preston Lee

import { Component, OnInit, inject, signal, computed, DestroyRef } from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { RouterLink } from '@angular/router';
import { Subject, of } from 'rxjs';
import { debounceTime, distinctUntilChanged, switchMap, catchError } from 'rxjs/operators';
import { SandboxService, type Sandbox, type SandboxCollaborator } from '../core/services/sandbox.service.js';
import { AuthService } from '../core/services/auth.service.js';
import { ImplementationGuideService } from '../core/services/implementation-guide.service.js';
import { FhirReleasesService, type FhirReleaseId } from '../core/services/fhir-releases.service.js';

export interface SelectableIgOption {
  id: string;
  name: string;
  title: string;
  version: string;
  description: string;
  category: string;
  selected: boolean;
}

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
  public readonly igService = inject(ImplementationGuideService);
  public readonly fhirReleases = inject(FhirReleasesService);
  private readonly destroyRef = inject(DestroyRef);

  public readonly sandboxes = this.sandboxService.sandboxes;
  public readonly loading = signal<boolean>(false);
  public readonly errorMessage = signal<string | null>(null);
  public readonly successMessage = signal<string | null>(null);

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

  // Dynamic IGs for creation wizard
  public readonly igOptions = signal<SelectableIgOption[]>([]);
  public readonly loadingIgs = signal<boolean>(false);

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

  // Count computed signals for summary analytics (enabled releases only appear in the mix)
  public readonly enabledReleases = this.fhirReleases.enabledReleases;
  public readonly r4Count = computed(() => this.sandboxes().filter((s) => s.fhirVersion === 'R4').length);
  public readonly r4bCount = computed(() => this.sandboxes().filter((s) => s.fhirVersion === 'R4B').length);
  public readonly r5Count = computed(() => this.sandboxes().filter((s) => s.fhirVersion === 'R5').length);
  public readonly securedCount = computed(() => this.sandboxes().filter((s) => !s.allowOpenAccess).length);
  public readonly openCount = computed(() => this.sandboxes().filter((s) => s.allowOpenAccess).length);

  public countForRelease(release: FhirReleaseId): number {
    switch (release) {
      case 'R4':
        return this.r4Count();
      case 'R4B':
        return this.r4bCount();
      case 'R5':
        return this.r5Count();
    }
  }

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

  public onFhirVersionChange(): void {
    this.loadCreationIgs(this.newSandbox.fhirVersion);
  }

  public loadCreationIgs(fhirVersion = 'R4'): void {
    this.loadingIgs.set(true);
    this.igService.getImplementationGuides({ fhirVersion }).subscribe({
      next: (res) => {
        const options: SelectableIgOption[] = (res.implementationGuides || []).map((ig) => ({
          id: ig.id,
          name: ig.packageId,
          title: ig.title,
          version: ig.version,
          description: ig.description || '',
          category: ig.category,
          selected: ig.recommendedForCreation,
        }));
        this.igOptions.set(options);
        this.loadingIgs.set(false);
      },
      error: () => {
        this.loadingIgs.set(false);
      },
    });
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
    this.loadCreationIgs(defaultRelease);
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

    const selectedIgs = this.igOptions()
      .filter((ig) => ig.selected)
      .map((ig) => `${ig.name}@${ig.version}`);

    this.loading.set(true);
    this.sandboxService
      .createSandbox({
        ...this.newSandbox,
        sandboxId: cleanSlug,
        initialIgs: selectedIgs,
      })
      .subscribe({
        next: () => {
          this.showCreateModal.set(false);
          this.successMessage.set(`Sandbox '${this.newSandbox.name}' created with ${selectedIgs.length} selected IG packages.`);
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
        next: () => {
          this.successMessage.set(`Sandbox '${sandbox.name}' deleted.`);
          if (this.showSettingsModal()) {
            this.showSettingsModal.set(false);
          }
          this.loadSandboxes();
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
