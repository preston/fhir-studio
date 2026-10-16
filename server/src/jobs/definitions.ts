import type { ScheduledJobType, JobScheduleFrequency } from '@fhir-studio/core';
import { HostingError } from '../hosted/access.js';

export const jobDefinitions: ScheduledJobType[] = [
  {
    jobType: 'TEST_JOB',
    description: 'Synthetic worker verification',
    defaults: { steps: 5, stepDelayMs: 1000, message: '', failAtStep: null },
  },
  {
    jobType: 'HOSTED_RECONCILE_ALL',
    description: 'Reconcile a fair batch of GitHub builds',
    defaults: {},
  },
  {
    jobType: 'HOSTED_STORAGE_INSPECT',
    description: 'Inspect deployed files, storage and missing builds',
    defaults: {},
  },
  {
    jobType: 'HOSTED_STORAGE_CLEANUP',
    description: 'Reclaim unreferenced files and abandoned staging',
    defaults: { dryRun: true },
  },
  {
    jobType: 'HOSTED_STALE_APPLICATIONS',
    description: 'Review/suspend/trash inactive applications',
    defaults: {
      dryRun: true,
      inactiveDays: 180,
      action: 'suspend',
      suspendedDays: 7,
      includePublished: false,
      includeTemplates: false,
    },
  },
  {
    jobType: 'HOSTED_PURGE_TRASH',
    description: 'Permanently purge expired application trash',
    defaults: { dryRun: true },
  },
  {
    jobType: 'HOSTED_HISTORY_PURGE',
    description:
      'Purge selected historical datasets before an explicit UTC cutoff',
    defaults: { dryRun: true, datasets: ['usage'], before: '' },
  },
];
export function objectInput(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new HostingError(400, 'Job input must be a JSON object.');
  return value as Record<string, unknown>;
}
export function validateJobInput(
  jobType: string,
  value: unknown,
): Record<string, unknown> {
  const definition = jobDefinitions.find((d) => d.jobType === jobType);
  if (!definition)
    throw new HostingError(400, 'Select a registered schedulable job type.');
  const input = { ...definition.defaults, ...objectInput(value ?? {}) };
  const permitted = new Set([
    ...Object.keys(definition.defaults),
    ...(jobType === 'HOSTED_STALE_APPLICATIONS' ? ['excludeOwnerIds'] : []),
  ]);
  for (const key of Object.keys(input))
    if (!permitted.has(key))
      throw new HostingError(400, `Unknown ${jobType} input: ${key}`);
  for (const key of ['dryRun', 'includePublished', 'includeTemplates'])
    if (key in input && typeof input[key] !== 'boolean')
      throw new HostingError(400, `${key} must be boolean.`);
  for (const key of ['inactiveDays', 'suspendedDays', 'steps', 'stepDelayMs'])
    if (
      key in input &&
      (!Number.isSafeInteger(input[key]) ||
        Number(input[key]) <
          (key === 'stepDelayMs' ? 0 : key === 'suspendedDays' ? 7 : 1) ||
        Number(input[key]) > (key === 'stepDelayMs' ? 60000 : 10000))
    )
      throw new HostingError(
        400,
        `${key} is outside its supported integer range.`,
      );
  if (jobType === 'HOSTED_STALE_APPLICATIONS') {
    if (!['suspend', 'trash'].includes(String(input.action)))
      throw new HostingError(400, 'Stale action must be suspend or trash.');
    if (
      'excludeOwnerIds' in input &&
      (!Array.isArray(input.excludeOwnerIds) ||
        !input.excludeOwnerIds.every(
          (id) => typeof id === 'string' && /^[a-f0-9-]{36}$/.test(id),
        ))
    )
      throw new HostingError(400, 'excludeOwnerIds must be UUIDs.');
  }
  if (jobType === 'HOSTED_HISTORY_PURGE') {
    if (
      !Array.isArray(input.datasets) ||
      !input.datasets.length ||
      !input.datasets.every((d) =>
        ['usage', 'builds', 'audit'].includes(String(d)),
      )
    )
      throw new HostingError(
        400,
        'Select usage, builds and/or audit datasets.',
      );
    if (
      typeof input.before !== 'string' ||
      !/^\d{4}-\d\d-\d\dT.*Z$/.test(input.before) ||
      !Number.isFinite(Date.parse(input.before)) ||
      Date.parse(input.before) >= Date.now()
    )
      throw new HostingError(
        400,
        'before must be a past ISO timestamp in UTC (Z).',
      );
  }
  return input;
}
export interface ScheduleTiming {
  frequency: JobScheduleFrequency;
  minuteOfHour: number;
  hourOfDay: number;
}
export function parseTiming(body: Record<string, unknown>): ScheduleTiming {
  const frequency = body.frequency as JobScheduleFrequency;
  if (!['EVERY_MINUTE', 'HOURLY', 'DAILY'].includes(frequency))
    throw new HostingError(
      400,
      'frequency must be EVERY_MINUTE, HOURLY, or DAILY.',
    );
  const minuteOfHour = body.minuteOfHour ?? 0,
    hourOfDay = body.hourOfDay ?? 0;
  if (
    !Number.isInteger(minuteOfHour) ||
    Number(minuteOfHour) < 0 ||
    Number(minuteOfHour) > 59 ||
    !Number.isInteger(hourOfDay) ||
    Number(hourOfDay) < 0 ||
    Number(hourOfDay) > 23
  )
    throw new HostingError(400, 'Invalid UTC hour/minute.');
  return {
    frequency,
    minuteOfHour: Number(minuteOfHour),
    hourOfDay: Number(hourOfDay),
  };
}
export function nextRunAt(timing: ScheduleTiming, from = new Date()): Date {
  const next = new Date(from);
  next.setUTCSeconds(0, 0);
  if (timing.frequency === 'EVERY_MINUTE')
    next.setUTCMinutes(next.getUTCMinutes() + 1);
  else if (timing.frequency === 'HOURLY') {
    next.setUTCMinutes(timing.minuteOfHour);
    if (next <= from) next.setUTCHours(next.getUTCHours() + 1);
  } else {
    next.setUTCHours(timing.hourOfDay, timing.minuteOfHour);
    if (next <= from) next.setUTCDate(next.getUTCDate() + 1);
  }
  return next;
}
