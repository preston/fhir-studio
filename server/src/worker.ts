// Author: Preston Lee

import 'dotenv/config';
import { hostname } from 'node:os';
import { loadWorkerConfig } from './env.js';
import { loadHapiConfig } from './hapi/partition_client.js';
import { disconnectPrisma, getPrisma } from './db/prisma.js';
import { claimNextJob, failJob, releaseRunningJob, requeueStaleJobs } from './jobs/queue.js';
import { executeClaimedJob } from './jobs/executor.js';
import { initializeJobs } from './jobs/registry.js';
import { isWorkerShuttingDown, markWorkerShuttingDown } from './jobs/workerLifecycle.js';

const POLL_EMPTY_MS = 2_000;
const REAPER_INTERVAL_MS = 60_000;
/** Keep below Docker Compose `stop_grace_period` (30s) so SIGKILL is not the first recovery path. */
const SHUTDOWN_GRACE_MS = 20_000;

function workerId(): string {
  return `${hostname()}:${process.pid}`;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

let activeJob: { id: string; workerId: string } | null = null;
let reaperTimer: ReturnType<typeof setInterval> | null = null;

async function consumerLoop(workerInstanceId: string): Promise<void> {
  console.log(`[JobWorker] started (id=${workerInstanceId})`);

  while (!isWorkerShuttingDown()) {
    const job = await claimNextJob(workerInstanceId);
    if (!job) {
      if (isWorkerShuttingDown()) {
        break;
      }
      await sleep(POLL_EMPTY_MS);
      continue;
    }

    if (isWorkerShuttingDown()) {
      // Claimed after shutdown began — return to queue immediately so another worker can take it.
      await releaseRunningJob(job.id, workerInstanceId);
      break;
    }

    console.log(`[JobWorker] Executing job ${job.id} (${job.jobType})`);
    activeJob = { id: job.id, workerId: workerInstanceId };
    try {
      await executeClaimedJob(job.id, workerInstanceId);
    } catch (err) {
      console.error(`[JobWorker] Unhandled error executing job ${job.id}:`, err);
      const message = err instanceof Error ? err.message : String(err);
      await failJob(job.id, workerInstanceId, message || 'Unhandled worker error');
    } finally {
      activeJob = null;
    }
  }
}

function startReaperLoop(): ReturnType<typeof setInterval> {
  return setInterval(() => {
    void requeueStaleJobs()
      .then((count) => {
        if (count > 0) {
          console.log(`[JobWorker] Reaped ${count} stale job lease(s)`);
        }
      })
      .catch((err) => {
        console.error('[JobWorker] Reaper failed:', err);
      });
  }, REAPER_INTERVAL_MS);
}

async function shutdown(signal: string): Promise<void> {
  if (isWorkerShuttingDown()) {
    return;
  }
  markWorkerShuttingDown();
  console.log(`[JobWorker] shutting down (${signal})...`);

  if (reaperTimer) {
    clearInterval(reaperTimer);
    reaperTimer = null;
  }

  const deadline = Date.now() + SHUTDOWN_GRACE_MS;
  while (activeJob && Date.now() < deadline) {
    await sleep(250);
  }

  if (activeJob) {
    // Do not force-release here: the handler may still be writing. Leave the lease so the
    // reaper (or another worker after lease expiry) recovers without duplicate execution.
    console.warn(
      `[JobWorker] In-flight job ${activeJob.id} did not stop within ${SHUTDOWN_GRACE_MS}ms; ` +
        'leaving lease in place for reaper recovery (no duplicate requeue)',
    );
  }

  try {
    await disconnectPrisma();
  } catch (err) {
    console.warn('[JobWorker] Failed to disconnect Prisma during shutdown:', err);
  }

  process.exit(0);
}

function registerShutdownHandlers(): void {
  for (const signal of ['SIGTERM', 'SIGINT'] as const) {
    process.on(signal, () => {
      void shutdown(signal);
    });
  }
}

async function main(): Promise<void> {
  // Same fail-fast env validation path as the API server (`requireEnvAll`).
  const config = loadWorkerConfig();
  loadHapiConfig();
  getPrisma(config.databaseUrl);

  const id = workerId();
  initializeJobs();
  registerShutdownHandlers();

  try {
    const recovered = await requeueStaleJobs();
    if (recovered > 0) {
      console.log(`[JobWorker] Startup reaper recovered ${recovered} stale job(s)`);
    }
  } catch (err) {
    console.error('[JobWorker] Startup reaper failed:', err);
  }

  reaperTimer = startReaperLoop();
  try {
    await consumerLoop(id);
  } catch (err) {
    console.error('[JobWorker] Consumer loop crashed:', err);
    markWorkerShuttingDown();
    await disconnectPrisma().catch(() => undefined);
    process.exit(1);
  }

  if (!isWorkerShuttingDown()) {
    console.error('[JobWorker] Consumer loop exited unexpectedly');
    process.exit(1);
  }
}

void main();
