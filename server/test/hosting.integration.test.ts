import { apiUsage } from '../src/hosted/usage.js';
import { before, after, test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import {
  mkdtemp,
  writeFile,
  mkdir,
  rm,
  utimes,
  access,
} from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import pg from 'pg';
import express from 'express';
import cookieParser from 'cookie-parser';
import type { Server } from 'node:http';
import http from 'node:http';
import net from 'node:net';
import { WebSocket } from 'ws';
import { SubscriptionHub } from '../src/subscriptions/hub.js';
import { hmacSign } from '../src/authentication/hmac.js';
import { SESSION_COOKIE } from '../src/authentication/session.js';
import { zipSync, strToU8 } from 'fflate';
import { createDefaultEffectivePermissions } from '../../core/src/rbac.js';
import { getPrisma, disconnectPrisma } from '../src/db/prisma.js';
import { loadEffectivePermissions } from '../src/authorization/effectivePermissions.js';
import { createAdministrationRouter } from '../src/administration/routes.js';
import { loadHostingConfig } from '../src/hosted/config.js';
import {
  createHostingRouter,
  hostingErrorHandler,
} from '../src/hosted/routes.js';
import {
  browserSecurity,
  controlPlaneAuthentication,
} from '../src/authentication/browser-security.js';
import type { OidcBffConfig } from '../src/auth/sso_config.js';
import { encrypt, userToken } from '../src/hosted/github.js';
import {
  provisionClients,
  reconcileRun,
  importBuild,
  publisherForRun,
  reconcileJob,
} from '../src/hosted/builds.js';
import { createGitHubWebhookRouter } from '../src/hosted/webhooks.js';
import { createSmartIdpRouter } from '../src/smart-idp/routes.js';
import {
  buildDirectory,
  cleanupStorage,
  reserveStorage,
} from '../src/hosted/filesystem.js';
import { verifySandboxAccess } from '../src/fhir-gateway/security.js';
import { createFhirGatewayRouter } from '../src/fhir-gateway/proxy.js';
import type { JobExecutionContext } from '../src/jobs/types.js';
import type { GitHubRun } from '../src/hosted/github.js';
import { ClientKeyResolver } from '../src/smart-idp/client-keys.js';

const adminUrl =
  process.env.FHIR_STUDIO_TEST_ADMIN_DATABASE_URL ||
  'postgresql://postgres:password@127.0.0.1:5433/postgres';
const database = `fhir_studio_hosting_test_${crypto.randomBytes(6).toString('hex')}`;
const admin = new pg.Pool({
  connectionString: adminUrl,
  connectionTimeoutMillis: 5000,
});
const realFetch = globalThis.fetch;
let root: string;
let server: Server;
let backend: Server;
let host: ReturnType<typeof spawn> | undefined;
let origin: string;
let created = false;
let refreshes = 0;
let refreshStatus = 200;
let badDigest = false;
let appId: string;
let activeRun: GitHubRun;
let zip: Uint8Array;
let currentHead = 'a'.repeat(40);
let deploymentRoleId: string;
let revokeBeforeActivation = false;
let remoteClientKeys: unknown;
let remoteKeyDownloads = 0;
const fhirRequests: Array<{ method: string; path: string; query: unknown; body: unknown; prefer?: string; ifMatch?: string }> = [];
const users = {
  owner: crypto.randomUUID(),
  manager: crypto.randomUUID(),
  developer: crypto.randomUUID(),
  viewer: crypto.randomUUID(),
  stranger: crypto.randomUUID(),
  operator: crypto.randomUUID(),
};

before(async () => {
  await admin.query(`CREATE DATABASE "${database}"`);
  created = true;
  const url = new URL(adminUrl);
  url.pathname = `/${database}`;
  root = await mkdtemp(path.join(os.tmpdir(), 'studio-hosting-integration-'));
  Object.assign(process.env, {
    NODE_ENV: 'test',
    FHIR_STUDIO_HOSTING_ENABLED: 'true',
    FHIR_STUDIO_HOSTING_ANALYTICS_KEY: crypto.randomBytes(32).toString('base64'),
    FHIR_STUDIO_SERVER_DATABASE_URL: url.href,
    DATABASE_URL: url.href,
    FHIR_STUDIO_HOSTING_DOMAIN: 'user.studio.test',
    FHIR_STUDIO_HOSTING_ROOT: root,
    FHIR_STUDIO_HOSTING_STUDIO_ORIGIN: 'http://studio.test',
    FHIR_STUDIO_SERVER_UI_BASE_URL: 'http://studio.test',
    FHIR_STUDIO_HAPI_R4_ENABLED: 'true',
    FHIR_STUDIO_HAPI_R4_BASE_URL: 'http://127.0.0.1:1/fhir',
    FHIR_STUDIO_HAPI_R4B_ENABLED: 'false',
    FHIR_STUDIO_HAPI_R5_ENABLED: 'false',
    FHIR_STUDIO_HOSTING_ENCRYPTION_KEY: crypto
      .randomBytes(32)
      .toString('base64'),
    FHIR_STUDIO_HOSTING_GITHUB_APP_ID: '1',
    FHIR_STUDIO_HOSTING_GITHUB_CLIENT_ID: 'client',
    FHIR_STUDIO_HOSTING_GITHUB_CLIENT_SECRET: 'secret',
    FHIR_STUDIO_HOSTING_GITHUB_PRIVATE_KEY: crypto.generateKeyPairSync('rsa', {
      modulusLength: 2048,
      privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
      publicKeyEncoding: { type: 'spki', format: 'pem' },
    }).privateKey,
    FHIR_STUDIO_HOSTING_GITHUB_WEBHOOK_SECRET: 'webhook',
    FHIR_STUDIO_HOSTING_GITHUB_SLUG: 'studio-test',
  });
  const migrated = spawnSync(
    process.execPath,
    [
      fileURLToPath(
        new URL('../../node_modules/prisma/build/index.js', import.meta.url),
      ),
      'migrate',
      'deploy',
      '--config',
      fileURLToPath(new URL('../prisma.config.ts', import.meta.url)),
    ],
    { env: process.env, encoding: 'utf8' },
  );
  assert.equal(migrated.status, 0, migrated.stdout + migrated.stderr);
  const prisma = getPrisma();
  deploymentRoleId = (
    await prisma.role.create({
      data: {
        name: 'Application deployer',
        permission_applications_deployment: true,
      },
    })
  ).id;
  const fhir = express();
  fhir.use(express.urlencoded({ extended: false }), express.json());
  fhir.use((req, _res, next) => {
    fhirRequests.push({ method: req.method, path: req.path, query: req.query, body: req.body, prefer: req.get('Prefer'), ifMatch: req.get('If-Match') });
    next();
  });
  fhir.get('/fhir/:tenant/Binary/:id', (_req, res) =>
    res.type('html').send('<script>window.compromised = true</script>'),
  );
  const patient = { resourceType: 'Patient', id: 'p1', name: [{ text: '<Patient & One>' }] };
  fhir.get('/fhir/:tenant/Patient', (_req, res) => res.json({ resourceType: 'Bundle', entry: [{ resource: patient }] }));
  fhir.get('/fhir/:tenant/Patient/:id', (req, res) => req.params.id === 'p1' ? res.json(patient) : res.sendStatus(404));
  fhir.all('/fhir/:tenant/Patient/_search', (_req, res) => res.json({ resourceType: 'Bundle', entry: [{ resource: patient }] }));
  fhir.all('/fhir/:tenant/Patient/:patient/Observation{/_search}', (_req, res) => res.json({ resourceType: 'Bundle', entry: [{ resource: { resourceType: 'Observation', id: 'o1' } }] }));
  fhir.put('/fhir/:tenant/Observation/:id', (req, res) => {
    res.setHeader('ETag', 'W/"2"');
    res.setHeader('Preference-Applied', 'return=representation');
    res.json({ resourceType: 'Observation', id: req.params.id });
  });
  backend = await new Promise<Server>((resolve) => {
    const listening = fhir.listen(0, '127.0.0.1', () => resolve(listening));
  });
  const hapiAddress = backend.address();
  assert.ok(hapiAddress && typeof hapiAddress !== 'string');
  process.env.FHIR_STUDIO_HAPI_R4_BASE_URL = `http://127.0.0.1:${hapiAddress.port}/fhir`;
  const cfg = loadHostingConfig()!;
  let id = 100;
  for (const [name, userId] of Object.entries(users)) {
    await prisma.user.create({
      data: {
        id: userId,
        ssoIssuer: 'test',
        ssoSubject: name,
        email: `${name}@example.test`,
      },
    });
    await setDeployment(name as keyof typeof users, true);
    await prisma.gitHubConnection.create({
      data: {
        userId,
        githubUserId: String(id++),
        login: name,
        encryptedTokens: encrypt(
          { access_token: `user-${name}`, refresh_token: `refresh-${name}` },
          cfg,
        ),
        expiresAt: new Date(Date.now() + 3_600_000),
        refreshExpiresAt: new Date(Date.now() + 86400_000),
      },
    });
  }
  await setDeployment('operator', false);
  const operatorRole = await prisma.role.create({
    data: { name: 'Operator', permission_global_manage: true },
  });
  await prisma.appointment.create({
    data: {
      entityType: 'User',
      entityId: users.operator,
      roleId: operatorRole.id,
    },
  });
  const app = await prisma.hostedApplication.create({
    data: {
      name: 'Test app',
      ownerUserId: users.owner,
      createdByUserId: users.owner,
      repositoryId: '42',
      repository: 'owner/repo',
      installationId: '7',
    },
  });
  appId = app.id;
  for (const [userId, role] of [
    [users.manager, 'MANAGE'],
    [users.developer, 'READ_WRITE'],
    [users.viewer, 'READ_ONLY'],
  ])
    await prisma.hostedCollaborator.create({
      data: { applicationId: appId, userId, role },
    });
  await provisionClients(app, cfg);
  globalThis.fetch = async (input, init) => {
    const url = new URL(
      typeof input === 'string'
        ? input
        : input instanceof URL
          ? input.href
          : input.url,
    );
    if (
      url.hostname === 'github.com' &&
      url.pathname === '/login/oauth/access_token'
    ) {
      refreshes++;
      if (refreshStatus !== 200)
        return Response.json(
          { error: 'temporarily_unavailable' },
          { status: refreshStatus },
        );
      await new Promise((resolve) => setTimeout(resolve, 20));
      return Response.json({
        access_token: 'renewed',
        refresh_token: 'rotated',
        expires_in: 28800,
        refresh_token_expires_in: 15897600,
      });
    }
    if (url.hostname.endsWith('.blob.core.windows.net'))
      return new Response(zip);
    if (url.hostname !== 'api.github.com') return realFetch(input, init);
    const auth = new Headers(init?.headers).get('authorization') || '';
    if (url.pathname === '/user') return Response.json({ id: 100, login: 'owner' });
    if (url.pathname === '/user/repos' && init?.method === 'POST') return Response.json({ id: 42, full_name: 'owner/new-app', default_branch: 'main', private: true });
    if (url.pathname === '/user/installations/7/repositories') return Response.json({ repositories: [{ id: 42 }] });
    if (url.pathname === '/repos/owner/repo/git/ref/heads/main') return Response.json({ object: { sha: currentHead } });
    if (url.pathname.startsWith('/repos/owner/repo/git/commits/')) return Response.json({ tree: { sha: currentHead } });
    if (url.pathname === '/repos/owner/repo/git/trees' || url.pathname === '/repos/owner/repo/git/commits') return Response.json({ sha: currentHead });
    if (url.pathname === '/repos/owner/repo/git/refs/heads/main') return Response.json({});
    if (url.pathname.endsWith('/access_tokens'))
      return Response.json({ token: 'installation' });
    if (url.pathname === '/repositories/42') {
      if (auth.includes('user-viewer-denied'))
        return Response.json({}, { status: 404 });
      return Response.json({
        id: 42,
        full_name: 'owner/repo',
        default_branch: 'main',
        private: false,
        permissions: { push: !auth.includes('viewer') },
      });
    }
    if (url.pathname.endsWith('/commits/main')) {
      if (revokeBeforeActivation) {
        revokeBeforeActivation = false;
        await setDeployment('owner', false);
      }
      return Response.json({ sha: currentHead });
    }
    if (/\/actions\/runs\/\d+$/.test(url.pathname))
      return Response.json(activeRun);
    if (url.pathname.endsWith('/artifacts'))
      return Response.json({
        artifacts: [
          {
            id: 9,
            name: `studio-${appId}-${activeRun.id}-${activeRun.run_attempt}`,
            expired: false,
            digest: badDigest
              ? 'sha256:invalid'
              : `sha256:${crypto.createHash('sha256').update(zip).digest('hex')}`,
          },
        ],
      });
    if (url.pathname.endsWith('/zip'))
      return new Response(null, {
        status: 302,
        headers: {
          location: 'https://test.blob.core.windows.net/artifact.zip',
        },
      });
    return Response.json(
      { message: `Unexpected fixture ${url.pathname}` },
      { status: 404 },
    );
  };
  const api = express();
  api.use(createGitHubWebhookRouter());
  api.use(
    browserSecurity({
      corsOrigins: ['http://studio.test'],
      redirectUrl: 'http://studio.test/sso/callback',
      uiBaseUrl: 'http://studio.test',
    } as OidcBffConfig),
  );
  api.use(cookieParser());
  api.use(express.json());
  api.use(express.urlencoded({ extended: false }));
  api.use(
    controlPlaneAuthentication(async (req, _res, next) => {
      const name = req.get('x-test-user') as keyof typeof users;
      if (users[name]) {
        req.sessionAuth = {
          userId: users[name],
          sessionId: 'test',
          sub: name,
          ssoRoles: [],
          isSuspended: false,
          email: null,
          displayName: name,
        };
        req.effectivePermissions = await loadEffectivePermissions(
          prisma,
          users[name],
        );
      }
      next();
    }),
  );
  api.use(createHostingRouter());
  api.use(createSmartIdpRouter({ clientKeys: new ClientKeyResolver(async url => {
    assert.equal(url, 'https://keys.example.org/jwks.json');
    remoteKeyDownloads++;
    return { keys: remoteClientKeys, cacheControl: 'max-age=300' };
  }) }));
  api.get('/api/sandboxes/test/fhir/r4/authority', (_req, res) =>
    res.json({
      isolated: !!res.locals.smartBrowserOrigin,
      principal: !!_req.sessionAuth,
      cookies: Object.keys(_req.cookies || {}).length,
    }),
  );
  api.use(createFhirGatewayRouter());
  api.use(createAdministrationRouter());
  api.use(hostingErrorHandler);
  api.use(
    (
      error: Error,
      _req: express.Request,
      res: express.Response,
      _next: express.NextFunction,
    ) => res.status(500).json({ error: error.message }),
  );
  server = await new Promise<Server>((resolve) => {
    const listener = api.listen(0, '127.0.0.1', () => resolve(listener));
  });
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  origin = `http://127.0.0.1:${address.port}`;
  SubscriptionHub.getInstance().init(server, {
    corsOrigins: ['http://studio.test'],
    redirectUrl: 'http://studio.test/sso/callback',
    uiBaseUrl: 'http://studio.test',
    sessionSecrets: ['test-secret'],
    sessionIdleHours: 1,
    sessionAbsoluteHours: 2,
  } as OidcBffConfig);
});
after(async () => {
  globalThis.fetch = realFetch;
  SubscriptionHub.getInstance().close();
  if (host && host.exitCode === null && host.signalCode === null) {
    host.kill();
    await new Promise((resolve) => host!.once('exit', resolve));
  }
  if (server)
    await new Promise<void>((resolve) => server.close(() => resolve()));
  if (backend)
    await new Promise<void>((resolve) => backend.close(() => resolve()));
  await disconnectPrisma();
  if (created) {
    await admin.query(
      'SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname=$1',
      [database],
    );
    await admin.query(`DROP DATABASE "${database}"`);
  }
  await admin.end();
  if (root) await rm(root, { recursive: true, force: true });
});
const request = (
  name: keyof typeof users,
  endpoint: string,
  method = 'GET',
  body?: unknown,
) =>
  realFetch(`${origin}/api/hosted-applications/${appId}${endpoint}`, {
    method,
    headers: {
      'x-test-user': name,
      Origin: 'http://studio.test',
      'Content-Type': 'application/json',
    },
    body: body ? JSON.stringify(body) : undefined,
  });

async function setDeployment(
  name: keyof typeof users,
  enabled: boolean,
): Promise<void> {
  const prisma = getPrisma();
  if (enabled)
    await prisma.appointment.upsert({
      where: {
        entityType_entityId_roleId: {
          entityType: 'User',
          entityId: users[name],
          roleId: deploymentRoleId,
        },
      },
      create: {
        entityType: 'User',
        entityId: users[name],
        roleId: deploymentRoleId,
      },
      update: {},
    });
  else
    await prisma.appointment.deleteMany({
      where: {
        entityType: 'User',
        entityId: users[name],
        roleId: deploymentRoleId,
      },
    });
}

test('deployment permission defaults false; administration can grant it and group grants are effective', async () => {
  const prisma = getPrisma();
  const create = await realFetch(`${origin}/api/administration/roles`, {
    method: 'POST',
    headers: {
      'x-test-user': 'operator',
      Origin: 'http://studio.test',
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ name: 'New role' }),
  });
  assert.equal(create.status, 201);
  const { role } = await create.json();
  assert.equal(role.permission_applications_deployment, false);
  const update = await realFetch(
    `${origin}/api/administration/roles/${role.id}`,
    {
      method: 'PUT',
      headers: {
        'x-test-user': 'operator',
        Origin: 'http://studio.test',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ permission_applications_deployment: true }),
    },
  );
  assert.equal(update.status, 200);
  assert.equal(
    (await update.json()).role.permission_applications_deployment,
    true,
  );
  const group = await prisma.group.create({
    data: { name: 'Approved deployers' },
  });
  await prisma.member.create({
    data: { userId: users.owner, groupId: group.id },
  });
  await prisma.appointment.create({
    data: { entityType: 'Group', entityId: group.id, roleId: role.id },
  });
  await setDeployment('owner', false);
  try {
    assert.equal((await request('owner', '')).status, 200);
    await prisma.appointment.deleteMany({
      where: { entityType: 'Group', entityId: group.id },
    });
    assert.equal((await request('owner', '')).status, 403);
  } finally {
    await setDeployment('owner', true);
    await prisma.group.delete({ where: { id: group.id } });
  }
});

