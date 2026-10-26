// Author: Preston Lee

import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { before, after, mock, test } from 'node:test';
import dns from 'node:dns/promises';
import https from 'node:https';
import { EventEmitter } from 'node:events';
import { Readable } from 'node:stream';
import { syncBuiltinESMExports } from 'node:module';
import { zipSync, strToU8 } from 'fflate';
import { access, mkdtemp, mkdir, readFile, rm, utimes, writeFile } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import type { Server } from 'node:http';
import express from 'express';
import { getPrisma, disconnectPrisma } from '../src/db/prisma.js';
import { createIntegrationOAuthRouter, integrationScopes, digest } from '../src/integrations/oauth.js';
import { createIntegrationRouter } from '../src/integrations/routes.js';
import { defaultStaticSmartContract } from '../src/integrations/catalog-contract.js';
import { importCatalogArtifact } from '../src/integrations/artifacts.js';
import { hostingErrorHandler } from '../src/hosted/routes.js';
import { loadHostingConfig } from '../src/hosted/config.js';
import { cleanupStorage } from '../src/hosted/filesystem.js';
import { createSessionAuth } from '../src/authentication/requireAuthentication.js';
import { loadEffectivePermissions } from '../src/authorization/effectivePermissions.js';
import { verifySandboxAccess } from '../src/fhir-gateway/security.js';
import type { OidcBffConfig } from '../src/auth/sso_config.js';
import type { JobExecutionContext } from '../src/jobs/types.js';

const databaseUrl = process.env.FHIR_STUDIO_INTEGRATION_TEST_DATABASE_URL || 'postgresql://fhir_studio_test:fhir-studio-test-only@127.0.0.1:55487/fhir_studio_integration';
const savedEnv = { ...process.env };
const ids = { owner: crypto.randomUUID(), stranger: crypto.randomUUID(), admin: crypto.randomUUID(), role: crypto.randomUUID(), adminRole: crypto.randomUUID(), sandbox: crypto.randomUUID() };
const clients: string[] = [];
const sandboxSlug = `integration-${crypto.randomUUID()}`;
let root: string; let server: Server; let origin: string;
let client: { id: string; client_secret: string };
let ownerToken: { access_token: string; refresh_token: string };
let applicationId: string; let operationId: string;
const callback = 'https://skycapp.example.test/settings/fhir-studio/callback';

