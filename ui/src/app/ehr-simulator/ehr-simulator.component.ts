// Author: Preston Lee

import { Component, OnInit, inject, signal, computed, effect, untracked } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { ActivatedRoute } from '@angular/router';
import { toSignal } from '@angular/core/rxjs-interop';
import { DomSanitizer, type SafeResourceUrl } from '@angular/platform-browser';
import { forkJoin, of } from 'rxjs';
import { SandboxService, type Sandbox } from '../core/services/sandbox.service.js';
import { FhirService } from '../core/services/fhir.service.js';
import { ApplicationsService, type SmartApplication } from '../core/services/applications.service.js';
import { PersonasService, type UserPersona } from '../core/services/personas.service.js';
import { ScenariosService, type LaunchScenario } from '../core/services/scenarios.service.js';
import { CdsHooksService, type CdsEndpoint } from '../core/services/cds-hooks.service.js';
import type { CdsHookCard } from '@fhir-studio/core';
import { ToastService } from '../core/services/toast.service.js';

export interface PatientSummary {
  id: string;
  name: string;
  gender: string;
  birthDate: string;
  mrn: string;
  age?: number;
}

export interface EncounterSummary {
  id: string;
  class: string;
  status: string;
  periodStart?: string;
  type?: string;
  displayName: string;
}

export interface LocationSummary {
  id: string;
  name: string;
  status: string;
  mode?: string;
  type?: string;
}

export interface SimulatedTimelineEvent {
  step: string;
  time: string;
  detail: string;
  status: string;
}

@Component({
  selector: 'app-ehr-simulator',
  standalone: true,
  imports: [CommonModule, FormsModule],
  templateUrl: './ehr-simulator.component.html',
  styleUrls: ['./ehr-simulator.component.scss'],
})
export class EhrSimulatorComponent implements OnInit {
  private readonly route = inject(ActivatedRoute);
  private readonly queryParams = toSignal(this.route.queryParamMap, { initialValue: this.route.snapshot.queryParamMap });
  private readonly sanitizer = inject(DomSanitizer);
  public readonly sandboxService = inject(SandboxService);
  private readonly fhirService = inject(FhirService);
  private readonly applicationsService = inject(ApplicationsService);
  private readonly personasService = inject(PersonasService);
  private readonly scenariosService = inject(ScenariosService);
  private readonly cdsHooksService = inject(CdsHooksService);
  private readonly toast = inject(ToastService);
  private scenarioId: string | null = null;
  private sandboxLoadId = 0;

  public readonly applications = signal<SmartApplication[]>([]);
  public readonly personas = signal<UserPersona[]>([]);
  public readonly patients = signal<PatientSummary[]>([]);
  public readonly encounters = signal<EncounterSummary[]>([]);
  public readonly locations = signal<LocationSummary[]>([]);
  public readonly cdsEndpoints = signal<CdsEndpoint[]>([]);

  // Active Launch Context
  public readonly selectedApplication = signal<SmartApplication | null>(null);
  public readonly selectedPersona = signal<UserPersona | null>(null);
  public readonly selectedPatient = signal<PatientSummary>({
    id: 'SMART-1088792',
    name: 'Sherlock Holmes',
    gender: 'male',
    birthDate: '1974-01-06',
    mrn: 'MRN-90210',
    age: 52,
  });
  public readonly selectedEncounter = signal<EncounterSummary>({
    id: 'enc-101',
    class: 'AMB',
    status: 'in-progress',
    type: 'Ambulatory Clinical Encounter',
    displayName: 'Ambulatory Outpatient Encounter (Room 3B)',
  });
  public readonly selectedLocation = signal<LocationSummary>({
    id: 'loc-primary-clinic',
    name: 'Logica Health Main Clinic - Exam Room 3B',
    status: 'active',
  });

  public readonly patientConditions = signal<string[]>(['Essential Hypertension', 'Type 2 Diabetes Mellitus']);
  public readonly patientAllergies = signal<string[]>(['Penicillin', 'Peanuts']);

  // View state & Dual Launch Modes
  public readonly activeTab = signal<'application' | 'cds'>('application');
  public readonly launchMode = signal<'iframe' | 'popup'>('iframe');
  public readonly iframeSrc = signal<SafeResourceUrl | null>(null);
  public readonly rawLaunchUrl = signal<string | null>(null);
  public readonly activeLaunchToken = signal<string | null>(null);
  public readonly launching = signal<boolean>(false);