test('deployment permission gates all management and GitHub endpoints despite ownership; global_manage retains its bypass', async () => {
  await setDeployment('owner', false);
  const beforeRefreshes = refreshes;
  try {
    for (const endpoint of [
      '/api/github/connection',
      '/api/github/connect',
      '/api/github/install',
      '/api/github/callback?code=test&state=test',
      '/api/github/setup',
      '/api/github/repositories',
      '/api/hosted-applications',
      '/api/application-templates',
    ]) {
      const response = await realFetch(`${origin}${endpoint}`, {
        headers: { 'x-test-user': 'owner' },
        redirect: 'manual',
      });
      assert.equal(response.status, 403, endpoint);
      assert.match(await response.text(), /applications_deployment/);
    }
    for (const [endpoint, method] of [
      ['', 'GET'],
      ['/source', 'PUT'],
      ['/builds', 'POST'],
      ['/publish', 'POST'],
      ['/unpublish', 'POST'],
      ['', 'DELETE'],
    ])
      assert.equal(
        (await request('owner', endpoint, method)).status,
        403,
        `${method} ${endpoint}`,
      );
    const disconnect = await realFetch(`${origin}/api/github/connection`, {
      method: 'DELETE',
      headers: { 'x-test-user': 'owner', Origin: 'http://studio.test' },
    });
    assert.equal(disconnect.status, 403);
    await assert.rejects(
      userToken(users.owner, loadHostingConfig()),
      /applications_deployment/,
    );
    assert.equal(refreshes, beforeRefreshes);
    assert.equal((await request('operator', '')).status, 200);
    assert.equal((await request('operator', '/publish', 'POST')).status, 403);
    assert.equal(
      (await loadEffectivePermissions(getPrisma(), users.operator))
        .applications_deployment,
      false,
    );
  } finally {
    await setDeployment('owner', true);
  }
});

