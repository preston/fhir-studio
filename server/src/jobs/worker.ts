// Author: Preston Lee

import type { PrismaClient, Job } from '@prisma/client';
import { getPrisma } from '../db/prisma.js';
import { HapiPartitionClient } from '../hapi/partition_client.js';
import type { JobHandler, JobExecutionContext } from './types.js';
import { testJobHandler } from './handlers/testJob.js';
import { sandboxPurgeHandler } from './handlers/sandboxPurge.js';
import { packageImportHandler } from './handlers/packageImport.js';
import { sandboxDataSeedHandler } from './handlers/sandboxDataSeed.js';

export class JobWorker {
  private static instance: JobWorker | null = null;
  private prisma: PrismaClient;
  private hapiClient: HapiPartitionClient;
  private handlers: Map<string, JobHandler> = new Map();
  private activeJobs: Map<string, AbortController> = new Map();
  private timer: NodeJS.Timeout | null = null;
  private isPolling = false;
  private concurrency: number;
  private pollIntervalMs: number;

  private constructor(concurrency = 3, pollIntervalMs = 2000) {
    this.prisma = getPrisma();
    this.hapiClient = new HapiPartitionClient();
    this.concurrency = concurrency;
    this.pollIntervalMs = pollIntervalMs;

    // Register default handlers
    this.registerHandler('TEST_JOB', testJobHandler);
    this.registerHandler('SANDBOX_PURGE', sandboxPurgeHandler);
    this.registerHandler('PACKAGE_IMPORT', packageImportHandler);
    this.registerHandler('SANDBOX_DATA_SEED', sandboxDataSeedHandler);
  }

  public static getInstance(): JobWorker {
    if (!JobWorker.instance) {
      JobWorker.instance = new JobWorker();
    }
    return JobWorker.instance;
  }

  public registerHandler(jobType: string, handler: JobHandler): void {
    this.handlers.set(jobType.toUpperCase(), handler);
  }

  public async start(): Promise<void> {
    if (this.timer) return;
    console.log(`[JobWorker] Starting generic background worker (concurrency: ${this.concurrency}, poll: ${this.pollIntervalMs}ms)`);
    await this.recoverStaleJobs();

    this.timer = setInterval(() => {
      this.pollAndProcess().catch((err) => {
        console.error('[JobWorker] Polling loop error:', err);
      });
    }, this.pollIntervalMs);
  }

  public stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    // Abort active jobs
    for (const [jobId, controller] of this.activeJobs.entries()) {
      controller.abort();
    }
    this.activeJobs.clear();
    console.log('[JobWorker] Generic background worker stopped.');
  }

  public async cancelJob(jobId: string): Promise<boolean> {
    const controller = this.activeJobs.get(jobId);
    if (controller) {
      controller.abort();
      this.activeJobs.delete(jobId);
    }

    const job = await this.prisma.job.findUnique({ where: { id: jobId } });
    if (!job) return false;

    if (job.status === 'queued' || job.status === 'in_progress') {
      await this.prisma.job.update({
        where: { id: jobId },
        data: {
          status: 'cancelled',
          cancelledAt: new Date(),
          stage: 'Cancelled by user/administrator',
        },
      });
      return true;
    }

    return false;
  }

  private async recoverStaleJobs(): Promise<void> {
    try {
      const staleCount = await this.prisma.job.updateMany({
        where: { status: 'in_progress' },
        data: {
          status: 'failed',
          error: 'Execution interrupted by server restart',
          completedAt: new Date(),
        },
      });
      if (staleCount.count > 0) {
        console.log(`[JobWorker] Recovered ${staleCount.count} interrupted in-progress jobs.`);
      }
    } catch (err) {
      console.error('[JobWorker] Failed to recover stale jobs:', err);
    }
  }

  private async pollAndProcess(): Promise<void> {
    if (this.isPolling) return;
    const availableSlots = this.concurrency - this.activeJobs.size;
    if (availableSlots <= 0) return;

    this.isPolling = true;

    try {
      const candidates = await this.prisma.job.findMany({
        where: { status: 'queued' },
        orderBy: { createdAt: 'asc' },
        take: availableSlots,
      });

      for (const candidate of candidates) {
        // Atomic claim: update status to in_progress only if still queued
        const claimed = await this.prisma.job.updateMany({
          where: { id: candidate.id, status: 'queued' },
          data: {
            status: 'in_progress',
            startedAt: new Date(),
            progress: 0,
            stage: 'Claimed by worker',
          },
        });

        if (claimed.count > 0) {
          const jobRecord = await this.prisma.job.findUnique({ where: { id: candidate.id } });
          if (jobRecord) {
            this.executeJob(jobRecord).catch((err) => {
              console.error(`[JobWorker] Error during execution of job ${candidate.id}:`, err);
            });
          }
        }
      }
    } finally {
      this.isPolling = false;
    }
  }

  private async executeJob(job: Job): Promise<void> {
    const handler = this.handlers.get(job.jobType.toUpperCase());
    const abortController = new AbortController();
    this.activeJobs.set(job.id, abortController);

    const updateProgress = async (progress: number, stage?: string): Promise<void> => {
      const clamped = Math.max(0, Math.min(100, Math.round(progress)));
      await this.prisma.job.update({
        where: { id: job.id },
        data: {
          progress: clamped,
          ...(stage !== undefined ? { stage } : {}),
        },
      });
    };

    const isCancelled = async (): Promise<boolean> => {
      if (abortController.signal.aborted) return true;
      const current = await this.prisma.job.findUnique({
        where: { id: job.id },
        select: { status: true },
      });
      return current?.status === 'cancelled';
    };

    const ctx: JobExecutionContext = {
      job,
      signal: abortController.signal,
      prisma: this.prisma,
      hapiClient: this.hapiClient,
      updateProgress,
      isCancelled,
    };

    try {
      if (!handler) {
        throw new Error(`No registered handler for job type '${job.jobType}'`);
      }

      const output = await handler(ctx);

      // Check if cancelled during execution
      if (await isCancelled()) {
        await this.prisma.job.update({
          where: { id: job.id },
          data: {
            status: 'cancelled',
            cancelledAt: new Date(),
            stage: 'Cancelled',
          },
        });
      } else {
        await this.prisma.job.update({
          where: { id: job.id },
          data: {
            status: 'completed',
            progress: 100,
            stage: 'Completed successfully',
            output: output ? JSON.parse(JSON.stringify(output)) : {},
            completedAt: new Date(),
          },
        });
      }
    } catch (err: any) {
      const cancelled = abortController.signal.aborted || (await isCancelled()) || err?.message?.toLowerCase().includes('cancelled');
      if (cancelled) {
        await this.prisma.job.update({
          where: { id: job.id },
          data: {
            status: 'cancelled',
            cancelledAt: new Date(),
            stage: 'Cancelled',
          },
        });
      } else {
        await this.prisma.job.update({
          where: { id: job.id },
          data: {
            status: 'failed',
            error: err?.message || 'Job execution failed with unknown error.',
            completedAt: new Date(),
            stage: 'Failed',
          },
        });
      }
    } finally {
      this.activeJobs.delete(job.id);
    }
  }
}
