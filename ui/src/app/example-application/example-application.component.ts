// Author: Preston Lee

import { Component, OnInit, inject, signal, computed } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { ActivatedRoute, Router } from '@angular/router';
import { HttpClient, HttpHeaders } from '@angular/common/http';
import { SandboxService } from '../core/services/sandbox.service.js';

export interface SmartTokenResponse {
  access_token: string;
  token_type: string;
  expires_in: number;
  scope: string;
  id_token?: string;
  refresh_token?: string;
  patient?: string;
  encounter?: string;
  need_patient_banner?: boolean;
  fhirContext?: any[];
  [key: string]: any;
}

export interface PatientResource {
  id?: string;
  name?: Array<{ given?: string[]; family?: string; text?: string; prefix?: string[] }>;
  gender?: string;
  birthDate?: string;
  telecom?: Array<{ system?: string; value?: string; use?: string }>;
  address?: Array<{ line?: string[]; city?: string; state?: string; postalCode?: string }>;
  identifier?: Array<{ system?: string; value?: string; type?: { text?: string } }>;
  [key: string]: any;
}

export interface ConditionResource {
  id?: string;
  clinicalStatus?: { coding?: Array<{ code?: string; display?: string }> };
  verificationStatus?: { coding?: Array<{ code?: string; display?: string }> };
  code?: { text?: string; coding?: Array<{ display?: string; code?: string; system?: string }> };
  recordedDate?: string;
  onsetDateTime?: string;
}

export interface ObservationResource {
  id?: string;
  status?: string;
  code?: { text?: string; coding?: Array<{ display?: string; code?: string }> };
  valueQuantity?: { value?: number; unit?: string; code?: string };
  valueCodeableConcept?: { text?: string; coding?: Array<{ display?: string }> };
  valueString?: string;
  effectiveDateTime?: string;
  category?: Array<{ text?: string; coding?: Array<{ display?: string; code?: string }> }>;
}

export interface MedicationRequestResource {
  id?: string;
  status?: string;
  intent?: string;
  medicationCodeableConcept?: { text?: string; coding?: Array<{ display?: string; code?: string }> };
  authoredOn?: string;
  dosageInstruction?: Array<{ text?: string }>;
}

export interface EncounterResource {
  id?: string;
  status?: string;
  class?: { code?: string; display?: string } | string;
  type?: Array<{ text?: string; coding?: Array<{ display?: string }> }>;
  period?: { start?: string; end?: string };
}

function generateRandomString(length = 64): string {
  const array = new Uint8Array(length);
  window.crypto.getRandomValues(array);
  return Array.from(array, (dec) => ('0' + dec.toString(16)).slice(-2))
    .join('')
    .slice(0, length);
}

function base64UrlEncode(buffer: ArrayBuffer): string {
  const bytes = new Uint8Array(buffer);
  let binary = '';
  for (let i = 0; i < bytes.byteLength; i++) {
    binary += String.fromCharCode(bytes[i]);
  }
  return btoa(binary)
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
}

async function generateCodeChallenge(verifier: string): Promise<string> {
  const encoder = new TextEncoder();
  const data = encoder.encode(verifier);
  const digest = await window.crypto.subtle.digest('SHA-256', data);
  return base64UrlEncode(digest);
}

function parseJwtPayload(token?: string): Record<string, any> | null {
  if (!token) return null;
  try {
    const parts = token.split('.');
    if (parts.length !== 3) return null;
    const base64 = parts[1].replace(/-/g, '+').replace(/_/g, '/');
    const jsonStr = decodeURIComponent(
      atob(base64)
        .split('')
        .map((c) => '%' + ('00' + c.charCodeAt(0).toString(16)).slice(-2))
        .join(''),
    );
    return JSON.parse(jsonStr);
  } catch {
    return null;
  }
}

@Component({
  selector: 'app-example-application',
  standalone: true,
  imports: [CommonModule, FormsModule],
  templateUrl: './example-application.component.html',
  styleUrls: ['./example-application.component.scss'],
})
export class ExampleApplicationComponent implements OnInit {
  private readonly route = inject(ActivatedRoute);
  private readonly router = inject(Router);
  private readonly http = inject(HttpClient);
  public readonly sandboxService = inject(SandboxService);

  // Application State
  public readonly loading = signal<boolean>(false);
  public readonly currentStep = signal<string>('Initializing SMART on FHIR v2 session...');
  public readonly errorMessage = signal<string | null>(null);
  public readonly mode = signal<'launch' | 'callback' | 'standalone' | 'connected'>('standalone');

