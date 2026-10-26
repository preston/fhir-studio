import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { after, before, test } from 'node:test';
import { IncomingMessage, ServerResponse } from 'node:http';
import { Socket } from 'node:net';
import express, { type Request, type Response, type NextFunction, type Router } from 'express';
import type { Prisma } from '@prisma/client';
import { getPrisma, disconnectPrisma } from '../src/db/prisma.js';
import { createSmartIdpRouter } from '../src/smart-idp/routes.js';
import { createHooksRouter } from '../src/hooks/routes.js';
import { verifySandboxAccess } from '../src/fhir-gateway/security.js';
import { HostingError } from '../src/hosted/access.js';

const databaseUrl = process.env.FHIR_STUDIO_SECURITY_TEST_DATABASE_URL;
assert.ok(databaseUrl && /test|integration/.test(new URL(databaseUrl).pathname), 'Set a disposable security test database URL.');
Object.assign(process.env, {
  FHIR_STUDIO_SERVER_DATABASE_URL: databaseUrl,
  FHIR_STUDIO_HOSTING_ENABLED: 'false',
  FHIR_STUDIO_SERVER_UI_BASE_URL: 'https://studio.example.org',
  FHIR_STUDIO_HAPI_R4_BASE_URL: 'https://hapi.example.org/fhir',
  FHIR_STUDIO_HAPI_R4B_ENABLED: 'false', FHIR_STUDIO_HAPI_R5_ENABLED: 'false',
});
const db = getPrisma(databaseUrl);
const userId = crypto.randomUUID();
const slug = `smart-binding-${crypto.randomUUID()}`;
const clientId = `smart-client-${crypto.randomUUID()}`;
const redirectUri = 'https://app.example.org/callback';
const scope = 'user/Patient.rs launch openid offline_access';
let sandbox: Awaited<ReturnType<typeof db.sandbox.create>>;
let otherSandbox: Awaited<ReturnType<typeof db.sandbox.create>>;
const smart = createSmartIdpRouter();

async function request(router: Router, method: string, url: string, body?: unknown, principal = false) {
  const app = express();
  app.use(router);
  app.use((error: Error, _req: Request, res: Response, _next: NextFunction) =>
    res.status(error instanceof HostingError ? error.status : 500).json({ error: error.message }));
  const req = new IncomingMessage(new Socket()) as Request;
  req.method = method; req.url = url; req.body = body; req.headers = { host: 'studio.example.org' };
  if (principal) req.sessionAuth = { userId, sessionId: 'browser', sub: userId, ssoRoles: [], email: null, displayName: null, isSuspended: false };
  return new Promise<{ status: number; body: Record<string, unknown>; location: string }>((resolve, reject) => {
    const res = new ServerResponse(req);
    Object.assign(res, { end(chunk?: string | Buffer) {
      let value: Record<string, unknown> = {};
      try { value = JSON.parse(String(chunk)) as Record<string, unknown>; } catch { /* HTML/text errors */ }
      resolve({ status: res.statusCode, body: value, location: String(res.getHeader('location') ?? '') });
      return res;
    } });
    app.handle(req, res, reject);
  });
}
function authorization(launch?: string) {
  return `/oauth/authorize?${new URLSearchParams({ response_type: 'code', client_id: clientId, redirect_uri: redirectUri,
    scope, state: 'state', code_challenge: 'a'.repeat(43), code_challenge_method: 'S256',
    aud: `https://studio.example.org/api/sandboxes/${slug}/fhir/r4`, ...(launch ? { launch } : {}) })}`;
}
function sessionData(extra: Partial<Prisma.SmartAuthSessionUncheckedCreateInput> = {}): Prisma.SmartAuthSessionUncheckedCreateInput {
  return { sandboxId: slug, sandboxRowId: sandbox.id, clientId, redirectUri, scope,
    tokenExpiresAt: new Date(Date.now() + 60000), refreshTokenExpiresAt: new Date(Date.now() + 60000),
    codeExpiresAt: new Date(Date.now() + 60000), ...extra };
}
before(async () => {
  await db.user.create({ data: { id: userId, ssoIssuer: 'smart-binding-test', ssoSubject: userId } });
  sandbox = await db.sandbox.create({ data: { sandboxId: slug, name: 'Binding', partitionId: 891001, createdByUserId: userId } });
  otherSandbox = await db.sandbox.create({ data: { sandboxId: `${slug}-other`, name: 'Other', partitionId: 891002, createdByUserId: userId } });
  await db.application.create({ data: { clientId, clientName: 'Binding test', launchUri: 'https://app.example.org/launch',
    redirectUris: [redirectUri], scope, tokenEndpointAuthMethod: 'none', createdByUserId: userId } });
});
after(async () => {
  await db.smartAuthSession.deleteMany({ where: { sandboxId: { startsWith: slug } } });
  await db.application.deleteMany({ where: { createdByUserId: userId } });
  await db.sandbox.deleteMany({ where: { createdByUserId: userId } });
  await db.user.delete({ where: { id: userId } });
  await disconnectPrisma();
});

