import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import { IncomingMessage, ServerResponse } from 'node:http';
import { Socket } from 'node:net';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import express, { type NextFunction, type Request, type Response } from 'express';
import type { FhirRelease } from '@fhir-studio/core';
import type { Prisma } from '@prisma/client';
import { getPrisma, disconnectPrisma } from '../src/db/prisma.js';
import { HostingError } from '../src/hosted/access.js';
import { createSmartIdpRouter } from '../src/smart-idp/routes.js';
import { isRegisteredRedirectUri } from '../src/smart-idp/redirect-uris.js';

const root = await mkdtemp(join(tmpdir(), 'fhir-studio-smart-launch-'));
Object.assign(process.env, {
  NODE_ENV: 'test',
  FHIR_STUDIO_SERVER_DATABASE_URL: 'postgresql://test:test@127.0.0.1:1/test',
  FHIR_STUDIO_SERVER_UI_BASE_URL: 'http://localhost:4200',
  FHIR_STUDIO_HOSTING_ENABLED: 'true',
  FHIR_STUDIO_HOSTING_DOMAIN: 'user.localhost',
  FHIR_STUDIO_HOSTING_ROOT: root,
  FHIR_STUDIO_HOSTING_STUDIO_ORIGIN: 'https://localhost',
  FHIR_STUDIO_HOSTING_ANALYTICS_KEY: Buffer.alloc(32, 1).toString('base64'),
  FHIR_STUDIO_HOSTING_ENCRYPTION_KEY: Buffer.alloc(32, 2).toString('base64'),
  FHIR_STUDIO_HOSTING_GITHUB_APP_ID: '',
  FHIR_STUDIO_HAPI_R4_ENABLED: 'true',
  FHIR_STUDIO_HAPI_R4_BASE_URL: 'https://hapi.example.test/r4',
  FHIR_STUDIO_HAPI_R4B_ENABLED: 'true',
  FHIR_STUDIO_HAPI_R4B_BASE_URL: 'https://hapi.example.test/r4b',
  FHIR_STUDIO_HAPI_R5_ENABLED: 'true',
  FHIR_STUDIO_HAPI_R5_BASE_URL: 'https://hapi.example.test/r5',
});

const db = getPrisma();
const sandbox = {
  id: 'sandbox-row', sandboxId: 'launch-test', fhirVersion: 'R4' as FhirRelease,
  createdByUserId: 'owner', collaborators: [],
};
const clientId = 'hosted-test-published';
const scope = 'launch launch/patient patient/*.rs';
const sessions: Prisma.SmartAuthSessionUncheckedCreateInput[] = [];
Object.assign(db.sandbox, { findUnique: async () => sandbox });
Object.assign(db.application, { findUnique: async () => ({
  clientId, scope, hostedChannel: 'published',
  hostedApplication: { id: 'hosted-test', publishedBuildId: 'published-build' },
}) });
Object.assign(db.hostedSandbox, { findUnique: async () => ({ applicationId: 'hosted-test', sandboxId: sandbox.id }) });
Object.assign(db.smartAuthSession, { create: async ({ data }: { data: Prisma.SmartAuthSessionUncheckedCreateInput }) => {
  sessions.push(data);
  return data;
} });

after(async () => {
  await disconnectPrisma();
  await rm(root, { recursive: true, force: true });
});

