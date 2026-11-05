import assert from 'node:assert/strict';
import { after, afterEach, beforeEach, mock, test } from 'node:test';
import { IncomingMessage, ServerResponse } from 'node:http';
import { Socket } from 'node:net';
import express, { type NextFunction, type Request, type Response, type Router } from 'express';
import { createDefaultEffectivePermissions, type EffectivePermissions } from '@fhir-studio/core';
import { getPrisma, disconnectPrisma } from '../src/db/prisma.js';
import { HapiPartitionClient } from '../src/hapi/partition_client.js';
import { HostingError } from '../src/hosted/access.js';
import { createSandboxesRouter } from '../src/sandboxes/routes.js';
import { createAdministrationRouter } from '../src/administration/routes.js';

Object.assign(process.env, {
  FHIR_STUDIO_SERVER_DATABASE_URL: 'postgresql://test:test@127.0.0.1:1/test',
  FHIR_STUDIO_HAPI_R4_BASE_URL: 'http://hapi.example.test/fhir',
  FHIR_STUDIO_HAPI_R4B_ENABLED: 'false',
  FHIR_STUDIO_HAPI_R5_ENABLED: 'false',
});

const db = getPrisma();
const sandbox = {
  id: 'sandbox-id', sandboxId: 'demo', name: 'Demo', description: null,
  fhirVersion: 'R4', partitionId: 1, visibility: 'PRIVATE', allowOpenAccess: false,
  createdByUserId: 'owner', createdAt: new Date(), updatedAt: new Date(),
  collaborators: [
    { id: 'manager-id', userId: 'manager', role: 'MANAGE' },
    { id: 'legacy-id', userId: 'legacy', role: 'OWNER' },
    { id: 'writer-id', userId: 'writer', role: 'READ_WRITE' },
    { id: 'reader-id', userId: 'reader', role: 'READ_ONLY' },
  ],
  applications: [],
};
const mutations: Array<{ operation: string; data: Record<string, unknown> }> = [];

beforeEach(() => {
  mutations.length = 0;
  Object.assign(db.sandbox, { findUnique: async ({ where }: { where: { sandboxId: string } }) =>
    where.sandboxId === sandbox.sandboxId ? sandbox : null });
  Object.assign(db.sandbox, { create: async ({ data }: { data: Record<string, unknown> }) => {
    mutations.push({ operation: 'create', data });
    return { ...sandbox, ...data, collaborators: [] };
  } });
  Object.assign(db.sandbox, { update: async ({ data }: { data: Record<string, unknown> }) => {
    mutations.push({ operation: 'update', data });
    return { ...sandbox, ...data };
  } });
  Object.assign(db.userPersona, { create: async () => ({}) });
  Object.assign(db.user, { findFirst: async ({ where }: { where: { email: { equals: string } } }) => ({
    id: where.email.equals.split('@')[0],
  }) });
  Object.assign(db.sandboxCollaborator, { upsert: async ({ create }: { create: Record<string, unknown> }) => {
    mutations.push({ operation: 'add', data: create });
    return create;
  } });
  Object.assign(db.sandboxCollaborator, { deleteMany: async ({ where }: { where: Record<string, unknown> }) => {
    mutations.push({ operation: 'remove', data: where });
    return { count: 1 };
  } });
  mock.method(HapiPartitionClient, 'allocateNextPartitionId', async () => 2);
  mock.method(HapiPartitionClient.prototype, 'createPartition', async () => {});
});
afterEach(() => mock.restoreAll());
after(async () => { await disconnectPrisma(); });

/** Run the real routing and permission middleware without network or database dependencies. */
async function request(
  router: Router,
  method: string,
  url: string,
  userId?: string,
  permissions: Partial<EffectivePermissions> = {},
  body?: unknown,
) {
  const app = express();
  app.use(router);
  app.use((error: Error, _req: Request, res: Response, _next: NextFunction) =>
    res.status(error instanceof HostingError ? error.status : 500).json({ error: error.message }));
  const req = new IncomingMessage(new Socket()) as Request;
  req.method = method;
  req.url = url;
  req.body = body;
  req.headers = { host: 'studio.example.test' };
  req.effectivePermissions = { ...createDefaultEffectivePermissions(), ...permissions };
  if (userId) req.sessionAuth = {
    userId, sessionId: 'browser', sub: userId, ssoRoles: [], email: null, displayName: null, isSuspended: false,
  };
  return new Promise<{ status: number; body: Record<string, unknown> }>((resolve, reject) => {
    const res = new ServerResponse(req);
    Object.assign(res, { end(chunk?: string | Buffer) {
      resolve({ status: res.statusCode, body: chunk ? JSON.parse(String(chunk)) as Record<string, unknown> : {} });
      return res;
    } });
    app.handle(req, res, reject);
  });
}

test('sandbox creation needs creation permission, with legacy isShared inputs ignored', async () => {
  const router = createSandboxesRouter();
  const body = { sandboxId: 'new-sandbox', name: 'New sandbox', seedData: false, isShared: true };
  assert.equal((await request(router, 'POST', '/api/sandboxes', 'owner', { sandboxes_create: false }, body)).status, 403);
  const response = await request(router, 'POST', '/api/sandboxes', 'owner', {}, body);
  assert.equal(response.status, 201);
  assert.equal('isShared' in (response.body['sandbox'] as object), false);
  assert.equal('isShared' in mutations[0].data, false);
  assert.equal(mutations[0].data['visibility'], 'PRIVATE');
  assert.equal(mutations[0].data['allowOpenAccess'], false);
});

