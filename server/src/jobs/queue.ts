// Author: Preston Lee

import type { Job } from '@prisma/client';
import { getPrisma } from '../db/prisma.js';

export const DEFAULT_LEASE_MS = 5 * 60 * 1000;

type ClaimedJobId = { id: string };

export async function claimNextJob(workerId: string, leaseMs = DEFAULT_LEASE_MS): Promise<Job | null> {
  const prisma = getPrisma();
  const leaseSecs = leaseMs / 1000;

  const rows = await prisma.$queryRaw<ClaimedJobId[]>`
    UPDATE jobs
    SET
      status = 'in_progress',
      locked_by = ${workerId},
      lease_expires_at = NOW() + make_interval(secs => ${leaseSecs}),
      started_at = COALESCE(started_at, NOW()),
      progress = 0,
      stage = 'Claimed by worker',
      updated_at = NOW()
    WHERE id = (
      SELECT id FROM jobs
      WHERE status = 'queued'
      ORDER BY created_at ASC
      FOR UPDATE SKIP LOCKED
      LIMIT 1
    )
    RETURNING id
  `;

  const claimedId = rows[0]?.id;
  if (!claimedId) return null;

  return prisma.job.findUnique({ where: { id: claimedId } });
}

export async function heartbeatJob(jobId: string, workerId: string, leaseMs = DEFAULT_LEASE_MS): Promise<boolean> {
  const prisma = getPrisma();
  const result = await prisma.job.updateMany({
    where: {
      id: jobId,
      status: 'in_progress',
      lockedBy: workerId,
    },
    data: {
      leaseExpiresAt: new Date(Date.now() + leaseMs),
    },
  });
  return result.count > 0;
}

export async function isJobCancelled(jobId: string): Promise<boolean> {
  const prisma = getPrisma();
  const job = await prisma.job.findUnique({
    where: { id: jobId },
    select: { status: true },
  });
  return job?.status === 'cancelled';
}

export async function completeJob(
  jobId: string,
  workerId: string,
  output?: Record<string, unknown> | void,
): Promise<boolean> {
  const prisma = getPrisma();
  const updated = await prisma.job.updateMany({
    where: { id: jobId, status: 'in_progress', lockedBy: workerId },
    data: {
      status: 'completed',
      progress: 100,
      stage: 'Completed successfully',
      output: output ? JSON.parse(JSON.stringify(output)) : {},
      completedAt: new Date(),
      lockedBy: null,
      leaseExpiresAt: null,
    },
  });
  if (updated.count === 0) {
    console.warn(`completeJob: no in_progress lease matched for job ${jobId} (worker ${workerId})`);
    return false;
  }
  return true;
}

export async function failJob(jobId: string, workerId: string, errorMessage: string): Promise<boolean> {
  const prisma = getPrisma();
  const updated = await prisma.job.updateMany({
    where: { id: jobId, status: 'in_progress', lockedBy: workerId },
    data: {
      status: 'failed',
      error: errorMessage,
      stage: 'Failed',
      completedAt: new Date(),
      lockedBy: null,
      leaseExpiresAt: null,
    },
  });
  if (updated.count === 0) {
    console.warn(`failJob: no in_progress lease matched for job ${jobId} (worker ${workerId})`);
    return false;
  }
  return true;
}

export async function markJobCancelled(jobId: string, workerId: string): Promise<boolean> {
  const prisma = getPrisma();
  const updated = await prisma.job.updateMany({
    where: { id: jobId, status: 'in_progress', lockedBy: workerId },
    data: {
      status: 'cancelled',
      cancelledAt: new Date(),
      stage: 'Cancelled',
      lockedBy: null,
      leaseExpiresAt: null,
    },
  });
  return updated.count > 0;
}

/** Return a running job to the queue without failing it (e.g. worker shutdown). */
export async function releaseRunningJob(jobId: string, workerId: string): Promise<boolean> {
  const prisma = getPrisma();
  const updated = await prisma.job.updateMany({
    where: { id: jobId, status: 'in_progress', lockedBy: workerId },
    data: {
      status: 'queued',
      stage: 'Re-queued after worker shutdown',
      progress: 0,
      startedAt: null,
      lockedBy: null,
      leaseExpiresAt: null,
    },
  });
  if (updated.count === 0) {
    console.warn(`releaseRunningJob: no in_progress lease matched for job ${jobId} (worker ${workerId})`);
    return false;
  }
  return true;
}

/** Cancel a queued or in-progress job via DB only (works across worker processes). */
export async function cancelJob(jobId: string): Promise<boolean> {
  const prisma = getPrisma();
  const job = await prisma.job.findUnique({ where: { id: jobId } });
  if (!job) return false;

  if (job.status !== 'queued' && job.status !== 'in_progress') {
    return false;
  }

  const updated = await prisma.job.updateMany({
    where: {
      id: jobId,
      status: { in: ['queued', 'in_progress'] },
    },
    data: {
      status: 'cancelled',
      cancelledAt: new Date(),
      stage: 'Cancelled by user/administrator',
      lockedBy: null,
      leaseExpiresAt: null,
    },
  });
  return updated.count > 0;
}

/** Re-queue jobs whose worker lease has expired (or legacy rows missing a lease). */
export async function requeueStaleJobs(): Promise<number> {
  const prisma = getPrisma();
  const rows = await prisma.$queryRaw<Array<{ id: string }>>`
    WITH stale AS (
      SELECT id
      FROM jobs
      WHERE status = 'in_progress'
        AND (
          lease_expires_at IS NULL
          OR lease_expires_at < NOW()
        )
      FOR UPDATE SKIP LOCKED
    )
    UPDATE jobs AS j
    SET
      status = 'queued',
      stage = 'Re-queued after stale lease',
      progress = 0,
      started_at = NULL,
      locked_by = NULL,
      lease_expires_at = NULL,
      updated_at = NOW()
    FROM stale s
    WHERE j.id = s.id
    RETURNING j.id
  `;

  return rows.length;
}
