import { before, after, test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
import {
  mkdtemp,
  mkdir,
  writeFile,
  rm,
  access,
  utimes,
} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Server } from 'node:http';
import express from 'express';
import pg from 'pg';
import type { Prisma } from '@prisma/client';
import { getPrisma, disconnectPrisma } from '../src/db/prisma.js';
import { loadEffectivePermissions } from '../src/authorization/effectivePermissions.js';
import { createHostingAdministrationRouter } from '../src/hosted/admin-routes.js';
import { createJobSchedulesRouter } from '../src/jobs/schedule-routes.js';
import { createJobsRouter } from '../src/jobs/routes.js';
import { hostingErrorHandler } from '../src/hosted/routes.js';
import { UsageCollector, usageReport, utcHour } from '../src/hosted/usage.js';
import {
  runSchedulerTick,
  seedHostingSchedules,
  enqueueSchedule,
} from '../src/jobs/scheduler.js';
import { performHostingAction } from '../src/hosted/operations.js';
import {
  assertOwnerQuota,
  lockHostingAllocation,
} from '../src/hosted/quotas.js';
import {
  cleanupStorage,
  buildDirectory,
  reserveStorage,
} from '../src/hosted/filesystem.js';
import { loadHostingConfig } from '../src/hosted/config.js';
import {
  staleEligible,
  maintenanceHandler,
  adminActionHandler,
} from '../src/hosted/maintenance.js';
import type { JobExecutionContext } from '../src/jobs/types.js';
import { HapiPartitionClient } from '../src/hapi/partition_client.js';

const adminUrl =
  process.env.FHIR_STUDIO_TEST_ADMIN_DATABASE_URL ||
  'postgresql://postgres:password@127.0.0.1:5433/postgres';
const database = `studio_admin_test_${crypto.randomBytes(6).toString('hex')}`;
const pool = new pg.Pool({
  connectionString: adminUrl,
  connectionTimeoutMillis: 5000,
});
const owner = crypto.randomUUID(),
  operator = crypto.randomUUID(),
  other = crypto.randomUUID(),
  stranger = crypto.randomUUID();
let root: string,
  server: Server,
  origin: string,
  created = false;