test('generated migration creates ownership and GitHub structures; ACL denies cross-user access', async () => {
  assert.equal((await request('owner', '')).status, 200);
  assert.equal((await request('stranger', '')).status, 404);
  assert.equal(
    (
      await request('viewer', '/publish', 'POST', {
        buildId: crypto.randomUUID(),
      })
    ).status,
    403,
  );
  assert.equal(
    (
      await request('developer', '/collaborators', 'PUT', {
        email: 'stranger@example.test',
        role: 'MANAGE',
      })
    ).status,
    403,
  );
  assert.equal(
    (
      await request('manager', '/collaborators', 'PUT', {
        email: 'stranger@example.test',
        role: 'MANAGE',
      })
    ).status,
    403,
  );
});
test('concurrent token refresh rotates once across separate database transactions', async () => {
  await getPrisma().gitHubConnection.update({
    where: { userId: users.owner },
    data: { expiresAt: new Date(0) },
  });
  const tokens = await Promise.all([
    userToken(users.owner, loadHostingConfig()!),
    userToken(users.owner, loadHostingConfig()!),
  ]);
  assert.deepEqual(tokens, ['renewed', 'renewed']);
  assert.equal(refreshes, 1);
});
test('untrusted same-site app origins cannot call credentialed management endpoints', async () => {
  const response = await realFetch(
    `${origin}/api/hosted-applications/${appId}`,
    {
      headers: {
        Origin: `https://preview-${appId}.user.studio.test`,
        Cookie: '__Host-fhir_studio_session=secret',
        'x-test-user': 'owner',
      },
    },
  );
  assert.equal(response.status, 403);
  assert.equal(response.headers.get('access-control-allow-credentials'), null);
});
test('canonical run artifact imports through leased worker; publication requires exact reviewed build', async () => {
  const prisma = getPrisma();
  const cfg = loadHostingConfig()!;
  activeRun = {
    id: 123,
    created_at: new Date().toISOString(),
    run_attempt: 1,
    workflow_id: 1,
    path: `.github/workflows/fhir-studio-${appId}.yml`,
    head_sha: currentHead,
    head_branch: 'main',
    event: 'push',
    status: 'completed',
    conclusion: 'success',
    html_url: 'https://github.com/owner/repo/actions/runs/123',
    actor: { id: 100, type: 'User' },
    triggering_actor: { id: 100, type: 'User' },
    repository: { id: 42 },
    head_repository: { id: 42 },
  };
  zip = zipSync({ 'index.html': strToU8('<html>Valid app</html>') });
  await reconcileRun(
    await prisma.hostedApplication.findUniqueOrThrow({ where: { id: appId } }),
    '123',
    cfg,
  );
  const build = await prisma.hostedBuild.findFirstOrThrow({
    where: { applicationId: appId, runId: '123' },
  });
  assert.ok(build.jobId);
  const job = await prisma.job.update({
    where: { id: build.jobId },
    data: {
      status: 'in_progress',
      lockedBy: 'test-worker',
      leaseExpiresAt: new Date(Date.now() + 60_000),
    },
  });
  await importBuild({
    job,
    prisma,
    signal: new AbortController().signal,
    updateProgress: async () => {},
    isCancelled: async () => false,
  } as JobExecutionContext);
  const project = await prisma.hostedApplication.findUniqueOrThrow({
    where: { id: appId },
  });
  assert.equal(project.previewBuildId, build.id);
  assert.equal(project.publishedBuildId, null);
  assert.equal(
    (
      await request('manager', '/publish', 'POST', {
        buildId: crypto.randomUUID(),
      })
    ).status,
    409,
  );
  assert.equal(
    (await request('manager', '/publish', 'POST', { buildId: build.id }))
      .status,
    200,
  );
  await access(path.join(buildDirectory(cfg, appId, build.id), 'index.html'));
});

