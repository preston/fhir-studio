// Author: Preston Lee

import express, { type Request, type Response, type Router } from 'express';
import { requirePermission } from '../authorization/requirePermission.js';
import { JobService } from './service.js';
import type { JobFilter, JobStatus } from '@fhir-studio/core';

const VALID_JOB_STATUSES = new Set<JobStatus>(['queued', 'in_progress', 'completed', 'failed', 'cancelled']);

function parseStatusQuery(status: unknown): JobStatus[] {
  if (status == null || status === '') return [];
  const rawValues = Array.isArray(status) ? status : [status];
  const parsed: JobStatus[] = [];
  for (const value of rawValues) {
    for (const part of String(value).split(',')) {
      const normalized = part.trim() as JobStatus;
      if (VALID_JOB_STATUSES.has(normalized) && !parsed.includes(normalized)) {
        parsed.push(normalized);
      }
    }
  }
  return parsed;
}

export function createJobsRouter(): Router {
  const router = express.Router();
  const jobService = new JobService();

  // ==========================================
  // 1. ADMINISTRATION JOB MANAGEMENT ENDPOINTS
  // ==========================================

  // List background jobs with filters & pagination
  router.get('/api/administration/jobs', requirePermission('global_manage'), async (req: Request, res: Response): Promise<void> => {
    const { status, jobType, sandboxId, createdByUserId, search, sortBy, sortOrder, page, limit } = req.query;

    const statusValues = parseStatusQuery(status);
    const allowedSortBy = new Set(['name', 'jobType', 'status', 'progress', 'createdAt', 'startedAt', 'completedAt']);
    const parsedSortBy = typeof sortBy === 'string' && allowedSortBy.has(sortBy)
      ? (sortBy as NonNullable<JobFilter['sortBy']>)
      : undefined;
    const parsedSortOrder = sortOrder === 'asc' || sortOrder === 'desc' ? sortOrder : undefined;

    const filters: JobFilter = {
      ...(statusValues.length === 1 ? { status: statusValues[0] } : {}),
      ...(statusValues.length > 1 ? { statuses: statusValues } : {}),
      ...(jobType ? { jobType: String(jobType) } : {}),
      ...(sandboxId ? { sandboxId: String(sandboxId) } : {}),
      ...(createdByUserId ? { createdByUserId: String(createdByUserId) } : {}),
      ...(search ? { search: String(search) } : {}),
      ...(parsedSortBy ? { sortBy: parsedSortBy } : {}),
      ...(parsedSortOrder ? { sortOrder: parsedSortOrder } : {}),
      page: page ? parseInt(String(page), 10) : 1,
      limit: limit ? parseInt(String(limit), 10) : 50,
    };

    const result = await jobService.getJobs(filters);
    res.json(result);
  });

  // Get job metrics summary
  router.get('/api/administration/jobs/metrics', requirePermission('global_manage'), async (req: Request, res: Response): Promise<void> => {
    const summary = await jobService.getJobMetrics();
    res.json({ summary });
  });

  // Purge finished/cancelled/failed jobs
  router.delete('/api/administration/jobs/purge-completed', requirePermission('global_manage'), async (req: Request, res: Response): Promise<void> => {
    const purgedCount = await jobService.purgeCompletedJobs();
    res.json({ message: `Purged ${purgedCount} completed/failed/cancelled jobs.`, count: purgedCount });
  });

  // Enqueue a new background job
  router.post('/api/administration/jobs', requirePermission('global_manage'), async (req: Request, res: Response): Promise<void> => {
    const { name, jobType, input, sandboxId } = req.body;
    if (!name || !jobType) {
      res.status(400).json({ error: 'name and jobType are required.' });
      return;
    }

    const userId = (req as any).user?.id;
    const job = await jobService.enqueueJob({ name, jobType, input, sandboxId }, userId);
    res.status(201).json({ job });
  });

  // Get single job detail
  router.get('/api/administration/jobs/:id', requirePermission('global_manage'), async (req: Request, res: Response): Promise<void> => {
    const { id } = req.params;
    const job = await jobService.getJobById(id);
    if (!job) {
      res.status(404).json({ error: 'Job not found.' });
      return;
    }
    res.json({ job });
  });

  // Cancel an active or queued job
  router.post('/api/administration/jobs/:id/cancel', requirePermission('global_manage'), async (req: Request, res: Response): Promise<void> => {
    const { id } = req.params;
    const cancelled = await jobService.cancelJob(id);
    if (!cancelled) {
      res.status(400).json({ error: 'Job could not be cancelled or was not found.' });
      return;
    }
    const updated = await jobService.getJobById(id);
    res.json({ message: 'Job cancelled successfully.', job: updated });
  });

  // Retry a failed or cancelled job
  router.post('/api/administration/jobs/:id/retry', requirePermission('global_manage'), async (req: Request, res: Response): Promise<void> => {
    const { id } = req.params;
    try {
      const userId = (req as any).user?.id;
      const job = await jobService.retryJob(id, userId);
      res.status(201).json({ message: 'Job re-enqueued successfully.', job });
    } catch (err: any) {
      res.status(400).json({ error: err?.message || 'Failed to retry job.' });
    }
  });

  // Delete a specific job record
  router.delete('/api/administration/jobs/:id', requirePermission('global_manage'), async (req: Request, res: Response): Promise<void> => {
    const { id } = req.params;
    const deleted = await jobService.deleteJob(id);
    if (!deleted) {
      res.status(404).json({ error: 'Job not found.' });
      return;
    }
    res.json({ message: 'Job deleted successfully.' });
  });

  // ==========================================
  // 2. USER & CLIENT JOB POLLING ENDPOINT
  // ==========================================
  router.get('/api/jobs/:id', async (req: Request, res: Response): Promise<void> => {
    const { id } = req.params;
    const job = await jobService.getJobById(id);
    if (!job) {
      res.status(404).json({ error: 'Job not found.' });
      return;
    }
    res.json({ job });
  });

  return router;
}