const db = () => getPrisma();
before(async () => {
  await pool.query(`CREATE DATABASE "${database}"`);
  created = true;
  const url = new URL(adminUrl);
  url.pathname = `/${database}`;
  root = await mkdtemp(path.join(os.tmpdir(), 'studio-admin-test-'));
  Object.assign(process.env, {
    NODE_ENV: 'test',
    FHIR_STUDIO_HOSTING_ENABLED: 'true',
    FHIR_STUDIO_SERVER_DATABASE_URL: url.href,
    DATABASE_URL: url.href,
    FHIR_STUDIO_HOSTING_ROOT: root,
    FHIR_STUDIO_HOSTING_DOMAIN: 'user.studio.test',
    FHIR_STUDIO_HOSTING_STUDIO_ORIGIN: 'http://studio.test',
    FHIR_STUDIO_HOSTING_ANALYTICS_KEY: crypto
      .randomBytes(32)
      .toString('base64'),
    FHIR_STUDIO_HOSTING_ENCRYPTION_KEY: crypto
      .randomBytes(32)
      .toString('base64'),
    FHIR_STUDIO_HOSTING_GITHUB_APP_ID: '1',
    FHIR_STUDIO_HOSTING_GITHUB_CLIENT_ID: 'test',
    FHIR_STUDIO_HOSTING_GITHUB_CLIENT_SECRET: 'test',
    FHIR_STUDIO_HOSTING_GITHUB_PRIVATE_KEY: crypto.generateKeyPairSync('rsa', {
      modulusLength: 2048,
      privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
      publicKeyEncoding: { type: 'spki', format: 'pem' },
    }).privateKey,
    FHIR_STUDIO_HOSTING_GITHUB_WEBHOOK_SECRET: 'test',
    FHIR_STUDIO_HOSTING_GITHUB_SLUG: 'test',
    FHIR_STUDIO_HAPI_R4_ENABLED: 'true',
    FHIR_STUDIO_HAPI_R4_BASE_URL: 'http://127.0.0.1:1/fhir',
    FHIR_STUDIO_HAPI_R4B_ENABLED: 'false',
    FHIR_STUDIO_HAPI_R5_ENABLED: 'false',
  });
  const migrate = spawnSync(
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
  assert.equal(migrate.status, 0, migrate.stdout + migrate.stderr);
  for (const [id, name] of [
    [owner, 'owner'],
    [operator, 'operator'],
    [other, 'other'],
    [stranger, 'stranger'],
  ])
    await db().user.create({
      data: {
        id,
        ssoIssuer: 'test',
        ssoSubject: name,
        displayName: name,
        email: `${name}@test.example`,
      },
    });
  const deploy = await db().role.create({
    data: { name: 'deploy', permission_applications_deployment: true },
  });
  const admin = await db().role.create({
    data: { name: 'admin', permission_global_manage: true },
  });
  for (const id of [owner, other, stranger])
    await db().appointment.create({
      data: { roleId: deploy.id, entityId: id, entityType: 'User' },
    });
  await db().appointment.create({
    data: { roleId: admin.id, entityId: operator, entityType: 'User' },
  });
  const api = express();
  api.use(express.json());
  api.use(async (req, _res, next) => {
    const id = req.header('x-test-user');
    if (id && [owner, operator, other, stranger].includes(id)) {
      req.sessionAuth = {
        userId: id,
        sessionId: 'test',
        sub: id,
        ssoRoles: [],
        email: null,
        displayName: null,
        isSuspended: false,
      };
      req.effectivePermissions = await loadEffectivePermissions(db(), id);
    }
    next();
  });
  api.use(createHostingAdministrationRouter());
  api.use(createJobSchedulesRouter());
  api.use(createJobsRouter());
  api.use(hostingErrorHandler);
  server = api.listen(0, '127.0.0.1');
  await new Promise<void>((resolve) => server.once('listening', resolve));
  origin = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
});
after(async () => {
  if (server)
    await new Promise<void>((resolve) => server.close(() => resolve()));
  await disconnectPrisma();
  if (created) await pool.query(`DROP DATABASE "${database}" WITH (FORCE)`);
  await pool.end();
  if (root) await rm(root, { recursive: true, force: true });
});
async function app(
  name: string,
  overrides: Partial<Prisma.HostedApplicationUncheckedCreateInput> = {},
) {
  return db().hostedApplication.create({
    data: {
      name,
      ownerUserId: owner,
      createdByUserId: owner,
      repositoryId: crypto.randomInt(1000000).toString(),
      repository: 'owner/repo',
      installationId: '1',
      ...overrides,
    },
  });
}
async function deployed(name: string) {
  const a = await app(name);
  const b = await db().hostedBuild.create({
    data: {
      applicationId: a.id,
      branch: 'main',
      commit: 'a'.repeat(40),
      generation: a.generation,
      status: 'READY',
      byteSize: 128n,
    },
  });
  const directory = buildDirectory(loadHostingConfig(), a.id, b.id);
  await mkdir(directory, { recursive: true });
  await writeFile(path.join(directory, 'index.html'), '<html>test</html>');
  const old = new Date(Date.now() - 3600000);
  await utimes(directory, old, old);
  await db().hostedBuild.update({ where: { id: b.id }, data: { directory } });
  await db().hostedApplication.update({
    where: { id: a.id },
    data: { previewBuildId: b.id, publishedBuildId: b.id },
  });
  return { a, b, directory };
}
async function request(
  endpoint: string,
  user: string | undefined = operator,
  method = 'GET',
  body?: unknown,
) {
  return fetch(origin + endpoint, {
    method,
    headers: {
      ...(user ? { 'x-test-user': user } : {}),
      ...(body ? { 'content-type': 'application/json' } : {}),
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
}
async function context(
  type: string,
  input: Prisma.InputJsonObject,
): Promise<JobExecutionContext> {
  const job = await db().job.create({
    data: {
      name: type,
      jobType: type,
      input,
      status: 'in_progress',
      lockedBy: 'test-worker',
      leaseExpiresAt: new Date(Date.now() + 300000),
      createdByUserId: operator,
    },
  });
  return {
    job,
    prisma: db(),
    hapiClient: new HapiPartitionClient(),
    signal: new AbortController().signal,
    updateProgress: async () => {},
    isCancelled: async () =>
      (await db().job.findUniqueOrThrow({ where: { id: job.id } })).status ===
      'cancelled',
  };
}

test('reports, exports, quotas, schedules and maintenance polling enforce authorization', async () => {
  const a = await app('permissions');
  for (const endpoint of [
    '/api/administration/hosting/applications',
    '/api/administration/hosting/owners',
    '/api/administration/hosting/storage',
    '/api/administration/hosting/audit?format=csv',
    '/api/administration/job-schedules',
    '/api/administration/job-types',
  ]) {
    assert.equal((await request(endpoint, '')).status, 401);
    assert.equal((await request(endpoint, owner)).status, 403);
    assert.equal((await request(endpoint)).status, 200);
  }
  assert.equal(
    (await request(`/api/hosted-applications/${a.id}/usage`, owner)).status,
    200,
  );
  assert.equal(
    (await request(`/api/hosted-applications/${a.id}/usage`, stranger)).status,
    404,
  );
  await db().hostedCollaborator.create({
    data: { applicationId: a.id, userId: stranger, role: 'READ_ONLY' },
  });
  assert.equal(
    (await request(`/api/hosted-applications/${a.id}/usage`, stranger)).status,
    200,
  );
  assert.equal(
    (
      await request(
        `/api/administration/hosting/owners/${owner}`,
        owner,
        'PUT',
        { applicationLimit: 20, storageBytesLimit: null, reason: 'bad' },
      )
    ).status,
    403,
  );
  const job = await context('HOSTED_STORAGE_INSPECT', {});
  assert.equal((await request(`/api/jobs/${job.job.id}`, owner)).status, 403);
  assert.equal((await request(`/api/jobs/${job.job.id}`)).status, 200);
});

test('collector flushes merge concurrent producers, deduplicate ambiguous retries, and preserve response classifications', async () => {
  const a = await app('usage'),
    at = new Date('2026-01-02T03:10:00Z');
  const one = new UsageCollector('host'),
    two = new UsageCollector('host');
  for (const collector of [one, two]) {
    collector.record({
      applicationId: a.id,
      channel: 'published',
      at,
      status: 200,
      document: true,
      bytes: 100,
      durationMs: 15,
      visitor: 'same-browser',
    });
    collector.record({
      applicationId: a.id,
      channel: 'published',
      at,
      status: 304,
      document: true,
      visitor: 'same-browser',
      durationMs: 5,
    });
  }
  one.record({
    applicationId: a.id,
    channel: 'published',
    at,
    status: 429,
    bot: true,
  });
  one.record({
    applicationId: a.id,
    channel: 'preview',
    at,
    status: 200,
    aborted: true,
    durationMs: 300,
  });
  one.record({ applicationId: a.id, channel: 'published', at, launch: true });
  await Promise.all([one.flush(), two.flush()]);
  const hour = await db().hostedUsageHour.findUniqueOrThrow({
    where: {
      applicationId_channel_hour: {
        applicationId: a.id,
        channel: 'published',
        hour: utcHour(at),
      },
    },
  });
  assert.equal(hour.requests, 5);
  assert.equal(hour.documents, 4);
  assert.equal(hour.bytes, 200n);
  assert.equal(hour.bots, 1);
  assert.equal(hour.rateLimited, 1);
  assert.equal(hour.launches, 1);
  const report = await usageReport(
    [a.id],
    new Date('2026-01-02'),
    new Date('2026-01-03'),
  );
  assert.equal(report.visitors.published, 1);
  assert.equal(report.totals.requests, 6);
  assert.equal(report.totals.aborted, 1);
  // A collector cursor already committed for this sequence simulates losing the acknowledgement.
  const retry = new UsageCollector('host');
  retry.record({ applicationId: a.id, channel: 'published', at, status: 200 });
  await db().hostedUsageCollector.create({
    data: { id: retry.id, kind: 'host', sequence: 1 },
  });
  await retry.flush();
  assert.equal(
    (
      await db().hostedUsageHour.findUniqueOrThrow({
        where: {
          applicationId_channel_hour: {
            applicationId: a.id,
            channel: 'published',
            hour: utcHour(at),
          },
        },
      })
    ).requests,
    5,
  );
  const fresh = await db().hostedApplication.findUniqueOrThrow({
    where: { id: a.id },
  });
  assert.equal(fresh.lastLaunchAt?.toISOString(), at.toISOString());
});

test('scheduler atomically coalesces concurrent ticks, preserves run-now cadence and existing seed choices', async () => {
  await seedHostingSchedules(db());
  const original = await db().jobSchedule.findUniqueOrThrow({
    where: { systemKey: 'hosting-reconcile' },
  });
  await db().jobSchedule.updateMany({ data: { enabled: false } });
  await seedHostingSchedules(db());
  assert.equal(
    (await db().jobSchedule.findUniqueOrThrow({ where: { id: original.id } }))
      .enabled,
    false,
  );
  const schedule = await db().jobSchedule.create({
    data: {
      name: 'test',
      jobType: 'TEST_JOB',
      frequency: 'HOURLY',
      input: {},
      enabled: true,
      nextRunAt: new Date(Date.now() - 10 * 86400000),
    },
  });
  await Promise.all([
    runSchedulerTick(),
    runSchedulerTick(),
    runSchedulerTick(),
  ]);
  assert.equal(await db().job.count({ where: { scheduleId: schedule.id } }), 1);
  const after = await db().jobSchedule.findUniqueOrThrow({
    where: { id: schedule.id },
  });
  assert.ok(after.nextRunAt > new Date());
  await assert.rejects(
    db().$transaction((tx) => enqueueSchedule(tx, schedule.id, true)),
    /active job/,
  );
  await db().job.updateMany({
    where: { scheduleId: schedule.id },
    data: { status: 'completed' },
  });
  await db().$transaction((tx) => enqueueSchedule(tx, schedule.id, true));
  assert.equal(
    (
      await db().jobSchedule.findUniqueOrThrow({ where: { id: schedule.id } })
    ).nextRunAt.toISOString(),
    after.nextRunAt.toISOString(),
  );
  const response = await request(
    `/api/administration/job-schedules/${schedule.id}`,
    operator,
    'PATCH',
    { minuteOfHour: 90 },
  );
  assert.equal(response.status, 400);
});

test('trash preserves assigned files, restores publication and keeps tokens revoked; permanent purge preserves traffic', async () => {
  const { a, b, directory } = await deployed('trash');
  const session = await db().smartAuthSession.create({
    data: {
      sandboxId: 'test',
      clientId: `hosted-${a.id}-published`,
      redirectUri: 'http://test',
      scope: 'openid',
    },
  });
  const collector = new UsageCollector('host');
  collector.record({ applicationId: a.id, channel: 'published', status: 200 });
  await collector.flush();
  await performHostingAction(
    a.id,
    { ids: [a.id], action: 'trash', reason: 'test trash' },
    operator,
  );
  await cleanupStorage(loadHostingConfig('worker'));
  await access(path.join(directory, 'index.html'));
  const trashed = await db().hostedApplication.findUniqueOrThrow({
    where: { id: a.id },
  });
  assert.equal(trashed.publishedBuildId, b.id);
  assert.ok(trashed.deleteAfter);
  await performHostingAction(
    a.id,
    { ids: [a.id], action: 'restore', reason: 'test restore' },
    operator,
  );
  const restored = await db().hostedApplication.findUniqueOrThrow({
    where: { id: a.id },
  });
  assert.equal(restored.publishedBuildId, b.id);
  assert.equal(restored.deletedAt, null);
  assert.ok(restored.publishingPaused);
  assert.ok(
    (
      await db().smartAuthSession.findUniqueOrThrow({
        where: { id: session.id },
      })
    ).isRevoked,
  );
  await performHostingAction(
    a.id,
    { ids: [a.id], action: 'trash', reason: 'purge setup' },
    operator,
  );
  await performHostingAction(
    a.id,
    { ids: [a.id], action: 'purge', reason: 'permanent purge' },
    operator,
  );
  await assert.rejects(access(directory));
  assert.equal(await db().hostedApplication.count({ where: { id: a.id } }), 0);
  assert.equal(
    await db().hostedUsageHour.count({ where: { applicationId: a.id } }),
    1,
  );
  assert.equal(
    await db().hostedAudit.count({
      where: { applicationId: a.id, action: 'ADMIN_PURGE' },
    }),
    1,
  );
  await performHostingAction(
    a.id,
    { ids: [a.id], action: 'purge', reason: 'retry purge' },
    operator,
  );
});

test('restore rejects missing files and expired trash, and worker lease loss prevents mutations', async () => {
  const { a, directory } = await deployed('restore-errors');
  await performHostingAction(
    a.id,
    { ids: [a.id], action: 'trash', reason: 'test' },
    operator,
  );
  await rm(path.join(directory, 'index.html'));
  await assert.rejects(
    performHostingAction(
      a.id,
      { ids: [a.id], action: 'restore', reason: 'test' },
      operator,
    ),
    /missing/,
  );
  await db().hostedApplication.update({
    where: { id: a.id },
    data: { deleteAfter: new Date(Date.now() - 1) },
  });
  await assert.rejects(
    performHostingAction(
      a.id,
      { ids: [a.id], action: 'restore', reason: 'test' },
      operator,
    ),
    /recovery window/,
  );
  const job = await context('HOSTED_ADMIN_ACTION', {});
  await db().job.update({
    where: { id: job.job.id },
    data: { lockedBy: 'different-worker' },
  });
  await assert.rejects(
    performHostingAction(
      a.id,
      { ids: [a.id], action: 'purge', reason: 'test' },
      operator,
      { job: job.job },
    ),
    /lease/,
  );
  assert.equal(await db().hostedApplication.count({ where: { id: a.id } }), 1);
});

test('quotas serialize concurrent allocations, charge trash/reservations, and validate reassignment', async () => {
  const target = await db().user.create({
    data: { ssoIssuer: 'test', ssoSubject: crypto.randomUUID() },
  });
  await db().hostedOwnerQuota.create({
    data: { userId: target.id, applicationLimit: 1, storageBytesLimit: 100n },
  });
  const results = await Promise.allSettled(
    [1, 2].map((i) =>
      db().$transaction(async (tx) => {
        await lockHostingAllocation(tx, [target.id]);
        await assertOwnerQuota(tx, loadHostingConfig(), target.id, 1);
        await tx.hostedApplication.create({
          data: {
            name: `race-${i}`,
            ownerUserId: target.id,
            createdByUserId: target.id,
            repositoryId: '1',
            repository: 'test/test',
            installationId: '1',
          },
        });
      }),
    ),
  );
  assert.equal(results.filter((r) => r.status === 'fulfilled').length, 1);
  const { a } = await deployed('quota-trash');
  await db().hostedOwnerQuota.upsert({
    where: { userId: owner },
    create: { userId: owner, storageBytesLimit: 128n },
    update: { storageBytesLimit: 128n },
  });
  await performHostingAction(
    a.id,
    { ids: [a.id], action: 'trash', reason: 'quota' },
    operator,
  );
  await assert.rejects(
    db().$transaction((tx) =>
      assertOwnerQuota(tx, loadHostingConfig(), owner, 0, 1n),
    ),
    /storage quota/,
  );
  await assert.rejects(
    performHostingAction(
      (await app('reassign-invalid')).id,
      { ids: [], action: 'reassign', ownerUserId: target.id, reason: 'test' },
      operator,
    ),
    /deployment/,
  );
  await db().hostedOwnerQuota.delete({ where: { userId: owner } });
  const source = await app('reassign-valid');
  await db().hostedCollaborator.create({
    data: { applicationId: source.id, userId: stranger, role: 'READ_ONLY' },
  });
  await performHostingAction(
    source.id,
    {
      ids: [source.id],
      action: 'reassign',
      ownerUserId: other,
      reason: 'new owner',
    },
    operator,
  );
  const moved = await db().hostedApplication.findUniqueOrThrow({
    where: { id: source.id },
  });
  assert.equal(moved.ownerUserId, other);
  assert.ok(moved.publishingPaused);
  assert.equal(
    await db().hostedCollaborator.count({
      where: { applicationId: source.id, userId: stranger },
    }),
    1,
  );
});

test('stale policies protect publication, templates, active builds, recent activity and unknown collection', async () => {
  const old = new Date(Date.now() - 200 * 86400000),
    input = {
      inactiveDays: 180,
      suspendedDays: 7,
      action: 'suspend',
      includePublished: false,
      includeTemplates: false,
    };
  const stale = await app('stale', { lastDeveloperActivityAt: old });
  assert.equal(await staleEligible(stale, db(), input), false);
  await db().hostedUsageCollector.create({
    data: {
      id: crypto.randomUUID(),
      kind: 'host',
      startedAt: old,
      lastFlushedAt: new Date(),
    },
  });
  assert.equal(await staleEligible(stale, db(), input), true);
  for (const change of [
    { cleanupProtected: true },
    { isTemplate: true },
    { publishedBuildId: crypto.randomUUID() },
    { transferToUserId: other },
    { lastServedAt: new Date() },
    { lastLaunchAt: new Date() },
    { lastDeveloperActivityAt: new Date() },
  ])
    assert.equal(
      await staleEligible({ ...stale, ...change }, db(), input),
      false,
    );
  await db().hostedBuild.create({
    data: {
      applicationId: stale.id,
      branch: 'main',
      commit: 'b',
      generation: 0,
      status: 'IMPORTING',
    },
  });
  assert.equal(await staleEligible(stale, db(), input), false);
  await db().hostedBuild.updateMany({
    where: { applicationId: stale.id },
    data: { status: 'FAILED' },
  });
  const dry = await context('HOSTED_STALE_APPLICATIONS', input);
  const result = await maintenanceHandler(dry);
  assert.equal(result?.dryRun, true);
  assert.equal(
    (
      await db().hostedApplication.findUniqueOrThrow({
        where: { id: stale.id },
      })
    ).suspended,
    false,
  );
  const live = await context('HOSTED_STALE_APPLICATIONS', {
    ...input,
    dryRun: false,
  });
  await maintenanceHandler(live);
  assert.equal(
    (
      await db().hostedApplication.findUniqueOrThrow({
        where: { id: stale.id },
      })
    ).suspended,
    true,
  );
  const suspended = await db().hostedApplication.findUniqueOrThrow({
    where: { id: stale.id },
  });
  assert.equal(
    await staleEligible(suspended, db(), { ...input, action: 'trash' }),
    false,
  );
});

test('bulk actions reject stale previews and report partial failures without dropping successful actions', async () => {
  const a = await app('bulk-one'),
    b = await app('bulk-two');
  const body = { ids: [a.id, b.id], action: 'suspend', reason: 'reviewed' };
  const preview = (await (
    await request(
      '/api/administration/hosting/actions/preview',
      operator,
      'POST',
      body,
    )
  ).json()) as { applications: Array<{ id: string; generation: number }> };
  const expectedGenerations = Object.fromEntries(
    preview.applications.map((a) => [a.id, a.generation]),
  );
  await db().hostedApplication.update({
    where: { id: b.id },
    data: { generation: { increment: 1 } },
  });
  const ctx = await context('HOSTED_ADMIN_ACTION', {
    ...body,
    expectedGenerations,
  });
  const result = await adminActionHandler(ctx);
  assert.equal(result?.succeeded, 1);
  assert.equal(result?.failed, 1);
  assert.ok(
    (await db().hostedApplication.findUniqueOrThrow({ where: { id: a.id } }))
      .suspended,
  );
  assert.equal(
    (await db().hostedApplication.findUniqueOrThrow({ where: { id: b.id } }))
      .suspended,
    false,
  );
});

test('history purge is opt-in, dry-run first, preserves active/trash builds and traffic by default', async () => {
  const { a, b } = await deployed('history');
  const old = new Date('2020-01-01');
  await db().hostedBuild.update({
    where: { id: b.id },
    data: { createdAt: old },
  });
  const inactive = await db().hostedBuild.create({
    data: {
      applicationId: a.id,
      branch: 'main',
      commit: 'old',
      generation: 0,
      status: 'FAILED',
      createdAt: old,
    },
  });
  const input = { datasets: ['builds'], before: '2021-01-01T00:00:00Z' };
  const dry = await context('HOSTED_HISTORY_PURGE', input);
  await maintenanceHandler(dry);
  assert.equal(await db().hostedBuild.count({ where: { id: inactive.id } }), 1);
  const live = await context('HOSTED_HISTORY_PURGE', {
    ...input,
    dryRun: false,
  });
  await maintenanceHandler(live);
  assert.equal(await db().hostedBuild.count({ where: { id: inactive.id } }), 0);
  assert.equal(await db().hostedBuild.count({ where: { id: b.id } }), 1);
});

test('owner storage quotas include concurrent import reservations and restoration honors the active application limit', async () => {
  const account = await db().user.create({
    data: { ssoIssuer: 'test', ssoSubject: crypto.randomUUID() },
  });
  const a = await app('reservation-race', { ownerUserId: account.id });
  await db().hostedOwnerQuota.create({
    data: { userId: account.id, storageBytesLimit: 150n, applicationLimit: 1 },
  });
  const builds = await Promise.all(
    [1, 2].map((i) =>
      db().hostedBuild.create({
        data: {
          applicationId: a.id,
          branch: 'main',
          commit: String(i),
          generation: 0,
          status: 'IMPORTING',
        },
      }),
    ),
  );
  const config = {
    ...loadHostingConfig(),
    maxExpandedBytes: 100,
    maxStorageBytes: 1000000,
  };
  const result = await Promise.allSettled(
    builds.map((b) => reserveStorage(config, b.id)),
  );
  assert.equal(result.filter((r) => r.status === 'fulfilled').length, 1);
  assert.equal(
    (
      await db().hostedBuild.aggregate({
        where: { applicationId: a.id },
        _sum: { byteSize: true },
      })
    )._sum.byteSize,
    100n,
  );
  await performHostingAction(
    a.id,
    { ids: [a.id], action: 'trash', reason: 'reservation test' },
    operator,
  );
  await assert.rejects(
    db().$transaction((tx) => assertOwnerQuota(tx, config, account.id, 0, 51n)),
    /storage quota/,
  );
  await db().hostedOwnerQuota.update({
    where: { userId: account.id },
    data: { applicationLimit: 0 },
  });
  await assert.rejects(
    performHostingAction(
      a.id,
      { ids: [a.id], action: 'restore', reason: 'quota test' },
      operator,
    ),
    /ownership quota/,
  );
});

test('explicit traffic purge persists a watermark so delayed collector batches cannot resurrect old hours', async () => {
  const a = await app('purge-watermark');
  const at = new Date('2020-01-01T01:00:00Z');
  const old = new UsageCollector('host'),
    delayed = new UsageCollector('host');
  for (const c of [old, delayed])
    c.record({ applicationId: a.id, channel: 'published', status: 200, at });
  await old.flush();
  const ctx = await context('HOSTED_HISTORY_PURGE', {
    datasets: ['usage'],
    before: '2021-01-01T00:00:00Z',
    dryRun: false,
  });
  await maintenanceHandler(ctx);
  await delayed.flush();
  assert.equal(
    await db().hostedUsageHour.count({ where: { applicationId: a.id } }),
    0,
  );
  delayed.record({ applicationId: a.id, channel: 'published', status: 200 });
  await delayed.flush();
  assert.equal(
    await db().hostedUsageHour.count({ where: { applicationId: a.id } }),
    1,
  );
});

test('health inventory includes assigned builds found missing by storage inspection', async () => {
  const { a, b, directory } = await deployed('missing-health');
  await rm(path.join(directory, 'index.html'));
  const ctx = await context('HOSTED_STORAGE_INSPECT', {});
  const output = await maintenanceHandler(ctx);
  await db().job.update({
    where: { id: ctx.job.id },
    data: {
      status: 'completed',
      completedAt: new Date(),
      output: output as Prisma.InputJsonObject,
    },
  });
  const response = await request(
    '/api/administration/hosting/applications?status=problem',
  );
  const report = (await response.json()) as {
    applications: Array<{ id: string; issues: string[] }>;
  };
  assert.ok(
    report.applications
      .find((item) => item.id === a.id)
      ?.issues.includes('Deployed files missing'),
  );
});
