// Author: Preston Lee

import type { PrismaClient, Job } from '@prisma/client';
import type { CreateJobPayload, JobFilter, JobSummary } from '@fhir-studio/core';
import { getPrisma } from '../db/prisma.js';
import { cancelJob as cancelQueuedJob } from './queue.js';

export class JobService {
  private prisma: PrismaClient;

  constructor(prisma?: PrismaClient) {
    this.prisma = prisma || getPrisma();
  }

  public async enqueueJob(payload: CreateJobPayload, createdByUserId?: string): Promise<Job> {
    const { name, jobType, input = {}, sandboxId } = payload;

    if (!name || !jobType) {
      throw new Error('Job name and jobType are required.');
    }

    let resolvedSandboxId: string | null = null;
    if (sandboxId) {
      const isUuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(sandboxId);
      const sandbox = await this.prisma.sandbox.findFirst({
        where: isUuid ? { OR: [{ id: sandboxId }, { sandboxId }] } : { sandboxId },
      });
      if (sandbox) {
        resolvedSandboxId = sandbox.id;
      }
    }

    return this.prisma.job.create({
      data: {
        name,
        jobType: jobType.toUpperCase(),
        status: 'queued',
        progress: 0,
        stage: 'Queued for processing',
        input: input ? JSON.parse(JSON.stringify(input)) : {},
        sandboxId: resolvedSandboxId,
        createdByUserId: createdByUserId || null,
      },
      include: {
        sandbox: { select: { id: true, sandboxId: true, name: true, fhirVersion: true } },
        createdByUser: { select: { id: true, email: true, displayName: true } },
      },
    });
  }

  public async getJobs(filters: JobFilter = {}): Promise<{
    jobs: any[];
    total: number;
    page: number;
    limit: number;
    summary: JobSummary;
  }> {
    const {
      status,
      statuses,
      jobType,
      sandboxId,
      createdByUserId,
      search,
      sortBy = 'createdAt',
      sortOrder = 'desc',
      page = 1,
      limit = 50,
    } = filters;
    const skip = Math.max(0, (page - 1) * limit);

    const where: Record<string, unknown> = {};

    const statusList = [
      ...(statuses ?? []),
      ...(status ? [status] : []),
    ].filter((value, index, all) => all.indexOf(value) === index);

    if (statusList.length === 1) {
      where['status'] = statusList[0];
    } else if (statusList.length > 1) {
      where['status'] = { in: statusList };
    }

    if (jobType) {
      where['jobType'] = jobType.toUpperCase();
    }

    if (sandboxId) {
      where['OR'] = [
        { sandboxId },
        { sandbox: { sandboxId } },
      ];
    }

    if (createdByUserId) {
      where['createdByUserId'] = createdByUserId;
    }

    if (search) {
      where['OR'] = [
        { name: { contains: search, mode: 'insensitive' } },
        { jobType: { contains: search, mode: 'insensitive' } },
        { stage: { contains: search, mode: 'insensitive' } },
        { error: { contains: search, mode: 'insensitive' } },
      ];
    }

    const allowedSortFields = new Set([
      'name',
      'jobType',
      'status',
      'progress',
      'createdAt',
      'startedAt',
      'completedAt',
    ]);
    const orderField = allowedSortFields.has(sortBy) ? sortBy : 'createdAt';
    const orderDirection = sortOrder === 'asc' ? 'asc' : 'desc';

    const [jobs, total, summary] = await Promise.all([
      this.prisma.job.findMany({
        where,
        include: {
          sandbox: { select: { id: true, sandboxId: true, name: true, fhirVersion: true } },
          createdByUser: { select: { id: true, email: true, displayName: true } },
        },
        orderBy: { [orderField]: orderDirection },
        skip,
        take: limit,
      }),
      this.prisma.job.count({ where }),
      this.getJobMetrics(),
    ]);

    return {
      jobs,
      total,
      page,
      limit,
      summary,
    };
  }

  public async getJobById(id: string): Promise<any | null> {
    return this.prisma.job.findUnique({
      where: { id },
      include: {
        sandbox: { select: { id: true, sandboxId: true, name: true, fhirVersion: true } },
        createdByUser: { select: { id: true, email: true, displayName: true } },
      },
    });
  }

  public async cancelJob(id: string): Promise<boolean> {
    return cancelQueuedJob(id);
  }

  public async retryJob(id: string, requestedByUserId?: string): Promise<Job> {
    const original = await this.prisma.job.findUnique({ where: { id } });
    if (!original) {
      throw new Error(`Job '${id}' not found.`);
    }

    return this.enqueueJob(
      {
        name: original.name,
        jobType: original.jobType,
        input: (original.input as Record<string, any>) || {},
        sandboxId: original.sandboxId || undefined,
      },
      requestedByUserId || original.createdByUserId || undefined,
    );
  }

  public async deleteJob(id: string): Promise<boolean> {
    const existing = await this.prisma.job.findUnique({ where: { id } });
    if (!existing) return false;

    // If active, cancel first
    if (existing.status === 'queued' || existing.status === 'in_progress') {
      await this.cancelJob(id);
    }

    await this.prisma.job.delete({ where: { id } });
    return true;
  }

  public async purgeCompletedJobs(): Promise<number> {
    const res = await this.prisma.job.deleteMany({
      where: {
        status: { in: ['completed', 'failed', 'cancelled'] },
      },
    });
    return res.count;
  }

  public async getJobMetrics(): Promise<JobSummary> {
    const [total, queued, inProgress, completed, failed, cancelled] = await Promise.all([
      this.prisma.job.count(),
      this.prisma.job.count({ where: { status: 'queued' } }),
      this.prisma.job.count({ where: { status: 'in_progress' } }),
      this.prisma.job.count({ where: { status: 'completed' } }),
      this.prisma.job.count({ where: { status: 'failed' } }),
      this.prisma.job.count({ where: { status: 'cancelled' } }),
    ]);

    return {
      total,
      queued,
      inProgress,
      completed,
      failed,
      cancelled,
    };
  }
}