  // Context Selection Modals
  public readonly showPatientModal = signal<boolean>(false);
  public readonly patientSearchQuery = signal<string>('');
  public readonly showEncounterModal = signal<boolean>(false);
  public readonly showLocationModal = signal<boolean>(false);

  // SMART & Token Inspector Modal
  public readonly showInspectorModal = signal<boolean>(false);
  public readonly inspectorActiveTab = signal<'jwt' | 'timeline' | 'network'>('jwt');
  public readonly simulatedIdTokenPayload = signal<Record<string, unknown>>({});
  public readonly simulatedTimelineEvents = signal<SimulatedTimelineEvent[]>([]);

  // CDS Hooks state
  public readonly selectedCdsHook = signal<string>('patient-view');
  public readonly customCdsServiceUrl = signal<string>('https://cqframework.info/cds-services/patient-greeter');
  public readonly cdsCards = signal<CdsHookCard[]>([]);
  public readonly evaluatingCds = signal<boolean>(false);

  // Computed filtered patients
  public readonly filteredPatients = computed(() => {
    const q = this.patientSearchQuery().toLowerCase().trim();
    const list = this.patients();
    if (!q) return list;
    return list.filter(
      (p) =>
        p.name.toLowerCase().includes(q) ||
        p.mrn.toLowerCase().includes(q) ||
        p.id.toLowerCase().includes(q),
    );
  });

  constructor() {
    effect(() => {
      const active = this.sandboxService.activeSandbox();
      const params = this.queryParams();
      if (active) {
        untracked(() => {
          this.onActiveSandboxChanged(active, params.get('sandbox') === active.sandboxId ? params.get('scenario') : null);
        });
      }
    });
  }

  ngOnInit(): void {
    const querySandbox = this.route.snapshot.queryParamMap.get('sandbox');
    if (this.sandboxService.sandboxes().length === 0) {
      this.sandboxService.getSandboxes().subscribe({
        next: (res) => {
          if (querySandbox && res?.sandboxes) {
            this.sandboxService.selectSandbox(querySandbox);
          }
        },
      });
    } else if (querySandbox) {
      this.sandboxService.selectSandbox(querySandbox);
    }
  }

  public onActiveSandboxChanged(sandbox: Sandbox, scenarioId: string | null = null): void {
    const loadId = ++this.sandboxLoadId;
    this.scenarioId = scenarioId;
    this.selectedApplication.set(null);
    this.selectedPersona.set(null);
    this.iframeSrc.set(null);
    this.rawLaunchUrl.set(null);
    this.activeLaunchToken.set(null);
    this.patients.set([]);
    this.encounters.set([]);
    this.locations.set([]);
    this.launching.set(Boolean(scenarioId));

    // Resolve the complete saved context before launching; these requests can finish in any order.
    forkJoin({
      applications: this.applicationsService.getSandboxApplications(sandbox.sandboxId),
      personas: this.personasService.getPersonas(sandbox.sandboxId),
      scenarios: scenarioId ? this.scenariosService.getScenarios(sandbox.sandboxId) : of({ scenarios: [] }),
    }).subscribe({
      next: ({ applications, personas, scenarios }) => {
        if (loadId !== this.sandboxLoadId) return;
        this.applications.set(applications.applications);
        this.personas.set(personas.personas);
        this.selectedApplication.set(applications.applications[0] || null);
        this.selectedPersona.set(personas.personas[0] || null);

        if (scenarioId) {
          const scenario = scenarios.scenarios.find((item) => item.id === scenarioId);
          if (!scenario) {
            this.toast.error('The launch scenario is unavailable in this sandbox.');
            this.launching.set(false);
            return;
          }
          if (!this.applyScenario(scenario)) {
            this.launching.set(false);
            return;
          }
        }

        // FHIR searches enrich the selectors but must not block or replace a saved scenario's IDs.
        this.loadFhirPatients(sandbox);
        this.loadFhirEncounters(sandbox);
        this.loadFhirLocations(sandbox);
        if (scenarioId) this.launchApplication();
      },
      error: (err) => {
        if (loadId !== this.sandboxLoadId) return;
        this.launching.set(false);
        this.toast.error(err?.error?.error || 'Failed to load launch configuration.');
      },
    });

    // Load CDS Endpoints
    this.cdsHooksService.getEndpoints(sandbox.sandboxId).subscribe({
      next: (res) => {
        this.cdsEndpoints.set(res?.endpoints || []);
      },
    });

  }

