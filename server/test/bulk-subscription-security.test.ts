import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { once } from 'node:events';
import type { AddressInfo } from 'node:net';
import { after, before, test, type TestContext } from 'node:test';
import express from 'express';
import axios from 'axios';
import https from 'node:https';
import type { BulkExportJob } from '@prisma/client';
import type { Server } from 'node:http';
import { WebSocket } from 'ws';
import type { OidcBffConfig } from '../src/auth/sso_config.js';
import { hmacSign } from '../src/authentication/hmac.js';
import { SESSION_COOKIE } from '../src/authentication/session.js';
import { createBulkExportRouter } from '../src/bulk-export/routes.js';
import { createSubscriptionsRouter } from '../src/subscriptions/routes.js';
import { SubscriptionHub } from '../src/subscriptions/hub.js';
import { hostingErrorHandler } from '../src/hosted/routes.js';
import { getPrisma, disconnectPrisma } from '../src/db/prisma.js';

const savedEnv = { ...process.env };
let server: Server;
let origin: string;
const sandboxIds = { alpha: crypto.randomUUID(), beta: crypto.randomUUID() };

before(async () => {
  Object.assign(process.env, {
    FHIR_STUDIO_SERVER_DATABASE_URL: 'postgresql://unused:unused@127.0.0.1:1/unused',
    FHIR_STUDIO_HAPI_R4_ENABLED: 'true',
    FHIR_STUDIO_HAPI_R4_BASE_URL: 'http://unused.invalid/fhir',
    FHIR_STUDIO_HAPI_R4B_ENABLED: 'false',
    FHIR_STUDIO_HAPI_R5_ENABLED: 'false',
  });
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    const userId = req.get('x-test-user');
    if (userId) req.sessionAuth = {
      sub: userId, ssoRoles: [], userId, sessionId: 'test-session',
      email: null, displayName: null, isSuspended: false,
    };
    next();
  });
  app.use(createBulkExportRouter());
  app.use(createSubscriptionsRouter());
  app.use(hostingErrorHandler);
  server = app.listen(0, '127.0.0.1');
  await once(server, 'listening');
  origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

after(async () => {
  if (server) await new Promise<void>((resolve) => server.close(() => resolve()));
  await disconnectPrisma();
  for (const name of Object.keys(process.env)) if (!(name in savedEnv)) delete process.env[name];
  Object.assign(process.env, savedEnv);
});

function mockSandboxes(t: TestContext) {
  mockDelegate(t, getPrisma().sandbox, 'findUnique', async ({ where }: { where: { sandboxId: 'alpha' | 'beta' } }) => {
    const slug = where.sandboxId;
    if (!sandboxIds[slug]) return null;
    return {
      id: sandboxIds[slug], sandboxId: slug, fhirVersion: 'R4',
      createdByUserId: slug === 'alpha' ? 'alice' : 'bob', allowOpenAccess: false,
      collaborators: [{ userId: 'reader', role: 'READ_ONLY' }],
    };
  });
}

function mockDelegate(t: TestContext, target: object, name: string, implementation: unknown): void {
  const delegate = target as Record<string, unknown>;
  const original = delegate[name];
  delegate[name] = implementation;
  t.after(() => { delegate[name] = original; });
}

