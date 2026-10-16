import type { Prisma, PrismaClient } from '@prisma/client';
import { getPrisma } from '../db/prisma.js';
import { HostingError } from '../hosted/access.js';
import { nextRunAt, validateJobInput } from './definitions.js';
import { isHostingEnabled } from '../env.js';

export async function enqueueSchedule(
  tx: Prisma.TransactionClient,
  id: string,
  manual = false,
): Promise<string | null> {
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`schedule:${id}`}, 0))`;
  const schedule = await tx.jobSchedule.findUnique({ where: { id } });
  if (!schedule) throw new HostingError(404, 'Schedule not found.');
  if (schedule.jobType.startsWith('HOSTED_') && !isHostingEnabled()) {
    if (manual) throw new HostingError(503, 'Application hosting is not enabled on this instance.');
    return null;
  }
  const now = new Date();
  if (!manual && (!schedule.enabled || schedule.nextRunAt > now)) return null;
  const active = await tx.job.findFirst({
    where: { scheduleId: id, status: { in: ['queued', 'in_progress'] } },
  });
  if (active) {
    if (manual)
      throw new HostingError(409, 'This schedule already has an active job.');
    await tx.jobSchedule.update({
      where: { id },
      data: { nextRunAt: nextRunAt(schedule, now) },
    });
    return null;
  }
  const input = validateJobInput(schedule.jobType, schedule.input);
  const occurrence = manual
    ? undefined
    : `${id}:${schedule.nextRunAt.toISOString()}`;
  const job = await tx.job.create({
    data: {
      name: schedule.name,
      jobType: schedule.jobType,
      input: input as Prisma.InputJsonObject,
      scheduleId: id,
      scheduledOccurrence: occurrence,
      createdByUserId: schedule.createdByUserId,
      stage: manual ? 'Manually queued schedule' : 'Queued by scheduler',
    },
  });
  await tx.jobSchedule.update({
    where: { id },
    data: {
      lastRunAt: now,
      ...(!manual ? { nextRunAt: nextRunAt(schedule, now) } : {}),
    },
  });
  return job.id;
}
export async function runSchedulerTick(
  db: PrismaClient = getPrisma(),
): Promise<number> {
  const due = await db.jobSchedule.findMany({
    where: {
      enabled: true,
      nextRunAt: { lte: new Date() },
      ...(!isHostingEnabled() ? { NOT: { jobType: { startsWith: 'HOSTED_' } } } : {}),
    },
    orderBy: { nextRunAt: 'asc' },
    take: 100,
  });
  let enqueued = 0;
  for (const schedule of due) {
    try {
      if (await db.$transaction((tx) => enqueueSchedule(tx, schedule.id)))
        enqueued++;
    } catch {
      console.error(`Schedule ${schedule.id} could not be queued`);
    }
  }
  return enqueued;
}
export function startSchedulerLoop(): ReturnType<typeof setInterval> {
  let running = false;
  const tick = async () => {
    if (running) return;
    running = true;
    try {
      await runSchedulerTick();
    } catch {
      console.error('Job scheduler failed');
    } finally {
      running = false;
    }
  };
  void tick();
  const timer = setInterval(() => {
    void tick();
  }, 15000);
  timer.unref();
  return timer;
}
export async function seedHostingSchedules(db: PrismaClient): Promise<void> {
  const defaults = [
    {
      key: 'hosting-reconcile',
      name: 'Reconcile hosted applications',
      jobType: 'HOSTED_RECONCILE_ALL',
      frequency: 'EVERY_MINUTE' as const,
      enabled: true,
      input: {},
    },
    {
      key: 'hosting-storage-cleanup',
      name: 'Clean unreferenced hosting storage',
      jobType: 'HOSTED_STORAGE_CLEANUP',
      frequency: 'HOURLY' as const,
      enabled: true,
      input: { dryRun: false },
    },
    {
      key: 'hosting-storage-inspect',
      name: 'Inspect hosting storage',
      jobType: 'HOSTED_STORAGE_INSPECT',
      frequency: 'DAILY' as const,
      enabled: true,
      input: {},
    },
    {
      key: 'hosting-trash',
      name: 'Purge expired hosting trash',
      jobType: 'HOSTED_PURGE_TRASH',
      frequency: 'DAILY' as const,
      enabled: true,
      input: { dryRun: false },
    },
    {
      key: 'hosting-stale',
      name: 'Review stale hosted applications',
      jobType: 'HOSTED_STALE_APPLICATIONS',
      frequency: 'DAILY' as const,
      enabled: false,
      input: {
        dryRun: true,
        inactiveDays: 180,
        suspendedDays: 7,
        action: 'suspend',
        includePublished: false,
        includeTemplates: false,
      },
    },
    {
      key: 'hosting-history',
      name: 'Review old hosting usage',
      jobType: 'HOSTED_HISTORY_PURGE',
      frequency: 'DAILY' as const,
      enabled: false,
      input: {
        dryRun: true,
        datasets: ['usage'],
        before: new Date(Date.now() - 365 * 86400000).toISOString(),
      },
    },
  ];
  for (const d of defaults) {
    const timing = {
      frequency: d.frequency,
      hourOfDay: d.key === 'hosting-trash' ? 3 : 2,
      minuteOfHour: 0,
    };
    await db.jobSchedule.upsert({
      where: { systemKey: d.key },
      update: {},
      create: {
        systemKey: d.key,
        name: d.name,
        jobType: d.jobType,
        input: d.input as Prisma.InputJsonObject,
        enabled: d.enabled,
        ...timing,
        nextRunAt: nextRunAt(timing),
      },
    });
  }
}
