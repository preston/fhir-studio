import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { IncomingMessage, ServerResponse } from 'node:http';
import { Socket } from 'node:net';
import express, { type Request, type Response, type NextFunction, type Router } from 'express';
import axios from 'axios';
import { getPrisma, disconnectPrisma } from '../src/db/prisma.js';
import { createFhirGatewayRouter } from '../src/fhir-gateway/proxy.js';
import { createHooksRouter } from '../src/hooks/routes.js';
import { HostingError } from '../src/hosted/access.js';
import { PublicRequestError, type PublicRequestOptions } from '../src/http/public-request.js';

Object.assign(process.env, {
  FHIR_STUDIO_SERVER_DATABASE_URL: 'postgresql://test:test@127.0.0.1:1/test',
  FHIR_STUDIO_HOSTING_ENABLED: 'false',
  FHIR_STUDIO_SERVER_UI_BASE_URL: 'https://studio.example.org',
  FHIR_STUDIO_HAPI_R4_BASE_URL: 'http://hapi.example.org/fhir',
  FHIR_STUDIO_HAPI_R4B_ENABLED: 'false',
  FHIR_STUDIO_HAPI_R5_ENABLED: 'false',
});
const db = getPrisma();
const sandboxes = {
  private: { id: 'private-id', sandboxId: 'private', fhirVersion: 'R4', createdByUserId: 'owner', allowOpenAccess: false,
    collaborators: [{ userId: 'viewer', role: 'READ_ONLY' }] },
  open: { id: 'open-id', sandboxId: 'open', fhirVersion: 'R4', createdByUserId: 'owner', allowOpenAccess: true, collaborators: [] },
};
Object.assign(db.sandbox, { findUnique: async ({ where }: { where: { sandboxId?: keyof typeof sandboxes; id?: string } }) =>
  (where.sandboxId ? sandboxes[where.sandboxId] : Object.values(sandboxes).find(row => row.id === where.id)) ?? null });
let smartScope = 'user/Patient.r';
let smartSandboxRowId: string | null = 'private-id';
Object.assign(db.smartAuthSession, { findFirst: async () => ({ id: 'smart-session', clientId: 'external-app', scope: smartScope,
  sandboxRowId: smartSandboxRowId,
  patientFhirId: 'p1', tokenExpiresAt: new Date(Date.now() + 3600000) }) });
Object.assign(db.application, { findUnique: async () => ({ clientId: 'external-app', hostedApplication: null }) });
const externalRequests: Array<{ url: string; options?: PublicRequestOptions }> = [];
const prefetchRequests: string[] = [];
const deletions: unknown[] = [];
Object.assign(db.cdsServiceEndpoint, {
  findMany: async () => [],
  create: async ({ data }: { data: unknown }) => data,
  deleteMany: async ({ where }: { where: { id: string; sandboxId: string } }) => {
    deletions.push(where);
    return { count: where.id === 'own-endpoint' && where.sandboxId === 'private-id' ? 1 : 0 };
  },
});
const originalAdapter = axios.defaults.adapter;
axios.defaults.adapter = async config => {
  prefetchRequests.push(config.url ?? '');
  return { config, status: 200, statusText: 'OK', headers: {}, data: { resourceType: 'Bundle', entry: [] } };
};
const hooks = createHooksRouter({ requestJson: async (url, options) => {
  externalRequests.push({ url, options });
  if (url.includes('private-dns')) throw new PublicRequestError(400, 'Outbound URL must resolve only to public internet addresses.');
  return options?.method === 'POST' ? { cards: [] } : { services: [] };
} });
const gateway = createFhirGatewayRouter();

/** Exercise real Express route matching/middleware without opening a listening socket. */
async function request(router: Router, method: string, url: string, body?: unknown, userId?: string, bearer = false) {
  const app = express();
  app.use(router);
  app.use((error: Error, _req: Request, res: Response, _next: NextFunction) =>
    res.status(error instanceof HostingError ? error.status : 500).json({ error: error.message }));
  const req = new IncomingMessage(new Socket()) as Request;
  req.method = method;
  req.url = url;
  req.body = body;
  req.headers = { host: 'studio.example.org', ...(bearer ? { authorization: 'Bearer valid-token' } : {}) };
  if (userId) req.sessionAuth = { userId, sessionId: 'browser', sub: userId, ssoRoles: [], email: null, displayName: null, isSuspended: false };
  return new Promise<{ status: number; body: unknown }>((resolve, reject) => {
    const res = new ServerResponse(req);
    Object.assign(res, { end(chunk?: string | Buffer) {
      try { resolve({ status: res.statusCode, body: chunk ? JSON.parse(String(chunk)) as unknown : null }); }
      catch { resolve({ status: res.statusCode, body: chunk ? String(chunk) : null }); }
      return res;
    } });
    app.handle(req, res, reject);
  });
}