  private applyScenario(scenario: LaunchScenario): boolean {
    const application = scenario.applicationId
      ? this.applications().find((item) => item.id === scenario.applicationId)
      : this.applications()[0];
    const persona = scenario.userPersonaId
      ? this.personas().find((item) => item.id === scenario.userPersonaId)
      : this.personas()[0];
    this.selectedApplication.set(application || null);
    this.selectedPersona.set(persona || null);
    if (!application) {
      this.toast.error('The scenario application is unavailable. Select an available application.');
      return false;
    }
    if (scenario.userPersonaId && !persona) {
      this.toast.error('The scenario persona is unavailable. Select an available persona.');
      return false;
    }
    this.selectedPatient.set({
      id: scenario.patientFhirId || '',
      name: scenario.patientName || scenario.patientFhirId || 'No patient selected',
      gender: 'unknown',
      birthDate: 'Unknown',
      mrn: '',
    });
    this.selectedEncounter.set({
      id: scenario.encounterFhirId || '',
      class: '',
      status: '',
      displayName: scenario.encounterFhirId || 'No encounter selected',
    });
    this.selectedLocation.set({
      id: scenario.locationFhirId || '',
      name: scenario.locationFhirId || 'No location selected',
      status: '',
    });
    this.patientConditions.set([]);
    this.patientAllergies.set([]);
    const sandbox = this.sandboxService.activeSandbox();
    if (sandbox && scenario.patientFhirId) this.loadClinicalContext(sandbox, scenario.patientFhirId);
    return true;
  }

  public loadFhirPatients(sandbox: Sandbox): void {
    this.fhirService.search(sandbox.sandboxId, sandbox.fhirVersion, 'Patient', { _count: 20 }).subscribe({
      next: (bundle) => {
        if (this.sandboxService.activeSandbox()?.sandboxId !== sandbox.sandboxId) return;
        if (bundle.entry && Array.isArray(bundle.entry)) {
          const mapped: PatientSummary[] = bundle.entry.map((e) => {
            const p = e.resource as {
              id?: string;
              name?: Array<{ given?: string[]; family?: string }>;
              gender?: string;
              birthDate?: string;
              identifier?: Array<{ value?: string }>;
            };
            const nameObj = p.name?.[0];
            const nameStr = nameObj
              ? `${nameObj.given?.join(' ') || ''} ${nameObj.family || ''}`.trim()
              : `Patient #${p.id || 'unknown'}`;
            const dob = p.birthDate || 'Unknown';
            return {
              id: p.id || 'unknown',
              name: nameStr,
              gender: p.gender || 'unknown',
              birthDate: dob,
              mrn: p.identifier?.[0]?.value || `MRN-${p.id || '0'}`,
              age: dob !== 'Unknown' ? this.calculateAge(dob) : undefined,
            };
          });
          this.patients.set(mapped);
          const patient = this.scenarioId ? mapped.find((item) => item.id === this.selectedPatient().id) : mapped[0];
          if (patient) {
            this.selectedPatient.set(patient);
            if (!this.scenarioId) this.loadClinicalContext(sandbox, patient.id);
          }
        }
      },
      error: () => {},
    });
  }

  public loadFhirEncounters(sandbox: Sandbox): void {
    this.fhirService.search(sandbox.sandboxId, sandbox.fhirVersion, 'Encounter', { _count: 10 }).subscribe({
      next: (bundle) => {
        if (this.sandboxService.activeSandbox()?.sandboxId !== sandbox.sandboxId) return;
        if (bundle.entry && Array.isArray(bundle.entry)) {
          const mapped: EncounterSummary[] = bundle.entry.map((e) => {
            const enc = e.resource as {
              id?: string;
              class?: { code?: string; display?: string };
              status?: string;
              type?: Array<{ text?: string; coding?: Array<{ display?: string }> }>;
            };
            return {
              id: enc.id || 'unknown',
              class: enc.class?.code || enc.class?.display || 'AMB',
              status: enc.status || 'in-progress',
              type: enc.type?.[0]?.text || enc.type?.[0]?.coding?.[0]?.display || 'Clinical Encounter',
              displayName: `${enc.type?.[0]?.text || 'Encounter'} (#${enc.id || '1'})`,
            };
          });
          this.encounters.set(mapped);
          const encounter = this.scenarioId ? mapped.find((item) => item.id === this.selectedEncounter().id) : mapped[0];
          if (encounter) this.selectedEncounter.set(encounter);
        }
      },
      error: () => {},
    });
  }

