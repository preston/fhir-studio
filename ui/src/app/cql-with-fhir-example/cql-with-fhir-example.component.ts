// Author: Preston Lee

/**
 * CQL-with-FHIR example SMART app.
 * Fork-friendly starter for a future in-Studio SMART app builder:
 * - SMART v2 + PKCE launch
 * - Library discovery from global knowledge (DEFAULT via gateway)
 * - Library/$evaluate against the launch Patient (data/content/terminology Endpoints = sandbox)
 */

import { Component, OnInit, inject, signal, computed } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { ActivatedRoute, Router } from '@angular/router';
import { HttpClient, HttpHeaders } from '@angular/common/http';
import { firstValueFrom } from 'rxjs';
import { SandboxService } from '../core/services/sandbox.service.js';

const CLIENT_ID = 'cql-with-fhir-example';
const DEFAULT_SCOPE =
  'openid profile email patient/*.rs patient/*.read user/Library.rs launch launch/patient fhirUser';

interface SmartTokenResponse {
  access_token: string;
  patient?: string;
  scope?: string;
  [key: string]: unknown;
}

interface LibrarySummary {
  id: string;
  name?: string;
  title?: string;
  url?: string;
  version?: string;
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
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

async function generateCodeChallenge(verifier: string): Promise<string> {
  const digest = await window.crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier));
  return base64UrlEncode(digest);
}

@Component({
  selector: 'app-cql-with-fhir-example',
  standalone: true,
  imports: [CommonModule, FormsModule],
  templateUrl: './cql-with-fhir-example.component.html',
})
export class CqlWithFhirExampleComponent implements OnInit {
  private readonly route = inject(ActivatedRoute);
  private readonly router = inject(Router);
  private readonly http = inject(HttpClient);
  readonly sandboxService = inject(SandboxService);

  readonly loading = signal(false);
  readonly currentStep = signal('Initializing…');
  readonly errorMessage = signal<string | null>(null);
  readonly mode = signal<'launch' | 'callback' | 'standalone' | 'connected'>('standalone');

  selectedSandboxId = '';
  clientScope = DEFAULT_SCOPE;

  readonly tokenResponse = signal<SmartTokenResponse | null>(null);
  readonly fhirBaseUrl = signal('');
  readonly patientId = signal<string | null>(null);
  readonly patientDisplay = signal<string | null>(null);

  readonly libraries = signal<LibrarySummary[]>([]);
  readonly selectedLibraryId = signal<string>('');
  readonly evaluateResult = signal<unknown>(null);
  readonly libraryQuery = signal('');

  readonly preferredLibraryFromQuery = computed(() => {
    return (
      sessionStorage.getItem('cql_smart_preferred_library') ||
      this.route.snapshot.queryParamMap.get('library') ||
      this.route.snapshot.queryParamMap.get('canonical') ||
      ''
    );
  });

  ngOnInit(): void {
    const initialLibrary =
      this.route.snapshot.queryParamMap.get('library') ||
      this.route.snapshot.queryParamMap.get('canonical');
    if (initialLibrary) {
      sessionStorage.setItem('cql_smart_preferred_library', initialLibrary);
    }

    if (this.sandboxService.sandboxes().length === 0) {
      this.sandboxService.getSandboxes().subscribe({
        next: (res) => {
          if (res?.sandboxes?.length && !this.selectedSandboxId) {
            this.selectedSandboxId = res.sandboxes[0].sandboxId;
          }
        },
      });
    } else if (!this.selectedSandboxId) {
      this.selectedSandboxId = this.sandboxService.sandboxes()[0]?.sandboxId || '';
    }

    const queryParams = this.route.snapshot.queryParams;
    const urlPath = this.route.snapshot.routeConfig?.path || '';

    if (urlPath === 'cql-with-fhir-example/launch' || (queryParams['iss'] && queryParams['launch'])) {
      void this.handleEhrLaunch(queryParams['iss'], queryParams['launch']);
    } else if (queryParams['code'] && queryParams['state']) {
      void this.handleOAuthCallback(queryParams['code'], queryParams['state']);
    } else if (queryParams['error']) {
      this.mode.set('standalone');
      this.errorMessage.set(
        `OAuth Error: ${queryParams['error']} - ${queryParams['error_description'] || ''}`,
      );
    } else {
      this.mode.set('standalone');
    }
  }