  // Standalone Launch Form
  public selectedSandboxId = signal<string>('');
  public customIssUrl = signal<string>('');
  public clientScope = signal<string>('openid profile email patient/*.rs patient/*.read launch launch/patient fhirUser');

  // Token and Auth Context
  public readonly tokenResponse = signal<SmartTokenResponse | null>(null);
  public readonly idTokenClaims = signal<Record<string, any> | null>(null);
  public readonly fhirBaseUrl = signal<string>('');

  // Clinical Resources
  public readonly patient = signal<PatientResource | null>(null);
  public readonly conditions = signal<ConditionResource[]>([]);
  public readonly observations = signal<ObservationResource[]>([]);
  public readonly medications = signal<MedicationRequestResource[]>([]);
  public readonly encounters = signal<EncounterResource[]>([]);

  // Active Tab
  public readonly activeTab = signal<'patient' | 'conditions' | 'observations' | 'medications' | 'encounters' | 'token'>(
    'patient',
  );

  // Computed Patient Display Info
  public readonly patientDisplayName = computed(() => {
    const p = this.patient();
    if (!p) return 'Unknown Patient';
    const nameObj = p.name?.[0];
    if (nameObj?.text) return nameObj.text;
    const given = nameObj?.given?.join(' ') || '';
    const family = nameObj?.family || '';
    const fullName = `${given} ${family}`.trim();
    return fullName || `Patient #${p.id || 'N/A'}`;
  });

  public readonly patientMrn = computed(() => {
    const p = this.patient();
    if (!p?.identifier) return 'N/A';
    const mrnObj = p.identifier.find((i) => i.type?.text?.toLowerCase().includes('mrn') || i.system?.includes('mrn'));
    return mrnObj?.value || p.identifier[0]?.value || 'N/A';
  });

  public readonly patientAge = computed(() => {
    const p = this.patient();
    if (!p?.birthDate) return null;
    const dob = new Date(p.birthDate);
    if (isNaN(dob.getTime())) return null;
    const diffMs = Date.now() - dob.getTime();
    const ageDt = new Date(diffMs);
    return Math.abs(ageDt.getUTCFullYear() - 1970);
  });

  ngOnInit(): void {
    // Load sandboxes list for standalone mode selector
    if (this.sandboxService.sandboxes().length === 0) {
      this.sandboxService.getSandboxes().subscribe({
        next: (res) => {
          if (res?.sandboxes?.length > 0 && !this.selectedSandboxId()) {
            this.selectedSandboxId.set(res.sandboxes[0].sandboxId);
          }
        },
      });
    } else {
      const first = this.sandboxService.sandboxes()[0];
      if (first && !this.selectedSandboxId()) {
        this.selectedSandboxId.set(first.sandboxId);
      }
    }

    const queryParams = this.route.snapshot.queryParams;
    const urlPath = this.route.snapshot.routeConfig?.path || '';

    if (
      urlPath === 'example-application/launch' ||
      (queryParams['iss'] && queryParams['launch'])
    ) {
      // 1. EHR Launch Flow
      this.handleEhrLaunch(queryParams['iss'], queryParams['launch']);
    } else if (queryParams['code'] && queryParams['state']) {
      // 2. OAuth Callback Flow
      this.handleOAuthCallback(queryParams['code'], queryParams['state']);
    } else if (queryParams['error']) {
      // OAuth Error
      this.mode.set('standalone');
      this.errorMessage.set(`OAuth Error: ${queryParams['error']} - ${queryParams['error_description'] || ''}`);
    } else {
      // 3. Standalone Mode Launcher
      this.mode.set('standalone');
    }
  }