before(async () => {
  assert.ok(new URL(databaseUrl).pathname.includes('integration'), 'Use the disposable integration test database.');
  root = await mkdtemp(path.join(os.tmpdir(), 'studio-integration-security-'));
  Object.assign(process.env, {
    NODE_ENV: 'test', FHIR_STUDIO_SERVER_DATABASE_URL: databaseUrl, DATABASE_URL: databaseUrl,
    FHIR_STUDIO_INTEGRATION_ENABLED: 'true', FHIR_STUDIO_INTEGRATION_ISSUER: 'https://studio.example/integration',
    FHIR_STUDIO_HOSTING_ENABLED: 'true', FHIR_STUDIO_HOSTING_ROOT: root,
    FHIR_STUDIO_HOSTING_DOMAIN: 'apps.studio.example', FHIR_STUDIO_HOSTING_STUDIO_ORIGIN: 'https://studio.example',
    FHIR_STUDIO_HOSTING_ANALYTICS_KEY: crypto.randomBytes(32).toString('base64'),
    FHIR_STUDIO_HOSTING_ENCRYPTION_KEY: crypto.randomBytes(32).toString('base64'),
    FHIR_STUDIO_SERVER_UI_BASE_URL: 'https://studio.example',
    FHIR_STUDIO_HAPI_R4_ENABLED: 'true', FHIR_STUDIO_HAPI_R4_BASE_URL: 'http://127.0.0.1:1/fhir',
    FHIR_STUDIO_HAPI_R4B_ENABLED: 'false', FHIR_STUDIO_HAPI_R5_ENABLED: 'false',
  });
  for (const key of Object.keys(process.env)) if (key.startsWith('FHIR_STUDIO_HOSTING_GITHUB_')) delete process.env[key];
  const db = getPrisma();
  await db.role.create({ data: { id: ids.role, name: `Integration deployer ${ids.role}`, permission_applications_deployment: true, permission_applications_register: true } });
  await db.role.create({ data: { id: ids.adminRole, name: `Integration administrator ${ids.adminRole}`, permission_applications_deployment: true, permission_applications_register: true, permission_global_manage: true } });
  for (const [name, id] of Object.entries({ owner: ids.owner, stranger: ids.stranger, admin: ids.admin })) {
    await db.user.create({ data: { id, ssoIssuer: `integration-${ids.owner}`, ssoSubject: name, email: `${id}@example.test` } });
    await db.appointment.create({ data: { entityType: 'User', entityId: id, roleId: name === 'admin' ? ids.adminRole : ids.role } });
  }
  await db.sandbox.create({ data: { id: ids.sandbox, sandboxId: sandboxSlug, name: 'Integration test sandbox', partitionId: 999999, fhirVersion: 'R4', createdByUserId: ids.owner } });
  const app = express();
  app.use(express.json(), express.urlencoded({ extended: false }));
  const oidc = { databaseUrl, apiTokenPepper: 'integration-api-token-pepper' } as OidcBffConfig;
  const auth = createSessionAuth(oidc);
  app.use(auth.optionalAuthentication);
  // Browser identity is explicit in this fixture; integration bearer requests receive no browser headers.
  app.use(async (req, _res, next) => {
    const userId = req.get('x-test-user');
    if (userId && [ids.owner, ids.stranger, ids.admin].includes(userId)) {
      req.sessionAuth = { userId, sessionId: req.get('x-test-session') || userId, sub: userId, ssoRoles: [], email: null, displayName: userId, isSuspended: false };
      req.effectivePermissions = await loadEffectivePermissions(db, userId);
    }
    next();
  });
  app.get('/api/control-plane-test', auth.requireAuthentication, (_req, res) => res.json({ allowed: true }));
  app.use(createIntegrationOAuthRouter(), createIntegrationRouter(), hostingErrorHandler);
  app.use((error: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) => res.status(500).json({ error: error instanceof Error ? error.message : 'Unexpected error' }));
  server = await new Promise<Server>(resolve => { const current = app.listen(0, '127.0.0.1', () => resolve(current)); });
  const address = server.address(); assert.ok(address && typeof address !== 'string'); origin = `http://127.0.0.1:${address.port}`;
});

after(async () => {
  if (server?.listening) await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  const db = getPrisma();
  const apps = await db.hostedApplication.findMany({ where: { integrationClientId: { in: clients } }, select: { id: true } });
  const appIds = apps.map(app => app.id);
  const jobs = await db.integrationOperation.findMany({ where: { clientId: { in: clients } }, select: { jobId: true } });
  const grantIds = (await db.integrationGrant.findMany({ where: { clientId: { in: clients } }, select: { id: true } })).map(grant => grant.id);
  await db.integrationRetiredToken.deleteMany({ where: { grantId: { in: grantIds } } });
  await db.hostedApplication.deleteMany({ where: { id: { in: appIds } } });
  await db.integrationOperation.deleteMany({ where: { clientId: { in: clients } } });
  await db.job.deleteMany({ where: { id: { in: jobs.map(job => job.jobId).filter((id): id is string => !!id) } } });
  await db.integrationClient.deleteMany({ where: { id: { in: clients } } });
  await db.sandbox.deleteMany({ where: { id: ids.sandbox } });
  await db.hostedOwnerQuota.deleteMany({ where: { userId: ids.owner } });
  await db.appointment.deleteMany({ where: { roleId: { in: [ids.role, ids.adminRole] } } });
  await db.role.deleteMany({ where: { id: { in: [ids.role, ids.adminRole] } } });
  await db.user.deleteMany({ where: { id: { in: [ids.owner, ids.stranger, ids.admin] } } });
  await disconnectPrisma();
  if (root) await rm(root, { recursive: true, force: true });
  for (const key of Object.keys(process.env)) if (!(key in savedEnv)) delete process.env[key];
  Object.assign(process.env, savedEnv);
});