test('bulk status, cancellation and cached files enforce authentication, sandbox scope and expiry', async (t) => {
  mockSandboxes(t);
  const db = getPrisma();
  const jobs = new Map<string, BulkExportJob>();
  t.mock.method(axios, 'get', async () => ({ data: { entry: [{ resource: { resourceType: 'Patient', id: 'private-patient' } }] } }));
  mockDelegate(t, db.bulkExportJob, 'create', async ({ data }: { data: BulkExportJob }) => {
    const job = { ...data, transactionTime: new Date(), outputFiles: [], createdAt: new Date(), updatedAt: new Date(), error: null };
    jobs.set(job.id, job);
    return job;
  });
  mockDelegate(t, db.bulkExportJob, 'update', async ({ where, data }: { where: { id: string }; data: Partial<BulkExportJob> }) => {
    const job = jobs.get(where.id)!;
    Object.assign(job, data);
    return job;
  });
  mockDelegate(t, db.bulkExportJob, 'findFirst', async ({ where }: { where: { id: string; sandboxId: string; status?: string; expiresAt: { gt: Date } } }) => {
    const job = jobs.get(where.id);
    return job && job.sandboxId === where.sandboxId && job.expiresAt > where.expiresAt.gt && (!where.status || where.status === job.status) ? job : null;
  });
  mockDelegate(t, db.bulkExportJob, 'deleteMany', async ({ where }: { where: { id: string; sandboxId: string } }) => {
    const job = jobs.get(where.id);
    return { count: job?.sandboxId === where.sandboxId && jobs.delete(where.id) ? 1 : 0 };
  });
  const request = (path: string, userId?: string, method = 'GET') => fetch(`${origin}${path}`, { method, headers: userId ? { 'x-test-user': userId } : {} });
  assert.equal((await request('/api/sandboxes/alpha/fhir/r4/$export?_type=Patient')).status, 401);
  assert.equal((await request('/api/sandboxes/alpha/fhir/r4/$export?_type=Patient', 'bob')).status, 403);
  assert.equal((await request('/api/sandboxes/alpha/fhir/r4/$export?_type=../beta/Patient', 'alice')).status, 400);
  assert.equal(jobs.size, 0);
  const start = await request('/api/sandboxes/alpha/fhir/r4/$export?_type=Patient', 'alice');
  assert.equal(start.status, 202);
  const { jobId } = await start.json() as { jobId: string };
  for (let attempt = 0; attempt < 20 && jobs.get(jobId)?.status !== 'completed'; attempt++)
    await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(jobs.get(jobId)?.status, 'completed');
  const poll = `/api/sandboxes/alpha/bulk-export/jobs/${jobId}`;
  assert.equal((await request(poll)).status, 401);
  assert.equal((await request(poll, 'bob')).status, 403);
  assert.equal((await request(`/api/sandboxes/beta/bulk-export/jobs/${jobId}`, 'bob')).status, 404);
  assert.equal((await request(poll, 'reader', 'DELETE')).status, 403);
  const manifestResponse = await request(poll, 'reader');
  assert.equal(manifestResponse.status, 200);
  const manifest = await manifestResponse.json() as { output: Array<{ url: string }> };
  const download = new URL(manifest.output[0]!.url).pathname;
  assert.equal((await request(download)).status, 401);
  assert.equal((await request(download.replace('/alpha/', '/beta/'), 'bob')).status, 404);
  assert.equal((await request(download, 'alice')).status, 200);
  assert.equal((await request(`/api/sandboxes/beta/bulk-export/jobs/${jobId}`, 'bob', 'DELETE')).status, 202);
  assert.ok(jobs.has(jobId));
  assert.equal((await request(poll, 'alice', 'DELETE')).status, 202);
  assert.equal((await request(download, 'alice')).status, 404);
  const second = await request('/api/sandboxes/alpha/fhir/r4/$export?_type=Patient', 'alice');
  const { jobId: expiringId } = await second.json() as { jobId: string };
  for (let attempt = 0; attempt < 20 && jobs.get(expiringId)?.status !== 'completed'; attempt++)
    await new Promise<void>((resolve) => setImmediate(resolve));
  const expiringPoll = `/api/sandboxes/alpha/bulk-export/jobs/${expiringId}`;
  const expiringManifest = await (await request(expiringPoll, 'alice')).json() as { output: Array<{ url: string }> };
  jobs.get(expiringId)!.expiresAt = new Date(0);
  assert.equal((await request(expiringPoll, 'alice')).status, 404);
  assert.equal((await request(new URL(expiringManifest.output[0]!.url).pathname, 'alice')).status, 404);
});

test('subscription trigger requires sandbox management and rejects private webhook destinations', async (t) => {
  mockSandboxes(t);
  const deliveries: unknown[] = [];
  t.mock.method(SubscriptionHub.getInstance(), 'broadcastEvent', async (...args: unknown[]) => { deliveries.push(args); });
  const trigger = (userId?: string, webhookUrl?: string) => fetch(`${origin}/api/sandboxes/alpha/subscriptions/trigger`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', ...(userId ? { 'x-test-user': userId } : {}) },
    body: JSON.stringify({ webhookUrl }),
  });
  assert.equal((await trigger()).status, 401);
  assert.equal((await trigger('bob')).status, 403);
  assert.equal((await trigger('reader')).status, 403);
  for (const destination of ['http://127.0.0.1/admin', 'https://169.254.169.254/latest/meta-data', 'https://[::1]/', 'https://service.internal/'])
    assert.equal((await trigger('alice', destination)).status, 400);
  assert.equal(deliveries.length, 0);
  assert.equal((await trigger('alice')).status, 201);
  assert.equal(deliveries.length, 1);
  assert.equal((deliveries[0] as unknown[])[0], sandboxIds.alpha);
});

test('subscription sender never contacts private literal addresses', async (t) => {
  let requests = 0;
  t.mock.method(https, 'request', () => { requests++; throw new Error('Unexpected network request'); });
  t.mock.method(console, 'warn', () => {});
  const event = {
    subscriptionId: 'test-subscription', topic: 'admission', status: 'active' as const,
    type: 'event-notification' as const, eventsSinceSubscriptionStart: 1,
    timestamp: new Date().toISOString(),
  };
  for (const destination of ['https://127.0.0.1/', 'https://169.254.169.254/latest/meta-data', 'https://[::1]/'])
    await SubscriptionHub.getInstance().broadcastEvent('alpha', event, destination);
  assert.equal(requests, 0);
});