after(async () => { axios.defaults.adapter = originalAdapter; await disconnectPrisma(); });

test('gateway rejects encoded tenant traversal and URL delimiters before any upstream request', async () => {
  for (const path of ['%252e%252e/private/Patient', '%252E%252E/DEFAULT/Library', 'Patient/%252f..%252fprivate',
    'Patient/%3fquery', 'Patient/%23fragment', 'Patient/%5c..%5cprivate', 'Patient/%00',
    '%2e%2e%0a/private/Patient', '%2e%2e%0d/private/Patient', '%2e%2e%09/private/Patient']) {
    const before = prefetchRequests.length;
    const result = await request(gateway, 'GET', `/api/sandboxes/open/fhir/r4/${path}`);
    assert.equal(result.status, 400, path);
    assert.equal(prefetchRequests.length, before, path);
  }
  assert.equal((await request(gateway, 'GET', '/api/sandboxes/open/fhir/r4/Patient/abc.123-def')).status, 200);
});

test('SMART resource grants cannot authorize multi-resource operations or compartment paths', async () => {
  for (const scope of ['user/Patient.r', 'system/Patient.r', 'patient/Patient.r']) {
    smartScope = scope;
    for (const path of ['Patient/p1/$everything', 'Patient/$graphql', 'Patient/p1/Observation']) {
      const before = prefetchRequests.length;
      assert.equal((await request(gateway, 'GET', `/api/sandboxes/private/fhir/r4/${path}`, undefined, undefined, true)).status, 403, `${scope}: ${path}`);
      assert.equal(prefetchRequests.length, before);
    }
    assert.equal((await request(gateway, 'GET', '/api/sandboxes/private/fhir/r4/Patient/p1', undefined, undefined, true)).status, 200, scope);
  }
  smartScope = 'user/Patient.r';
  assert.equal((await request(gateway, 'GET', '/api/sandboxes/private/fhir/r4/Patient/_history', undefined, undefined, true)).status, 403);
  smartScope = 'user/Patient.rs';
  assert.equal((await request(gateway, 'GET', '/api/sandboxes/private/fhir/r4/Patient/_history', undefined, undefined, true)).status, 200);
});

test('SMART tokens require the current immutable tenant binding, including after slug reuse', async () => {
  smartScope = 'user/Patient.r';
  try {
    for (const binding of [null, 'deleted-sandbox-id']) {
      smartSandboxRowId = binding;
      assert.equal((await request(gateway, 'GET', '/api/sandboxes/private/fhir/r4/Patient/p1', undefined, undefined, true)).status, 401);
    }
    smartSandboxRowId = 'private-id';
    assert.equal((await request(gateway, 'GET', '/api/sandboxes/private/fhir/r4/Patient/p1', undefined, undefined, true)).status, 200);
  } finally { smartSandboxRowId = 'private-id'; }
});

test('HAPI administration and batch tenant escapes are blocked even for sandbox owners', async () => {
  for (const path of ['$partition-management-list-partitions', '$expunge', 'Patient/$expunge', '$cql']) {
    const before = prefetchRequests.length;
    assert.equal((await request(gateway, 'POST', `/api/sandboxes/open/fhir/r4/${path}`, {}, 'owner')).status, 403);
    assert.equal(prefetchRequests.length, before);
  }
  for (const url of ['../private/Patient', '%2e%2e/private/Patient', '/Patient', 'https://hapi.example.org/fhir/private/Patient',
    'Patient/$expunge', 'Patient/$partition-management-delete-partition']) {
    const before = prefetchRequests.length;
    const result = await request(gateway, 'POST', '/api/sandboxes/open/fhir/r4', {
      resourceType: 'Bundle', type: 'batch', entry: [{ request: { method: 'POST', url } }],
    }, 'owner');
    assert.equal(result.status, 400, url);
    assert.equal(prefetchRequests.length, before);
  }
  for (const path of ['Library/$delete-expunge', 'Library/$evaluate', 'Library/$cql', 'StructureDefinition/new', 'Measure/$evaluate-measure']) {
    const before = prefetchRequests.length;
    assert.equal((await request(gateway, 'POST', `/api/sandboxes/open/fhir/r4/${path}`, { resourceType: 'Parameters' }, 'owner')).status, 403, path);
    assert.equal(prefetchRequests.length, before);
  }
  const before = prefetchRequests.length;
  assert.equal((await request(gateway, 'POST', '/api/sandboxes/open/fhir/r4', {
    resourceType: 'Bundle', type: 'batch', entry: [{ resource: { resourceType: 'Parameters' }, request: { method: 'POST', url: 'Library/$evaluate' } }],
  }, 'owner')).status, 403);
  assert.equal(prefetchRequests.length, before);
});

