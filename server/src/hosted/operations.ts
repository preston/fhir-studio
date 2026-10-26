import { access, rm } from 'node:fs/promises';
import path from 'node:path';
import type { HostedApplication, Prisma } from '@prisma/client';
import type { HostingActionRequest, HostingAction } from '@fhir-studio/core';
import { getPrisma } from '../db/prisma.js';
import { HostingError, assertDeploymentPermission } from './access.js';
import { loadHostingConfig } from './config.js';
import { lockApplication } from './github.js';
import { buildDirectory } from './filesystem.js';
import { assertOwnerQuota, lockHostingAllocation } from './quotas.js';

const actions: HostingAction[] = [
  'suspend',
  'resume',
  'unpublish',
  'trash',
  'restore',
  'purge',
  'protect',
  'unprotect',
  'reassign',
];
export function actionRequest(value: unknown): HostingActionRequest {
  const b = value as Partial<HostingActionRequest> | null;
  if (
    !b ||
    !Array.isArray(b.ids) ||
    !b.ids.length ||
    b.ids.length > 100 ||
    !b.ids.every(
      (id) =>
        typeof id === 'string' &&
        /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(
          id,
        ),
    ) ||
    !actions.includes(b.action!) ||
    typeof b.reason !== 'string' ||
    !b.reason.trim() ||
    b.reason.length > 2000
  )
    throw new HostingError(
      400,
      'Provide up to 100 application UUIDs, a supported action, and an administrative reason (1–2000 characters).',
    );
  if (
    b.action === 'reassign' &&
    (typeof b.ownerUserId !== 'string' ||
      !/^[a-f0-9-]{36}$/.test(b.ownerUserId))
  )
    throw new HostingError(400, 'Select a new owner UUID.');
  if (
    b.expectedGenerations &&
    (typeof b.expectedGenerations !== 'object' ||
      Array.isArray(b.expectedGenerations) ||
      !Object.values(b.expectedGenerations).every(Number.isSafeInteger))
  )
    throw new HostingError(400, 'Invalid application versions.');
  return {
    ...b,
    ids: [...new Set(b.ids)],
    reason: b.reason.trim(),
  } as HostingActionRequest;
}
export function validateLifecycle(
  app: HostedApplication,
  action: HostingAction,
): void {
  if (action === 'restore') {
    if (!app.deletedAt || !app.deleteAfter || app.deleteAfter <= new Date())
      throw new HostingError(409, 'Application is not in its recovery window.');
  } else if (action === 'purge') {
    if (!app.deletedAt)
      throw new HostingError(
        409,
        'Move the application to trash before permanent purge.',
      );
  } else if (app.deletedAt)
    throw new HostingError(409, 'Restore the application before changing it.');
}
export async function revokeHostedSessions(
  tx: Prisma.TransactionClient,
  id: string,
  publishedOnly = false,
): Promise<void> {
  await tx.smartAuthSession.updateMany({
    where: {
      clientId: {
        in: publishedOnly
          ? [`hosted-${id}-published`]
          : [`hosted-${id}-preview`, `hosted-${id}-published`],
      },
    },
    data: { isRevoked: true },
  });
}
export async function performHostingAction(
  id: string,
  request: HostingActionRequest,
  actorId: string | null,
  options: {
    job?: { id: string; lockedBy: string | null };
    authorize?: (tx: Prisma.TransactionClient) => Promise<void>;
    eligible?: (
      app: HostedApplication,
      tx: Prisma.TransactionClient,
    ) => Promise<boolean>;
  } = {},
): Promise<void> {
  const db = getPrisma(),
    config = loadHostingConfig(request.action === 'purge' ? 'worker' : 'api');
  await db.$transaction(
    async (tx) => {
      if(options.authorize)await options.authorize(tx);
      await lockHostingAllocation(tx);
      await lockApplication(tx, id);
      if (options.job) {
        const lease = await tx.job.findFirst({
          where: {
            id: options.job.id,
            lockedBy: options.job.lockedBy,
            status: 'in_progress',
            leaseExpiresAt: { gt: new Date() },
          },
        });
        if (!lease)
          throw new HostingError(409, 'Job lease lost or job cancelled.');
      }
      const app = await tx.hostedApplication.findUnique({ where: { id } });
      if (!app) {
        if (
          request.action === 'purge' &&
          (await tx.hostedAudit.findFirst({
            where: { applicationId: id, action: 'ADMIN_PURGE' },
          }))
        )
          return;
        throw new HostingError(404, 'Application not found.');
      }
      if (
        request.expectedGenerations?.[id] != null &&
        app.generation !== request.expectedGenerations[id]
      )
        throw new HostingError(
          409,
          'Application changed after preview. Review it again.',
        );
      validateLifecycle(app, request.action);
      if (options.eligible && !(await options.eligible(app, tx)))
        throw new HostingError(
          409,
          'Application is no longer eligible for this maintenance policy.',
        );
      const data: Prisma.HostedApplicationUpdateInput = {
        generation: { increment: 1 },
        policyUpdatedAt: new Date(),
      };
      const terminal = [
        'suspend',
        'unpublish',
        'trash',
        'purge',
        'reassign',
      ].includes(request.action);
      switch (request.action) {
        case 'suspend':
          data.suspended = true;
          data.suspendedAt = app.suspendedAt ?? new Date();
          data.publishingPaused = true;
          break;
        case 'resume':
          data.suspended = false;
          data.suspendedAt = null;
          data.publishingPaused = true;
          break;
        case 'unpublish':
          data.publishedBuildId = null;
          data.publishingPaused = true;
          break;
        case 'trash':
          data.deletedAt = new Date();
          data.deleteAfter = new Date(Date.now() + 30 * 86400000);
          data.publishingPaused = true;
          break;
        case 'restore': {
          await assertOwnerQuota(tx, config, app.ownerUserId, 1);
          for (const buildId of new Set(
            [app.previewBuildId, app.publishedBuildId].filter(
              (v): v is string => !!v,
            ),
          )) {
            const build = await tx.hostedBuild.findFirst({
              where: {
                id: buildId,
                applicationId: id,
                status: 'READY',
                directory: { not: null },
              },
            });
            if (!build)
              throw new HostingError(
                409,
                'A retained build is unavailable. Repair storage before restoring.',
              );
            try {
              await access(
                path.join(
                  buildDirectory(config, id, build.contentBuildId || buildId),
                  build.launchPath,
                ),
              );
              await access(
                path.join(
                  buildDirectory(config, id, build.contentBuildId || buildId),
                  build.callbackPath,
                ),
              );
            } catch {
              throw new HostingError(
                409,
                'Retained launch/callback files are missing. Repair storage before restoring.',
              );
            }
          }
          // Storage is already charged to this owner, including while in trash.
          data.deletedAt = null;
          data.deleteAfter = null;
          data.publishingPaused = true;
          data.lastDeveloperActivityAt = new Date();
          break;
        }
        case 'protect':
          data.cleanupProtected = true;
          break;
        case 'unprotect':
          data.cleanupProtected = false;
          break;
        case 'reassign': {
          const ownerId = request.ownerUserId!;
          if (ownerId === app.ownerUserId)
            throw new HostingError(
              409,
              'Application already belongs to this owner.',
            );
          await assertDeploymentPermission(tx, ownerId);
          const size = await tx.hostedBuild.aggregate({
            where: { applicationId: id },
            _sum: { byteSize: true },
          });
          await assertOwnerQuota(
            tx,
            config,
            ownerId,
            1,
            size._sum.byteSize ?? 0n,
          );
          data.owner = { connect: { id: ownerId } };
          data.transferToUserId = null;
          data.publishingPaused = true;
          data.lastDeveloperActivityAt = new Date();
          await tx.hostedCollaborator.deleteMany({
            where: { applicationId: id, userId: ownerId },
          });
          break;
        }
        case 'purge': {
          // Caller holds the app lock; imports cannot activate and restore cannot race file deletion.
          await revokeHostedSessions(tx, id);
          const builds = await tx.hostedBuild.findMany({
            where: { applicationId: id },
          });
          for (const build of builds)
            await rm(buildDirectory(config, id, build.id), {
              recursive: true,
              force: true,
            });
          await rm(path.join(config.root, 'apps', id), {
            recursive: true,
            force: true,
          });
          await tx.hostedAudit.create({
            data: {
              applicationId: id,
              userId: actorId,
              action: 'ADMIN_PURGE',
              detail: {
                reason: request.reason,
                name: app.name,
                ownerUserId: app.ownerUserId,
                jobId: options.job?.id ?? null,
              },
            },
          });
          await tx.hostedApplication.delete({ where: { id } });
          return;
        }
      }
      if (terminal) {
        data.desiredBuildId = null;
        const pending = await tx.hostedBuild.findMany({
          where: {
            applicationId: id,
            status: { in: ['WAITING', 'BUILDING', 'IMPORTING'] },
          },
          select: { jobId: true },
        });
        const jobIds = pending.flatMap((b) => (b.jobId ? [b.jobId] : []));
        await tx.job.updateMany({
          where: {
            id: { in: jobIds },
            status: { in: ['queued', 'in_progress'] },
          },
          data: {
            status: 'cancelled',
            cancelledAt: new Date(),
            stage: 'Application administration cancelled this build',
          },
        });
        await tx.hostedBuild.updateMany({
          where: {
            applicationId: id,
            status: { in: ['WAITING', 'BUILDING', 'IMPORTING'] },
          },
          data: { status: 'CANCELLED' },
        });
        await revokeHostedSessions(tx, id, request.action === 'unpublish');
      }
      await tx.hostedApplication.update({ where: { id }, data });
      await tx.hostedAudit.create({
        data: {
          applicationId: id,
          userId: actorId,
          action: `ADMIN_${request.action.toUpperCase()}`,
          detail: {
            reason: request.reason,
            previousOwnerUserId: app.ownerUserId,
            ownerUserId: request.ownerUserId ?? app.ownerUserId,
            jobId: options.job?.id ?? null,
          },
        },
      });
    },
    { timeout: 30000 },
  );
}
