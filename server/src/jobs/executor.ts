// Author: Preston Lee

import { getPrisma } from '../db/prisma.js';
import { HapiPartitionClient } from '../hapi/partition_client.js';
import {
  completeJob,
  DEFAULT_LEASE_MS,
  failJob,
  heartbeatJob,
  isJobCancelled,
  markJobCancelled,
  releaseRunningJob,
} from './queue.js';
import { getHandler } from './registry.js';
import type { JobExecutionContext } from './types.js';
import { isWorkerShuttingDown } from './workerLifecycle.js';

const HEARTBEAT_INTERVAL_MS = 30_000;

async function shouldStopJob(jobId: string): Promise<boolean> {
  return (await isJobCancelled(jobId)) || isWorkerShuttingDown();
}

async function handleInterruptedJob(jobId: string, workerId: string): Promise<void> {
  if (await isJobCancelled(jobId)) {
    await markJobCancelled(jobId, workerId);
    return;
  }
  if (isWorkerShuttingDown()) {
    await releaseRunningJob(jobId, workerId);
  }
}

export async function executeClaimedJob(jobId: string, workerId: string): Promise<void> {
  const prisma = getPrisma();
  const job = await prisma.job.findUnique({ where: { id: jobId } });
  if (!job || job.status !== 'in_progress' || job.lockedBy !== workerId) {
    return;
  }

  const handler = getHandler(job.jobType);
  if (!handler) {
    await failJob(jobId, workerId, `No registered handler for job type '${job.jobType}'`);
    return;
  }

  const abortController = new AbortController();
  let heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  const hapiClient = new HapiPartitionClient();

  const updateProgress = async (progress: number, stage?: string): Promise<void> => {
    try {
      if (await shouldStopJob(jobId)) {
        return;
      }
      const clamped = Math.max(0, Math.min(100, Math.round(progress)));
      await prisma.job.update({
        where: { id: jobId },
        data: {
          progress: clamped,
          ...(stage !== undefined ? { stage } : {}),
        },
      });
    } catch (err) {
      console.warn(`Non-critical: failed to update job ${jobId} progress:`, err);
    }
  };

  const isCancelled = async (): Promise<boolean> => {
    if (abortController.signal.aborted) return true;
    return shouldStopJob(jobId);
  };

  const ctx: JobExecutionContext = {
    job,
    signal: abortController.signal,
    prisma,
    hapiClient,
    updateProgress,
    isCancelled,
  };

  heartbeatTimer = setInterval(() => {
    void heartbeatJob(jobId, workerId, DEFAULT_LEASE_MS).then((ok) => {
      if (!ok) {
        abortController.abort();
      }
    });
  }, HEARTBEAT_INTERVAL_MS);

  const cancelPollTimer = setInterval(() => {
    void shouldStopJob(jobId).then((stop) => {
      if (stop && !abortController.signal.aborted) {
        abortController.abort();
      }
    });
  }, 1_000);

  try {
    const output = await handler(ctx);

    if (await shouldStopJob(jobId)) {
      await handleInterruptedJob(jobId, workerId);
      return;
    }

    await completeJob(jobId, workerId, output ?? undefined);
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    const cancelled =
      abortController.signal.aborted ||
      (await shouldStopJob(jobId)) ||
      message.toLowerCase().includes('cancelled');

    if (cancelled) {
      await handleInterruptedJob(jobId, workerId);
      return;
    }

    await failJob(jobId, workerId, message || 'Job execution failed with unknown error.');
  } finally {
    if (heartbeatTimer) {
      clearInterval(heartbeatTimer);
    }
    clearInterval(cancelPollTimer);
  }
}