test('existing subscription sockets stop receiving events after membership, session or account revocation', async (t) => {
  const db = getPrisma();
  let membership = true;
  let activeSession = true;
  const sessionId = crypto.randomUUID();
  const row = {
    id: sessionId, userId: 'reader', encryptedTokenBundle: null, ssoRoles: [],
    idleExpiresAt: new Date(Date.now() + 3_600_000), expiresAt: new Date(Date.now() + 7_200_000),
    user: { id: 'reader', isSuspended: false },
  };
  mockDelegate(t, db.session, 'findUnique', async () => activeSession ? row : null);
  mockDelegate(t, db.appointment, 'findMany', async () => []);
  mockDelegate(t, db.member, 'findMany', async () => []);
  mockDelegate(t, db.sandbox, 'findUnique', async () => ({
    id: sandboxIds.alpha, sandboxId: 'alpha', createdByUserId: 'alice', allowOpenAccess: false,
    collaborators: membership ? [{ userId: 'reader', role: 'READ_ONLY' }] : [],
  }));
  const secret = 'subscription-regression-session-secret';
  const oidc: OidcBffConfig = {
    issuerUrl: 'https://sso.example.org', clientId: 'test', clientSecret: 'test', clientSecretPrevious: [],
    redirectUrl: 'https://studio.example.org/sso/callback', scopes: 'openid',
    postLogoutRedirectUrl: 'https://studio.example.org', uiBaseUrl: 'https://studio.example.org',
    corsOrigins: ['https://studio.example.org'], sessionSecret: secret, sessionSecrets: [secret],
    sessionIdleHours: 1, sessionAbsoluteHours: 2, databaseUrl: process.env.FHIR_STUDIO_SERVER_DATABASE_URL!,
    rolesClaim: 'roles', bootstrapAdminEmails: [], apiTokenPepper: 'pepper', nodeEnv: 'test',
  };
  const hub = SubscriptionHub.getInstance();
  hub.init(server, oidc);
  t.after(() => hub.close());
  const event = {
    subscriptionId: 'test-subscription', topic: 'admission', status: 'active' as const,
    type: 'event-notification' as const, eventsSinceSubscriptionStart: 1,
    timestamp: new Date().toISOString(),
  };
  for (const revoke of ['membership', 'session', 'suspension', 'expiry']) {
    membership = true;
    activeSession = true;
    row.user.isSuspended = false;
    row.idleExpiresAt = new Date(Date.now() + 3_600_000);
    const socket = new WebSocket(`${origin.replace('http:', 'ws:')}/subscriptions/ws?sandboxId=alpha`, {
      headers: { Origin: 'https://studio.example.org', Cookie: `${SESSION_COOKIE}=${hmacSign(sessionId, secret)}` },
    });
    const received: string[] = [];
    socket.on('message', (data) => received.push(data.toString()));
    await Promise.all([once(socket, 'open'), once(socket, 'message')]);
    const delivered = once(socket, 'message');
    await hub.broadcastEvent(sandboxIds.alpha, event);
    await delivered;
    const count = received.length;
    if (revoke === 'membership') membership = false;
    if (revoke === 'session') activeSession = false;
    if (revoke === 'suspension') row.user.isSuspended = true;
    if (revoke === 'expiry') row.idleExpiresAt = new Date(0);
    const closed = once(socket, 'close');
    await hub.broadcastEvent(sandboxIds.alpha, event);
    assert.equal((await closed)[0], 1008, revoke);
    assert.equal(received.length, count, revoke);
  }
});

test('recreating a sandbox slug cannot expose the previous sandbox subscription history', async (t) => {
  let sandbox = { id: crypto.randomUUID(), sandboxId: 'alpha', createdByUserId: 'alice', allowOpenAccess: false, collaborators: [] };
  mockDelegate(t, getPrisma().sandbox, 'findUnique', async () => sandbox);
  const request = (userId: string, method = 'GET') => fetch(`${origin}/api/sandboxes/alpha/subscriptions/${method === 'POST' ? 'trigger' : 'events'}`, {
    method, headers: { 'x-test-user': userId, 'Content-Type': 'application/json' },
    ...(method === 'POST' ? { body: JSON.stringify({ resourceId: 'previous-private-event' }) } : {}),
  });
  assert.equal((await request('alice', 'POST')).status, 201);
  const previous = await (await request('alice')).json() as { events: unknown[] };
  assert.equal(previous.events.length, 1);
  sandbox = { ...sandbox, id: crypto.randomUUID(), createdByUserId: 'bob' };
  const replacement = await (await request('bob')).json() as { events: unknown[] };
  assert.deepEqual(replacement.events, []);
});
