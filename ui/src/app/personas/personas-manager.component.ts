// Author: Preston Lee

import { Component, OnInit, inject, signal, effect, untracked } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { SandboxService } from '../core/services/sandbox.service.js';
import { PersonasService, type UserPersona } from '../core/services/personas.service.js';

@Component({
  selector: 'app-personas-manager',
  standalone: true,
  imports: [CommonModule, FormsModule],
  templateUrl: './personas-manager.component.html',
})
export class PersonasManagerComponent implements OnInit {
  public readonly sandboxService = inject(SandboxService);
  public readonly personasService = inject(PersonasService);

  public readonly personas = signal<UserPersona[]>([]);
  public readonly loading = signal<boolean>(false);
  public readonly successMessage = signal<string | null>(null);
  public readonly errorMessage = signal<string | null>(null);

  public readonly showCreateModal = signal<boolean>(false);
  public newPersona = {
    personaUserId: '',
    personaName: '',
    fhirResourceType: 'Practitioner',
    fhirResourceId: '',
    fhirResourceName: '',
  };

  constructor() {
    effect(() => {
      const active = this.sandboxService.activeSandbox();
      if (active) {
        untracked(() => {
          this.loadPersonas(active.sandboxId);
        });
      }
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
        this.loading.set(false);
      },
      error: (err) => {
        this.errorMessage.set(err?.error?.error || 'Failed to load personas.');
        this.loading.set(false);
      },
    });
  }

  public createPersona(): void {
    const current = this.sandboxService.activeSandbox();
    if (!current || !this.newPersona.personaUserId || !this.newPersona.personaName) {
      this.errorMessage.set('Persona User ID and Name are required.');
      return;
    }

    this.personasService
      .createPersona(current.sandboxId, {
        personaUserId: this.newPersona.personaUserId,
        personaName: this.newPersona.personaName,
        fhirResourceType: this.newPersona.fhirResourceType,
        fhirResourceId: this.newPersona.fhirResourceId || this.newPersona.personaUserId,
        fhirResourceName: this.newPersona.fhirResourceName || this.newPersona.personaName,
      })
      .subscribe({
        next: () => {
          this.showCreateModal.set(false);
          this.successMessage.set(`Persona '${this.newPersona.personaName}' created successfully.`);
          this.newPersona = {
            personaUserId: '',
            personaName: '',
            fhirResourceType: 'Practitioner',
            fhirResourceId: '',
            fhirResourceName: '',
          };
          this.loadPersonas(current.sandboxId);
        },
        error: (err) => {
          this.errorMessage.set(err?.error?.error || 'Failed to create persona.');
        },
      });
  }

  public deletePersona(persona: UserPersona): void {
    const current = this.sandboxService.activeSandbox();
    if (!current) return;
    if (confirm(`Are you sure you want to delete persona '${persona.personaName}'?`)) {
      this.personasService.deletePersona(current.sandboxId, persona.id).subscribe({
        next: () => {
          this.successMessage.set(`Persona '${persona.personaName}' deleted.`);
          this.loadPersonas(current.sandboxId);
        },
        error: (err) => {
          this.errorMessage.set(err?.error?.error || 'Failed to delete persona.');
        },
      });
    }
  }
}
