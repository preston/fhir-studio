import express from 'express';
import type { Prisma } from '@prisma/client';
import { getPrisma } from '../db/prisma.js';
import { requirePermission } from '../authorization/requirePermission.js';
import { HostingError } from '../hosted/access.js';
import {
  jobDefinitions,
  nextRunAt,
  objectInput,
  parseTiming,
  validateJobInput,
} from './definitions.js';
import { enqueueSchedule } from './scheduler.js';
import { routeParam } from '../http/routeParam.js';

export function createJobSchedulesRouter(): express.Router {
  const router = express.Router();
  router.use(
    '/api/administration/job-schedules',
    requirePermission('global_manage'),
  );
  router.get(
    '/api/administration/job-types',
    requirePermission('global_manage'),
    (_req, res) => {
      res.json({ types: jobDefinitions });
    },
  );
  router.get('/api/administration/job-schedules', async (_req, res) => {
    res.json({
      schedules: await getPrisma().jobSchedule.findMany({
        orderBy: { name: 'asc' },
      }),
    });
  });
  router.post('/api/administration/job-schedules', async (req, res) => {
    const body = objectInput(req.body),
      timing = parseTiming(body),
      jobType = String(body.jobType);
    const name = String(body.name ?? '').trim();
    if (!name || name.length > 200)
      throw new HostingError(
        400,
        'Provide a schedule name (1–200 characters).',
      );
    const input = validateJobInput(jobType, body.input);
    const schedule = await getPrisma().jobSchedule.create({
      data: {
        name,
        description: String(body.description ?? '').slice(0, 2000),
        jobType,
        input: input as Prisma.InputJsonObject,
        ...timing,
        enabled: body.enabled !== false,
        nextRunAt: nextRunAt(timing),
        createdByUserId: req.sessionAuth!.userId,
      },
    });
    res.status(201).json({ schedule });
  });
  router.patch('/api/administration/job-schedules/:id', async (req, res) => {
    const id = routeParam(req.params.id),
      body = objectInput(req.body);
    const schedule = await getPrisma().$transaction(async (tx) => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`schedule:${id}`}, 0))`;
      const old = await tx.jobSchedule.findUnique({ where: { id } });
      if (!old) throw new HostingError(404, 'Schedule not found.');
      const timing = parseTiming({ ...old, ...body });
      const name = String(body.name ?? old.name).trim();
      if (
        !name ||
        name.length > 200 ||
        ('enabled' in body && typeof body.enabled !== 'boolean')
      )
        throw new HostingError(400, 'Invalid schedule name or enabled flag.');
      const jobType = String(body.jobType ?? old.jobType);
      const input = validateJobInput(jobType, body.input ?? old.input);
      const changed =
        timing.frequency !== old.frequency ||
        timing.minuteOfHour !== old.minuteOfHour ||
        timing.hourOfDay !== old.hourOfDay ||
        (body.enabled === true && !old.enabled);
      return tx.jobSchedule.update({
        where: { id },
        data: {
          name,
          description: String(body.description ?? old.description).slice(
            0,
            2000,
          ),
          jobType,
          input: input as Prisma.InputJsonObject,
          ...timing,
          enabled:
            typeof body.enabled === 'boolean' ? body.enabled : old.enabled,
          ...(changed ? { nextRunAt: nextRunAt(timing) } : {}),
        },
      });
    });
    res.json({ schedule });
  });
  router.delete('/api/administration/job-schedules/:id', async (req, res) => {
    const id = routeParam(req.params.id);
    await getPrisma().$transaction(async (tx) => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`schedule:${id}`}, 0))`;
      await tx.jobSchedule.delete({ where: { id } });
    });
    res.json({ deleted: true });
  });
  router.post(
    '/api/administration/job-schedules/:id/run-now',
    async (req, res) => {
      const jobId = await getPrisma().$transaction((tx) =>
        enqueueSchedule(tx, routeParam(req.params.id), true),
      );
      res.status(202).json({ jobId });
    },
  );
  return router;
}