test('all SMART session creation paths bind the authorized immutable sandbox row', async () => {
  const launch = await request(smart, 'POST', `/api/sandboxes/${slug}/launch-context`, { clientId, scope }, true);
  assert.equal(launch.status, 201);
  assert.equal((await db.smartAuthSession.findFirstOrThrow({ where: { launchId: String(launch.body.launch) } })).sandboxRowId, sandbox.id);
  const standalone = await request(smart, 'GET', authorization(), undefined, true);
  assert.equal(standalone.status, 302);
  const code = new URL(standalone.location).searchParams.get('code')!;
  assert.equal((await db.smartAuthSession.findUniqueOrThrow({ where: { code } })).sandboxRowId, sandbox.id);
  const backend = await db.application.create({ data: { clientId: `${clientId}-backend`, clientName: 'Backend', launchUri: redirectUri,
    redirectUris: [redirectUri], sandboxId: sandbox.id, scope: 'system/Patient.r', tokenEndpointAuthMethod: 'client_secret_post', clientSecret: 'test-secret', createdByUserId: userId } });
  const token = await request(smart, 'POST', '/oauth/token', { grant_type: 'client_credentials', client_id: backend.clientId,
    client_secret: 'test-secret', scope: 'system/Patient.r' });
  assert.equal(token.status, 200);
  assert.equal((await db.smartAuthSession.findFirstOrThrow({ where: { accessToken: String(token.body.access_token) } })).sandboxRowId, sandbox.id);
  const hooks = createHooksRouter({ requestJson: async () => ({ cards: [{ links: [{ type: 'smart', url: 'https://app.example.org/launch' }] }] }) });
  const cds = await request(hooks, 'POST', `/api/sandboxes/${slug}/cds-services/proxy`, { serviceUrl: 'https://cds.example.org/service' }, true);
  assert.equal(cds.status, 200);
  const cards = cds.body.cards as Array<{ links: Array<{ url: string }> }>;
  const cardLaunch = new URL(cards[0].links[0].url).searchParams.get('launch')!;
  assert.equal((await db.smartAuthSession.findFirstOrThrow({ where: { launchId: cardLaunch } })).sandboxRowId, sandbox.id);
});

test('legacy and mismatched bindings cannot access FHIR, exchange codes, refresh, authorize or introspect', async () => {
  for (const binding of [null, otherSandbox.id]) {
    const session = await db.smartAuthSession.create({ data: sessionData({ sandboxRowId: binding,
      code: crypto.randomUUID(), accessToken: crypto.randomUUID(), refreshToken: crypto.randomUUID() }) });
    assert.equal((await verifySandboxAccess(db, sandbox, `Bearer ${session.accessToken}`, undefined, undefined,
      { method: 'GET', path: '/Patient/p1', resourceType: 'Patient' })).authorized, false);
    assert.equal((await request(smart, 'POST', '/oauth/token', { grant_type: 'authorization_code', client_id: clientId,
      code: session.code, redirect_uri: redirectUri })).status, 400);
    assert.equal((await request(smart, 'POST', '/oauth/token', { grant_type: 'refresh_token', client_id: clientId,
      refresh_token: session.refreshToken })).status, 400);
    assert.equal((await request(smart, 'POST', '/oauth/introspect', { token: session.accessToken })).body.active, false);
    const launch = await db.smartAuthSession.create({ data: sessionData({ sandboxRowId: binding, launchId: crypto.randomUUID() }) });
    assert.equal((await request(smart, 'GET', authorization(launch.launchId!))).status, 400);
  }
});

test('bound sessions exchange and rotate successfully before tenant deletion', async () => {
  const session = await db.smartAuthSession.create({ data: sessionData({ code: crypto.randomUUID() }) });
  const exchange = await request(smart, 'POST', '/oauth/token', { grant_type: 'authorization_code', client_id: clientId,
    code: session.code, redirect_uri: redirectUri });
  assert.equal(exchange.status, 200);
  const refresh = await request(smart, 'POST', '/oauth/token', { grant_type: 'refresh_token', client_id: clientId,
    refresh_token: exchange.body.refresh_token });
  assert.equal(refresh.status, 200);
  assert.equal((await request(smart, 'POST', '/oauth/introspect', { token: refresh.body.access_token })).body.active, true);
});

test('deleting a sandbox cascades credentials and reusing its slug cannot revive old authority', async () => {
  const oldId = sandbox.id;
  const old = await db.smartAuthSession.create({ data: sessionData({ accessToken: crypto.randomUUID(), refreshToken: crypto.randomUUID(), code: crypto.randomUUID() }) });
  const launch = await db.smartAuthSession.create({ data: sessionData({ launchId: crypto.randomUUID() }) });
  await db.sandbox.delete({ where: { id: oldId } });
  assert.equal(await db.smartAuthSession.count({ where: { sandboxRowId: oldId } }), 0);
  sandbox = await db.sandbox.create({ data: { sandboxId: slug, name: 'New owner tenant', partitionId: 891003, createdByUserId: userId } });
  assert.notEqual(sandbox.id, oldId);
  assert.equal((await verifySandboxAccess(db, sandbox, `Bearer ${old.accessToken}`, undefined, undefined,
    { method: 'GET', path: '/Patient/p1', resourceType: 'Patient' })).authorized, false);
  assert.equal((await request(smart, 'POST', '/oauth/token', { grant_type: 'refresh_token', client_id: clientId, refresh_token: old.refreshToken })).status, 400);
  assert.equal((await request(smart, 'POST', '/oauth/token', { grant_type: 'authorization_code', client_id: clientId, code: old.code, redirect_uri: redirectUri })).status, 400);
  assert.equal((await request(smart, 'GET', authorization(launch.launchId!))).status, 400);
  const fresh = await db.smartAuthSession.create({ data: sessionData({ accessToken: crypto.randomUUID() }) });
  assert.equal((await verifySandboxAccess(db, sandbox, `Bearer ${fresh.accessToken}`, undefined, undefined,
    { method: 'GET', path: '/Patient/p1', resourceType: 'Patient' })).authorized, true);
});