test('static host serves only active generated origins, without GitHub credentials or management routes', async () => {
  const probe = net.createServer();
  await new Promise<void>((resolve) => probe.listen(0, '127.0.0.1', resolve));
  const address = probe.address();
  assert.ok(address && typeof address !== 'string');
  const port = address.port;
  await new Promise<void>((resolve) => probe.close(() => resolve()));
  const env = { ...process.env, PORT: String(port) };
  for (const name of Object.keys(env))
    if (
      name.startsWith('FHIR_STUDIO_HOSTING_GITHUB_') ||
      name === 'FHIR_STUDIO_HOSTING_ENCRYPTION_KEY'
    )
      delete env[name as keyof typeof env];
  host = spawn(
    process.execPath,
    [
      '--import',
      'tsx',
      fileURLToPath(new URL('../src/hosted/host.ts', import.meta.url)),
    ],
    { env, stdio: 'pipe' },
  );
  let output = '';
  host.stderr?.on('data', (chunk) => {
    output += String(chunk);
  });
  const load = (hostname: string, resource = '/') =>
    new Promise<{
      status: number;
      body: string;
      headers: http.IncomingHttpHeaders;
    }>((resolve, reject) => {
      http
        .get(
          `http://127.0.0.1:${port}${resource}`,
          { headers: { Host: hostname } },
          (response) => {
            let body = '';
            response.setEncoding('utf8');
            response.on('data', (chunk) => (body += chunk));
            response.on('end', () =>
              resolve({
                status: response.statusCode!,
                body,
                headers: response.headers,
              }),
            );
          },
        )
        .on('error', reject);
    });
  const hostname = `preview-${appId}.user.studio.test`;
  let response: Awaited<ReturnType<typeof load>> | undefined;
  for (let attempt = 0; attempt < 40; attempt++) {
    try {
      response = await load(hostname);
      break;
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
  }
  assert.ok(response, output);
  assert.equal(response.status, 200, response.body);
  assert.match(response.body, /Valid app/);
  const visitor = response.headers['set-cookie']?.find(cookie => cookie.startsWith('__Host-studio-visitor='));
  assert.ok(visitor);
  assert.match(visitor, /HttpOnly/); assert.match(visitor, /Secure/); assert.match(visitor, /SameSite=Lax/); assert.ok(!/Domain=/i.test(visitor));
  assert.match(
    String(response.headers['content-security-policy']),
    /worker-src 'none'/,
  );
  assert.equal((await load('studio.test')).status, 404);
  assert.equal((await load(hostname, '/api/github/connection')).status, 404);
  assert.equal((await load(hostname, '/.staging/index.html')).status, 404);
  await setDeployment('owner', false);
  try {
    assert.equal((await load(hostname)).status, 200);
    assert.equal((await load(`app-${appId}.user.studio.test`)).status, 200);
  } finally {
    await setDeployment('owner', true);
  }
  const config = await load(hostname, '/_studio/config.json');
  assert.equal(config.status, 200);
  assert.equal(config.headers['cache-control'], 'no-store');
  assert.ok(!config.body.includes('access_token'));
  assert.match(config.body, /clientId/);
});

test('GitHub repository access is required in addition to Studio viewing permission', async () => {
  await getPrisma().gitHubConnection.update({
    where: { userId: users.viewer },
    data: {
      encryptedTokens: encrypt(
        { access_token: 'user-viewer-denied', refresh_token: 'refresh' },
        loadHostingConfig()!,
      ),
    },
  });
  const response = await request('viewer', '/source?branch=main');
  assert.equal(response.status, 409);
  assert.equal((await response.json()).recovery, 'repository-access');
});
test('old completions, unpublish and role changes cannot publish stale work', async () => {
  const prisma = getPrisma();
  const project = await prisma.hostedApplication.findUniqueOrThrow({
    where: { id: appId },
  });
  const generation = project.generation;
  assert.equal((await request('manager', '/unpublish', 'POST')).status, 200);
  const paused = await prisma.hostedApplication.findUniqueOrThrow({
    where: { id: appId },
  });
  assert.equal(paused.publishedBuildId, null);
  assert.equal(paused.publishingPaused, true);
  assert.ok(paused.generation > generation);
  await reconcileRun(project, '123', loadHostingConfig()!);
  assert.equal(
    (await prisma.hostedApplication.findUniqueOrThrow({ where: { id: appId } }))
      .publishedBuildId,
    null,
  );
  assert.equal(
    (
      await request('owner', '/collaborators', 'PUT', {
        email: 'manager@example.test',
        role: 'READ_ONLY',
      })
    ).status,
    200,
  );
  assert.equal(
    (
      await request('manager', '/publish', 'POST', {
        buildId: project.previewBuildId,
      })
    ).status,
    403,
  );
});
test('SMART bearer scope never inherits owner session or open-access authority', async () => {
  const prisma = getPrisma();
  const sandbox = await prisma.sandbox.create({
    data: {
      sandboxId: 'scoped-test',
      name: 'Scope test',
      partitionId: 999,
      createdByUserId: users.owner,
      allowOpenAccess: true,
    },
  });
  await prisma.smartAuthSession.create({
    data: {
      sandboxId: sandbox.sandboxId,
      sandboxRowId: sandbox.id,
      clientId: `hosted-${appId}-preview`,
      redirectUri: 'https://example.test',
      accessToken: 'smart-test-token',
      tokenExpiresAt: new Date(Date.now() + 60_000),
      scope: 'patient/Patient.r',
      patientFhirId: 'p1',
    },
  });
  const result = await verifySandboxAccess(
    prisma,
    sandbox,
    'Bearer smart-test-token',
    { userId: users.owner, sessionId: 'browser' } as never,
    createDefaultEffectivePermissions(),
    { method: 'DELETE', path: '/Patient/p1', resourceType: 'Patient' },
  );
  assert.equal(result.authorized, false);
});
test('filesystem cleanup removes only unreferenced complete directories after grace', async () => {
  const cfg = loadHostingConfig()!;
  const orphan = buildDirectory(cfg, appId, crypto.randomUUID());
  await mkdir(orphan, { recursive: true });
  await writeFile(path.join(orphan, 'old.js'), 'old');
  await utimes(orphan, new Date(0), new Date(0));
  await cleanupStorage(cfg);
  await assert.rejects(access(orphan));
  const project = await getPrisma().hostedApplication.findUniqueOrThrow({
    where: { id: appId },
  });
  await access(buildDirectory(cfg, appId, project.previewBuildId!));
  const interrupted = await getPrisma().hostedBuild.create({
    data: {
      applicationId: appId,
      branch: 'main',
      commit: currentHead,
      generation: project.generation,
      status: 'FAILED',
    },
  });
  await getPrisma().hostedApplication.update({
    where: { id: appId },
    data: { desiredBuildId: interrupted.id },
  });
  const finalizedOrphan = buildDirectory(cfg, appId, interrupted.id);
  await mkdir(finalizedOrphan, { recursive: true });
  await writeFile(path.join(finalizedOrphan, 'index.html'), 'Never activated');
  await utimes(finalizedOrphan, new Date(0), new Date(0));
  await cleanupStorage(cfg);
  await assert.rejects(access(finalizedOrphan));
  await access(buildDirectory(cfg, appId, project.previewBuildId!));
});

test('cookie requests without Origin fail CSRF; same-site FHIR subresources omit Studio authority', async () => {
  const response = await realFetch(
    `${origin}/api/hosted-applications/${appId}/unpublish`,
    {
      method: 'POST',
      headers: { Cookie: '__Host-studio=secret', 'x-test-user': 'owner' },
    },
  );
  assert.equal(response.status, 403);
  const data = await realFetch(
    `${origin}/api/sandboxes/test/fhir/r4/authority`,
    {
      headers: {
        Cookie: '__Host-studio=secret',
        'Sec-Fetch-Site': 'same-site',
        'x-test-user': 'owner',
      },
    },
  );
  assert.deepEqual(await data.json(), {
    isolated: true,
    principal: false,
    cookies: 0,
  });
});

test('automatic publication checks original and rerun identities, Studio roles and live connection state', async () => {
  const prisma = getPrisma();
  const app = await prisma.hostedApplication.update({
    where: { id: appId },
    data: { autoPublish: true, publishingPaused: false },
  });
  await prisma.hostedCollaborator.update({
    where: {
      applicationId_userId: { applicationId: appId, userId: users.manager },
    },
    data: { role: 'MANAGE' },
  });
  const run = {
    ...activeRun,
    created_at: new Date().toISOString(),
    actor: { id: 100, type: 'User' },
    triggering_actor: { id: 101, type: 'User' },
  };
  assert.equal(await publisherForRun(app, run, loadHostingConfig()!), true);
  for (const name of ['owner', 'manager'] as const) {
    await setDeployment(name, false);
    try {
      assert.equal(
        await publisherForRun(app, run, loadHostingConfig()),
        false,
        name,
      );
    } finally {
      await setDeployment(name, true);
    }
  }
  for (const actor of [
    { id: 102, type: 'User' },
    { id: 100, type: 'Bot' },
    { id: 9999, type: 'User' },
  ]) {
    assert.equal(
      await publisherForRun(
        app,
        { ...run, triggering_actor: actor },
        loadHostingConfig()!,
      ),
      false,
    );
    assert.equal(
      await publisherForRun(app, { ...run, actor }, loadHostingConfig()!),
      false,
    );
  }
  await prisma.gitHubConnection.update({
    where: { userId: users.owner },
    data: { status: 'REVOKED' },
  });
  assert.equal(await publisherForRun(app, run, loadHostingConfig()!), false);
  await prisma.gitHubConnection.update({
    where: { userId: users.owner },
    data: { status: 'CONNECTED' },
  });
  await prisma.hostedApplication.update({
    where: { id: appId },
    data: { autoPublish: false, publishingPaused: true },
  });
});

test('temporary OAuth outages preserve credentials; expired refresh authorization requires reconnect', async () => {
  const prisma = getPrisma();
  await prisma.gitHubConnection.update({
    where: { userId: users.owner },
    data: { expiresAt: new Date(0) },
  });
  refreshStatus = 503;
  try {
    await assert.rejects(
      userToken(users.owner, loadHostingConfig()!),
      /temporarily unavailable/,
    );
  } finally {
    refreshStatus = 200;
  }
  assert.equal(
    (
      await prisma.gitHubConnection.findUniqueOrThrow({
        where: { userId: users.owner },
      })
    ).status,
    'CONNECTED',
  );
  await userToken(users.owner, loadHostingConfig()!);
  await prisma.gitHubConnection.update({
    where: { userId: users.stranger },
    data: { refreshExpiresAt: new Date(0) },
  });
  await assert.rejects(
    userToken(users.stranger, loadHostingConfig()!),
    /Reconnect/,
  );
  assert.equal(
    (
      await prisma.gitHubConnection.findUniqueOrThrow({
        where: { userId: users.stranger },
      })
    ).status,
    'RECONNECT_REQUIRED',
  );
});

test('explicit dispatch request cannot be replaced by an unrelated push or different dispatch', async () => {
  const prisma = getPrisma();
  const cfg = loadHostingConfig()!;
  const app = await prisma.hostedApplication.findUniqueOrThrow({
    where: { id: appId },
  });
  const pending = await prisma.hostedBuild.create({
    data: {
      applicationId: appId,
      branch: 'main',
      commit: currentHead,
      generation: app.generation,
      requestEvent: 'workflow_dispatch',
      requestedByUserId: users.owner,
    },
  });
  await prisma.hostedApplication.update({
    where: { id: appId },
    data: { desiredBuildId: pending.id },
  });
  activeRun = { ...activeRun, id: 200, run_attempt: 1, event: 'push' };
  await reconcileRun(app, '200', cfg);
  assert.equal(
    (await prisma.hostedBuild.findUniqueOrThrow({ where: { id: pending.id } }))
      .runId,
    null,
  );
  activeRun = {
    ...activeRun,
    event: 'workflow_dispatch',
    display_title: `Studio preview ${crypto.randomUUID()}`,
  };
  await reconcileRun(app, '200', cfg);
  assert.equal(
    (await prisma.hostedBuild.findUniqueOrThrow({ where: { id: pending.id } }))
      .runId,
    null,
  );
  activeRun.display_title = `Studio preview ${pending.id}`;
  await reconcileRun(app, '200', cfg);
  assert.equal(
    (await prisma.hostedBuild.findUniqueOrThrow({ where: { id: pending.id } }))
      .runId,
    '200',
  );
});

test('lost worker lease and artifact integrity failure cannot replace successful preview', async () => {
  const prisma = getPrisma();
  const cfg = loadHostingConfig()!;
  const app = await prisma.hostedApplication.findUniqueOrThrow({
    where: { id: appId },
  });
  const build = await prisma.hostedBuild.findUniqueOrThrow({
    where: { id: app.desiredBuildId! },
  });
  const job = await prisma.job.update({
    where: { id: build.jobId! },
    data: {
      status: 'in_progress',
      lockedBy: 'replacement-worker',
      leaseExpiresAt: new Date(Date.now() + 60_000),
    },
  });
  const context = {
    job: { ...job, lockedBy: 'lost-worker' },
    prisma,
    signal: new AbortController().signal,
    updateProgress: async () => {},
    isCancelled: async () => false,
  } as JobExecutionContext;
  await assert.rejects(importBuild(context), /lease/);
  assert.equal(
    (await prisma.hostedApplication.findUniqueOrThrow({ where: { id: appId } }))
      .previewBuildId,
    app.previewBuildId,
  );
  badDigest = true;
  try {
    await assert.rejects(importBuild({ ...context, job }), /integrity/);
  } finally {
    badDigest = false;
  }
  assert.equal(
    (await prisma.hostedBuild.findUniqueOrThrow({ where: { id: build.id } }))
      .byteSize,
    0n,
  );
  assert.equal(
    (await prisma.hostedApplication.findUniqueOrThrow({ where: { id: appId } }))
      .previewBuildId,
    app.previewBuildId,
  );
});

test('SMART launch binds sandbox, client, exact callback, PKCE and single-use authorization code', async () => {
  const prisma = getPrisma();
  await prisma.sandbox.create({
    data: {
      sandboxId: 'launch-test',
      name: 'Launch',
      partitionId: 1000,
      createdByUserId: users.owner,
    },
  });
  const clientId = `hosted-${appId}-preview`;
  const callback = `https://preview-${appId}.user.studio.test/index.html`;
  const launchResponse = await realFetch(
    `${origin}/api/sandboxes/launch-test/launch-context`,
    {
      method: 'POST',
      headers: {
        Origin: 'http://studio.test',
        'x-test-user': 'owner',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        clientId,
        scope: 'launch patient/Patient.r',
        patientFhirId: 'p1',
      }),
    },
  );
  assert.equal(launchResponse.status, 201, await launchResponse.clone().text());
  const { launch } = await launchResponse.json();
  const verifier = crypto.randomBytes(32).toString('base64url');
  const params = new URLSearchParams({
    response_type: 'code',
    client_id: clientId,
    redirect_uri: callback,
    scope: 'launch patient/Patient.r',
    state: 'state',
    launch,
    aud: 'http://studio.test/api/sandboxes/launch-test/fhir/r4',
    code_challenge: crypto
      .createHash('sha256')
      .update(verifier)
      .digest('base64url'),
    code_challenge_method: 'S256',
  });
  const authorize = await realFetch(`${origin}/oauth/authorize?${params}`, {
    redirect: 'manual',
  });
  assert.equal(authorize.status, 302, await authorize.clone().text());
  const code = new URL(authorize.headers.get('location')!).searchParams.get(
    'code',
  )!;
  assert.equal(
    (
      await realFetch(`${origin}/oauth/authorize?${params}`, {
        redirect: 'manual',
      })
    ).status,
    400,
  );
  const token = (redirectUri: string, codeVerifier: string) =>
    realFetch(`${origin}/oauth/token`, {
      method: 'POST',
      headers: { Origin: new URL(callback).origin },
      body: new URLSearchParams({
        grant_type: 'authorization_code',
        client_id: clientId,
        code,
        redirect_uri: redirectUri,
        code_verifier: codeVerifier,
      }),
    });
  assert.equal(
    (await token('https://evil.test/callback', verifier)).status,
    400,
  );
  assert.equal((await token(callback, 'wrong')).status, 400);
  const response = await token(callback, verifier);
  assert.equal(response.status, 200, await response.clone().text());
  assert.equal(response.headers.get('access-control-allow-credentials'), null);
  assert.equal((await response.json()).patient, 'p1');
  assert.equal((await token(callback, verifier)).status, 400);
});

