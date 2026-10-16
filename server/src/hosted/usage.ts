import crypto from 'node:crypto';
import type { HostedUsageHour, PrismaClient } from '@prisma/client';
import type {
  HostedChannel,
  HostingUsageReport,
  HostingUsagePoint,
} from '@fhir-studio/core';
import { getPrisma } from '../db/prisma.js';
import {
  addVisitor,
  estimateVisitors,
  HLL_SIZE,
  mergeVisitors,
} from './hll.js';

export const LATENCY_LIMITS = [
  10,
  25,
  50,
  100,
  250,
  500,
  1000,
  2500,
  5000,
  10000,
  Infinity,
];
export const isKnownBot = (agent: string): boolean =>
  /bot|crawler|spider|slurp|headless|lighthouse|uptime|monitor|curl|wget/i.test(
    agent,
  );
const counters = [
  'requests',
  'documents',
  'bots',
  'status2xx',
  'status3xx',
  'status4xx',
  'status5xx',
  'rateLimited',
  'aborted',
  'launches',
] as const;
type Bucket = Omit<HostedUsageHour, 'histogram' | 'visitors'> & {
  histogram: number[];
  visitors: Uint8Array;
  servedAt: Date | null;
  launchAt: Date | null;
};
export interface UsageSample {
  applicationId: string;
  channel: HostedChannel;
  status?: number;
  document?: boolean;
  bot?: boolean;
  bytes?: number;
  durationMs?: number;
  aborted?: boolean;
  visitor?: string | null;
  launch?: boolean;
  at?: Date;
}
export function utcHour(date: Date): Date {
  return new Date(Math.floor(date.getTime() / 3600000) * 3600000);
}
function emptyBucket(sample: UsageSample, hour: Date): Bucket {
  return {
    applicationId: sample.applicationId,
    channel: sample.channel,
    hour,
    requests: 0,
    documents: 0,
    bots: 0,
    status2xx: 0,
    status3xx: 0,
    status4xx: 0,
    status5xx: 0,
    rateLimited: 0,
    aborted: 0,
    bytes: 0n,
    durationMs: 0,
    histogram: LATENCY_LIMITS.map(() => 0),
    visitors: new Uint8Array(HLL_SIZE),
    launches: 0,
    servedAt: null,
    launchAt: null,
  };
}
function histogram(value: unknown): number[] {
  return LATENCY_LIMITS.map((_, i) =>
    Array.isArray(value) && typeof value[i] === 'number' ? value[i] : 0,
  );
}
export class UsageCollector {
  readonly id = crypto.randomUUID();
  private sequence = 0;
  private pending = new Map<string, Bucket>();
  private batch: Map<string, Bucket> | null = null;
  private dropped = 0;
  private flushing: Promise<void> | null = null;
  private timer?: ReturnType<typeof setInterval>;
  constructor(
    readonly kind: 'host' | 'api',
    private readonly db: () => PrismaClient = getPrisma,
  ) {}
  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => {
      void this.flush().catch(() =>
        console.error(`Hosting usage ${this.kind} flush failed`),
      );
    }, 30000);
    this.timer.unref();
  }
  record(sample: UsageSample): void {
    const at = sample.at ?? new Date();
    const hour = utcHour(at);
    const key = `${sample.applicationId}:${sample.channel}:${hour.toISOString()}`;
    let bucket = this.pending.get(key);
    if (!bucket) {
      // Two maps cap buffered sketches/counters at roughly 16 MiB, independent of request volume.
      if (this.pending.size >= 4096) {
        this.dropped++;
        return;
      }
      bucket = emptyBucket(sample, hour);
      this.pending.set(key, bucket);
    }
    if (sample.launch) {
      bucket.launches++;
      bucket.launchAt = at;
      return;
    }
    bucket.requests++;
    bucket.bots += Number(!!sample.bot);
    const status = sample.status ?? 500;
    if (status >= 200 && status < 300) bucket.status2xx++;
    else if (status < 400) bucket.status3xx++;
    else if (status < 500) bucket.status4xx++;
    else bucket.status5xx++;
    if (status === 429) bucket.rateLimited++;
    if (sample.aborted) bucket.aborted++;
    const duration = Math.max(0, Math.min(3600000, sample.durationMs ?? 0));
    bucket.durationMs += duration;
    bucket.histogram[LATENCY_LIMITS.findIndex((limit) => duration <= limit)]++;
    bucket.bytes += BigInt(Math.max(0, Math.floor(sample.bytes ?? 0)));
    const success =
      ((status >= 200 && status < 300) || status === 304) && !sample.aborted;
    if (success && sample.document) bucket.documents++;
    if (success && !sample.bot) {
      if (sample.document) bucket.servedAt = at;
      if (sample.visitor) addVisitor(bucket.visitors, sample.visitor);
    }
  }
  flush(): Promise<void> {
    if (this.flushing) return this.flushing;
    this.flushing = this.doFlush().finally(() => {
      this.flushing = null;
    });
    return this.flushing;
  }
  private async doFlush(): Promise<void> {
    if (!this.batch) {
      this.batch = this.pending;
      this.pending = new Map();
    }
    const batch = this.batch;
    const sequence = this.sequence + 1;
    const dropped = this.dropped;
    await this.db().$transaction(
      async (tx) => {
        // Serializes all collectors merging the same hour; transaction-scoped for pooled connections.
        await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended('hosted-usage', 0))`;
        const cursor = await tx.hostedUsageCollector.findUnique({
          where: { id: this.id },
        });
        if ((cursor?.sequence ?? 0) >= sequence) return;
        const policy = await tx.hostedUsagePolicy.findUnique({
          where: { id: 'global' },
        });
        for (const bucket of batch.values()) {
          const key = {
            applicationId: bucket.applicationId,
            channel: bucket.channel,
            hour: bucket.hour,
          };
          if (!policy || bucket.hour >= policy.purgedBefore) {
            const old = await tx.hostedUsageHour.findUnique({
              where: { applicationId_channel_hour: key },
            });
            const data = {
              ...key,
              bytes: (old?.bytes ?? 0n) + bucket.bytes,
              durationMs: (old?.durationMs ?? 0) + bucket.durationMs,
              histogram: histogram(old?.histogram).map(
                (v, i) => v + bucket.histogram[i],
              ),
              visitors: Buffer.from(
                mergeVisitors(
                  old?.visitors ?? new Uint8Array(HLL_SIZE),
                  bucket.visitors,
                ),
              ),
              ...Object.fromEntries(
                counters.map((field) => [
                  field,
                  (old?.[field] ?? 0) + bucket[field],
                ]),
              ),
            };
            await tx.hostedUsageHour.upsert({
              where: { applicationId_channel_hour: key },
              create: data,
              update: data,
            });
          }
          if (bucket.servedAt)
            await tx.hostedApplication.updateMany({
              where: {
                id: bucket.applicationId,
                OR: [
                  { lastServedAt: null },
                  { lastServedAt: { lt: bucket.servedAt } },
                ],
              },
              data: { lastServedAt: bucket.servedAt },
            });
          if (bucket.launchAt)
            await tx.hostedApplication.updateMany({
              where: {
                id: bucket.applicationId,
                OR: [
                  { lastLaunchAt: null },
                  { lastLaunchAt: { lt: bucket.launchAt } },
                ],
              },
              data: { lastLaunchAt: bucket.launchAt },
            });
        }
        await tx.hostedUsageCollector.upsert({
          where: { id: this.id },
          create: {
            id: this.id,
            kind: this.kind,
            sequence,
            dropped,
            lastFlushedAt: new Date(),
          },
          update: { sequence, dropped, lastFlushedAt: new Date() },
        });
      },
      { timeout: 30000 },
    );
    this.sequence = sequence;
    this.batch = null;
  }
  async stop(): Promise<void> {
    if (this.timer) clearInterval(this.timer);
    await this.flush();
    if (this.pending.size) await this.flush();
  }
}
export const apiUsage = new UsageCollector('api');
export async function usageReport(
  applicationIds: string[] | undefined,
  from: Date,
  to: Date,
  channel?: HostedChannel,
): Promise<HostingUsageReport> {
  const db = getPrisma();
  const where = {
    ...(applicationIds ? { applicationId: { in: applicationIds } } : {}),
    hour: { gte: from, lt: to },
    ...(channel ? { channel } : {}),
  };
  // Aggregate numeric metrics in SQL; load sketches only for a single app to avoid instance-wide visitor identities.
  const rows = await db.hostedUsageHour.groupBy({
    by: ['hour', 'channel'],
    where,
    _sum: {
      requests: true,
      documents: true,
      bots: true,
      status2xx: true,
      status3xx: true,
      status4xx: true,
      status5xx: true,
      rateLimited: true,
      aborted: true,
      bytes: true,
      durationMs: true,
      launches: true,
    },
    orderBy: { hour: 'asc' },
  });
  const totals = {
    requests: 0,
    documents: 0,
    bots: 0,
    status2xx: 0,
    status3xx: 0,
    status4xx: 0,
    status5xx: 0,
    rateLimited: 0,
    aborted: 0,
    launches: 0,
    bytes: '0',
    durationMs: 0,
  };
  let bytes = 0n;
  const points: HostingUsagePoint[] = rows.map((row) => {
    const values = row._sum;
    for (const field of counters) totals[field] += values[field] ?? 0;
    bytes += values.bytes ?? 0n;
    totals.durationMs += values.durationMs ?? 0;
    return {
      hour: row.hour.toISOString(),
      channel: row.channel as HostedChannel,
      ...Object.fromEntries(counters.map((k) => [k, values[k] ?? 0])),
      bytes: String(values.bytes ?? 0n),
      durationMs: values.durationMs ?? 0,
    } as HostingUsagePoint;
  });
  totals.bytes = String(bytes);
  const sketches = {
    preview: new Uint8Array(HLL_SIZE),
    published: new Uint8Array(HLL_SIZE),
  };
  const durations = LATENCY_LIMITS.map(() => 0);
  if (applicationIds?.length === 1) {
    let cursor:
      { applicationId: string; channel: string; hour: Date } | undefined;
    for (;;) {
      const batch = await db.hostedUsageHour.findMany({
        where,
        take: 500,
        ...(cursor
          ? { cursor: { applicationId_channel_hour: cursor }, skip: 1 }
          : {}),
        orderBy: [
          { applicationId: 'asc' },
          { channel: 'asc' },
          { hour: 'asc' },
        ],
        select: {
          applicationId: true,
          hour: true,
          channel: true,
          visitors: true,
          histogram: true,
        },
      });
      for (const row of batch) {
        const c = row.channel as HostedChannel;
        sketches[c] = mergeVisitors(
          sketches[c],
          row.visitors,
        ) as Uint8Array<ArrayBuffer>;
        histogram(row.histogram).forEach((n, i) => (durations[i] += n));
      }
      if (batch.length < 500) break;
      const last = batch[batch.length - 1];
      cursor = {
        applicationId: last.applicationId,
        channel: last.channel,
        hour: last.hour,
      };
    }
  }
  const target = Math.ceil(durations.reduce((a, b) => a + b, 0) * 0.95);
  let cumulative = 0;
  const index = target
    ? durations.findIndex((n) => (cumulative += n) >= target)
    : -1;
  const collectors = await db.hostedUsageCollector.findMany({
    orderBy: { lastFlushedAt: 'desc' },
    take: 100,
    select: { id: true, kind: true, lastFlushedAt: true, dropped: true },
  });
  return {
    points,
    totals,
    visitors:
      applicationIds?.length === 1
        ? {
            preview: estimateVisitors(sketches.preview),
            published: estimateVisitors(sketches.published),
          }
        : null,
    averageResponseMs: totals.requests
      ? totals.durationMs / totals.requests
      : 0,
    p95ResponseMs:
      index >= 0 && Number.isFinite(LATENCY_LIMITS[index])
        ? LATENCY_LIMITS[index]
        : null,
    collectors: collectors.map((c) => ({
      ...c,
      lastFlushedAt: c.lastFlushedAt.toISOString(),
    })),
  };
}
