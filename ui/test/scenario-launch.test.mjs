// Author: Preston Lee

import assert from 'node:assert/strict';
import { after, afterEach, test } from 'node:test';
import { mkdtemp, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { build } from 'esbuild';
import '@angular/compiler';
import { DOCUMENT } from '@angular/common';
import { signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { BrowserTestingModule, platformBrowserTesting } from '@angular/platform-browser/testing';
import { ActivatedRoute, Router, convertToParamMap } from '@angular/router';
import { DomSanitizer } from '@angular/platform-browser';
import { BehaviorSubject, of, Subject } from 'rxjs';

// Compile the real components for Node while retaining Angular's injection and effect behavior.
const directory = await mkdtemp(join(tmpdir(), 'fhir-studio-scenario-test-'));
after(() => rm(directory, { recursive: true, force: true }));
await symlink(fileURLToPath(new URL('../../node_modules', import.meta.url)), join(directory, 'node_modules'));
const bundle = join(directory, 'components.mjs');
await build({
  stdin: {
    contents: `
      export { EhrSimulatorComponent } from './ehr-simulator/ehr-simulator.component.ts';
      export { ScenariosManagerComponent } from './scenarios/scenarios-manager.component.ts';
      export { HostedApplicationsComponent } from './applications/hosted-applications.component.ts';
      export { HostingService } from './core/services/hosting.service.ts';
      export { AuthService } from './core/services/auth.service.ts';
      export { SandboxService } from './core/services/sandbox.service.ts';
      export { ApplicationsService } from './core/services/applications.service.ts';
      export { PersonasService } from './core/services/personas.service.ts';
      export { ScenariosService } from './core/services/scenarios.service.ts';
      export { FhirService } from './core/services/fhir.service.ts';
      export { CdsHooksService } from './core/services/cds-hooks.service.ts';
      export { ToastService } from './core/services/toast.service.ts';
    `,
    resolveDir: fileURLToPath(new URL('../src/app', import.meta.url)),
    loader: 'ts',
  },
  tsconfig: fileURLToPath(new URL('../tsconfig.json', import.meta.url)),
  outfile: bundle,
  bundle: true,
  format: 'esm',
  platform: 'node',
  packages: 'external',
});
const components = await import(pathToFileURL(bundle).href);
TestBed.initTestEnvironment(BrowserTestingModule, platformBrowserTesting());
const originalWindow = globalThis.window;
afterEach(() => {
  TestBed.resetTestingModule();
  if (originalWindow === undefined) delete globalThis.window;
  else globalThis.window = originalWindow;
});

const sandbox = { sandboxId: 'launch-test', fhirVersion: 'R4B' };
const browserOrigin = 'http://localhost:4200';
const launchContext = {
  launch: 'launch-token',
  iss: 'https://localhost/api/sandboxes/launch-test/fhir/r4b',
  sandboxId: sandbox.sandboxId,
  expiresIn: 900,
};
const applications = [
  { id: 'default-app', clientId: 'default-client', scope: 'launch patient/*.rs', launchUri: '/default/launch' },
  { id: 'saved-app', clientId: 'saved-client', scope: 'launch patient/Observation.rs', launchUri: '/saved/launch?theme=dark' },
];
const personas = [{ id: 'default-persona' }, { id: 'saved-persona', personaName: 'Saved Practitioner' }];
const scenario = {
  id: 'saved-scenario', title: 'Saved scenario', applicationId: 'saved-app', userPersonaId: 'saved-persona',
  patientFhirId: 'saved-patient', patientName: 'Saved Patient', encounterFhirId: 'saved-encounter', locationFhirId: 'saved-location',
};

function setup(Component, options = {}) {
  const errors = [];
  const launches = [];
  const windows = [];
  const navigations = [];
  const fhirRequests = [];
  const hostingRequests = [];
  const activeSandbox = signal(sandbox);
  const queryParams = new BehaviorSubject(convertToParamMap({ sandbox: sandbox.sandboxId, scenario: scenario.id }));
  globalThis.window = {
    location: { origin: browserOrigin },
    open: (...args) => {
      if (options.blockPopup) return null;
      const popup = { args, opener: {}, closed: false, url: null };
      popup.location = { replace: (url) => { popup.url = url; } };
      popup.close = () => { popup.closed = true; };
      windows.push(popup);
      return popup;
    },
  };
  TestBed.configureTestingModule({ providers: [
    { provide: DOCUMENT, useValue: { querySelectorAll: () => [] } },
    { provide: ActivatedRoute, useValue: { snapshot: { queryParamMap: queryParams.value }, queryParamMap: queryParams } },
    { provide: Router, useValue: { navigate: (...args) => { navigations.push(args); return Promise.resolve(true); } } },
    { provide: DomSanitizer, useValue: { bypassSecurityTrustResourceUrl: (url) => url } },
    { provide: components.SandboxService, useValue: { activeSandbox, sandboxes: signal([sandbox]) } },
    { provide: components.AuthService, useValue: {} },
    { provide: components.HostingService, useValue: {
      post: async (path, data) => {
        hostingRequests.push({ path, data });
        return launchContext;
      },
    } },
    { provide: components.ApplicationsService, useValue: { getSandboxApplications: () => options.applications || of({ applications }) } },
    { provide: components.PersonasService, useValue: { getPersonas: () => options.personas || of({ personas }) } },
    { provide: components.ScenariosService, useValue: {
      getScenarios: () => options.scenarios || of({ scenarios: [scenario] }),
      createLaunchContext: (sandboxId, data) => {
        const response = new Subject();
        launches.push({ sandboxId, data, response });
        return response;
      },
    } },
    { provide: components.CdsHooksService, useValue: { getEndpoints: () => of({ endpoints: [] }) } },
    { provide: components.FhirService, useValue: {
      search: (_sandboxId, _version, type) => {
        const response = new Subject();
        fhirRequests.push({ type, response });
        return response;
      },
    } },
    { provide: components.ToastService, useValue: { error: (message) => errors.push(message) } },
  ] });
  const component = TestBed.runInInjectionContext(() => new Component());
  TestBed.tick();
  return { component, launches, windows, errors, navigations, fhirRequests, hostingRequests, activeSandbox, queryParams };
}

function reply(subject, value) {
  subject.next(value);
  subject.complete();
}

function assertSavedLaunch(launch) {
  assert.equal(launch.sandboxId, sandbox.sandboxId);
  assert.deepEqual(launch.data, {
    applicationId: 'saved-app', clientId: 'saved-client', scope: applications[1].scope,
    userPersonaId: 'saved-persona', patientFhirId: 'saved-patient', patientName: 'Saved Patient',
    encounterFhirId: 'saved-encounter', locationFhirId: 'saved-location',
    fhirContext: [
      { type: 'Patient', reference: 'Patient/saved-patient' },
      { type: 'Encounter', reference: 'Encounter/saved-encounter' },
      { type: 'Location', reference: 'Location/saved-location' },
    ],
  });
}

function assertLaunchUrl(value) {
  const url = new URL(value);
  assert.equal(url.origin + url.pathname, `${browserOrigin}/saved/launch`);
  assert.equal(url.searchParams.get('theme'), 'dark');
  assert.equal(url.searchParams.get('iss'), launchContext.iss);
  assert.equal(url.searchParams.get('launch'), 'launch-token');
}

test('Execute in EHR includes the chosen scenario and sandbox in navigation', () => {
  const state = setup(components.ScenariosManagerComponent);
  state.component.runScenario(scenario);
  assert.deepEqual(state.navigations, [[['/ehr-simulator'], { queryParams: { sandbox: sandbox.sandboxId, scenario: scenario.id } }]]);
});

test('EHR waits for scenario, application, and persona lookups before launching the saved context once', () => {
  const appResponse = new Subject();
  const personaResponse = new Subject();
  const scenarioResponse = new Subject();
  const state = setup(components.EhrSimulatorComponent, { applications: appResponse, personas: personaResponse, scenarios: scenarioResponse });
  reply(appResponse, { applications });
  reply(scenarioResponse, { scenarios: [scenario] });
  assert.equal(state.launches.length, 0);
  reply(personaResponse, { personas });
  assert.equal(state.launches.length, 1);
  assertSavedLaunch(state.launches[0]);

  // Saved resources need not be in the first page of the FHIR search results.
  for (const type of ['Patient', 'Encounter', 'Location']) {
    reply(state.fhirRequests.find((request) => request.type === type).response, { entry: [{ resource: { id: 'unrelated-first-result' } }] });
  }
  assert.equal(state.component.selectedPatient().id, scenario.patientFhirId);
  assert.equal(state.component.selectedEncounter().id, scenario.encounterFhirId);
  assert.equal(state.component.selectedLocation().id, scenario.locationFhirId);
  assert.equal(state.launches.length, 1);
  reply(state.launches[0].response, launchContext);
  assertLaunchUrl(state.component.rawLaunchUrl());
  assert.equal(state.component.iframeSrc(), state.component.rawLaunchUrl());
  assert.equal(state.component.launching(), false);
  assert.equal(state.component.simulatedIdTokenPayload().iss, 'https://localhost');
  assert.ok(state.component.simulatedTimelineEvents()[1].detail.includes(launchContext.iss));
  assert.deepEqual(state.errors, []);
});

test('FHIR results enrich matching saved selections without choosing the first result', () => {
  const state = setup(components.EhrSimulatorComponent);
  reply(state.fhirRequests.find((request) => request.type === 'Patient').response, { entry: [
    { resource: { id: 'another-patient' } },
    { resource: { id: scenario.patientFhirId, name: [{ given: ['Updated'], family: 'Patient' }] } },
  ] });
  assert.equal(state.component.selectedPatient().name, 'Updated Patient');
  assert.equal(state.component.selectedPatient().id, scenario.patientFhirId);
  assert.equal(state.launches.length, 1);
});

test('default application and persona resolve while empty clinical context stays empty', () => {
  const emptyScenario = { ...scenario, applicationId: null, userPersonaId: null, patientFhirId: null, patientName: null, encounterFhirId: null, locationFhirId: null };
  const state = setup(components.EhrSimulatorComponent, { scenarios: of({ scenarios: [emptyScenario] }) });
  assert.equal(state.launches[0].data.applicationId, applications[0].id);
  assert.equal(state.launches[0].data.userPersonaId, personas[0].id);
  assert.equal(state.launches[0].data.patientFhirId, '');
  assert.equal(state.launches[0].data.encounterFhirId, '');
  assert.deepEqual(state.launches[0].data.fhirContext, []);
});

for (const [label, options] of [
  ['missing scenario', { scenarios: of({ scenarios: [] }) }],
  ['unavailable named application', { applications: of({ applications: applications.slice(0, 1) }) }],
  ['unavailable named persona', { personas: of({ personas: personas.slice(0, 1) }) }],
]) test(`EHR reports ${label} without launching a different target`, () => {
  const state = setup(components.EhrSimulatorComponent, options);
  assert.equal(state.launches.length, 0);
  assert.equal(state.component.launching(), false);
  assert.match(state.errors[0], /unavailable/);
});

test('a late launch response from the previous sandbox cannot populate the current EHR', () => {
  const state = setup(components.EhrSimulatorComponent);
  assert.equal(state.launches.length, 1);
  state.activeSandbox.set({ ...sandbox, sandboxId: 'other-sandbox' });
  TestBed.tick();
  reply(state.launches[0].response, { ...launchContext, launch: 'old-token' });
  assert.equal(state.component.rawLaunchUrl(), null);
  assert.equal(state.launches.length, 1);
});

test('standalone opens a tab during the click, mints the saved context, and navigates after success', () => {
  const state = setup(components.ScenariosManagerComponent);
  state.component.launchStandalone(scenario);
  assert.equal(state.windows.length, 1);
  assert.deepEqual(state.windows[0].args, ['about:blank', '_blank']);
  assert.equal(state.windows[0].opener, null);
  assert.equal(state.windows[0].url, null);
  assert.equal(state.component.launchingScenarioId(), scenario.id);
  assertSavedLaunch(state.launches[0]);
  state.component.launchStandalone(scenario);
  assert.equal(state.windows.length, 1);
  assert.equal(state.launches.length, 1);
  reply(state.launches[0].response, launchContext);
  assertLaunchUrl(state.windows[0].url);
  assert.equal(state.component.launchingScenarioId(), null);
  assert.deepEqual(state.navigations, []);
});

test('standalone reports a blocked popup without creating a launch context', () => {
  const state = setup(components.ScenariosManagerComponent, { blockPopup: true });
  state.component.launchStandalone(scenario);
  assert.equal(state.launches.length, 0);
  assert.match(state.errors[0], /Allow pop-ups/);
  assert.equal(state.component.launchingScenarioId(), null);
});

test('standalone closes the blank tab and permits retry after launch API failure', () => {
  const state = setup(components.ScenariosManagerComponent);
  state.component.launchStandalone(scenario);
  state.launches[0].response.error({ error: { error: 'Launch denied' } });
  assert.equal(state.windows[0].closed, true);
  assert.deepEqual(state.errors, ['Launch denied']);
  assert.equal(state.component.launchingScenarioId(), null);
  state.component.launchStandalone(scenario);
  assert.equal(state.launches.length, 2);
});

test('standalone does not substitute a default application when the saved application is unavailable', () => {
  const state = setup(components.ScenariosManagerComponent, { applications: of({ applications: applications.slice(0, 1) }) });
  state.component.launchStandalone(scenario);
  assert.equal(state.launches.length, 0);
  assert.equal(state.windows[0].closed, true);
  assert.match(state.errors[0], /application is unavailable/);
  assert.equal(state.component.launchingScenarioId(), null);
});

test('GitHub Repositories uses the canonical launch issuer when opened on the UI development origin', async () => {
  const state = setup(components.HostedApplicationsComponent);
  state.component.app.set({
    id: 'hosted-app', publishedBuildId: 'published-build',
    publishedUrl: 'https://app-hosted.user.localhost/index.html?theme=dark',
    scope: 'launch patient/*.rs',
    builds: [{ id: 'published-build', scope: 'launch launch/patient patient/Observation.rs' }],
  });
  state.component.test = {
    sandbox: sandbox.sandboxId, patient: 'saved-patient', encounter: 'saved-encounter', persona: 'saved-persona',
  };

  await state.component.launch();

  assert.deepEqual(state.hostingRequests, [{
    path: `/api/sandboxes/${sandbox.sandboxId}/launch-context`,
    data: {
      clientId: 'hosted-hosted-app-published', scope: 'launch launch/patient patient/Observation.rs',
      patientFhirId: 'saved-patient', encounterFhirId: 'saved-encounter', userPersonaId: 'saved-persona',
    },
  }]);
  const url = new URL(state.component.launchSrc());
  assert.equal(url.origin + url.pathname, 'https://app-hosted.user.localhost/index.html');
  assert.equal(url.searchParams.get('theme'), 'dark');
  assert.equal(url.searchParams.get('iss'), launchContext.iss);
  assert.equal(url.searchParams.get('launch'), launchContext.launch);
  assert.equal(state.component.error(), '');
});
