// Author: Preston Lee

import type { JobHandler } from '../types.js';

export const sandboxPurgeHandler: JobHandler = async (ctx) => {
  const input = (ctx.job.input as Record<string, any>) || {};
  const sandboxId = input.sandboxId || ctx.job.sandboxId;

  if (!sandboxId) {
    throw new Error('Sandbox ID is required for purge job.');
  }

  await ctx.updateProgress(10, `Locating sandbox tenant '${sandboxId}'`);

  const sandbox = await ctx.prisma.sandbox.findFirst({
    where: {
      OR: [{ id: sandboxId }, { sandboxId }],
    },
  });

  if (!sandbox) {
    throw new Error(`Sandbox '${sandboxId}' not found in database.`);
  }

  if (ctx.signal.aborted || (await ctx.isCancelled())) {
    throw new Error('Job was cancelled.');
  }

  await ctx.updateProgress(30, `Purging HAPI FHIR partition #${sandbox.partitionId} (${sandbox.fhirVersion})`);

  try {
    await ctx.hapiClient.deletePartition(sandbox.fhirVersion, sandbox.partitionId, sandbox.sandboxId);
  } catch (err: any) {
    console.warn(`HAPI partition deletion encountered a warning for sandbox ${sandbox.sandboxId}:`, err?.message);
  }

  if (ctx.signal.aborted || (await ctx.isCancelled())) {
    throw new Error('Job was cancelled.');
  }

  await ctx.updateProgress(70, `Deleting PostgreSQL records for sandbox '${sandbox.sandboxId}'`);

  await ctx.prisma.sandbox.delete({
    where: { id: sandbox.id },
  });

  await ctx.updateProgress(100, `Purge completed for sandbox '${sandbox.sandboxId}'`);

  return {
    purgedSandboxId: sandbox.sandboxId,
    partitionId: sandbox.partitionId,
    fhirVersion: sandbox.fhirVersion,
    name: sandbox.name,
    purgedAt: new Date().toISOString(),
  };
};