function request(endpoint: string, options: { method?: string; body?: unknown; user?: string; session?: string; token?: string; key?: string } = {}) {
  return fetch(`${origin}${endpoint}`, { method: options.method || 'GET', redirect: 'manual', headers: {
    ...(options.user ? { 'x-test-user': options.user } : {}), ...(options.session ? { 'x-test-session': options.session } : {}),
    ...(options.token ? { Authorization: `Bearer ${options.token}` } : {}), ...(options.key ? { 'Idempotency-Key': options.key } : {}),
    ...(options.body === undefined ? {} : { 'Content-Type': 'application/json' }),
  }, ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }) });
}
async function createClient(name: string) {
  const response = await request('/api/admin/integration-clients', { method: 'POST', user: ids.admin, body: { name, redirect_uris: [callback], scopes: integrationScopes, enabled: true } });
  assert.equal(response.status, 201, await response.clone().text());
  const result = await response.json() as { id: string; client_secret: string }; clients.push(result.id); return result;
}
async function authorization(user = ids.owner, selected = client, scopes = integrationScopes.join(' ')) {
  const verifier = crypto.randomBytes(48).toString('base64url');
  const query = new URLSearchParams({ client_id: selected.id, redirect_uri: callback, response_type: 'code', scope: scopes, state: crypto.randomBytes(32).toString('base64url'), code_challenge_method: 'S256', code_challenge: crypto.createHash('sha256').update(verifier).digest('base64url') });
  const response = await request(`/api/integration/authorization?${query}`, { user });
  assert.equal(response.status, 200, await response.clone().text());
  const result = await response.json() as { request_id: string };
  return { ...result, verifier, query, user, selected };
}
async function approve(flow: Awaited<ReturnType<typeof authorization>>) {
  const response = await request(`/api/integration/authorization/${flow.request_id}`, { method: 'POST', user: flow.user, body: { approve: true } });
  assert.equal(response.status, 200, await response.clone().text());
  const result = await response.json() as { redirect_url: string }; return new URL(result.redirect_url);
}
function token(fields: Record<string, string>, selected = client) {
  return fetch(`${origin}/integration/token`, { method: 'POST', headers: { Authorization: `Basic ${Buffer.from(`${encodeURIComponent(selected.id)}:${encodeURIComponent(selected.client_secret)}`).toString('base64')}`, 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams(fields) });
}
async function grant(user = ids.owner, selected = client, scopes = integrationScopes.join(' ')) {
  const flow = await authorization(user, selected, scopes); const result = await approve(flow);
  assert.equal(result.searchParams.get('iss'), 'https://studio.example/integration'); assert.equal(result.searchParams.get('state'), flow.query.get('state'));
  const response = await token({ grant_type: 'authorization_code', code: result.searchParams.get('code')!, redirect_uri: callback, code_verifier: flow.verifier }, selected);
  assert.equal(response.status, 200, await response.clone().text()); return await response.json() as { access_token: string; refresh_token: string };
}
function deploymentBody() {
  const contract = defaultStaticSmartContract(); contract.callback_paths = ['callback.html', 'finish.html'];
  contract.public_configuration = [{ name: 'greeting', label: 'Greeting', type: 'string', required: true, default: 'Hello' }];
  return { name: 'Catalog integration test', mode: 'install', artifact: { id: crypto.randomUUID(), build_id: crypto.randomUUID(), name: 'Static app', format_version: 1, resolver: 'public-https', locator: { url: 'https://cdn.example.test/app.zip' }, immutable_id: 'v1', sha256: 'a'.repeat(64), archive_root: '' }, runtime_contract: contract, source_project: null, configuration: { greeting: 'Hello' }, sandboxId: sandboxSlug, origin: { installation_id: crypto.randomUUID(), deployment_id: crypto.randomUUID(), product_id: crypto.randomUUID(), build_id: crypto.randomUUID() } };
}

test('separates browser-only administration and consent from integration bearer authority', async () => {
  assert.equal((await request('/api/admin/integration-clients')).status, 401);
  assert.equal((await request('/api/admin/integration-clients', { user: ids.owner })).status, 403);
  client = await createClient('Skycapp integration test');
  const capabilities = await (await request('/api/integration/v1/capabilities')).json() as { api_version: number; hosting_available: boolean };
  assert.equal(capabilities.api_version, 1); assert.equal(capabilities.hosting_available, true);
  ownerToken = await grant();
  assert.match(ownerToken.access_token, /^fsi_access_/); assert.match(ownerToken.refresh_token, /^fsi_refresh_/);
  assert.equal((await request('/api/control-plane-test', { token: ownerToken.access_token })).status, 401);
  const sandbox = await getPrisma().sandbox.findUniqueOrThrow({ where: { id: ids.sandbox } });
  assert.equal((await verifySandboxAccess(getPrisma(), sandbox, `Bearer ${ownerToken.access_token}`, undefined, undefined)).authorized, false);
  assert.equal((await request('/api/integration/connections', { token: ownerToken.access_token })).status, 401);
});

test('rejects callback substitution, cross-user/session consent, PKCE failure and code replay', async () => {
  const flow = await authorization();
  assert.equal((await request(`/api/integration/authorization?${new URLSearchParams({ ...Object.fromEntries(flow.query), redirect_uri: 'https://attacker.example/callback' })}`, { user: ids.owner })).status, 400);
  assert.equal((await request(`/api/integration/authorization/${flow.request_id}`, { method: 'POST', user: ids.stranger, body: { approve: true } })).status, 400);
  assert.equal((await request(`/api/integration/authorization/${flow.request_id}`, { method: 'POST', user: ids.owner, session: crypto.randomUUID(), body: { approve: true } })).status, 400);
  const redirect = await approve(flow); const code = redirect.searchParams.get('code')!;
  assert.equal((await token({ grant_type: 'authorization_code', code, redirect_uri: callback, code_verifier: 'wrong'.repeat(15) })).status, 400);
  const fields = { grant_type: 'authorization_code', code, redirect_uri: callback, code_verifier: flow.verifier };
  assert.equal((await token(fields)).status, 200); assert.equal((await token(fields)).status, 400);
});

test('rotation rejects old access and revokes the refresh family on replay from two rotations ago', async () => {
  const initial = await grant();
  const firstResponse = await token({ grant_type: 'refresh_token', refresh_token: initial.refresh_token }); assert.equal(firstResponse.status, 200);
  const first = await firstResponse.json() as typeof initial;
  const secondResponse = await token({ grant_type: 'refresh_token', refresh_token: first.refresh_token }); assert.equal(secondResponse.status, 200);
  const second = await secondResponse.json() as typeof initial;
  assert.equal((await request('/api/integration/v1/account', { token: initial.access_token })).status, 401);
  assert.equal((await token({ grant_type: 'refresh_token', refresh_token: initial.refresh_token })).status, 400);
  assert.equal((await request('/api/integration/v1/account', { token: second.access_token })).status, 403);
  const revocable = await grant();
  const rotated = await (await token({ grant_type: 'refresh_token', refresh_token: revocable.refresh_token })).json() as typeof revocable;
  const latest = await (await token({ grant_type: 'refresh_token', refresh_token: rotated.refresh_token })).json() as typeof revocable;
  const revocation = await fetch(`${origin}/integration/revoke`, { method: 'POST', headers: { Authorization: `Basic ${Buffer.from(`${client.id}:${client.client_secret}`).toString('base64')}`, 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ token: revocable.refresh_token }) });
  assert.equal(revocation.status, 200);
  assert.equal((await request('/api/integration/v1/account', { token: latest.access_token })).status, 403, 'Revoking an older family token must invalidate current authority.');
});