  async handleEhrLaunch(iss?: string, launch?: string): Promise<void> {
    if (!iss) {
      this.mode.set('standalone');
      this.errorMessage.set('Missing "iss" parameter in EHR launch request.');
      return;
    }
    this.mode.set('launch');
    this.loading.set(true);
    this.currentStep.set('Discovering SMART configuration…');
    try {
      const wellKnownUrl = `${iss.replace(/\/+$/, '')}/.well-known/smart-configuration`;
      const config: any = await firstValueFrom(this.http.get(wellKnownUrl));
      const codeVerifier = generateRandomString(64);
      const codeChallenge = await generateCodeChallenge(codeVerifier);
      const state = generateRandomString(32);
      sessionStorage.setItem('cql_smart_code_verifier', codeVerifier);
      sessionStorage.setItem('cql_smart_auth_state', state);
      sessionStorage.setItem('cql_smart_token_endpoint', config.token_endpoint);
      sessionStorage.setItem('cql_smart_iss', iss);

      const redirectUri = `${window.location.origin}/cql-with-fhir-example`;
      const authUrl = new URL(config.authorization_endpoint);
      authUrl.searchParams.set('response_type', 'code');
      authUrl.searchParams.set('client_id', CLIENT_ID);
      authUrl.searchParams.set('redirect_uri', redirectUri);
      authUrl.searchParams.set('scope', this.clientScope);
      authUrl.searchParams.set('state', state);
      authUrl.searchParams.set('aud', iss);
      authUrl.searchParams.set('code_challenge', codeChallenge);
      authUrl.searchParams.set('code_challenge_method', 'S256');
      if (launch) authUrl.searchParams.set('launch', launch);
      window.location.href = authUrl.toString();
    } catch (err: any) {
      this.loading.set(false);
      this.errorMessage.set(`EHR Launch failed: ${err?.message || err}`);
      this.mode.set('standalone');
    }
  }

  async handleOAuthCallback(code: string, state: string): Promise<void> {
    this.mode.set('callback');
    this.loading.set(true);
    this.currentStep.set('Exchanging authorization code…');
    try {
      const expectedState = sessionStorage.getItem('cql_smart_auth_state');
      const codeVerifier = sessionStorage.getItem('cql_smart_code_verifier');
      const tokenEndpoint = sessionStorage.getItem('cql_smart_token_endpoint');
      const iss = sessionStorage.getItem('cql_smart_iss');
      if (!expectedState || state !== expectedState || !codeVerifier || !tokenEndpoint || !iss) {
        throw new Error('Invalid or missing OAuth session state.');
      }

      const body = new URLSearchParams({
        grant_type: 'authorization_code',
        code,
        redirect_uri: `${window.location.origin}/cql-with-fhir-example`,
        client_id: CLIENT_ID,
        code_verifier: codeVerifier,
      });
      const token = await firstValueFrom(
        this.http.post<SmartTokenResponse>(tokenEndpoint, body.toString(), {
          headers: new HttpHeaders({ 'Content-Type': 'application/x-www-form-urlencoded' }),
        }),
      );
      this.tokenResponse.set(token);
      this.fhirBaseUrl.set(iss.replace(/\/+$/, ''));
      this.patientId.set(token.patient || null);
      this.mode.set('connected');
      sessionStorage.removeItem('cql_smart_code_verifier');
      sessionStorage.removeItem('cql_smart_auth_state');
      sessionStorage.removeItem('cql_smart_token_endpoint');
      sessionStorage.removeItem('cql_smart_iss');
      await this.loadPatient();
      await this.searchLibraries();
      const preferred = this.preferredLibraryFromQuery();
      if (preferred) {
        const match = this.libraries().find(
          (l) => l.id === preferred || l.url === preferred || `${l.url}|${l.version}` === preferred,
        );
        if (match) this.selectedLibraryId.set(match.id);
        sessionStorage.removeItem('cql_smart_preferred_library');
      }
      void this.router.navigate(['/cql-with-fhir-example'], { replaceUrl: true });
    } catch (err: any) {
      sessionStorage.removeItem('cql_smart_code_verifier');
      sessionStorage.removeItem('cql_smart_auth_state');
      sessionStorage.removeItem('cql_smart_token_endpoint');
      sessionStorage.removeItem('cql_smart_iss');
      this.errorMessage.set(`Token exchange failed: ${err?.message || err}`);
      this.mode.set('standalone');
    } finally {
      this.loading.set(false);
    }
  }