test('all CDS routes require authentication and access to the requested sandbox', async () => {
  const calls = [['GET', '', undefined], ['POST', '', { name: 'CDS', url: 'https://cds.example.org' }],
    ['DELETE', '/own-endpoint', undefined], ['POST', '/proxy', { serviceUrl: 'https://cds.example.org' }],
    ['POST', '/feedback', { feedbackUrl: 'https://cds.example.org', feedback: {} }]] as const;
  const before = externalRequests.length;
  for (const [method, suffix, body] of calls) {
    assert.equal((await request(hooks, method, `/api/sandboxes/private/cds-services${suffix}`, body)).status, 401);
    assert.equal((await request(hooks, method, `/api/sandboxes/private/cds-services${suffix}`, body, 'stranger')).status, 403);
  }
  assert.equal((await request(hooks, 'POST', '/api/sandboxes/open/cds-services/proxy', { serviceUrl: 'https://cds.example.org' })).status, 401);
  assert.equal(externalRequests.length, before);
});

test('CDS endpoint changes require manage access and deletion is constrained to the sandbox', async () => {
  assert.equal((await request(hooks, 'POST', '/api/sandboxes/private/cds-services', { name: 'CDS', url: 'https://cds.example.org' }, 'viewer')).status, 403);
  assert.equal((await request(hooks, 'DELETE', '/api/sandboxes/private/cds-services/foreign-endpoint', undefined, 'owner')).status, 404);
  assert.deepEqual(deletions.at(-1), { id: 'foreign-endpoint', sandboxId: 'private-id' });
  assert.equal((await request(hooks, 'DELETE', '/api/sandboxes/private/cds-services/own-endpoint', undefined, 'owner')).status, 200);
});

test('CDS discovery, invocation and feedback reject internal and non-HTTPS targets', async () => {
  for (const url of ['http://127.0.0.1/fhir', 'https://169.254.169.254/latest', 'https://[::1]/', 'https://hapi.internal/fhir',
    'https://name:secret@cds.example.org', 'https://cds.example.org:8443']) {
    const before = externalRequests.length;
    assert.equal((await request(hooks, 'POST', '/api/sandboxes/private/cds-services', { name: 'CDS', url }, 'owner')).status, 400);
    assert.equal((await request(hooks, 'POST', '/api/sandboxes/private/cds-services/proxy', { serviceUrl: url }, 'owner')).status, 400);
    assert.equal((await request(hooks, 'POST', '/api/sandboxes/private/cds-services/feedback', { feedbackUrl: url, feedback: {} }, 'owner')).status, 400);
    assert.equal(externalRequests.length, before);
  }
  assert.equal((await request(hooks, 'POST', '/api/sandboxes/private/cds-services', { name: 'CDS', url: 'https://private-dns.example.org' }, 'owner')).status, 400);
});

test('CDS prefetch cannot escape its tenant, and valid invocation/feedback use bounded redirect-free transport', async () => {
  for (const template of ['../other/Patient', '%2e%2e/other/Patient', '%252e%252e/other/Patient', '//evil.example.org',
    'Patient/%3fescape', 'Patient/p1/$everything', 'Patient/{{context.patientId}}']) {
    const before = prefetchRequests.length;
    const result = await request(hooks, 'POST', '/api/sandboxes/private/cds-services/proxy', {
      serviceUrl: 'https://cds.example.org/service', prefetchTemplates: { data: template }, context: { patientId: '../other' },
    }, 'owner');
    assert.equal(result.status, 400, template);
    assert.equal(prefetchRequests.length, before);
  }
  assert.equal((await request(hooks, 'POST', '/api/sandboxes/private/cds-services/proxy', {
    serviceUrl: 'https://cds.example.org/service', prefetchTemplates: { data: 'Patient/p1', search: 'Observation?patient={{context.patientId}}' },
    context: { patientId: 'p1&_include=*' },
  }, 'viewer')).status, 200);
  assert.equal(prefetchRequests.at(-2), 'http://hapi.example.org/fhir/private/Patient/p1');
  const search = new URL(prefetchRequests.at(-1)!);
  assert.equal(search.searchParams.get('patient'), 'p1&_include=*');
  assert.equal(search.searchParams.has('_include'), false);
  assert.equal(externalRequests.at(-1)?.options?.followRedirects, false);
  assert.equal(externalRequests.at(-1)?.options?.maxBytes, 5 * 1024 * 1024);
  assert.equal((await request(hooks, 'POST', '/api/sandboxes/private/cds-services/feedback', {
    feedbackUrl: 'https://cds.example.org/feedback', feedback: { outcome: 'accepted' },
  }, 'viewer')).status, 200);
  assert.equal(externalRequests.at(-1)?.options?.method, 'POST');
  assert.equal(externalRequests.at(-1)?.options?.followRedirects, false);
});