  /** Step 1: EHR Launch - Discover SMART configuration, generate PKCE challenge, and redirect */
  public async handleEhrLaunch(iss?: string, launch?: string): Promise<void> {
    if (!iss) {
      this.mode.set('standalone');
      this.errorMessage.set('Missing "iss" parameter in EHR launch request.');
      return;
    }

    this.mode.set('launch');
    this.loading.set(true);
    this.currentStep.set('1. Querying /.well-known/smart-configuration from FHIR server...');

    try {
      const wellKnownUrl = `${iss.replace(/\/+$/, '')}/.well-known/smart-configuration`;
      const config: any = await this.http.get(wellKnownUrl).toPromise();

      if (!config?.authorization_endpoint || !config?.token_endpoint) {
        throw new Error('SMART configuration missing authorization_endpoint or token_endpoint.');
      }

      this.currentStep.set('2. Generating cryptographically secure PKCE S256 challenge...');
      const codeVerifier = generateRandomString(64);
      const codeChallenge = await generateCodeChallenge(codeVerifier);
      const state = generateRandomString(32);

      // Persist auth transaction in sessionStorage
      sessionStorage.setItem('smart_code_verifier', codeVerifier);
      sessionStorage.setItem('smart_auth_state', state);
      sessionStorage.setItem('smart_token_endpoint', config.token_endpoint);
      sessionStorage.setItem('smart_iss', iss);

      this.currentStep.set('3. Redirecting to SMART Authorization Server...');

      const redirectUri = `${window.location.origin}/example-application`;
      const authUrl = new URL(config.authorization_endpoint);
      authUrl.searchParams.set('response_type', 'code');
      authUrl.searchParams.set('client_id', 'example-application');
      authUrl.searchParams.set('redirect_uri', redirectUri);
      authUrl.searchParams.set('scope', this.clientScope());
      authUrl.searchParams.set('state', state);
      authUrl.searchParams.set('aud', iss);
      authUrl.searchParams.set('code_challenge', codeChallenge);
      authUrl.searchParams.set('code_challenge_method', 'S256');
      if (launch) {
        authUrl.searchParams.set('launch', launch);
      }

      // Redirect browser to authorization endpoint
      window.location.href = authUrl.toString();
    } catch (err: any) {
      this.loading.set(false);
      this.errorMessage.set(`EHR Launch failed: ${err?.message || err}`);
      this.mode.set('standalone');
    }
  }

  /** Step 2: Standalone Launch trigger */
  public async launchStandalone(): Promise<void> {
    let iss = this.customIssUrl().trim();
    if (!iss) {
      const sId = this.selectedSandboxId();
      if (!sId) {
        this.errorMessage.set('Please select or specify a sandbox FHIR endpoint.');
        return;
      }
      const active = this.sandboxService.sandboxes().find((s) => s.sandboxId === sId);
      const version = (active?.fhirVersion || 'R4').toLowerCase();
      iss = `${window.location.origin}/api/sandboxes/${sId}/fhir/${version}`;
    }

    this.loading.set(true);
    this.errorMessage.set(null);
    this.currentStep.set('Initiating Standalone SMART on FHIR v2 authorization...');

    try {
      const wellKnownUrl = `${iss.replace(/\/+$/, '')}/.well-known/smart-configuration`;
      const config: any = await this.http.get(wellKnownUrl).toPromise();

      if (!config?.authorization_endpoint || !config?.token_endpoint) {
        throw new Error('SMART configuration missing authorization_endpoint or token_endpoint.');
      }

      const codeVerifier = generateRandomString(64);
      const codeChallenge = await generateCodeChallenge(codeVerifier);
      const state = generateRandomString(32);

      sessionStorage.setItem('smart_code_verifier', codeVerifier);
      sessionStorage.setItem('smart_auth_state', state);
      sessionStorage.setItem('smart_token_endpoint', config.token_endpoint);
      sessionStorage.setItem('smart_iss', iss);

      const redirectUri = `${window.location.origin}/example-application`;
      const authUrl = new URL(config.authorization_endpoint);
      authUrl.searchParams.set('response_type', 'code');
      authUrl.searchParams.set('client_id', 'example-application');
      authUrl.searchParams.set('redirect_uri', redirectUri);
      authUrl.searchParams.set('scope', this.clientScope());
      authUrl.searchParams.set('state', state);
      authUrl.searchParams.set('aud', iss);
      authUrl.searchParams.set('code_challenge', codeChallenge);
      authUrl.searchParams.set('code_challenge_method', 'S256');

      window.location.href = authUrl.toString();
    } catch (err: any) {
      this.loading.set(false);
      this.errorMessage.set(`Standalone launch failed: ${err?.message || err}`);
    }
  }