  startStandalone(): void {
    const sandbox = this.sandboxService
      .sandboxes()
      .find((s) => s.sandboxId === this.selectedSandboxId || s.id === this.selectedSandboxId);
    if (!sandbox) {
      this.errorMessage.set('Select a sandbox first.');
      return;
    }
    const version = String(sandbox.fhirVersion || 'R4').toLowerCase();
    const iss = `${window.location.origin}/api/sandboxes/${sandbox.sandboxId}/fhir/${version}`;
    void this.handleEhrLaunch(iss);
  }

  private authHeaders(): HttpHeaders {
    const token = this.tokenResponse()?.access_token;
    return new HttpHeaders({
      Authorization: `Bearer ${token}`,
      Accept: 'application/fhir+json',
      'Content-Type': 'application/fhir+json',
    });
  }

  async loadPatient(): Promise<void> {
    const id = this.patientId();
    const base = this.fhirBaseUrl();
    if (!id || !base) return;
    try {
      const patient: any = await firstValueFrom(
        this.http.get(`${base}/Patient/${id}`, { headers: this.authHeaders() }),
      );
      const name = patient?.name?.[0];
      const display =
        name?.text ||
        `${name?.given?.join(' ') || ''} ${name?.family || ''}`.trim() ||
        `Patient/${id}`;
      this.patientDisplay.set(display);
    } catch {
      this.patientDisplay.set(`Patient/${id}`);
    }
  }

  async searchLibraries(): Promise<void> {
    const base = this.fhirBaseUrl();
    if (!base) return;
    this.loading.set(true);
    this.errorMessage.set(null);
    try {
      const params: Record<string, string> = { _count: '50', _sort: '-_lastUpdated' };
      const q = this.libraryQuery().trim();
      if (q) params['name:contains'] = q;
      const bundle: any = await firstValueFrom(
        this.http.get(`${base}/Library`, { headers: this.authHeaders(), params }),
      );
      const libs: LibrarySummary[] = (bundle?.entry || [])
        .map((e: any) => e.resource)
        .filter((r: any) => r?.resourceType === 'Library' && r.id)
        .map((r: any) => ({
          id: r.id,
          name: r.name,
          title: r.title,
          url: r.url,
          version: r.version,
        }));
      this.libraries.set(libs);
      if (!this.selectedLibraryId() && libs.length) {
        this.selectedLibraryId.set(libs[0].id);
      }
    } catch (err: any) {
      this.errorMessage.set(`Library search failed: ${err?.error?.issue?.[0]?.diagnostics || err?.message || err}`);
    } finally {
      this.loading.set(false);
    }
  }

  async evaluateSelected(): Promise<void> {
    const base = this.fhirBaseUrl();
    const libraryId = this.selectedLibraryId();
    const patient = this.patientId();
    if (!base || !libraryId) {
      this.errorMessage.set('Select a Library to evaluate.');
      return;
    }
    this.loading.set(true);
    this.errorMessage.set(null);
    this.evaluateResult.set(null);
    try {
      // Library/$evaluate runs on DEFAULT (knowledge); pass sandbox Endpoint params so
      // Patient data / nested content resolve against this launch FHIR base.
      const endpointResource = {
        resourceType: 'Endpoint',
        status: 'active',
        connectionType: {
          system: 'http://terminology.hl7.org/CodeSystem/endpoint-connection-type',
          code: 'hl7-fhir-rest',
        },
        address: base,
        payloadType: [{ coding: [{ code: 'any' }] }],
        header: [
          `Authorization: Bearer ${this.tokenResponse()?.access_token || ''}`,
          'Accept: application/fhir+json',
        ],
      };
      const parameters: Record<string, unknown> = {
        resourceType: 'Parameters',
        parameter: [
          ...(patient
            ? [{ name: 'subject', valueString: patient.startsWith('Patient/') ? patient : `Patient/${patient}` }]
            : []),
          { name: 'dataEndpoint', resource: endpointResource },
          { name: 'contentEndpoint', resource: endpointResource },
          { name: 'terminologyEndpoint', resource: endpointResource },
        ],
      };
      const result = await firstValueFrom(
        this.http.post(`${base}/Library/${libraryId}/$evaluate`, parameters, {
          headers: this.authHeaders(),
        }),
      );
      this.evaluateResult.set(result);
    } catch (err: any) {
      this.errorMessage.set(
        `$evaluate failed: ${err?.error?.issue?.[0]?.diagnostics || err?.message || JSON.stringify(err?.error) || err}`,
      );
    } finally {
      this.loading.set(false);
    }
  }
}
