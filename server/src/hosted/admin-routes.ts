import express from 'express';
import type { Prisma } from '@prisma/client';
import type {
  HostingInventoryItem,
  HostingActionPreview,
  HostedChannel,
} from '@fhir-studio/core';
import { statfs } from 'node:fs/promises';
import { getPrisma } from '../db/prisma.js';
import { requirePermission } from '../authorization/requirePermission.js';
import { routeParam } from '../http/routeParam.js';
import { applicationAccess, HostingError } from './access.js';
import { loadHostingConfig } from './config.js';
import { actionRequest, validateLifecycle } from './operations.js';
import { lockHostingAllocation } from './quotas.js';
import { usageReport } from './usage.js';
import { isHostingEnabled } from '../env.js';

export function jsonSafe(value: unknown): unknown {
  return JSON.parse(
    JSON.stringify(value, (_key, item: unknown) =>
      typeof item === 'bigint' ? String(item) : item,
    ),
  );
}
export function csv(rows: Record<string, unknown>[]): string {
  const keys = [...new Set(rows.flatMap((row) => Object.keys(row)))];
  const cell = (value: unknown) => {
    let s =
      value == null
        ? ''
        : typeof value === 'object'
          ? JSON.stringify(value)
          : String(value);
    if (/^[\s]*[=+\-@]/.test(s)) s = `'${s}`; // Prevent spreadsheet formula execution in exports.
    return `"${s.replaceAll('"', '""')}"`;
  };
  return (
    '\uFEFF' +
    [
      keys.map(cell).join(','),
      ...rows.map((row) => keys.map((key) => cell(row[key])).join(',')),
    ].join('\r\n')
  );
}
function integer(value: unknown, fallback: number, max: number): number {
  if (value == null || value === '') return fallback;
  const n = Number(value);
  if (!Number.isInteger(n) || n < 1 || n > max)
    throw new HostingError(400, `Expected an integer between 1 and ${max}.`);
  return n;
}
export function usageRange(query: Record<string, unknown>): {
  from: Date;
  to: Date;
  channel?: HostedChannel;
} {
  const from = query.from
    ? new Date(String(query.from))
    : new Date(Date.now() - 30 * 86400000);
  const to = query.to ? new Date(String(query.to)) : new Date();
  if (
    !Number.isFinite(+from) ||
    !Number.isFinite(+to) ||
    from >= to ||
    to.getTime() - from.getTime() > 366 * 86400000
  )
    throw new HostingError(
      400,
      'Choose a valid reporting range of up to 366 days. Older records remain available using an earlier range.',
    );
  if (
    query.channel &&
    !['preview', 'published'].includes(String(query.channel))
  )
    throw new HostingError(400, 'Invalid hosting channel.');
  from.setUTCMinutes(0, 0, 0);
  to.setTime(Math.ceil(to.getTime() / 3600000) * 3600000);
  return { from, to, channel: query.channel as HostedChannel | undefined };
}
export function createHostingAdministrationRouter(): express.Router {
  const router = express.Router(),
    db = getPrisma();
  if (!isHostingEnabled()) {
    router.use(['/api/administration/hosting', '/api/hosted-applications/:id/usage'], (_req, res) => {
      res.status(503).json({ error: 'Application hosting is not enabled on this instance.' });
    });
    return router;
  }
  router.use('/api/administration/hosting', requirePermission('global_manage'));
  router.get('/api/hosted-applications/:id/usage', async (req, res) => {
    const { app } = await applicationAccess(req, routeParam(req.params.id));
    const { from, to, channel } = usageRange(req.query);
    res.json(await usageReport([app.id], from, to, channel));
  });
  router.get('/api/administration/hosting/applications', async (req, res) => {
    const query = req.query,
      page = integer(query.page, 1, 1000000),
      limit = integer(query.limit, 25, query.format === 'csv' ? 10000 : 100);
    const search =
      typeof query.search === 'string' ? query.search.trim().slice(0, 200) : '';
    const cutoff = new Date(Date.now() - 180 * 86400000);
    const status = String(query.status ?? 'active');
    const priorInspection =
      status === 'problem'
        ? await db.job.findFirst({
            where: { jobType: 'HOSTED_STORAGE_INSPECT', status: 'completed' },
            orderBy: { completedAt: 'desc' },
            select: { output: true },
          })
        : null;
    const missingForFilter =
      (priorInspection?.output as { missingBuildIds?: string[] } | null)
        ?.missingBuildIds ?? [];

    const where: Prisma.HostedApplicationWhereInput = {
      ...(status === 'trash'
        ? { deletedAt: { not: null } }
        : status === 'all'
          ? {}
          : { deletedAt: null }),
      ...(query.ownerUserId ? { ownerUserId: String(query.ownerUserId) } : {}),
      ...(search
        ? {
            OR: [
              { name: { contains: search, mode: 'insensitive' } },
              { repository: { contains: search, mode: 'insensitive' } },
              { owner: { email: { contains: search, mode: 'insensitive' } } },
              {
                owner: {
                  displayName: { contains: search, mode: 'insensitive' },
                },
              },
            ],
          }
        : {}),
      ...(status === 'suspended' ? { suspended: true } : {}),
      ...(status === 'published' ? { publishedBuildId: { not: null } } : {}),
      ...(status === 'stale'
        ? {
            lastDeveloperActivityAt: { lte: cutoff },
            AND: [
              {
                OR: [{ lastServedAt: null }, { lastServedAt: { lte: cutoff } }],
              },
              {
                OR: [{ lastLaunchAt: null }, { lastLaunchAt: { lte: cutoff } }],
              },
            ],
            cleanupProtected: false,
            publishedBuildId: null,
            isTemplate: false,
            transferToUserId: null,
          }
        : {}),
    };
    if (status === 'problem')
      where.AND = [
        {
          OR: [
            { reconciliationError: { not: null } },
            { previewBuildId: { in: missingForFilter } },
            { publishedBuildId: { in: missingForFilter } },
            { owner: { isSuspended: true } },
            {
              builds: {
                some: {
                  status: 'FAILED',
                  createdAt: { gte: new Date(Date.now() - 7 * 86400000) },
                },
              },
            },
            {
              builds: {
                some: {
                  status: { in: ['WAITING', 'BUILDING', 'IMPORTING'] },
                  updatedAt: { lt: new Date(Date.now() - 86400000) },
                },
              },
            },
          ],
        },
      ];
    const sortFields = [
      'name',
      'createdAt',
      'lastDeveloperActivityAt',
      'lastServedAt',
      'lastReconciledAt',
      'deletedAt',
    ];
    const sortBy = sortFields.includes(String(query.sortBy))
      ? String(query.sortBy)
      : 'createdAt';
    const [apps, total, inspection, collectors] = await Promise.all([
      db.hostedApplication.findMany({
        where,
        orderBy: [
          { [sortBy]: query.sortOrder === 'asc' ? 'asc' : 'desc' },
          { id: 'asc' },
        ],
        skip: (page - 1) * limit,
        take: limit,
        include: {
          owner: {
            select: { email: true, displayName: true, isSuspended: true },
          },
          _count: { select: { sandboxes: true } },
          builds: { orderBy: { createdAt: 'desc' }, take: 5 },
        },
      }),
      db.hostedApplication.count({ where }),
      db.job.findFirst({
        where: { jobType: 'HOSTED_STORAGE_INSPECT', status: 'completed' },
        orderBy: { completedAt: 'desc' },
        select: { output: true },
      }),
      db.hostedUsageCollector.findFirst({
        where: {
          kind: 'host',
          lastFlushedAt: { gt: new Date(Date.now() - 5 * 60000) },
        },
      }),
    ]);
    const sizes = await db.hostedBuild.groupBy({
      by: ['applicationId'],
      where: { applicationId: { in: apps.map((a) => a.id) } },
      _sum: { byteSize: true },
    });
    const reserved = await db.hostedBuild.groupBy({
      by: ['applicationId'],
      where: { applicationId: { in: apps.map((a) => a.id) }, directory: null },
      _sum: { byteSize: true },
    });
    const missing = new Set(
      Array.isArray(
        (inspection?.output as Record<string, unknown> | undefined)
          ?.missingBuildIds,
      )
        ? (inspection!.output as { missingBuildIds: string[] }).missingBuildIds
        : [],
    );
    const rows = apps.map((app) => {
      const issues: string[] = [];
      if (app.owner.isSuspended) issues.push('Owner suspended');
      if (app.reconciliationError) issues.push(app.reconciliationError);
      if (
        app.builds.some(
          (b) =>
            b.status === 'FAILED' &&
            b.createdAt > new Date(Date.now() - 7 * 86400000),
        )
      )
        issues.push('Recent build/import failures');
      if (
        app.builds.some(
          (b) =>
            ['WAITING', 'BUILDING', 'IMPORTING'].includes(b.status) &&
            b.updatedAt < new Date(Date.now() - 86400000),
        )
      )
        issues.push('Build pending over 24 hours');
      if (
        [app.previewBuildId, app.publishedBuildId].some(
          (id) => id && missing.has(id),
        )
      )
        issues.push('Deployed files missing');
      const { builds, _count, ...rest } = app;
      return {
        ...rest,
        storageBytes: String(
          sizes.find((s) => s.applicationId === app.id)?._sum.byteSize ?? 0n,
        ),
        reservedBytes: String(
          reserved.find((s) => s.applicationId === app.id)?._sum.byteSize ?? 0n,
        ),
        sandboxCount: _count.sandboxes,
        latestBuild: builds[0]
          ? {
              id: builds[0].id,
              status: builds[0].status,
              error: builds[0].error,
              createdAt: builds[0].createdAt.toISOString(),
            }
          : null,
        issues,
        abandonmentCandidate:
          !!collectors &&
          !app.deletedAt &&
          !app.cleanupProtected &&
          !app.publishedBuildId &&
          !app.isTemplate &&
          !app.transferToUserId &&
          app.lastDeveloperActivityAt <= cutoff &&
          (!app.lastServedAt || app.lastServedAt <= cutoff) &&
          (!app.lastLaunchAt || app.lastLaunchAt <= cutoff) &&
          !builds.some((b) =>
            ['WAITING', 'BUILDING', 'IMPORTING'].includes(b.status),
          ),
      };
    });
    if (query.format === 'csv') {
      res
        .attachment('hosting-inventory.csv')
        .type('text/csv')
        .send(csv(jsonSafe(rows) as Record<string, unknown>[]));
      return;
    }
    res.json(jsonSafe({ applications: rows, total, page, limit }));
  });
  router.get(
    '/api/administration/hosting/applications/:id',
    async (req, res) => {
      const app = await db.hostedApplication.findUnique({
        where: { id: routeParam(req.params.id) },
        include: {
          owner: {
            select: {
              id: true,
              email: true,
              displayName: true,
              isSuspended: true,
            },
          },
          collaborators: {
            include: {
              user: { select: { id: true, email: true, displayName: true } },
            },
          },
          sandboxes: {
            include: { sandbox: { select: { sandboxId: true, name: true } } },
          },
          builds: { take: 20, orderBy: { createdAt: 'desc' } },
        },
      });
      if (!app) throw new HostingError(404, 'Application not found.');
      res.json(
        jsonSafe({
          ...app,
          builds: app.builds.map(
            ({ directory: _directory, ...build }) => build,
          ),
        }),
      );
    },
  );
  router.get('/api/administration/hosting/usage', async (req, res) => {
    const { from, to, channel } = usageRange(req.query);
    const report = await usageReport(
      req.query.applicationId ? [String(req.query.applicationId)] : undefined,
      from,
      to,
      channel,
    );
    if (req.query.format === 'csv') {
      res
        .attachment('hosting-usage.csv')
        .type('text/csv')
        .send(csv(report.points.map((p) => ({ ...p }))));
      return;
    }
    res.json(report);
  });
  router.get('/api/administration/hosting/storage', async (_req, res) => {
    const config = loadHostingConfig('api');
    const [size, reservations, trash, fs, inspection] = await Promise.all([
      db.hostedBuild.aggregate({ _sum: { byteSize: true } }),
      db.hostedBuild.aggregate({
        where: { directory: null },
        _sum: { byteSize: true },
      }),
      db.hostedBuild.aggregate({
        where: { application: { deletedAt: { not: null } } },
        _sum: { byteSize: true },
      }),
      statfs(config.root),
      db.job.findFirst({
        where: { jobType: 'HOSTED_STORAGE_INSPECT', status: 'completed' },
        orderBy: { completedAt: 'desc' },
        select: { output: true, completedAt: true },
      }),
    ]);
    res.json(
      jsonSafe({
        allocatedBytes: size._sum.byteSize ?? 0n,
        reservedBytes: reservations._sum.byteSize ?? 0n,
        trashBytes: trash._sum.byteSize ?? 0n,
        budgetBytes: config.maxStorageBytes,
        freeBytes: BigInt(fs.bavail) * BigInt(fs.bsize),
        inspection,
      }),
    );
  });
  router.get('/api/administration/hosting/owners', async (req, res) => {
    const config = loadHostingConfig('api'),
      page = integer(req.query.page, 1, 1000000),
      limit = integer(req.query.limit, 25, 10000);
    const search = String(req.query.search ?? '').slice(0, 200);
    const where: Prisma.UserWhereInput = search
      ? {
          OR: [
            { email: { contains: search, mode: 'insensitive' } },
            { displayName: { contains: search, mode: 'insensitive' } },
          ],
        }
      : {};
    const [users, total] = await Promise.all([
      db.user.findMany({
        where,
        orderBy: { id: 'asc' },
        skip: (page - 1) * limit,
        take: limit,
        include: {
          hostedQuota: true,
          hostedApplications: { select: { id: true, deletedAt: true } },
        },
      }),
      db.user.count({ where }),
    ]);
    const applicationIds = users.flatMap((u) =>
      u.hostedApplications.map((a) => a.id),
    );
    const [sizes, reservations] = await Promise.all([
      db.hostedBuild.groupBy({
        by: ['applicationId'],
        where: { applicationId: { in: applicationIds } },
        _sum: { byteSize: true },
      }),
      db.hostedBuild.groupBy({
        by: ['applicationId'],
        where: { applicationId: { in: applicationIds }, directory: null },
        _sum: { byteSize: true },
      }),
    ]);
    const sizeByApp = new Map(
      sizes.map((s) => [s.applicationId, s._sum.byteSize ?? 0n]),
    );
    const reservedByApp = new Map(
      reservations.map((s) => [s.applicationId, s._sum.byteSize ?? 0n]),
    );
    const rows = users.map((u) => ({
      userId: u.id,
      email: u.email,
      displayName: u.displayName,
      isSuspended: u.isSuspended,
      applications: u.hostedApplications.filter((a) => !a.deletedAt).length,
      storageBytes: String(
        u.hostedApplications.reduce(
          (n, a) => n + (sizeByApp.get(a.id) ?? 0n),
          0n,
        ),
      ),
      reservedBytes: String(
        u.hostedApplications.reduce(
          (n, a) => n + (reservedByApp.get(a.id) ?? 0n),
          0n,
        ),
      ),
      trashBytes: String(
        u.hostedApplications
          .filter((a) => a.deletedAt)
          .reduce((n, a) => n + (sizeByApp.get(a.id) ?? 0n), 0n),
      ),
      applicationLimit: u.hostedQuota?.applicationLimit ?? null,
      effectiveApplicationLimit:
        u.hostedQuota?.applicationLimit ?? config.maxApps,
      storageBytesLimit:
        u.hostedQuota?.storageBytesLimit == null
          ? null
          : String(u.hostedQuota.storageBytesLimit),
    }));
    if (req.query.format === 'csv') {
      res.attachment('hosting-owners.csv').type('text/csv').send(csv(rows));
      return;
    }
    res.json({ owners: rows, total, page, limit });
  });
  router.put('/api/administration/hosting/owners/:id', async (req, res) => {
    const id = routeParam(req.params.id),
      b = req.body as Record<string, unknown>;
    if (
      typeof b.reason !== 'string' ||
      !b.reason.trim() ||
      b.reason.length > 2000 ||
      (b.applicationLimit !== null &&
        (!Number.isSafeInteger(b.applicationLimit) ||
          Number(b.applicationLimit) < 0))
    )
      throw new HostingError(
        400,
        'Provide a reason and a nonnegative application limit (or null to inherit).',
      );
    if (
      b.storageBytesLimit !== null &&
      (typeof b.storageBytesLimit !== 'string' ||
        !/^\d{1,18}$/.test(b.storageBytesLimit))
    )
      throw new HostingError(
        400,
        'Storage limit must be a nonnegative byte string, or null.',
      );
    const quota = await db.$transaction(async (tx) => {
      await lockHostingAllocation(tx, [id]);
      const old = await tx.hostedOwnerQuota.findUnique({
        where: { userId: id },
      });
      const data = {
        applicationLimit: b.applicationLimit as number | null,
        storageBytesLimit:
          b.storageBytesLimit === null
            ? null
            : BigInt(String(b.storageBytesLimit)),
      };
      const result = await tx.hostedOwnerQuota.upsert({
        where: { userId: id },
        create: { userId: id, ...data },
        update: data,
      });
      await tx.hostedAudit.create({
        data: {
          userId: req.sessionAuth!.userId,
          action: 'OWNER_QUOTA_CHANGED',
          detail: jsonSafe({
            ownerUserId: id,
            reason: b.reason,
            previous: old,
            current: data,
          }) as Prisma.InputJsonObject,
        },
      });
      return result;
    });
    res.json(jsonSafe({ quota }));
  });
  router.get('/api/administration/hosting/audit', async (req, res) => {
    const page = integer(req.query.page, 1, 1000000),
      limit = integer(
        req.query.limit,
        25,
        req.query.format === 'csv' ? 10000 : 100,
      );
    const { from, to } = usageRange(req.query);
    const where: Prisma.HostedAuditWhereInput = {
      createdAt: { gte: from, lt: to },
      ...(req.query.applicationId
        ? { applicationId: String(req.query.applicationId) }
        : {}),
      ...(req.query.action
        ? {
            action: { contains: String(req.query.action), mode: 'insensitive' },
          }
        : {}),
    };
    const [records, total] = await Promise.all([
      db.hostedAudit.findMany({
        where,
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        skip: (page - 1) * limit,
        take: limit,
      }),
      db.hostedAudit.count({ where }),
    ]);
    if (req.query.format === 'csv') {
      res
        .attachment('hosting-audit.csv')
        .type('text/csv')
        .send(csv(jsonSafe(records) as Record<string, unknown>[]));
      return;
    }
    res.json({ records, total, page, limit });
  });
  router.post(
    '/api/administration/hosting/actions/preview',
    async (req, res) => {
      const request = actionRequest(req.body);
      const applications: HostingActionPreview['applications'] = [];
      let bytes = 0n;
      for (const id of request.ids) {
        const app = await db.hostedApplication.findUnique({ where: { id } });
        if (!app) {
          applications.push({
            id,
            name: id,
            generation: -1,
            storageBytes: '0',
            error: 'Application not found',
          });
          continue;
        }
        const size = await db.hostedBuild.aggregate({
          where: { applicationId: id },
          _sum: { byteSize: true },
        });
        const storageBytes = size._sum.byteSize ?? 0n;
        bytes += storageBytes;
        let error: string | undefined;
        try {
          validateLifecycle(app, request.action);
        } catch (e) {
          error = e instanceof Error ? e.message : 'Action unavailable';
        }
        applications.push({
          id,
          name: app.name,
          generation: app.generation,
          storageBytes: String(storageBytes),
          ...(error ? { error } : {}),
        });
      }
      res.json({
        applications,
        storageBytes: String(bytes),
      } satisfies HostingActionPreview);
    },
  );
  router.post('/api/administration/hosting/actions', async (req, res) => {
    const request = actionRequest(req.body);
    if (
      !request.expectedGenerations ||
      request.ids.some((id) => request.expectedGenerations![id] == null)
    )
      throw new HostingError(
        400,
        'Preview the affected applications before executing an action.',
      );
    const job = await db.job.create({
      data: {
        name: `Hosting: ${request.action} (${request.ids.length} applications)`,
        jobType: 'HOSTED_ADMIN_ACTION',
        input: request as unknown as Prisma.InputJsonObject,
        createdByUserId: req.sessionAuth!.userId,
      },
    });
    res.status(202).json({ jobId: job.id });
  });
  return router;
}
