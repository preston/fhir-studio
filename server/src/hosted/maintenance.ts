import { access, readdir, stat, statfs } from 'node:fs/promises';
import path from 'node:path';
import type { HostedApplication, Prisma } from '@prisma/client';
import type {
  HostingActionRequest,
  HostingActionResult,
} from '@fhir-studio/core';
import type { JobHandler, JobExecutionContext } from '../jobs/types.js';
import { validateJobInput } from '../jobs/definitions.js';
import { utcHour } from './usage.js';
import { loadHostingConfig } from './config.js';
import { sweepHosting } from './builds.js';
import { cleanupStorage, buildDirectory } from './filesystem.js';
import { actionRequest, performHostingAction } from './operations.js';

const checkpointTimes = new WeakMap<JobExecutionContext, number>();
async function check(ctx: JobExecutionContext): Promise<void> {
  if (ctx.signal.aborted) throw new Error('Job cancelled');
  const now = Date.now();
  if (now - (checkpointTimes.get(ctx) ?? 0) < 1000) return;
  const lease = await ctx.prisma.job.findFirst({
    where: {
      id: ctx.job.id,
      status: 'in_progress',
      lockedBy: ctx.job.lockedBy,
      leaseExpiresAt: { gt: new Date() },
    },
    select: { id: true },
  });
  if (!lease || (await ctx.isCancelled()))
    throw new Error('Job cancelled or lease lost');
  checkpointTimes.set(ctx, now);
}
export async function storageInspection(
  ctx: JobExecutionContext,
): Promise<Record<string, unknown>> {
  const config = loadHostingConfig('worker');
  const builds = await ctx.prisma.hostedBuild.findMany({
    where: { directory: { not: null } },
  });
  const applications = await ctx.prisma.hostedApplication.findMany();
  const protectedIds = new Set(
    applications.flatMap((a) =>
      [a.previewBuildId, a.publishedBuildId, a.desiredBuildId].filter(
        (id): id is string => !!id,
      ),
    ),
  );
  for (const build of builds) if (protectedIds.has(build.id) && build.contentBuildId) protectedIds.add(build.contentBuildId);
  let allocated = 0n,
    reclaimable = 0n,
    staging = 0n,
    orphaned = 0n;
  const missing: string[] = [];
  for (const build of builds) {
    await check(ctx);
    allocated += build.byteSize;
    if (!protectedIds.has(build.id)) reclaimable += build.byteSize;
    try {
      await access(
        path.join(
          buildDirectory(config, build.applicationId, build.contentBuildId || build.id),
          build.launchPath,
        ),
      );
    } catch {
      missing.push(build.id);
    }
  }
  const measure = async (target: string): Promise<bigint> => {
    let bytes = 0n;
    for (const entry of await readdir(target, { withFileTypes: true }).catch(
      () => [],
    )) {
      await check(ctx);
      const name = path.join(target, entry.name);
      if (entry.isDirectory()) bytes += await measure(name);
      else if (entry.isFile()) bytes += BigInt((await stat(name)).size);
    }
    return bytes;
  };
  staging = await measure(path.join(config.root, '.staging'));
  const known = new Set(builds.map((b) => `${b.applicationId}/${b.id}`));
  for (const app of await readdir(path.join(config.root, 'apps'), {
    withFileTypes: true,
  }).catch(() => []))
    if (app.isDirectory()) {
      for (const build of await readdir(
        path.join(config.root, 'apps', app.name),
        { withFileTypes: true },
      ))
        if (build.isDirectory() && !known.has(`${app.name}/${build.name}`))
          orphaned += await measure(
            path.join(config.root, 'apps', app.name, build.name),
          );
    }
  const fs = await statfs(config.root);
  return {
    inspectedAt: new Date().toISOString(),
    allocatedBytes: String(allocated),
    reclaimableBytes: String(reclaimable + orphaned),
    orphanBytes: String(orphaned),
    stagingBytes: String(staging),
    freeBytes: String(BigInt(fs.bavail) * BigInt(fs.bsize)),
    budgetBytes: String(config.maxStorageBytes),
    missingBuildIds: missing,
  };
}
export async function staleEligible(
  app: HostedApplication,
  tx: Prisma.TransactionClient,
  input: Record<string, unknown>,
): Promise<boolean> {
  const cutoff = new Date(Date.now() - Number(input.inactiveDays) * 86400000);
  if (
    app.deletedAt ||
    app.cleanupProtected ||
    app.transferToUserId ||
    (!input.includePublished && app.publishedBuildId) ||
    (!input.includeTemplates && app.isTemplate) ||
    (Array.isArray(input.excludeOwnerIds) &&
      input.excludeOwnerIds.includes(app.ownerUserId))
  )
    return false;
  if (
    app.lastDeveloperActivityAt > cutoff ||
    (app.lastServedAt && app.lastServedAt > cutoff) ||
    (app.lastLaunchAt && app.lastLaunchAt > cutoff)
  )
    return false;
  // Missing/outdated host collection is unknown usage, never evidence of abandonment.
  const baseline = await tx.hostedUsageCollector.findFirst({
    where: { kind: 'host', startedAt: { lte: cutoff } },
  });
  const collector = await tx.hostedUsageCollector.findFirst({
    where: {
      kind: 'host',
      lastFlushedAt: { gt: new Date(Date.now() - 5 * 60000) },
    },
  });
  if (!baseline || !collector) return false;
  if (input.action === 'suspend' && app.suspended) return false;
  if (
    input.action === 'trash' &&
    (!app.suspended ||
      !app.suspendedAt ||
      app.suspendedAt >
        new Date(Date.now() - Number(input.suspendedDays) * 86400000))
  )
    return false;
  return !(await tx.hostedBuild.findFirst({
    where: {
      applicationId: app.id,
      status: { in: ['WAITING', 'BUILDING', 'IMPORTING'] },
    },
  }));
}
export const adminActionHandler: JobHandler = async (ctx) => {
  const input = actionRequest(ctx.job.input),
    results: HostingActionResult[] = [];
  // Recheck that the initiating administrator still has management authority.
  const { loadEffectivePermissions } =
    await import('../authorization/effectivePermissions.js');
  const actor = ctx.job.createdByUserId;
  const user = actor
    ? await ctx.prisma.user.findUnique({ where: { id: actor } })
    : null;
  if (
    !actor ||
    !user ||
    user.isSuspended ||
    !(await loadEffectivePermissions(ctx.prisma, actor)).global_manage
  )
    throw new Error('Administrative authority is no longer available.');
  for (const id of input.ids) {
    await check(ctx);
    try {
      await performHostingAction(id, input, actor, { job: ctx.job });
      results.push({ id, success: true });
    } catch (error) {
      results.push({
        id,
        success: false,
        error: error instanceof Error ? error.message : 'Action failed',
      });
    }
    await ctx.updateProgress(
      (results.length / input.ids.length) * 100,
      `${results.length}/${input.ids.length} applications processed`,
    );
  }
  return {
    results,
    succeeded: results.filter((r) => r.success).length,
    failed: results.filter((r) => !r.success).length,
  };
};
export const maintenanceHandler: JobHandler = async (ctx) => {
  const input = validateJobInput(ctx.job.jobType, ctx.job.input);
  await check(ctx);
  if (ctx.job.jobType === 'HOSTED_RECONCILE_ALL') {
    await sweepHosting(() => check(ctx));
    return { reconciled: true };
  }
  if (ctx.job.jobType === 'HOSTED_STORAGE_INSPECT')
    return storageInspection(ctx);
  if (ctx.job.jobType === 'HOSTED_STORAGE_CLEANUP') {
    if (input.dryRun)
      return { dryRun: true, ...(await storageInspection(ctx)) };
    await cleanupStorage(loadHostingConfig('worker'), () => check(ctx));
    return { cleaned: true };
  }
  if (ctx.job.jobType === 'HOSTED_HISTORY_PURGE') {
    const before = new Date(String(input.before)),
      datasets = input.datasets as string[];
    const counts: Record<string, number> = {};
    // Serialize history deletion and its durable watermark with collector merges.
    await ctx.prisma.$transaction(
      async (tx) => {
        await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended('hosted-usage', 0))`;
        const lease = await tx.job.findFirst({
          where: {
            id: ctx.job.id,
            lockedBy: ctx.job.lockedBy,
            status: 'in_progress',
            leaseExpiresAt: { gt: new Date() },
          },
        });
        if (!lease) throw new Error('Job cancelled or lease lost');
        if (datasets.includes('usage')) {
          const cutoff = utcHour(before);
          const where = { hour: { lt: cutoff } };
          counts.usage = await tx.hostedUsageHour.count({ where });
          if (!input.dryRun) {
            await tx.hostedUsageHour.deleteMany({ where });
            const policy = await tx.hostedUsagePolicy.findUnique({
              where: { id: 'global' },
            });
            const purgedBefore =
              policy && policy.purgedBefore > cutoff
                ? policy.purgedBefore
                : cutoff;
            await tx.hostedUsagePolicy.upsert({
              where: { id: 'global' },
              create: { id: 'global', purgedBefore },
              update: { purgedBefore },
            });
          }
        }
        if (datasets.includes('audit')) {
          const where = { createdAt: { lt: before } };
          counts.audit = await tx.hostedAudit.count({ where });
          if (!input.dryRun) await tx.hostedAudit.deleteMany({ where });
        }
        if (datasets.includes('builds')) {
          await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended('hosted-storage', 0))`;
          const apps = await tx.hostedApplication.findMany({
            select: {
              previewBuildId: true,
              publishedBuildId: true,
              desiredBuildId: true,
            },
          });
          const ids = apps.flatMap((a) =>
            [a.previewBuildId, a.publishedBuildId, a.desiredBuildId].filter(
              (v): v is string => !!v,
            ),
          );
          const where: Prisma.HostedBuildWhereInput = {
            createdAt: { lt: before },
            directory: null,
            byteSize: 0n,
            status: { notIn: ['WAITING', 'BUILDING', 'IMPORTING'] },
            id: { notIn: ids },
            application: { deletedAt: null },
          };
          counts.builds = await tx.hostedBuild.count({ where });
          if (!input.dryRun) await tx.hostedBuild.deleteMany({ where });
        }
        await tx.hostedAudit.create({
          data: {
            action: 'HISTORY_PURGE',
            userId: ctx.job.createdByUserId,
            detail: {
              jobId: ctx.job.id,
              before: before.toISOString(),
              datasets,
              dryRun: !!input.dryRun,
              counts,
            },
          },
        });
      },
      { timeout: 30000 },
    );
    return { dryRun: input.dryRun, counts };
  }
  const isTrash = ctx.job.jobType === 'HOSTED_PURGE_TRASH';
  const apps = await ctx.prisma.hostedApplication.findMany({
    where: isTrash
      ? { deletedAt: { not: null }, deleteAfter: { lte: new Date() } }
      : {
          deletedAt: null,
          lastDeveloperActivityAt: {
            lte: new Date(Date.now() - Number(input.inactiveDays) * 86400000),
          },
        },
    orderBy: { id: 'asc' },
  });
  let eligible = 0,
    succeeded = 0;
  const results: HostingActionResult[] = [];
  for (const app of apps) {
    await check(ctx);
    if (!isTrash && !(await staleEligible(app, ctx.prisma, input))) continue;
    eligible++;
    if (input.dryRun) {
      if (results.length < 100) results.push({ id: app.id, success: true });
      continue;
    }
    const request: HostingActionRequest = {
      ids: [app.id],
      action: isTrash ? 'purge' : (input.action as 'suspend' | 'trash'),
      reason: `Scheduled ${ctx.job.jobType} (${ctx.job.id})`,
    };
    try {
      await performHostingAction(app.id, request, null, {
        job: ctx.job,
        eligible: isTrash
          ? async (a) => !!a.deleteAfter && a.deleteAfter <= new Date()
          : (a, tx) => staleEligible(a, tx, input),
      });
      succeeded++;
      if (results.length < 100) results.push({ id: app.id, success: true });
    } catch (error) {
      if (results.length < 100)
        results.push({
          id: app.id,
          success: false,
          error: error instanceof Error ? error.message : 'Maintenance failed',
        });
    }
    await ctx.updateProgress(
      apps.length ? (eligible / apps.length) * 100 : 100,
      `${eligible} eligible, ${succeeded} processed`,
    );
  }
  return {
    dryRun: input.dryRun,
    eligible,
    succeeded,
    results,
    sampledResults: eligible > 100,
  };
};
