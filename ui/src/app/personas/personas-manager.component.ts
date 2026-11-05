// Author: Preston Lee

import { Component, OnInit, inject, signal, effect, untracked } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { SandboxService } from '../core/services/sandbox.service.js';
import { PersonasService, type UserPersona } from '../core/services/personas.service.js';
import { ToastService } from '../core/services/toast.service.js';

@Component({
  selector: 'app-personas-manager',
  standalone: true,
  imports: [CommonModule, FormsModule],
  templateUrl: './personas-manager.component.html',
})
export class PersonasManagerComponent implements OnInit {
  private readonly toast = inject(ToastService);
  public readonly sandboxService = inject(SandboxService);
  public readonly personasService = inject(PersonasService);

  public readonly personas = signal<UserPersona[]>([]);
  public readonly loading = signal<boolean>(false);
  public readonly errorMessage = signal<string | null>(null);
  public readonly formError = signal<string | null>(null);

  public readonly showPersonaModal = signal<boolean>(false);
  public readonly editingPersonaId = signal<string | null>(null);
  public readonly saving = signal<boolean>(false);
  public personaForm = this.emptyPersonaForm();

  constructor() {
    effect(() => {
      const active = this.sandboxService.activeSandbox();
      untracked(() => {
        this.closePersonaModal();
        if (active) {
          this.loadPersonas(active.sandboxId);
        }
      });
    });
  }

  ngOnInit(): void {
    if (this.sandboxService.sandboxes().length === 0) {
      this.sandboxService.getSandboxes().subscribe();
    }
  }

  public loadPersonas(sandboxId?: string): void {
    const targetId = sandboxId || this.sandboxService.activeSandbox()?.sandboxId;
    if (!targetId) return;

    this.loading.set(true);
    this.personasService.getPersonas(targetId).subscribe({
      next: (res) => {
        this.personas.set(res?.personas || []);
        this.errorMessage.set(null);
        this.loading.set(false);
      },
      error: (err) => {
        this.errorMessage.set(err?.error?.error || 'Failed to load personas.');
        this.loading.set(false);
      },
    });
  }

  private emptyPersonaForm() {
    return {
      personaUserId: '',
      personaName: '',
      fhirResourceType: 'Practitioner',
      fhirResourceId: '',
      fhirResourceName: '',
    };
  }

  public openCreatePersona(): void {
    this.personaForm = this.emptyPersonaForm();
    this.editingPersonaId.set(null);
    this.formError.set(null);
    this.showPersonaModal.set(true);
  }

  public openEditPersona(persona: UserPersona): void {
    this.personaForm = {
      personaUserId: persona.personaUserId,
      personaName: persona.personaName,
      fhirResourceType: persona.fhirResourceType,
      fhirResourceId: persona.fhirResourceId,
      fhirResourceName: persona.fhirResourceName,
    };
    this.editingPersonaId.set(persona.id);
    this.formError.set(null);
    this.showPersonaModal.set(true);
  }

  public closePersonaModal(): void {
    this.showPersonaModal.set(false);
    this.editingPersonaId.set(null);
    this.formError.set(null);
  }

  public savePersona(): void {
    if (this.saving()) return;
    this.formError.set(null);
    const current = this.sandboxService.activeSandbox();
    if (!current) return;
    const personaUserId = this.personaForm.personaUserId.trim();
    const personaName = this.personaForm.personaName.trim();
    if (!personaUserId || !personaName) {
      this.formError.set('Persona User ID and Name are required.');
      return;
    }

    const personaId = this.editingPersonaId();
    const data = {
      personaName,
      fhirResourceType: this.personaForm.fhirResourceType,
      fhirResourceId: this.personaForm.fhirResourceId.trim() || personaUserId,
      fhirResourceName: this.personaForm.fhirResourceName.trim() || personaName,
    };
    const request = personaId
      ? this.personasService.updatePersona(current.sandboxId, personaId, data)
      : this.personasService.createPersona(current.sandboxId, { ...data, personaUserId });

    this.saving.set(true);
    request.subscribe({
      next: () => {
        this.saving.set(false);
        this.closePersonaModal();
        this.toast.success(`Persona '${personaName}' ${personaId ? 'updated' : 'created'} successfully.`);
        if (this.sandboxService.activeSandbox()?.sandboxId === current.sandboxId) {
          this.loadPersonas(current.sandboxId);
        }
      },
      error: (err) => {
        this.saving.set(false);
        this.formError.set(err?.error?.error || `Failed to ${personaId ? 'update' : 'create'} persona.`);
      },
    });
  }

  public deletePersona(persona: UserPersona): void {
    const current = this.sandboxService.activeSandbox();
    if (!current) return;
    if (confirm(`Are you sure you want to delete persona '${persona.personaName}'?`)) {
      this.personasService.deletePersona(current.sandboxId, persona.id).subscribe({
        next: () => {
          this.toast.success(`Persona '${persona.personaName}' deleted.`);
          this.loadPersonas(current.sandboxId);
        },
        error: (err) => {
          this.toast.error(err?.error?.error || 'Failed to delete persona.');
        },
      });
    }
  }
}