  public loadFhirLocations(sandbox: Sandbox): void {
    this.fhirService.search(sandbox.sandboxId, sandbox.fhirVersion, 'Location', { _count: 10 }).subscribe({
      next: (bundle) => {
        if (this.sandboxService.activeSandbox()?.sandboxId !== sandbox.sandboxId) return;
        if (bundle.entry && Array.isArray(bundle.entry)) {
          const mapped: LocationSummary[] = bundle.entry.map((e) => {
            const loc = e.resource as {
              id?: string;
              name?: string;
              status?: string;
              type?: Array<{ text?: string }>;
            };
            return {
              id: loc.id || 'unknown',
              name: loc.name || `Location #${loc.id || '1'}`,
              status: loc.status || 'active',
              type: loc.type?.[0]?.text || 'Exam Room',
            };
          });
          this.locations.set(mapped);
          const location = this.scenarioId ? mapped.find((item) => item.id === this.selectedLocation().id) : mapped[0];
          if (location) this.selectedLocation.set(location);
        }
      },
      error: () => {},
    });
  }

  public selectPatient(patient: PatientSummary): void {
    this.selectedPatient.set(patient);
    this.showPatientModal.set(false);
    const active = this.sandboxService.activeSandbox();
    if (active) {
      this.loadClinicalContext(active, patient.id);
    }
    if (this.selectedApplication()) {
      this.launchApplication();
    }
  }

  public selectEncounter(encounter: EncounterSummary): void {
    this.selectedEncounter.set(encounter);
    this.showEncounterModal.set(false);
    if (this.selectedApplication()) {
      this.launchApplication();
    }
  }

  public selectLocation(location: LocationSummary): void {
    this.selectedLocation.set(location);
    this.showLocationModal.set(false);
    if (this.selectedApplication()) {
      this.launchApplication();
    }
  }

  public loadClinicalContext(sandbox: Sandbox, patientId: string): void {
    this.fhirService.search(sandbox.sandboxId, sandbox.fhirVersion, 'Condition', { patient: patientId }).subscribe({
      next: (bundle) => {
        if (bundle.entry) {
          const conds = bundle.entry.map((e) => {
            const c = e.resource as { code?: { text?: string; coding?: Array<{ display?: string }> } };
            return c.code?.text || c.code?.coding?.[0]?.display || 'Condition';
          });
          this.patientConditions.set(conds);
        }
      },
      error: () => {},
    });

    this.fhirService.search(sandbox.sandboxId, sandbox.fhirVersion, 'AllergyIntolerance', { patient: patientId }).subscribe({
      next: (bundle) => {
        if (bundle.entry) {
          const allergies = bundle.entry.map((e) => {
            const a = e.resource as { code?: { text?: string; coding?: Array<{ display?: string }> } };
            return a.code?.text || a.code?.coding?.[0]?.display || 'Allergy';
          });
          this.patientAllergies.set(allergies);
        }
      },
      error: () => {},
    });
  }

