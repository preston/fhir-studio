// Author: Preston Lee

import { Component, OnInit, inject, signal, effect, untracked } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { Router } from '@angular/router';
import { SandboxService } from '../core/services/sandbox.service.js';
import { ScenariosService, type LaunchScenario } from '../core/services/scenarios.service.js';
import { ApplicationsService, type SmartApplication } from '../core/services/applications.service.js';
import { PersonasService, type UserPersona } from '../core/services/personas.service.js';

@Component({
  selector: 'app-scenarios-manager',
  standalone: true,
  imports: [CommonModule, FormsModule],
  templateUrl: './scenarios-manager.component.html',
})
export class ScenariosManagerComponent implements OnInit {
  public readonly sandboxService = inject(SandboxService);
  public readonly scenariosService = inject(ScenariosService);
  public readonly applicationsService = inject(ApplicationsService);
  public readonly personasService = inject(PersonasService);
  private readonly router = inject(Router);

  public readonly scenarios = signal<LaunchScenario[]>([]);
  public readonly applications = signal<SmartApplication[]>([]);
  public readonly personas = signal<UserPersona[]>([]);
  public readonly loading = signal<boolean>(false);
  public readonly successMessage = signal<string | null>(null);
  public readonly errorMessage = signal<string | null>(null);

  public readonly showCreateModal = signal<boolean>(false);
  public newScenario = {
    title: '',
    description: '',
    applicationId: '',
    userPersonaId: '',
    patientFhirId: 'SMART-1088792',
    patientName: 'Sherlock Holmes',
    encounterFhirId: 'encounter-101',
    intent: '',
  };

  constructor() {
    effect(() => {
      const active = this.sandboxService.activeSandbox();
      if (active) {
        untracked(() => {
          this.loadData(active.sandboxId);
        });
      }
    });
  }

  ngOnInit(): void {
    if (this.sandboxService.sandboxes().length === 0) {
      this.sandboxService.getSandboxes().subscribe();
    }
  }

  public loadData(sandboxId?: string): void {
    const targetId = sandboxId || this.sandboxService.activeSandbox()?.sandboxId;
    if (!targetId) return;

    this.loading.set(true);

    this.scenariosService.getScenarios(targetId).subscribe({
      next: (res) => {
        this.scenarios.set(res?.scenarios || []);
        this.loading.set(false);
      },
      error: (err) => {
        this.errorMessage.set(err?.error?.error || 'Failed to load launch scenarios.');
        this.loading.set(false);
      },
    });

    this.applicationsService.getSandboxApplications(targetId).subscribe({
      next: (res) => {
        const appsList = res?.applications || [];
        this.applications.set(appsList);
        if (appsList.length > 0 && !this.newScenario.applicationId) {
          this.newScenario.applicationId = appsList[0].id;
        }
      },
    });

    this.personasService.getPersonas(targetId).subscribe({
      next: (res) => {
        const personasList = res?.personas || [];
        this.personas.set(personasList);
        if (personasList.length > 0 && !this.newScenario.userPersonaId) {
          this.newScenario.userPersonaId = personasList[0].id;
        }
      },
    });
  }

  public createScenario(): void {
    const current = this.sandboxService.activeSandbox();
    if (!current || !this.newScenario.title) {
      this.errorMessage.set('Title is required.');
      return;
    }

    this.scenariosService
      .createScenario(current.sandboxId, {
        title: this.newScenario.title,
        description: this.newScenario.description,
        applicationId: this.newScenario.applicationId || null,
        userPersonaId: this.newScenario.userPersonaId || null,
        patientFhirId: this.newScenario.patientFhirId || null,
        patientName: this.newScenario.patientName || null,
        encounterFhirId: this.newScenario.encounterFhirId || null,
        intent: this.newScenario.intent || null,
      })
      .subscribe({
        next: () => {
          this.showCreateModal.set(false);
          this.successMessage.set(`Scenario '${this.newScenario.title}' created successfully.`);
          this.loadData(current.sandboxId);
        },
        error: (err) => {
          this.errorMessage.set(err?.error?.error || 'Failed to create scenario.');
        },
      });
  }

  public runScenario(scenario: LaunchScenario): void {
    const current = this.sandboxService.activeSandbox();
    if (!current) return;
    this.router.navigate(['/ehr-simulator'], {
      queryParams: {
        sandbox: current.sandboxId,
      },
    });
  }

  public deleteScenario(scenario: LaunchScenario): void {
    const current = this.sandboxService.activeSandbox();
    if (!current) return;
    if (confirm(`Are you sure you want to delete scenario '${scenario.title}'?`)) {
      this.scenariosService.deleteScenario(current.sandboxId, scenario.id).subscribe({
        next: () => {
          this.successMessage.set(`Scenario '${scenario.title}' deleted.`);
          this.loadData(current.sandboxId);
        },
        error: (err) => {
          this.errorMessage.set(err?.error?.error || 'Failed to delete scenario.');
        },
      });
    }
  }
}