test('intersects grant scope and current account permission without borrowing a browser session', async () => {
  const limited = await grant(ids.owner, client, 'account:read');
  assert.equal((await request('/api/integration/v1/account', { token: limited.access_token })).status, 200);
  assert.equal((await request('/api/integration/v1/sandboxes', { token: limited.access_token, user: ids.admin })).status, 403);
  await getPrisma().user.update({ where: { id: ids.owner }, data: { isSuspended: true } });
  try { assert.equal((await request('/api/integration/v1/account', { token: ownerToken.access_token })).status, 403); }
  finally { await getPrisma().user.update({ where: { id: ids.owner }, data: { isSuspended: false } }); }
});

test('preflights and queues public static releases without GitHub credentials, preserving idempotency', async () => {
  assert.equal(loadHostingConfig().appId, '');
  const body = deploymentBody(); const key = crypto.randomUUID();
  const preflight = await request('/api/integration/v1/preflight', { method: 'POST', token: ownerToken.access_token, body });
  assert.equal(preflight.status, 200); assert.equal((await preflight.json() as { ready: boolean }).ready, true);
  const response = await request('/api/integration/v1/deployments', { method: 'POST', token: ownerToken.access_token, body, key });
  assert.equal(response.status, 202, await response.clone().text());
  const operation = await response.json() as { id: string; application_id: string }; applicationId = operation.application_id; operationId = operation.id;
  const duplicate = await request('/api/integration/v1/deployments', { method: 'POST', token: ownerToken.access_token, body, key });
  assert.equal(duplicate.status, 202); assert.equal((await duplicate.json() as { id: string }).id, operation.id);
  assert.equal((await request('/api/integration/v1/deployments', { method: 'POST', token: ownerToken.access_token, body: { ...body, configuration: { greeting: 'Changed' } }, key })).status, 409);
  const stranger = await grant(ids.stranger);
  assert.equal((await request(`/api/integration/v1/applications/${applicationId}`, { token: stranger.access_token })).status, 404);
  const secondClient = await createClient('Different integration'); const differentClientGrant = await grant(ids.owner, secondClient);
  assert.equal((await request(`/api/integration/v1/applications/${applicationId}`, { token: differentClientGrant.access_token })).status, 404);
});

