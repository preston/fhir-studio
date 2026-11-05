// Author: Preston Lee

import { Component, OnInit, inject, signal, effect, untracked } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { Router } from '@angular/router';
import { finalize, forkJoin, map, switchMap } from 'rxjs';
import { SandboxService } from '../core/services/sandbox.service.js';
import { ScenariosService, type LaunchScenario } from '../core/services/scenarios.service.js';
import { ApplicationsService, type SmartApplication } from '../core/services/applications.service.js';
import { PersonasService, type UserPersona } from '../core/services/personas.service.js';
import { ToastService } from '../core/services/toast.service.js';
import { PatientSearchInputComponent, type PatientSearchResult } from '../shared/patient-search-input/patient-search-input.component.js';

@Component({
  selector: 'app-scenarios-manager',
  standalone: true,
  imports: [CommonModule, FormsModule, PatientSearchInputComponent],
  templateUrl: './scenarios-manager.component.html',
})
export class ScenariosManagerComponent implements OnInit {
  private readonly toast = inject(ToastService);
  public readonly sandboxService = inject(SandboxService);
  public readonly scenariosService = inject(ScenariosService);
  public readonly applicationsService = inject(ApplicationsService);
  public readonly personasService = inject(PersonasService);
  private readonly router = inject(Router);

  public readonly scenarios = signal<LaunchScenario[]>([]);
  public readonly applications = signal<SmartApplication[]>([]);
  public readonly personas = signal<UserPersona[]>([]);
  public readonly loading = signal<boolean>(false);
  public readonly errorMessage = signal<string | null>(null);
  public readonly formError = signal<string | null>(null);

  public readonly showScenarioModal = signal<boolean>(false);
  public readonly editingScenarioId = signal<string | null>(null);
  public readonly saving = signal<boolean>(false);
  public readonly launchingScenarioId = signal<string | null>(null);
  public scenarioForm = this.emptyScenarioForm();

  constructor() {
    effect(() => {
      const active = this.sandboxService.activeSandbox();
      untracked(() => {
        this.closeScenarioModal();
        if (active) {
          this.loadData(active.sandboxId);
        }
      });
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
        this.errorMessage.set(null);
        this.loading.set(false);
      },
      error: (err) => {
        this.errorMessage.set(err?.error?.error || 'Failed to load launch scenarios.');
        this.loading.set(false);
      },
    });

    this.applicationsService.getSandboxApplications(targetId).subscribe({
      next: (res) => {
        this.applications.set(res?.applications || []);
      },
    });