test('editing settings ignores the retired flag and preserves collaborator assignments', async () => {
  const response = await request(createSandboxesRouter(), 'PUT', '/api/sandboxes/demo', 'owner', {}, {
    name: 'Renamed', isShared: false,
  });
  assert.equal(response.status, 200);
  assert.deepEqual(mutations, [{ operation: 'update', data: { name: 'Renamed' } }]);
  assert.deepEqual((response.body['sandbox'] as { collaborators: unknown[] }).collaborators, sandbox.collaborators);
});

test('existing collaborators retain access without permission to manage sharing', async () => {
  for (const user of ['reader', 'writer', 'manager']) {
    assert.equal((await request(createSandboxesRouter(), 'GET', '/api/sandboxes/demo', user)).status, 200, user);
  }
});

test('collaborator mutations require authentication and the sharing permission', async () => {
  const router = createSandboxesRouter();
  for (const method of ['POST', 'DELETE']) {
    const endpoint = `/api/sandboxes/demo/collaborators${method === 'DELETE' ? '/reader' : ''}`;
    const body = { email: 'reader@example.test', role: 'READ_ONLY' };
    assert.equal((await request(router, method, endpoint, undefined, { sandboxes_shared: true }, body)).status, 401);
    for (const user of ['owner', 'manager', 'legacy']) {
      assert.equal((await request(router, method, endpoint, user, {}, body)).status, 403, user);
    }
  }
  assert.equal(mutations.length, 0);
});

test('sharing permission alone does not authorize readers, writers, or unrelated users', async () => {
  const router = createSandboxesRouter();
  for (const user of ['reader', 'writer', 'stranger']) {
    assert.equal((await request(router, 'POST', '/api/sandboxes/demo/collaborators', user,
      { sandboxes_shared: true }, { email: 'new@example.test' })).status, 403, user);
    assert.equal((await request(router, 'DELETE', '/api/sandboxes/demo/collaborators/reader', user,
      { sandboxes_shared: true })).status, 403, user);
  }
  assert.equal(mutations.length, 0);
});

test('owners and sandbox managers with permission can add, update, and remove ordinary collaborators', async () => {
  const router = createSandboxesRouter();
  for (const user of ['owner', 'manager', 'legacy']) {
    for (const role of ['READ_ONLY', 'READ_WRITE']) {
      assert.equal((await request(router, 'POST', '/api/sandboxes/demo/collaborators', user,
        { sandboxes_shared: true }, { email: 'reader@example.test', role })).status, 201, `${user}: ${role}`);
    }
    assert.equal((await request(router, 'DELETE', '/api/sandboxes/demo/collaborators/reader', user,
      { sandboxes_shared: true })).status, 200, user);
  }
  assert.equal(mutations.length, 9);
});

test('sandbox managers cannot grant, demote, or remove administrators', async () => {
  const router = createSandboxesRouter();
  for (const user of ['manager', 'legacy']) {
    assert.equal((await request(router, 'POST', '/api/sandboxes/demo/collaborators', user,
      { sandboxes_shared: true }, { email: 'reader@example.test', role: 'MANAGE' })).status, 403);
    for (const target of ['manager', 'legacy']) {
      assert.equal((await request(router, 'POST', '/api/sandboxes/demo/collaborators', user,
        { sandboxes_shared: true }, { email: `${target}@example.test`, role: 'READ_ONLY' })).status, 403);
      assert.equal((await request(router, 'DELETE', `/api/sandboxes/demo/collaborators/${target}`, user,
        { sandboxes_shared: true })).status, 403);
    }
  }
  assert.equal(mutations.length, 0);
});

test('owners and global administrators can manage administrator assignments', async () => {
  const router = createSandboxesRouter();
  for (const [user, permissions] of [
    ['owner', { sandboxes_shared: true }],
    ['global-admin', { global_manage: true, sandboxes_shared: false }],
  ] as const) {
    assert.equal((await request(router, 'POST', '/api/sandboxes/demo/collaborators', user,
      permissions, { email: 'reader@example.test', role: 'MANAGE' })).status, 201);
    for (const target of ['manager', 'legacy']) {
      assert.equal((await request(router, 'POST', '/api/sandboxes/demo/collaborators', user,
        permissions, { email: `${target}@example.test`, role: 'READ_ONLY' })).status, 201);
      assert.equal((await request(router, 'DELETE', `/api/sandboxes/demo/collaborators/${target}`, user,
        permissions)).status, 200);
    }
  }
  assert.equal(mutations.length, 10);
});

test('sharing rejects invalid collaborator roles', async () => {
  for (const role of ['OWNER', 'INVALID']) {
    assert.equal((await request(createSandboxesRouter(), 'POST', '/api/sandboxes/demo/collaborators', 'owner',
      { sandboxes_shared: true }, { email: 'reader@example.test', role })).status, 400);
  }
  assert.equal(mutations.length, 0);
});

test('shared sandbox metrics count actual collaborators other than the creator', async () => {
  Object.assign(db.sandbox, { count: async () => 4 });
  Object.assign(db.sandbox, { findMany: async () => [
    sandbox,
    { ...sandbox, collaborators: [{ userId: sandbox.createdByUserId }] },
    { ...sandbox, collaborators: [] },
    { ...sandbox, collaborators: [{ userId: sandbox.createdByUserId }, { userId: 'reader' }] },
  ] });
  Object.assign(db.user, { count: async () => 0, findMany: async () => [] });
  Object.assign(db.session, { count: async () => 0 });
  Object.assign(db.application, { count: async () => 0 });
  Object.assign(db.launchScenario, { count: async () => 0 });
  const response = await request(createAdministrationRouter(), 'GET', '/api/administration/metrics', 'admin', { global_manage: true });
  assert.equal(response.status, 200);
  assert.equal((response.body['summary'] as { sharedSandboxes: number }).sharedSandboxes, 2);
});