test('publishes only an explicitly reviewed revision and atomically enables its managed sandbox', async () => {
  const db = getPrisma(); const build = await db.hostedBuild.findFirstOrThrow({ where: { applicationId } });
  const content = path.join(root, 'apps', applicationId, build.id);
  await mkdir(content, { recursive: true });
  for (const file of ['index.html', 'callback.html', 'finish.html']) await writeFile(path.join(content, file), '<html>Test app</html>');
  await db.hostedBuild.update({ where: { id: build.id }, data: { status: 'READY', directory: content } });
  await db.hostedApplication.update({ where: { id: applicationId }, data: { previewBuildId: build.id } });
  const payload = { buildId: build.id, sandboxId: sandboxSlug };
  assert.equal((await request(`/api/integration/v1/applications/${applicationId}/publish`, { method: 'POST', token: ownerToken.access_token, body: payload })).status, 409);
  assert.equal((await request(`/api/integration/applications/${applicationId}/review`, { method: 'POST', user: ids.owner, body: { revision_id: build.id } })).status, 200);
  const published = await request(`/api/integration/v1/applications/${applicationId}/publish`, { method: 'POST', token: ownerToken.access_token, body: payload });
  assert.equal(published.status, 200, await published.clone().text());
  assert.equal(await db.hostedSandbox.count({ where: { applicationId, sandboxId: ids.sandbox } }), 1);
  const registered = await db.application.findMany({ where: { hostedApplicationId: applicationId } });
  assert.ok(registered.every(client => (client.redirectUris as string[]).some(uri => uri.endsWith('/finish.html'))), 'All declared callbacks must be registered.');
  const app = await db.hostedApplication.findUniqueOrThrow({ where: { id: applicationId } });
  assert.equal(app.publishedBuildId, build.id);
});