  public launchApplication(): void {
    const activeSandbox = this.sandboxService.activeSandbox();
    const application = this.selectedApplication();
    if (!activeSandbox || !application) {
      this.launching.set(false);
      return;
    }

    const loadId = this.sandboxLoadId;
    this.launching.set(true);
    const fhirVersion = activeSandbox.fhirVersion.toLowerCase();
    const issUrl = `${window.location.origin}/api/sandboxes/${activeSandbox.sandboxId}/fhir/${fhirVersion}`;
    const patient = this.selectedPatient();
    const encounter = this.selectedEncounter();
    const location = this.selectedLocation();
    const persona = this.selectedPersona();

    this.scenariosService
      .createLaunchContext(activeSandbox.sandboxId, {
        patientFhirId: patient.id,
        patientName: patient.name,
        encounterFhirId: encounter.id,
        locationFhirId: location.id,
        userPersonaId: persona?.id || null,
        applicationId: application.id,
        clientId: application.clientId,
        scope: application.scope,
        fhirContext: [
          { type: 'Patient', id: patient.id },
          { type: 'Encounter', id: encounter.id },
          { type: 'Location', id: location.id },
        ].filter((item) => item.id).map((item) => ({ type: item.type, reference: `${item.type}/${item.id}` })),
      })
      .subscribe({
        next: (ctx) => {
          if (loadId !== this.sandboxLoadId) return;
          this.activeLaunchToken.set(ctx.launch);
          const launchUrl = new URL(application.launchUri, window.location.origin);
          launchUrl.searchParams.set('iss', issUrl);
          launchUrl.searchParams.set('launch', ctx.launch);

          const urlStr = launchUrl.toString();
          this.rawLaunchUrl.set(urlStr);
          this.iframeSrc.set(this.sanitizer.bypassSecurityTrustResourceUrl(urlStr));
          this.launching.set(false);

          // Update Inspector state
          this.simulatedIdTokenPayload.set({
            iss: window.location.origin,
            sub: persona?.personaUserId || 'practitioner-1',
            aud: application.clientId || 'smart-application-client',
            fhirUser: `Practitioner/${persona?.personaUserId || 'dr-smith'}`,
            patient: patient.id,
            encounter: encounter.id,
            location: location.id,
            fhirContext: [
              { type: 'Patient', reference: `Patient/${patient.id}` },
              { type: 'Encounter', reference: `Encounter/${encounter.id}` },
              { type: 'Location', reference: `Location/${location.id}` },
            ],
            iat: Math.floor(Date.now() / 1000),
            exp: Math.floor(Date.now() / 1000) + 3600,
          });

          this.simulatedTimelineEvents.set([
            {
              step: '1. Launch Context Minted',
              time: new Date().toLocaleTimeString(),
              detail: `Minted launch token '${ctx.launch.substring(0, 8)}...' for patient ${patient.id} and practitioner ${persona?.personaName || 'Practitioner'}`,
              status: 'success',
            },
            {
              step: '2. Application Launch Requested',
              time: new Date().toLocaleTimeString(),
              detail: `Redirected to ${application.launchUri} with iss=${issUrl}`,
              status: 'success',
            },
            {
              step: '3. SMART v2 Discovery',
              time: new Date().toLocaleTimeString(),
              detail: `Application fetches /.well-known/smart-configuration with PKCE S256 & granular scope capabilities`,
              status: 'success',
            },
            {
              step: '4. OAuth Authorization Code & Token Exchange',
              time: 'Pending / Live',
              detail: `Authorizes with scope: ${application.scope}`,
              status: 'info',
            },
          ]);

          // Handle popup launch mode if enabled
          if (this.launchMode() === 'popup') {
            window.open(urlStr, '_blank', 'noopener,noreferrer');
          }
        },
        error: (err) => {
          if (loadId !== this.sandboxLoadId) return;
          console.error('Launch failed:', err);
          this.toast.error(err?.error?.error || err?.message || 'Failed to launch application.');
          this.launching.set(false);
        },
      });
  }

  public evaluateCdsHooks(): void {
    const activeSandbox = this.sandboxService.activeSandbox();
    if (!activeSandbox) return;
    this.evaluatingCds.set(true);
    this.cdsCards.set([]);

    const serviceUrl = this.customCdsServiceUrl() || this.cdsEndpoints()[0]?.url;
    if (!serviceUrl) {
      this.evaluatingCds.set(false);
      return;
    }

    const patient = this.selectedPatient();
    const encounter = this.selectedEncounter();
    const persona = this.selectedPersona();

    this.cdsHooksService
      .invokeHookProxy(activeSandbox.sandboxId, {
        serviceUrl,
        hook: this.selectedCdsHook(),
        hookInstance: `hook-${Date.now()}`,
        context: {
          userId: persona?.personaUserId || 'practitioner-1',
          patientId: patient.id,
          encounterId: encounter.id,
        },
      })
      .subscribe({
        next: (res) => {
          this.cdsCards.set(res?.cards || []);
          this.evaluatingCds.set(false);
        },
        error: (err) => {
          this.cdsCards.set([
            {
              summary: 'CDS Hook Evaluation Error',
              detail: err?.error?.message || err?.message || 'Unable to invoke remote CDS service',
              indicator: 'warning',
              source: { label: 'FHIR Studio Gateway' },
            },
          ]);
          this.evaluatingCds.set(false);
        },
      });
  }

  private calculateAge(dobStr: string): number {
    const birth = new Date(dobStr);
    const diffMs = Date.now() - birth.getTime();
    const ageDate = new Date(diffMs);
    return Math.abs(ageDate.getUTCFullYear() - 1970);
  }
}