test('published SMART launches remain available without deployment permission; preview testing requires it', async () => {
  const prisma = getPrisma();
  const before = await prisma.hostedApplication.findUniqueOrThrow({
    where: { id: appId },
  });
  const sandbox = await prisma.sandbox.create({
    data: {
      sandboxId: 'consumer-test',
      name: 'Consumer',
      partitionId: 1002,
      createdByUserId: users.viewer,
    },
  });
  await prisma.hostedSandbox.create({
    data: { applicationId: appId, sandboxId: sandbox.id },
  });
  const active = await prisma.hostedApplication.update({
    where: { id: appId },
    data: { publishedBuildId: before.previewBuildId },
  });
  await provisionClients(active, loadHostingConfig());
  await setDeployment('viewer', false);
  try {
    for (const [channel, status] of [
      ['published', 201],
      ['preview', 403],
    ] as const) {
      const response = await realFetch(
        `${origin}/api/sandboxes/consumer-test/launch-context`,
        {
          method: 'POST',
          headers: {
            Origin: 'http://studio.test',
            'x-test-user': 'viewer',
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            clientId: `hosted-${appId}-${channel}`,
            scope: 'launch patient/Patient.r',
          }),
        },
      );
      assert.equal(response.status, status, await response.text());
    }
  } finally {
    await setDeployment('viewer', true);
    const restored = await prisma.hostedApplication.update({
      where: { id: appId },
      data: { publishedBuildId: before.publishedBuildId },
    });
    await provisionClients(restored, loadHostingConfig());
  }
});

test('signed webhook notifications are durable and installation removal invalidates queued imports', async () => {
  const send = async (kind: string, value: unknown, valid = true) => {
    const body = JSON.stringify(value);
    return realFetch(`${origin}/api/github/webhook`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-GitHub-Event': kind,
        'X-Hub-Signature-256': valid
          ? `sha256=${crypto.createHmac('sha256', 'webhook').update(body).digest('hex')}`
          : 'invalid',
      },
      body,
    });
  };
  const event = {
    installation: { id: 7 },
    workflow_run: { id: 201, repository: { id: 42 } },
  };
  assert.equal((await send('workflow_run', event, false)).status, 401);
  assert.equal((await send('workflow_run', event)).status, 204);
  assert.equal((await send('workflow_run', event)).status, 204);
  assert.equal(
    await getPrisma().job.count({ where: { jobType: 'HOSTED_RECONCILE' } }),
    1,
  );
  const before = await getPrisma().hostedApplication.findUniqueOrThrow({
    where: { id: appId },
  });
  assert.equal(
    (await send('installation', { action: 'deleted', installation: { id: 7 } }))
      .status,
    204,
  );
  const after = await getPrisma().hostedApplication.findUniqueOrThrow({
    where: { id: appId },
  });
  assert.ok(after.generation > before.generation);
  assert.equal(after.publishingPaused, true);
  assert.equal(after.previewBuildId, before.previewBuildId);
  assert.equal(
    (
      await send('github_app_authorization', {
        action: 'revoked',
        sender: { id: 100 },
      })
    ).status,
    204,
  );
  const connection = await getPrisma().gitHubConnection.findUniqueOrThrow({
    where: { userId: users.owner },
  });
  assert.equal(connection.status, 'REVOKED');
  assert.equal(connection.encryptedTokens, '');
});

test('completed builds cannot be cancelled by developers and storage reservations enforce the global budget', async () => {
  const prisma = getPrisma();
  const app = await prisma.hostedApplication.findUniqueOrThrow({
    where: { id: appId },
  });
  assert.equal(
    (await request('developer', `/builds/${app.previewBuildId}/cancel`, 'POST'))
      .status,
    409,
  );
  assert.equal(
    (
      await prisma.hostedBuild.findUniqueOrThrow({
        where: { id: app.previewBuildId! },
      })
    ).status,
    'READY',
  );
  const build = await prisma.hostedBuild.create({
    data: {
      applicationId: appId,
      branch: 'main',
      commit: currentHead,
      generation: app.generation,
      status: 'IMPORTING',
    },
  });
  await assert.rejects(
    reserveStorage({ ...loadHostingConfig()!, maxStorageBytes: 1 }, build.id),
    /budget/,
  );
  assert.equal(
    (await prisma.hostedBuild.findUniqueOrThrow({ where: { id: build.id } }))
      .byteSize,
    0n,
  );
});