test('configuration revisions reuse validated content at quota, preserve publication, and require a new exact review', async () => {
  const db = getPrisma();
  const previous = await db.hostedApplication.findUniqueOrThrow({ where: { id: applicationId } });
  const original = await db.hostedBuild.findUniqueOrThrow({ where: { id: previous.publishedBuildId! } });
  const operation = await db.integrationOperation.findUniqueOrThrow({ where: { id: operationId } });
  const body = { ...operation.request as Record<string, unknown>, application_id: applicationId, configuration: { greeting: 'Updated greeting' } };
  await db.hostedOwnerQuota.create({ data: { userId: ids.owner, applicationLimit: 1 } });
  try {
    const preflight = await request('/api/integration/v1/preflight', { method: 'POST', token: ownerToken.access_token, body });
    assert.equal(preflight.status, 200); assert.equal((await preflight.json() as { ready: boolean }).ready, true, 'Updating an application does not consume another application slot.');
    const invalid = { ...body, runtime_contract: { ...(body.runtime_contract as Record<string, unknown>), callback_paths: ['callback.html', 'missing.html'] } };
    assert.equal((await request(`/api/integration/v1/applications/${applicationId}/preview`, { method: 'POST', token: ownerToken.access_token, body: invalid, key: crypto.randomUUID() })).status, 400);
    assert.equal((await db.hostedApplication.findUniqueOrThrow({ where: { id: applicationId } })).publishedBuildId, original.id);
    const response = await request(`/api/integration/v1/applications/${applicationId}/preview`, { method: 'POST', token: ownerToken.access_token, body, key: crypto.randomUUID() });
    assert.equal(response.status, 202, await response.clone().text());
    const app = await db.hostedApplication.findUniqueOrThrow({ where: { id: applicationId } });
    assert.equal(app.publishedBuildId, original.id); assert.notEqual(app.previewBuildId, original.id);
    const preview = await db.hostedBuild.findUniqueOrThrow({ where: { id: app.previewBuildId! } });
    assert.equal(preview.status, 'READY'); assert.equal(preview.directory, original.directory); assert.equal(preview.contentBuildId, original.id);
    assert.deepEqual(preview.publicConfiguration, { greeting: 'Updated greeting' });
    assert.deepEqual((await db.hostedBuild.findUniqueOrThrow({ where: { id: original.id } })).publicConfiguration, { greeting: 'Hello' });
    assert.equal((await request(`/api/integration/v1/applications/${applicationId}/publish`, { method: 'POST', token: ownerToken.access_token, body: { buildId: preview.id, sandboxId: sandboxSlug } })).status, 409);
    assert.equal((await request(`/api/integration/applications/${applicationId}/review`, { method: 'POST', user: ids.owner, body: { revision_id: preview.id } })).status, 200);
    assert.equal((await request(`/api/integration/v1/applications/${applicationId}/publish`, { method: 'POST', token: ownerToken.access_token, body: { buildId: preview.id, sandboxId: sandboxSlug } })).status, 200);
    const old = new Date(Date.now() - 20 * 60_000); await utimes(original.directory!, old, old);
    await cleanupStorage(loadHostingConfig());
    await access(path.join(original.directory!, 'index.html'));
  } finally { await db.hostedOwnerQuota.deleteMany({ where: { userId: ids.owner } }); }
});