async function request(method: string, url: string, body?: unknown) {
  const app = express();
  app.use(createSmartIdpRouter());
  app.use((error: Error, _req: Request, res: Response, _next: NextFunction) =>
    res.status(error instanceof HostingError ? error.status : 500).json({ error: error.message }));
  const req = new IncomingMessage(new Socket()) as Request;
  req.method = method;
  req.url = url;
  req.body = body;
  // Neither the development UI nor proxy-supplied hosts define the FHIR issuer.
  req.headers = {
    host: 'localhost:3000', origin: 'http://localhost:4200',
    'x-forwarded-host': 'untrusted.example', 'x-forwarded-proto': 'http',
  };
  req.sessionAuth = {
    userId: 'owner', sessionId: 'browser', sub: 'owner', ssoRoles: [],
    email: null, displayName: null, isSuspended: false,
  };
  return new Promise<{ status: number; body: Record<string, unknown>; text: string; location: string }>((resolve, reject) => {
    const res = new ServerResponse(req);
    Object.assign(res, { end(chunk?: string | Buffer) {
      const text = String(chunk);
      let body: Record<string, unknown> = {};
      try { body = JSON.parse(text) as Record<string, unknown>; } catch { /* OAuth redirects and errors use HTML/text. */ }
      resolve({ status: res.statusCode, body, text, location: String(res.getHeader('location') ?? '') });
      return res;
    } });
    app.handle(req, res, reject);
  });
}

function launch() {
  return request('POST', `/api/sandboxes/${sandbox.sandboxId}/launch-context`, {
    clientId, scope, patientFhirId: 'patient-1',
  });
}

test('hosted launches return the configured canonical issuer for every FHIR release', async () => {
  for (const version of ['R4', 'R4B', 'R5'] as const) {
    sandbox.fhirVersion = version;
    const response = await launch();
    assert.equal(response.status, 201);
    assert.equal(response.body.iss, `https://localhost/api/sandboxes/launch-test/fhir/${version.toLowerCase()}`);
    assert.equal(response.body.sandboxId, sandbox.sandboxId);
    assert.equal(response.body.expiresIn, 900);
    const session = sessions.at(-1)!;
    assert.equal(response.body.launch, session.launchId);
    assert.equal(session.sandboxRowId, sandbox.id);
    assert.equal(session.clientId, clientId);
    assert.equal(session.patientFhirId, 'patient-1');
  }
});

test('launches use the configured UI origin when hosting is disabled', async () => {
  process.env.FHIR_STUDIO_HOSTING_ENABLED = 'false';
  sandbox.fhirVersion = 'R4';
  const response = await launch();
  assert.equal(response.status, 201);
  assert.equal(response.body.iss, 'http://localhost:4200/api/sandboxes/launch-test/fhir/r4');
});

test('relative callbacks match only configured UI origins and exact registered paths', t => {
  const saved = { ...process.env };
  t.after(() => { process.env = saved; });
  process.env.NODE_ENV = 'development';
  process.env.FHIR_STUDIO_SERVER_CORS_ORIGINS = 'https://localhost, http://localhost:4200';
  const matches = (uri: string, registrations: unknown = ['/example-application']) =>
    isRegisteredRedirectUri(uri, registrations, 'https://localhost', 'https://localhost');

  assert.ok(matches('https://localhost/example-application'));
  assert.ok(matches('http://localhost:4200/example-application'));
  for (const uri of [
    'https://attacker.example/example-application',
    'https://app-example.user.localhost/example-application',
    'http://localhost:4300/example-application',
    'http://localhost:4200/example-application/extra',
    'http://localhost:4200/example-application/',
    'http://localhost:4200/example-application?next=https://attacker.example',
  ]) assert.equal(matches(uri), false, uri);

  const absolute = ['https://localhost/example-application'];
  assert.ok(matches(absolute[0], absolute));
  assert.equal(matches('http://localhost:4200/example-application', absolute), false);
  assert.ok(matches('https://external.example/callback', ['https://external.example/callback']));
  assert.equal(matches('https://external.example/callback/extra', ['https://external.example/callback']), false);
  assert.ok(matches('https://external.example/callback', ['//external.example/callback']));
  assert.equal(matches('http://external.example/callback', ['//external.example/callback']), false);
  assert.equal(matches('http://external.example/callback', ['/\\external.example/callback']), false);
  assert.equal(matches('https://localhost/example-application', null), false);
  assert.equal(matches('https://localhost/example-application', [null, 5, 'http://[invalid']), false);
  assert.ok(matches('https://localhost/example-application', ['http://[invalid', '/example-application']));

  // CORS entries must be exact HTTP(S) origins, never patterns or URLs with paths/credentials.
  process.env.FHIR_STUDIO_SERVER_CORS_ORIGINS = '*, https://*.example, https://dev.example/path, https://user:password@dev.example';
  assert.equal(matches('https://dev.example/example-application'), false);
  delete process.env.FHIR_STUDIO_SERVER_CORS_ORIGINS;
  assert.equal(matches('http://localhost:4200/example-application'), false);

  process.env.FHIR_STUDIO_SERVER_CORS_ORIGINS = 'http://localhost:4200';
  process.env.NODE_ENV = 'production';
  assert.equal(matches('http://localhost:4200/example-application'), false);
  assert.ok(matches('https://localhost/example-application'));
});