test('queued reconciliation from before a policy change cannot activate a build', async () => {
  const job = await getPrisma().job.findFirstOrThrow({
    where: { jobType: 'HOSTED_RECONCILE' },
  });
  assert.deepEqual(await reconcileJob({ job } as JobExecutionContext), {
    ignored: true,
  });
});

test('asymmetric SMART assertions require a valid signature and are accepted only once', async () => {
  const prisma = getPrisma();
  const sandbox = await prisma.sandbox.findUniqueOrThrow({
    where: { sandboxId: 'launch-test' },
  });
  const keys = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
  const clientId = `backend-${crypto.randomUUID()}`;
  const jwk = { ...keys.publicKey.export({ format: 'jwk' }), kid: 'test-key' };
  await prisma.application.create({
    data: {
      clientId,
      clientName: 'Backend test',
      sandboxId: sandbox.id,
      tokenEndpointAuthMethod: 'private_key_jwt',
      launchUri: 'https://example.test',
      redirectUris: [],
      jwks: { keys: [jwk] },
      scope: 'system/Patient.rs',
    },
  });
  const header = Buffer.from(
    JSON.stringify({ alg: 'RS256', kid: 'test-key' }),
  ).toString('base64url');
  const payload = Buffer.from(
    JSON.stringify({
      iss: clientId,
      sub: clientId,
      aud: 'http://studio.test/oauth/token',
      exp: Math.floor(Date.now() / 1000) + 60,
      jti: crypto.randomUUID(),
    }),
  ).toString('base64url');
  const input = `${header}.${payload}`;
  const assertion = `${input}.${crypto.sign('RSA-SHA256', Buffer.from(input), keys.privateKey).toString('base64url')}`;
  const requestToken = (value: string) =>
    realFetch(`${origin}/oauth/token`, {
      method: 'POST',
      body: new URLSearchParams({
        grant_type: 'client_credentials',
        client_id: clientId,
        scope: 'system/Patient.rs',
        client_assertion_type:
          'urn:ietf:params:oauth:client-assertion-type:jwt-bearer',
        client_assertion: value,
      }),
    });
  assert.equal((await requestToken(`${input}.invalid`)).status, 401);
  assert.equal((await requestToken(assertion)).status, 200);
  assert.equal((await requestToken(assertion)).status, 401);
});

test('ownership transfer requires recipient acceptance and preserves the original creator', async () => {
  const prisma = getPrisma();
  const originalId = appId;
  const app = await prisma.hostedApplication.create({
    data: {
      name: 'Transfer test',
      ownerUserId: users.developer,
      createdByUserId: users.developer,
      repository: 'owner/repo',
      repositoryId: '42',
      installationId: '7',
    },
  });
  appId = app.id;
  try {
    assert.equal(
      (await request('manager', '/accept-transfer', 'POST')).status,
      404,
    );
    assert.equal(
      (
        await request('developer', '/transfer', 'POST', {
          email: 'manager@example.test',
        })
      ).status,
      200,
    );
    await prisma.hostedOwnerQuota.upsert({ where: { userId: users.manager }, create: { userId: users.manager, applicationLimit: 0 }, update: { applicationLimit: 0 } });
    assert.equal((await request('manager', '/accept-transfer', 'POST')).status, 409);
    await prisma.hostedOwnerQuota.delete({ where: { userId: users.manager } });
    assert.equal(
      (await request('manager', '/accept-transfer', 'POST')).status,
      200,
    );
    const transferred = await prisma.hostedApplication.findUniqueOrThrow({
      where: { id: app.id },
    });
    assert.equal(transferred.ownerUserId, users.manager);
    assert.equal(transferred.createdByUserId, users.developer);
    assert.equal((await request('developer', '')).status, 404);
    assert.equal(
      (await request('manager', '/accept-transfer', 'POST')).status,
      404,
    );
  } finally {
    appId = originalId;
  }
});

test('WebSocket upgrades require a trusted Studio origin, an active session and an immutable sandbox binding', async () => {
  const prisma = getPrisma();
  const session = await prisma.session.create({
    data: {
      userId: users.owner,
      expiresAt: new Date(Date.now() + 7200_000),
      idleExpiresAt: new Date(Date.now() + 3600_000),
    },
  });
  const cookie = `${SESSION_COOKIE}=${encodeURIComponent(hmacSign(session.id, 'test-secret'))}`;
  const connect = (browserOrigin: string, authenticated = true) =>
    new Promise<WebSocket | number>((resolve, reject) => {
      const ws = new WebSocket(
        `${origin.replace('http:', 'ws:')}/subscriptions/ws?sandboxId=launch-test`,
        {
          headers: {
            Origin: browserOrigin,
            ...(authenticated ? { Cookie: cookie } : {}),
          },
        },
      );
      ws.once('open', () => resolve(ws));
      ws.once('unexpected-response', (_request, response) => {
        response.resume();
        resolve(response.statusCode!);
        ws.terminate();
      });
      ws.on('error', (error) => {
        if (!String(error).includes('closed before')) reject(error);
      });
    });
  assert.equal(await connect(`https://preview-${appId}.user.studio.test`), 403);
  assert.equal(await connect('http://studio.test', false), 403);
  const ws = await connect('http://studio.test');
  assert.ok(ws instanceof WebSocket);
  const closed = new Promise<number>((resolve) =>
    ws.once('close', (code) => resolve(code)),
  );
  ws.send(JSON.stringify({ type: 'subscribe', sandboxId: 'another-sandbox' }));
  assert.equal(await closed, 1008);
});

test('deployment-setting edits preserve callbacks and runtime settings of already validated builds', async () => {
  const prisma = getPrisma();
  const cfg = loadHostingConfig()!;
  const app = await prisma.hostedApplication.update({
    where: { id: appId },
    data: {
      launchPath: 'next.html',
      callbackPath: 'next.html',
      scope: 'launch patient/Observation.r',
    },
  });
  await provisionClients(app, cfg);
  const client = await prisma.application.findUniqueOrThrow({
    where: { clientId: `hosted-${appId}-preview` },
  });
  assert.ok(
    Array.isArray(client.redirectUris) &&
      client.redirectUris.some(
        (uri) => typeof uri === 'string' && uri.endsWith('/index.html'),
      ),
  );
  assert.equal(
    client.scope,
    'launch launch/patient openid fhirUser patient/*.rs',
  );
});

test('FHIR Binary content is an attachment and cannot execute as a Studio-origin document', async () => {
  const response = await realFetch(
    `${origin}/api/sandboxes/launch-test/fhir/r4/Binary/b1`,
    { headers: { Origin: 'http://studio.test', 'x-test-user': 'owner' } },
  );
  assert.equal(response.status, 200, await response.clone().text());
  assert.match(
    response.headers.get('content-security-policy') || '',
    /sandbox; default-src 'none'/,
  );
  assert.equal(response.headers.get('content-disposition'), 'attachment');
  assert.equal(response.headers.get('x-content-type-options'), 'nosniff');
  assert.match(await response.text(), /<script>/);
});

test('branch movement before workflow dispatch starts fails with rebuild guidance without replacing preview', async () => {
  const prisma = getPrisma();
  const cfg = loadHostingConfig()!;
  const app = await prisma.hostedApplication.findUniqueOrThrow({
    where: { id: appId },
  });
  const pending = await prisma.hostedBuild.create({
    data: {
      applicationId: appId,
      branch: 'main',
      commit: currentHead,
      generation: app.generation,
      requestEvent: 'workflow_dispatch',
    },
  });
  await prisma.hostedApplication.update({
    where: { id: appId },
    data: { desiredBuildId: pending.id },
  });
  activeRun = {
    ...activeRun,
    id: 300,
    run_attempt: 1,
    event: 'workflow_dispatch',
    display_title: `Studio preview ${pending.id}`,
    head_sha: 'b'.repeat(40),
  };
  await reconcileRun(app, '300', cfg);
  const failed = await prisma.hostedBuild.findUniqueOrThrow({
    where: { id: pending.id },
  });
  assert.equal(failed.status, 'FAILED');
  assert.match(failed.error || '', /branch changed.*Build the current commit/s);
  assert.equal(
    (await prisma.hostedApplication.findUniqueOrThrow({ where: { id: appId } }))
      .previewBuildId,
    app.previewBuildId,
  );
});

