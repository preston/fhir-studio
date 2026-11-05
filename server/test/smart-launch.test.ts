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

async function launch() {
  const app = express();
  app.use(createSmartIdpRouter());
  app.use((error: Error, _req: Request, res: Response, _next: NextFunction) =>
    res.status(error instanceof HostingError ? error.status : 500).json({ error: error.message }));
  const req = new IncomingMessage(new Socket()) as Request;
  req.method = 'POST';
  req.url = `/api/sandboxes/${sandbox.sandboxId}/launch-context`;
  req.body = { clientId, scope, patientFhirId: 'patient-1' };
  // Neither the development UI nor proxy-supplied hosts define the FHIR issuer.
  req.headers = {
    host: 'localhost:3000', origin: 'http://localhost:4200',
    'x-forwarded-host': 'untrusted.example', 'x-forwarded-proto': 'http',
  };
  req.sessionAuth = {
    userId: 'owner', sessionId: 'browser', sub: 'owner', ssoRoles: [],
    email: null, displayName: null, isSuspended: false,
  };
  return new Promise<{ status: number; body: Record<string, unknown> }>((resolve, reject) => {
    const res = new ServerResponse(req);
    Object.assign(res, { end(chunk?: string | Buffer) {
      resolve({ status: res.statusCode, body: JSON.parse(String(chunk)) as Record<string, unknown> });
      return res;
    } });
    app.handle(req, res, reject);
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