test('both built-in EHR applications authorize on canonical and configured development UI origins', async t => {
  const saved = { ...process.env };
  t.after(() => { process.env = saved; });
  Object.assign(process.env, {
    NODE_ENV: 'development',
    FHIR_STUDIO_HOSTING_ENABLED: 'true',
    FHIR_STUDIO_SERVER_UI_BASE_URL: 'https://localhost',
    FHIR_STUDIO_SERVER_CORS_ORIGINS: 'https://localhost,http://localhost:4200',
  });
  const registered = [
    { clientId: 'example-application', redirectUris: ['/example-application', '/example-application/launch'] },
    { clientId: 'cql-with-fhir-example', redirectUris: ['/example-cql-with-fhir', '/example-cql-with-fhir/launch'] },
  ];
  const originalFindUnique = db.application.findUnique;
  const originalFindFirst = db.smartAuthSession.findFirst;
  const originalUpdateMany = db.smartAuthSession.updateMany;
  t.after(() => {
    Object.assign(db.application, { findUnique: originalFindUnique });
    Object.assign(db.smartAuthSession, { findFirst: originalFindFirst, updateMany: originalUpdateMany });
  });
  Object.assign(db.application, { findUnique: async ({ where }: { where: { clientId: string } }) => ({
    ...registered.find(app => app.clientId === where.clientId), scope, hostedApplication: null,
  }) });
  const session = {
    id: 'example-launch', sandboxRowId: sandbox.id, sandboxId: sandbox.sandboxId,
    clientId: '', scope, code: null, accessToken: null, isRevoked: false,
    codeExpiresAt: new Date(Date.now() + 60_000),
  };
  Object.assign(db.smartAuthSession, { findFirst: async () => session });
  let boundRedirect: string | undefined;
  Object.assign(db.smartAuthSession, { updateMany: async ({ data }: { data: { redirectUri: string } }) => {
    boundRedirect = data.redirectUri;
    return { count: 1 };
  } });

  for (const application of registered) {
    session.clientId = application.clientId;
    for (const origin of ['https://localhost', 'http://localhost:4200']) {
      const redirectUri = `${origin}${application.redirectUris[0]}`;
      const params = new URLSearchParams({
        response_type: 'code', client_id: application.clientId, redirect_uri: redirectUri,
        scope, launch: 'example-launch-token', state: 'example-state',
        code_challenge: 'a'.repeat(43), code_challenge_method: 'S256',
        aud: `https://localhost/api/sandboxes/${sandbox.sandboxId}/fhir/r4`,
      });
      const response = await request('GET', `/oauth/authorize?${params}`);
      assert.equal(response.status, 302, response.text);
      const callback = new URL(response.location);
      assert.equal(callback.origin + callback.pathname, redirectUri);
      assert.equal(callback.searchParams.get('state'), 'example-state');
      assert.ok(callback.searchParams.get('code'));
      assert.equal(boundRedirect, redirectUri);
    }
  }
});