test('deployment revocation blocks queued imports and is rechecked immediately before activation', async () => {
  const prisma = getPrisma();
  const before = await prisma.hostedApplication.findUniqueOrThrow({
    where: { id: appId },
  });
  zip = zipSync(
    Object.fromEntries(
      ['index.html', before.launchPath, before.callbackPath].map((name) => [
        name,
        strToU8('<p>New preview</p>'),
      ]),
    ),
  );
  for (const phase of ['queued', 'activation', 'finalized'] as const) {
    const build = await prisma.hostedBuild.create({
      data: {
        applicationId: appId,
        requestedByUserId: users.owner,
        branch: 'main',
        commit: currentHead,
        generation: before.generation,
        runId:
          phase === 'queued' ? '400' : phase === 'activation' ? '401' : '402',
        status: 'IMPORTING',
      },
    });
    const job = await prisma.job.create({
      data: {
        name: 'Permission revocation fixture',
        jobType: 'HOSTED_IMPORT',
        input: { buildId: build.id },
        status: 'in_progress',
        lockedBy: 'permission-worker',
        leaseExpiresAt: new Date(Date.now() + 60_000),
      },
    });
    await prisma.hostedBuild.update({
      where: { id: build.id },
      data: { jobId: job.id },
    });
    await prisma.hostedApplication.update({
      where: { id: appId },
      data: { desiredBuildId: build.id },
    });
    activeRun = {
      ...activeRun,
      id: Number(build.runId),
      head_sha: currentHead,
      head_branch: 'main',
      event: 'push',
      run_attempt: 1,
      status: 'completed',
      conclusion: 'success',
    };
    if (phase === 'queued') await setDeployment('owner', false);
    else if (phase === 'activation') revokeBeforeActivation = true;
    try {
      await assert.rejects(
        importBuild({
          job,
          prisma,
          signal: new AbortController().signal,
          updateProgress: async (progress: number) => {
            if (phase === 'finalized' && progress === 80)
              await setDeployment('owner', false);
          },
          isCancelled: async () => false,
        } as JobExecutionContext),
        /applications_deployment/,
      );
      const after = await prisma.hostedApplication.findUniqueOrThrow({
        where: { id: appId },
      });
      assert.equal(after.previewBuildId, before.previewBuildId);
      assert.equal(after.publishedBuildId, before.publishedBuildId);
      assert.equal(
        (
          await prisma.hostedBuild.findUniqueOrThrow({
            where: { id: build.id },
          })
        ).status,
        'FAILED',
      );
      const directory = buildDirectory(loadHostingConfig(), appId, build.id);
      if (phase === 'finalized') {
        // Rejection after finalization leaves only an inactive orphan for normal cleanup.
        await access(directory);
        await utimes(directory, new Date(0), new Date(0));
        await cleanupStorage(loadHostingConfig());
      }
      await assert.rejects(access(directory));
    } finally {
      revokeBeforeActivation = false;
      await setDeployment('owner', true);
    }
  }
});

 test('consumed hosted SMART launches are aggregated without FHIR context', async () => {
  await apiUsage.flush();
  const usage = await getPrisma().hostedUsageHour.aggregate({ _sum: { launches: true } });
  assert.ok((usage._sum.launches ?? 0) > 0);
});