    this.personasService.getPersonas(targetId).subscribe({
      next: (res) => {
        this.personas.set(res?.personas || []);
      },
    });
  }

  private emptyScenarioForm() {
    return {
      title: '',
      description: '',
      applicationId: this.applications()[0]?.id || '',
      userPersonaId: this.personas()[0]?.id || '',
      patientFhirId: 'SMART-1088792',
      patientName: 'Sherlock Holmes',
      encounterFhirId: 'encounter-101',
      intent: '',
    };
  }

  public openCreateScenario(): void {
    this.scenarioForm = this.emptyScenarioForm();
    this.editingScenarioId.set(null);
    this.formError.set(null);
    this.showScenarioModal.set(true);
  }

  public openEditScenario(scenario: LaunchScenario): void {
    this.scenarioForm = {
      title: scenario.title,
      description: scenario.description ?? '',
      applicationId: scenario.applicationId ?? '',
      userPersonaId: scenario.userPersonaId ?? '',
      patientFhirId: scenario.patientFhirId ?? '',
      patientName: scenario.patientName ?? '',
      encounterFhirId: scenario.encounterFhirId ?? '',
      intent: scenario.intent ?? '',
    };
    this.editingScenarioId.set(scenario.id);
    this.formError.set(null);
    this.showScenarioModal.set(true);
  }

  public closeScenarioModal(): void {
    this.showScenarioModal.set(false);
    this.editingScenarioId.set(null);
    this.formError.set(null);
  }

  public selectPatient(patient: PatientSearchResult): void {
    this.scenarioForm.patientFhirId = patient.id;
    this.scenarioForm.patientName = patient.name;
  }

  public saveScenario(): void {
    if (this.saving()) return;
    this.formError.set(null);
    const current = this.sandboxService.activeSandbox();
    if (!current) return;
    const title = this.scenarioForm.title.trim();
    if (!title) {
      this.formError.set('Title is required.');
      return;
    }

    const scenarioId = this.editingScenarioId();
    const data: Partial<LaunchScenario> = {
      title,
      description: this.scenarioForm.description || null,
      applicationId: this.scenarioForm.applicationId || null,
      userPersonaId: this.scenarioForm.userPersonaId || null,
      patientFhirId: this.scenarioForm.patientFhirId || null,
      patientName: this.scenarioForm.patientName || null,
      encounterFhirId: this.scenarioForm.encounterFhirId || null,
      intent: this.scenarioForm.intent || null,
    };
    const request = scenarioId
      ? this.scenariosService.updateScenario(current.sandboxId, scenarioId, data)
      : this.scenariosService.createScenario(current.sandboxId, data);

    this.saving.set(true);
    request.subscribe({
      next: () => {
        this.saving.set(false);
        this.closeScenarioModal();
        this.toast.success(`Scenario '${title}' ${scenarioId ? 'updated' : 'created'} successfully.`);
        if (this.sandboxService.activeSandbox()?.sandboxId === current.sandboxId) {
          this.loadData(current.sandboxId);
        }
      },
      error: (err) => {
        this.saving.set(false);
        this.formError.set(err?.error?.error || `Failed to ${scenarioId ? 'update' : 'create'} scenario.`);
      },
    });
  }

  public runScenario(scenario: LaunchScenario): void {
    const current = this.sandboxService.activeSandbox();
    if (!current) return;
    this.router.navigate(['/ehr-simulator'], {
      queryParams: {
        sandbox: current.sandboxId,
        scenario: scenario.id,
      },
    });
  }

  public launchStandalone(scenario: LaunchScenario): void {
    const sandbox = this.sandboxService.activeSandbox();
    if (!sandbox || this.launchingScenarioId()) return;

    // Open during the click so browsers do not block the tab after the HTTP request.
    const launchWindow = window.open('about:blank', '_blank');
    if (!launchWindow) {
      this.toast.error('Allow pop-ups to launch this scenario in a new tab.');
      return;
    }
    launchWindow.opener = null;
    this.launchingScenarioId.set(scenario.id);

    forkJoin({
      applications: this.applicationsService.getSandboxApplications(sandbox.sandboxId),
      personas: this.personasService.getPersonas(sandbox.sandboxId),
    }).pipe(
      switchMap(({ applications, personas }) => {
        const application = scenario.applicationId
          ? applications.applications.find((item) => item.id === scenario.applicationId)
          : applications.applications[0];
        const persona = scenario.userPersonaId
          ? personas.personas.find((item) => item.id === scenario.userPersonaId)
          : personas.personas[0];
        if (!application) throw new Error('The scenario application is unavailable. Select an available application.');
        if (scenario.userPersonaId && !persona) throw new Error('The scenario persona is unavailable. Select an available persona.');

        const launchUrl = new URL(application.launchUri, window.location.origin);
        launchUrl.searchParams.set('iss', `${window.location.origin}/api/sandboxes/${sandbox.sandboxId}/fhir/${sandbox.fhirVersion.toLowerCase()}`);
        return this.scenariosService.createLaunchContext(sandbox.sandboxId, {
          applicationId: application.id,
          clientId: application.clientId,
          scope: application.scope,
          userPersonaId: persona?.id || null,
          patientFhirId: scenario.patientFhirId,
          patientName: scenario.patientName,
          encounterFhirId: scenario.encounterFhirId,
          locationFhirId: scenario.locationFhirId,
          fhirContext: [
            { type: 'Patient', id: scenario.patientFhirId },
            { type: 'Encounter', id: scenario.encounterFhirId },
            { type: 'Location', id: scenario.locationFhirId },
          ].filter((item) => item.id).map((item) => ({ type: item.type, reference: `${item.type}/${item.id}` })),
        }).pipe(map((context) => {
          launchUrl.searchParams.set('launch', context.launch);
          return launchUrl.toString();
        }));
      }),
      finalize(() => this.launchingScenarioId.set(null)),
    ).subscribe({
      next: (url) => {
        if (!launchWindow.closed) launchWindow.location.replace(url);
      },
      error: (err) => {
        launchWindow.close();
        this.toast.error(err?.error?.error || err?.message || 'Failed to launch scenario.');
      },
    });
  }

  public deleteScenario(scenario: LaunchScenario): void {
    const current = this.sandboxService.activeSandbox();
    if (!current) return;
    if (confirm(`Are you sure you want to delete scenario '${scenario.title}'?`)) {
      this.scenariosService.deleteScenario(current.sandboxId, scenario.id).subscribe({
        next: () => {
          this.toast.success(`Scenario '${scenario.title}' deleted.`);
          this.loadData(current.sandboxId);
        },
        error: (err) => {
          this.toast.error(err?.error?.error || 'Failed to delete scenario.');
        },
      });
    }
  }
}