  /** Step 3: OAuth Callback - Exchange authorization code for SMART token and query FHIR */
  public async handleOAuthCallback(code: string, state: string): Promise<void> {
    this.mode.set('callback');
    this.loading.set(true);
    this.currentStep.set('Validating OAuth state and exchanging authorization code for access token...');

    try {
      const expectedState = sessionStorage.getItem('smart_auth_state');
      const codeVerifier = sessionStorage.getItem('smart_code_verifier');
      const tokenEndpoint = sessionStorage.getItem('smart_token_endpoint');
      const iss = sessionStorage.getItem('smart_iss') || '';

      if (!tokenEndpoint) {
        throw new Error('Missing token endpoint in session storage.');
      }
      if (expectedState && expectedState !== state) {
        throw new Error('OAuth state mismatch (potential CSRF).');
      }

      const redirectUri = `${window.location.origin}/example-application`;
      const body = new URLSearchParams();
      body.set('grant_type', 'authorization_code');
      body.set('code', code);
      body.set('redirect_uri', redirectUri);
      body.set('client_id', 'example-application');
      if (codeVerifier) {
        body.set('code_verifier', codeVerifier);
      }

      const headers = new HttpHeaders({
        'Content-Type': 'application/x-www-form-urlencoded',
      });

      const tokenRes: any = await this.http.post(tokenEndpoint, body.toString(), { headers }).toPromise();
      this.tokenResponse.set(tokenRes);
      this.fhirBaseUrl.set(iss);

      if (tokenRes.id_token) {
        this.idTokenClaims.set(parseJwtPayload(tokenRes.id_token));
      }

      this.currentStep.set('Token exchange successful. Loading clinical FHIR resources...');
      await this.loadClinicalData(iss, tokenRes.access_token, tokenRes.patient, tokenRes.encounter);

      this.mode.set('connected');
      this.loading.set(false);
      // Clean query params from URL without page reload
      window.history.replaceState({}, document.title, window.location.pathname);
    } catch (err: any) {
      this.loading.set(false);
      this.mode.set('standalone');
      this.errorMessage.set(`Token exchange failed: ${err?.error?.error_description || err?.message || err}`);
    }
  }

  /** Step 4: Fetch Patient, Conditions, Observations, Medications, Encounters */
  private async loadClinicalData(
    fhirBase: string,
    accessToken: string,
    patientId?: string,
    encounterId?: string,
  ): Promise<void> {
    const headers = new HttpHeaders({
      Authorization: `Bearer ${accessToken}`,
      Accept: 'application/fhir+json',
    });

    const base = fhirBase.replace(/\/+$/, '');

    // 1. Fetch Patient
    if (patientId) {
      try {
        const p: any = await this.http.get(`${base}/Patient/${patientId}`, { headers }).toPromise();
        this.patient.set(p);
      } catch (err) {
        console.warn('Failed to load Patient:', err);
      }

      // 2. Fetch Conditions
      try {
        const condBundle: any = await this.http.get(`${base}/Condition?patient=${patientId}&_count=20`, { headers }).toPromise();
        const entries = condBundle?.entry?.map((e: any) => e.resource) || [];
        this.conditions.set(entries);
      } catch (err) {
        console.warn('Failed to load Conditions:', err);
      }

      // 3. Fetch Observations (Labs & Vitals)
      try {
        const obsBundle: any = await this.http.get(`${base}/Observation?patient=${patientId}&_count=20`, { headers }).toPromise();
        const entries = obsBundle?.entry?.map((e: any) => e.resource) || [];
        this.observations.set(entries);
      } catch (err) {
        console.warn('Failed to load Observations:', err);
      }

      // 4. Fetch MedicationRequests
      try {
        const medBundle: any = await this.http
          .get(`${base}/MedicationRequest?patient=${patientId}&_count=20`, { headers })
          .toPromise();
        const entries = medBundle?.entry?.map((e: any) => e.resource) || [];
        this.medications.set(entries);
      } catch (err) {
        console.warn('Failed to load Medications:', err);
      }

      // 5. Fetch Encounters
      try {
        const encBundle: any = await this.http.get(`${base}/Encounter?patient=${patientId}&_count=10`, { headers }).toPromise();
        const entries = encBundle?.entry?.map((e: any) => e.resource) || [];
        this.encounters.set(entries);
      } catch (err) {
        console.warn('Failed to load Encounters:', err);
      }
    } else {
      // Standalone launch without launch/patient scope - list all patients
      try {
        const patientsBundle: any = await this.http.get(`${base}/Patient?_count=1`, { headers }).toPromise();
        if (patientsBundle?.entry?.[0]?.resource) {
          this.patient.set(patientsBundle.entry[0].resource);
        }
      } catch (err) {
        console.warn('Failed to list patients:', err);
      }
    }
  }

  public disconnect(): void {
    sessionStorage.removeItem('smart_code_verifier');
    sessionStorage.removeItem('smart_auth_state');
    sessionStorage.removeItem('smart_token_endpoint');
    sessionStorage.removeItem('smart_iss');
    this.tokenResponse.set(null);
    this.idTokenClaims.set(null);
    this.patient.set(null);
    this.conditions.set([]);
    this.observations.set([]);
    this.medications.set([]);
    this.encounters.set([]);
    this.mode.set('standalone');
  }
}