const regressionPost = (endpoint: string, body: unknown, name: keyof typeof users = 'owner', method = 'POST') =>
  realFetch(`${origin}${endpoint}`, {
    method,
    headers: { Origin: 'http://studio.test', 'x-test-user': name, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
const regressionClient = (scope: string) => getPrisma().application.create({
  data: {
    clientId: `regression-${crypto.randomUUID()}`,
    clientName: 'Regression client',
    launchUri: 'https://client.example.org/index.html',
    redirectUris: ['https://client.example.org/index.html'],
    tokenEndpointAuthMethod: 'none',
    createdByUserId: users.owner,
    scope,
  },
});
async function restoreRegressionConnection(name: keyof typeof users): Promise<void> {
  await getPrisma().gitHubConnection.update({
    where: { userId: users[name] },
    data: {
      status: 'CONNECTED',
      encryptedTokens: encrypt({ access_token: `user-${name}`, refresh_token: `refresh-${name}` }, loadHostingConfig()),
      expiresAt: new Date(Date.now() + 3600000),
      refreshExpiresAt: new Date(Date.now() + 86400000),
    },
  });
}

test('filtered registrations and legacy filtered tokens cannot acquire unfiltered access', async () => {
  const prisma = getPrisma();
  const client = await regressionClient('patient/Observation.rs?category=vital-signs');
  const launch = await regressionPost('/api/sandboxes/launch-test/launch-context', { clientId: client.clientId, scope: 'patient/Observation.rs', patientFhirId: 'p1' });
  assert.equal(launch.status, 400);
  const token = crypto.randomUUID();
  await prisma.smartAuthSession.create({ data: { clientId: client.clientId, sandboxId: 'launch-test', sandboxRowId: (await getPrisma().sandbox.findUniqueOrThrow({ where: { sandboxId: 'launch-test' } })).id, redirectUri: client.launchUri, scope: client.scope, accessToken: token, patientFhirId: 'p1', tokenExpiresAt: new Date(Date.now() + 60000) } });
  const response = await realFetch(`${origin}/api/sandboxes/launch-test/fhir/r4/Observation`, { headers: { Authorization: `Bearer ${token}` } });
  assert.equal(response.status, 403);
});

test('SMART include and revinclude are blocked for user scopes and form-based searches', async () => {
  const client = await regressionClient('user/Patient.rs');
  const token = crypto.randomUUID();
  await getPrisma().smartAuthSession.create({ data: { clientId: client.clientId, sandboxId: 'launch-test', sandboxRowId: (await getPrisma().sandbox.findUniqueOrThrow({ where: { sandboxId: 'launch-test' } })).id, redirectUri: client.launchUri, scope: client.scope, accessToken: token, tokenExpiresAt: new Date(Date.now() + 60000) } });
  for (const parameter of ['_include=Patient:general-practitioner', '_revinclude:iterate=Observation:patient']) {
    const before = fhirRequests.length;
    const response = await realFetch(`${origin}/api/sandboxes/launch-test/fhir/r4/Patient?${parameter}`, { headers: { Authorization: `Bearer ${token}` } });
    assert.equal(response.status, 403);
    const post = await realFetch(`${origin}/api/sandboxes/launch-test/fhir/r4/Patient/_search`, { method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/x-www-form-urlencoded' }, body: parameter });
    assert.equal(post.status, 403);
    assert.equal(fhirRequests.length, before);
  }
});

test('EHR launch accepts a sandbox persona row and rejects malformed persona IDs cleanly', async () => {
  const prisma = getPrisma();
  const sandbox = await prisma.sandbox.findUniqueOrThrow({ where: { sandboxId: 'launch-test' } });
  const client = await regressionClient('launch patient/*.rs openid fhirUser');
  const persona = await prisma.userPersona.create({ data: { sandboxId: sandbox.id, personaUserId: 'practitioner-1', personaName: 'Practitioner', fhirResourceType: 'Practitioner', fhirResourceId: 'pr1', fhirResourceName: 'Practitioner One' } });
  const launch = await regressionPost('/api/sandboxes/launch-test/launch-context', { clientId: client.clientId, scope: client.scope, userPersonaId: persona.id, patientFhirId: 'p1' });
  assert.equal(launch.status, 201, await launch.clone().text());
  const session = await prisma.smartAuthSession.findFirstOrThrow({ where: { launchId: (await launch.json()).launch } });
  assert.equal(session.userPersonaId, persona.id);
  assert.match(session.fhirUser ?? '', /Practitioner\/pr1$/);
  const invalid = await regressionPost('/api/sandboxes/launch-test/launch-context', { clientId: client.clientId, scope: client.scope, userPersonaId: persona.personaUserId });
  assert.equal(invalid.status, 400);
  const defaultPersona = await regressionPost('/api/sandboxes/launch-test/launch-context', { clientId: client.clientId, scope: client.scope, userPersonaId: null, patientFhirId: 'p1' });
  assert.equal(defaultPersona.status, 201);
});

test('standalone patient selection establishes usable context and validates the selected patient', async () => {
  const client = await regressionClient('launch/patient patient/*.rs');
  const verifier = crypto.randomBytes(32).toString('base64url');
  const params = new URLSearchParams({ response_type: 'code', client_id: client.clientId, redirect_uri: client.launchUri, scope: client.scope, state: 'standalone-state', aud: 'http://studio.test/api/sandboxes/launch-test/fhir/r4', code_challenge: crypto.createHash('sha256').update(verifier).digest('base64url'), code_challenge_method: 'S256' });
  const authorize = () => realFetch(`${origin}/oauth/authorize?${params}`, { redirect: 'manual', headers: { 'x-test-user': 'owner' } });
  const selection = await authorize();
  assert.equal(selection.status, 200, await selection.clone().text());
  const html = await selection.text();
  assert.match(html, /Select a patient/);
  assert.match(html, /&lt;Patient &amp; One&gt;/);
  assert.doesNotMatch(html, /<Patient & One>/);
  assert.match(html, /name="patient" value="p1"/);
  params.set('patient', 'missing');
  assert.equal((await authorize()).status, 400);
  params.set('patient', 'p1');
  const granted = await authorize();
  assert.equal(granted.status, 302, await granted.clone().text());
  const code = new URL(granted.headers.get('location')!).searchParams.get('code')!;
  const exchange = await realFetch(`${origin}/oauth/token`, { method: 'POST', body: new URLSearchParams({ grant_type: 'authorization_code', client_id: client.clientId, redirect_uri: client.launchUri, code, code_verifier: verifier }) });
  assert.equal(exchange.status, 200, await exchange.clone().text());
  const token = await exchange.json();
  assert.equal(token.patient, 'p1');
  const patient = await realFetch(`${origin}/api/sandboxes/launch-test/fhir/r4/Patient/p1`, { headers: { Authorization: `Bearer ${token.access_token}` } });
  assert.equal(patient.status, 200);
  assert.equal((await patient.json()).id, 'p1');
});

test('patient POST searches stay in the selected compartment and constrain body patient IDs', async () => {
  const client = await regressionClient('patient/*.rs');
  const token = crypto.randomUUID();
  await getPrisma().smartAuthSession.create({ data: { clientId: client.clientId, sandboxId: 'launch-test', sandboxRowId: (await getPrisma().sandbox.findUniqueOrThrow({ where: { sandboxId: 'launch-test' } })).id, redirectUri: client.launchUri, scope: client.scope, accessToken: token, patientFhirId: 'p1', tokenExpiresAt: new Date(Date.now() + 60000) } });
  const search = (type: string, body: string) => realFetch(`${origin}/api/sandboxes/launch-test/fhir/r4/${type}/_search`, { method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/x-www-form-urlencoded' }, body });
  const observation = await search('Observation', 'status=final');
  assert.equal(observation.status, 200, await observation.clone().text());
  assert.equal(fhirRequests.at(-1)?.path, '/fhir/launch-test/Patient/p1/Observation/_search');
  assert.equal((fhirRequests.at(-1)?.body as Record<string, string>).status, 'final');
  const patient = await search('Patient', '_id=p2');
  assert.equal(patient.status, 200, await patient.clone().text());
  assert.equal((fhirRequests.at(-1)?.body as Record<string, string>)._id, 'p1');
  assert.equal((fhirRequests.at(-1)?.query as Record<string, string>)._id, 'p1');
});

test('registered browser FHIR clients can preflight and forward conditional-write headers', async () => {
  const client = await regressionClient('user/Observation.u');
  const token = crypto.randomUUID();
  await getPrisma().smartAuthSession.create({ data: { clientId: client.clientId, sandboxId: 'launch-test', sandboxRowId: (await getPrisma().sandbox.findUniqueOrThrow({ where: { sandboxId: 'launch-test' } })).id, redirectUri: client.launchUri, scope: client.scope, accessToken: token, tokenExpiresAt: new Date(Date.now() + 60000) } });
  const url = `${origin}/api/sandboxes/launch-test/fhir/r4/Observation/o1`;
  const preflight = await realFetch(url, { method: 'OPTIONS', headers: { Origin: 'https://client.example.org', 'Access-Control-Request-Method': 'PUT', 'Access-Control-Request-Headers': 'authorization,content-type,prefer,if-match' } });
  assert.equal(preflight.status, 204);
  for (const header of ['prefer', 'if-match', 'if-none-exist']) assert.ok(preflight.headers.get('access-control-allow-headers')?.toLowerCase().includes(header));
  const response = await realFetch(url, { method: 'PUT', headers: { Origin: 'https://client.example.org', Authorization: `Bearer ${token}`, 'Content-Type': 'application/fhir+json', Prefer: 'return=representation', 'If-Match': 'W/"1"' }, body: JSON.stringify({ resourceType: 'Observation', id: 'o1' }) });
  assert.equal(response.status, 200, await response.clone().text());
  assert.equal(fhirRequests.at(-1)?.ifMatch, 'W/"1"');
  assert.equal(fhirRequests.at(-1)?.prefer, 'return=representation');
  assert.equal(response.headers.get('etag'), 'W/"2"');
  assert.match(response.headers.get('access-control-expose-headers') ?? '', /ETag/);
  assert.equal(response.headers.get('access-control-allow-credentials'), null);
});

test('configuration changes retire obsolete builds and allow the next push to import', async () => {
  const prisma = getPrisma();
  await restoreRegressionConnection('owner');
  const app = await prisma.hostedApplication.create({ data: { name: 'Superseded build', ownerUserId: users.owner, createdByUserId: users.owner, repositoryId: '42', repository: 'owner/repo', installationId: '7' } });
  const pending = await prisma.hostedBuild.create({ data: { applicationId: app.id, commit: '0'.repeat(40), branch: 'main', generation: 0, status: 'BUILDING', runId: '900' } });
  await prisma.hostedApplication.update({ where: { id: app.id }, data: { desiredBuildId: pending.id } });
  const changed = await regressionPost(`/api/hosted-applications/${app.id}`, { description: 'changed' }, 'owner', 'PATCH');
  assert.equal(changed.status, 200, await changed.clone().text());
  assert.equal((await prisma.hostedBuild.findUniqueOrThrow({ where: { id: pending.id } })).status, 'CANCELLED');
  assert.equal((await prisma.hostedApplication.findUniqueOrThrow({ where: { id: app.id } })).desiredBuildId, null);
  const previous = activeRun;
  activeRun = { ...previous, id: 901, run_attempt: 1, head_sha: currentHead, head_branch: 'main', path: `.github/workflows/fhir-studio-${app.id}.yml`, event: 'push', status: 'completed', conclusion: 'success', repository: { id: 42 }, head_repository: { id: 42 } };
  try {
    await reconcileRun(app, '901', loadHostingConfig());
    const current = await prisma.hostedApplication.findUniqueOrThrow({ where: { id: app.id } });
    const next = await prisma.hostedBuild.findUniqueOrThrow({ where: { id: current.desiredBuildId! } });
    assert.equal(next.runId, '901');
    assert.equal(next.status, 'IMPORTING');
    assert.equal(next.generation, current.generation);
  } finally { activeRun = previous; }
});

test('administrator quota overrides allow creation beyond the instance application default', async () => {
  const prisma = getPrisma(), config = loadHostingConfig();
  await restoreRegressionConnection('stranger');
  await prisma.hostedOwnerQuota.upsert({ where: { userId: users.stranger }, create: { userId: users.stranger, applicationLimit: config.maxApps + 2 }, update: { applicationLimit: config.maxApps + 2 } });
  const count = await prisma.hostedApplication.count({ where: { ownerUserId: users.stranger, deletedAt: null } });
  for (let index = count; index < config.maxApps; index++) await prisma.hostedApplication.create({ data: { name: `Quota ${index}`, ownerUserId: users.stranger, createdByUserId: users.stranger, repositoryId: '42', repository: 'owner/repo', installationId: '7' } });
  const created = await regressionPost('/api/hosted-applications', { repositoryId: '42', installationId: '7', name: 'Above default' }, 'stranger');
  assert.equal(created.status, 201, await created.clone().text());
  await prisma.hostedOwnerQuota.update({ where: { userId: users.stranger }, data: { applicationLimit: 0 } });
  const blocked = await regressionPost('/api/hosted-applications', { repositoryId: '42', installationId: '7', name: 'Blocked' }, 'stranger');
  assert.equal(blocked.status, 409);
});

test('repository creation defaults an empty owner to the connected GitHub account', async () => {
  await restoreRegressionConnection('owner');
  const response = await regressionPost('/api/github/repositories', { owner: '', name: 'new-app', private: true });
  assert.equal(response.status, 201, await response.clone().text());
  assert.equal((await response.json()).full_name, 'owner/new-app');
});

test('a registered remote JWKS authenticates signed backend requests and rejects substituted jku', async () => {
  const prisma = getPrisma();
  const sandbox = await prisma.sandbox.findUniqueOrThrow({ where: { sandboxId: 'launch-test' } });
  const keys = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
  const clientId = `remote-keys-${crypto.randomUUID()}`;
  remoteClientKeys = { keys: [{ ...keys.publicKey.export({ format: 'jwk' }), kid: 'remote', alg: 'RS384' }] };
  remoteKeyDownloads = 0;
  await prisma.application.create({ data: { clientId, clientName: 'Remote keys', sandboxId: sandbox.id, launchUri: 'https://client.example.org', redirectUris: [], scope: 'system/Patient.rs', tokenEndpointAuthMethod: 'private_key_jwt', jwksUri: 'https://keys.example.org/jwks.json' } });
  const assertion = (jku?: string) => {
    const encode = (value: unknown) => Buffer.from(JSON.stringify(value)).toString('base64url');
    const input = `${encode({ alg: 'RS384', kid: 'remote', typ: 'JWT', ...(jku ? { jku } : {}) })}.${encode({ iss: clientId, sub: clientId, aud: 'http://studio.test/oauth/token', exp: Math.floor(Date.now() / 1000) + 60, jti: crypto.randomUUID() })}`;
    return `${input}.${crypto.sign('sha384', Buffer.from(input), keys.privateKey).toString('base64url')}`;
  };
  const token = (jwt: string) => realFetch(`${origin}/oauth/token`, { method: 'POST', body: new URLSearchParams({ grant_type: 'client_credentials', client_id: clientId, scope: 'system/Patient.rs', client_assertion_type: 'urn:ietf:params:oauth:client-assertion-type:jwt-bearer', client_assertion: jwt }) });
  const first = await token(assertion());
  assert.equal(first.status, 200, await first.clone().text());
  assert.equal((await token(assertion('https://keys.example.org/jwks.json'))).status, 200);
  assert.equal(remoteKeyDownloads, 1);
  assert.equal((await token(assertion('https://attacker.example.org/keys'))).status, 401);
  assert.equal(remoteKeyDownloads, 1);
});