test('reducing the registered client scopes immediately restricts existing grants and refreshes', async () => {
  const delegated = await grant();
  const scopes = integrationScopes.filter(scope => scope !== 'projects:create' && scope !== 'applications:publish');
  const settings = { name: 'Skycapp integration test', redirect_uris: [callback], scopes, enabled: true };
  assert.equal((await request(`/api/admin/integration-clients/${client.id}`, { method: 'PATCH', user: ids.admin, body: settings })).status, 200);
  try {
    assert.equal((await request('/api/integration/v1/account', { token: delegated.access_token })).status, 200);
    assert.equal((await request('/api/integration/v1/source-options', { token: delegated.access_token })).status, 403);
    const current = await getPrisma().hostedApplication.findUniqueOrThrow({ where: { id: applicationId } });
    assert.equal((await request(`/api/integration/v1/applications/${applicationId}/publish`, { method: 'POST', token: delegated.access_token, body: { buildId: current.previewBuildId, sandboxId: sandboxSlug } })).status, 403);
    const refresh = await token({ grant_type: 'refresh_token', refresh_token: delegated.refresh_token });
    assert.equal(refresh.status, 200);
    const refreshed = await refresh.json() as { scope: string; access_token: string };
    assert.equal(refreshed.scope.split(' ').includes('projects:create'), false);
    assert.equal(refreshed.scope.split(' ').includes('applications:publish'), false);
    assert.equal((await request('/api/integration/v1/source-options', { token: refreshed.access_token })).status, 403);
  } finally {
    assert.equal((await request(`/api/admin/integration-clients/${client.id}`, { method: 'PATCH', user: ids.admin, body: { ...settings, scopes: integrationScopes } })).status, 200);
  }
});

test('imports a validated public archive through the real worker without GitHub and rechecks authority before activation', async () => {
  const db = getPrisma(); const delegated = await grant();
  const archive = zipSync({ 'index.html': strToU8('<html>Launch</html>'), 'callback.html': strToU8('<html>Callback</html>'), 'finish.html': strToU8('<html>Finish</html>') });
  const hash = crypto.createHash('sha256').update(archive).digest('hex');
  const lookup = mock.method(dns, 'lookup', async () => [{ address: '93.184.216.34', family: 4 }]);
  syncBuiltinESMExports();
  const download = mock.method(https, 'get', (_url: unknown, options: { headers?: Record<string, unknown> }, callback: (response: unknown) => void) => {
    assert.equal(options.headers?.Authorization, undefined);
    const request = new EventEmitter();
    process.nextTick(() => { const response = Readable.from([archive]); Object.assign(response, { statusCode: 200, headers: { 'content-length': String(archive.length) } }); callback(response); });
    return request;
  });
  try {
    for (const outcome of ['valid', 'digest', 'scope', 'revoked']) {
      const body = deploymentBody(); body.artifact.sha256 = outcome === 'digest' ? 'b'.repeat(64) : hash;
      const response = await request('/api/integration/v1/deployments', { method: 'POST', token: delegated.access_token, body, key: crypto.randomUUID() });
      assert.equal(response.status, 202, await response.clone().text()); const op = await response.json() as { id: string; application_id: string };
      const operation = await db.integrationOperation.findUniqueOrThrow({ where: { id: op.id } });
      const job = await db.job.update({ where: { id: operation.jobId! }, data: { status: 'in_progress', lockedBy: 'integration-test-worker', leaseExpiresAt: new Date(Date.now() + 300_000) } });
      const context = { job, signal: new AbortController().signal, prisma: db, updateProgress: async (progress: number) => {
        if (outcome === 'revoked' && progress === 40) await db.integrationGrant.update({ where: { refreshTokenHash: digest(delegated.refresh_token) }, data: { revokedAt: new Date() } });
        if (outcome === 'scope' && progress === 40) await db.integrationClient.update({ where: { id: client.id }, data: { scopes: integrationScopes.filter(scope => scope !== 'applications:write') } });
      }, isCancelled: async () => false } as JobExecutionContext;
      if (outcome === 'valid') {
        await importCatalogArtifact(context);
        const app = await db.hostedApplication.findUniqueOrThrow({ where: { id: op.application_id } });
        assert.ok(app.previewBuildId); const build = await db.hostedBuild.findUniqueOrThrow({ where: { id: app.previewBuildId! } });
        assert.equal(build.status, 'READY'); assert.equal(await readFile(path.join(build.directory!, 'index.html'), 'utf8'), '<html>Launch</html>');
      } else {
        await assert.rejects(importCatalogArtifact(context), outcome === 'digest' ? /integrity/ : /revoked|required scope/);
        const app = await db.hostedApplication.findUniqueOrThrow({ where: { id: op.application_id } }); assert.equal(app.previewBuildId, null);
        assert.equal((await db.hostedBuild.findFirstOrThrow({ where: { applicationId: app.id } })).status, 'FAILED');
      }
      if (outcome === 'scope') await db.integrationClient.update({ where: { id: client.id }, data: { scopes: integrationScopes } });
    }
    assert.equal(download.mock.callCount(), 4);
  } finally { await db.integrationClient.update({ where: { id: client.id }, data: { scopes: integrationScopes } }); download.mock.restore(); lookup.mock.restore(); syncBuiltinESMExports(); }
});

