// Author: Preston Lee

import type { JobHandler } from '../types.js';
import { destroyHapiTenant } from '../../hapi/tenant_purge.js';

export const sandboxPurgeHandler: JobHandler = async (ctx) => {
  const input = (ctx.job.input as Record<string, any>) || {};
  const sandboxId = input.sandboxId || ctx.job.sandboxId;

  if (!sandboxId) {
    throw new Error('Sandbox ID is required for purge job.');
  }

  await ctx.updateProgress(5, `Locating sandbox tenant '${sandboxId}'`);

  const isUuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(sandboxId);
  const sandbox = await ctx.prisma.sandbox.findFirst({
    where: isUuid ? { OR: [{ id: sandboxId }, { sandboxId }] } : { sandboxId },
  });

  if (!sandbox) {
    throw new Error(`Sandbox '${sandboxId}' not found in database.`);
  }

  if (ctx.signal.aborted || (await ctx.isCancelled())) {
    throw new Error('Job was cancelled.');
  }

  await ctx.updateProgress(
    15,
    `Purging HAPI tenant '${sandbox.sandboxId}' (partition #${sandbox.partitionId}, ${sandbox.fhirVersion})`,
  );

  const purgeResult = await destroyHapiTenant(
    ctx.hapiClient,
    sandbox.fhirVersion,
    sandbox.partitionId,
    sandbox.sandboxId,
    {
      signal: ctx.signal,
      isCancelled: ctx.isCancelled,
      onProgress: async (message) => {
        await ctx.updateProgress(40, message);
      },
    },
  );

  if (ctx.signal.aborted || (await ctx.isCancelled())) {
    throw new Error('Job was cancelled.');
  }

  await ctx.updateProgress(85, `Detaching background jobs from sandbox '${sandbox.sandboxId}'`);

  // Job.sandboxId cascades on sandbox delete — clear FKs so this purge job (and history) survive.
  await ctx.prisma.job.updateMany({
    where: { sandboxId: sandbox.id },
    data: { sandboxId: null },
  });

  await ctx.updateProgress(90, `Deleting PostgreSQL records for sandbox '${sandbox.sandboxId}'`);

  await ctx.prisma.sandbox.delete({
    where: { id: sandbox.id },
  });

  await ctx.updateProgress(100, `Purge completed for sandbox '${sandbox.sandboxId}'`);

  return {
    purgedSandboxId: sandbox.sandboxId,
    partitionId: sandbox.partitionId,
    fhirVersion: sandbox.fhirVersion,
    name: sandbox.name,
    patientsDeleted: purgeResult.patientsDeleted,
    relatedDeleted: purgeResult.relatedDeleted,
    expungedCount: purgeResult.expungedCount,
    purgedAt: new Date().toISOString(),
  };
};