test('disabling integration preserves metadata, browser revocation, and hosted applications', async () => {
  const delegated = await grant();
  process.env.FHIR_STUDIO_INTEGRATION_ENABLED = 'false';
  try {
    assert.equal((await request('/.well-known/oauth-authorization-server/integration')).status, 200, 'Discovery stays available so clients can find revocation.');
    assert.equal((await request('/api/integration/v1/account', { token: delegated.access_token })).status, 503);
    assert.equal((await request('/api/integration/connections', { user: ids.owner })).status, 200);
    const revoke = await fetch(`${origin}/integration/revoke`, { method: 'POST', headers: { Authorization: `Basic ${Buffer.from(`${client.id}:${client.client_secret}`).toString('base64')}`, 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ token: delegated.refresh_token }) });
    assert.equal(revoke.status, 200);
    const stored = await getPrisma().integrationGrant.findUniqueOrThrow({ where: { refreshTokenHash: digest(delegated.refresh_token) } }); assert.ok(stored.revokedAt);
    assert.ok((await getPrisma().hostedApplication.findUniqueOrThrow({ where: { id: applicationId } })).publishedBuildId);
  } finally { process.env.FHIR_STUDIO_INTEGRATION_ENABLED = 'true'; }
});

test('revocation blocks queued activation and subsequent operations while retaining existing hosting', async () => {
  const db = getPrisma(); const body = deploymentBody();
  const response = await request('/api/integration/v1/deployments', { method: 'POST', token: ownerToken.access_token, body, key: crypto.randomUUID() });
  assert.equal(response.status, 202); const op = await response.json() as { id: string; application_id: string };
  const operation = await db.integrationOperation.findUniqueOrThrow({ where: { id: op.id } }); const job = await db.job.findUniqueOrThrow({ where: { id: operation.jobId! } });
  const revoke = await fetch(`${origin}/integration/revoke`, { method: 'POST', headers: { Authorization: `Basic ${Buffer.from(`${client.id}:${client.client_secret}`).toString('base64')}`, 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ token: ownerToken.refresh_token }) }); assert.equal(revoke.status, 200);
  await assert.rejects(importCatalogArtifact({ job, signal: new AbortController().signal, prisma: db, updateProgress: async () => {}, isCancelled: async () => false } as JobExecutionContext));
  const app = await db.hostedApplication.findUniqueOrThrow({ where: { id: op.application_id } }); assert.equal(app.previewBuildId, null);
  assert.equal((await request(`/api/integration/v1/operations/${operationId}`, { token: ownerToken.access_token })).status, 403);
  assert.ok((await db.hostedApplication.findUniqueOrThrow({ where: { id: applicationId } })).publishedBuildId);
});
