// Author: Preston Lee

import express, { type Request, type Response, type Router } from 'express';
import axios from 'axios';
import { AppointmentEntityType, type Prisma } from '@prisma/client';
import { getPrisma } from '../db/prisma.js';
import { HapiPartitionClient, assertFhirReleaseEnabled } from '../hapi/partition_client.js';
import { requirePermission } from '../authorization/requirePermission.js';
import { JobService } from '../jobs/service.js';
import type { FhirRelease } from '@fhir-studio/core';

export function createAdministrationRouter(): Router {
  const router = express.Router();
  const prisma = getPrisma();
  const hapiClient = new HapiPartitionClient();

  // Protect entire administration router with global_manage permission
  router.use(requirePermission('global_manage'));

  // ==========================================
  // 1. SYSTEM & REPORTING METRICS
  // ==========================================
  router.get('/api/administration/metrics', async (req: Request, res: Response): Promise<void> => {
    const [
      totalSandboxes,
      r4Sandboxes,
      r5Sandboxes,
      openSandboxes,
      securedSandboxes,
      sharedSandboxes,
      totalUsers,
      suspendedUsers,
      totalSessions,
      totalApplications,
      totalScenarios,
      sandboxes,
      users,
    ] = await Promise.all([
      prisma.sandbox.count(),
      prisma.sandbox.count({ where: { fhirVersion: 'R4' } }),
      prisma.sandbox.count({ where: { fhirVersion: 'R5' } }),
      prisma.sandbox.count({ where: { allowOpenAccess: true } }),
      prisma.sandbox.count({ where: { allowOpenAccess: false } }),
      prisma.sandbox.count({ where: { isShared: true } }),
      prisma.user.count(),
      prisma.user.count({ where: { isSuspended: true } }),
      prisma.session.count(),
      prisma.application.count(),
      prisma.launchScenario.count(),

      prisma.sandbox.findMany({
        select: { createdAt: true, fhirVersion: true },
        orderBy: { createdAt: 'asc' },
      }),
      prisma.user.findMany({
        select: { createdAt: true },
        orderBy: { createdAt: 'asc' },
      }),
    ]);

    // Aggregate monthly timelines for ECharts
    const monthlySignups: Record<string, number> = {};
    for (const u of users) {
      const monthKey = u.createdAt.toISOString().slice(0, 7); // YYYY-MM
      monthlySignups[monthKey] = (monthlySignups[monthKey] || 0) + 1;
    }

    const monthlySandboxes: Record<string, number> = {};
    for (const s of sandboxes) {
      const monthKey = s.createdAt.toISOString().slice(0, 7);
      monthlySandboxes[monthKey] = (monthlySandboxes[monthKey] || 0) + 1;
    }

    res.json({
      summary: {
        totalSandboxes,
        r4Sandboxes,
        r5Sandboxes,
        openSandboxes,
        securedSandboxes,
        sharedSandboxes,
        totalUsers,
        suspendedUsers,
        totalSessions,
        totalApplications,
        totalScenarios,
      },
      charts: {
        versionDistribution: [
          { name: 'FHIR R4', value: r4Sandboxes },
          { name: 'FHIR R5', value: r5Sandboxes },
        ],
        accessModeDistribution: [
          { name: 'Secured (OAuth)', value: securedSandboxes },
          { name: 'Open Access', value: openSandboxes },
        ],
        monthlySignupsTimeline: Object.entries(monthlySignups).map(([month, count]) => ({ month, count })),
        monthlySandboxesTimeline: Object.entries(monthlySandboxes).map(([month, count]) => ({ month, count })),
      },
    });
  });

  // ==========================================
  // 2. USER MANAGEMENT & SUSPENSION
  // ==========================================
  router.get('/api/administration/users', async (req: Request, res: Response): Promise<void> => {
    const users = await prisma.user.findMany({
      include: {
        memberships: {
          include: { group: { select: { id: true, name: true } } },
        },
        _count: {
          select: {
            sessions: true,
            sandboxesCreated: true,
          },
        },
      },
      orderBy: { createdAt: 'desc' },
    });

    const appointments = await prisma.appointment.findMany({
      where: { entityType: AppointmentEntityType.User },
      include: { role: true },
    });

    const enriched = users.map((u) => {
      const userAppointments = appointments.filter((a) => a.entityId === u.id);
      const appointmentSummaries = userAppointments.map((a) => ({ id: a.id, role: a.role }));
      return {
        ...u,
        appointments: appointmentSummaries,
        roles: appointmentSummaries.map((a) => a.role),
      };
    });

    res.json({ users: enriched });
  });

  router.put('/api/administration/users/:userId', async (req: Request, res: Response): Promise<void> => {
    const { userId } = req.params;
    const { displayName, email, isSuspended } = req.body;

    const user = await prisma.user.findUnique({ where: { id: userId } });
    if (!user) {
      res.status(404).json({ error: 'User not found.' });
      return;
    }

    const updated = await prisma.user.update({
      where: { id: userId },
      data: {
        ...(displayName !== undefined ? { displayName: displayName || null } : {}),
        ...(email !== undefined ? { email: email || null } : {}),
        ...(isSuspended !== undefined ? { isSuspended: Boolean(isSuspended) } : {}),
      },
    });

    if (isSuspended === true) {
      await prisma.session.deleteMany({
        where: { userId },
      });
    }

    res.json({ user: updated });
  });

  router.put('/api/administration/users/:userId/suspend', async (req: Request, res: Response): Promise<void> => {
    const { userId } = req.params;
    const { isSuspended } = req.body;

    const user = await prisma.user.findUnique({ where: { id: userId } });
    if (!user) {
      res.status(404).json({ error: 'User not found.' });
      return;
    }

    const updated = await prisma.user.update({
      where: { id: userId },
      data: { isSuspended: Boolean(isSuspended) },
    });

    if (isSuspended) {
      // Immediately terminate all active sessions for suspended user
      await prisma.session.deleteMany({
        where: { userId },
      });
    }

    res.json({ user: updated });
  });

  // ==========================================
  // 3. GROUP MANAGEMENT
  // ==========================================
  router.get('/api/administration/groups', async (req: Request, res: Response): Promise<void> => {
    const groups = await prisma.group.findMany({
      include: {
        members: {
          include: { user: { select: { id: true, email: true, displayName: true } } },
        },
      },
      orderBy: { name: 'asc' },
    });

    const appointments = await prisma.appointment.findMany({
      where: { entityType: AppointmentEntityType.Group },
      include: { role: true },
    });

    const enriched = groups.map((g) => {
      const groupAppointments = appointments.filter((a) => a.entityId === g.id);
      return {
        ...g,
        roles: groupAppointments.map((a) => a.role),
      };
    });

    res.json({ groups: enriched });
  });

  router.post('/api/administration/groups', async (req: Request, res: Response): Promise<void> => {
    const { name, description, ssoRoleMapping } = req.body;
    if (!name) {
      res.status(400).json({ error: 'Group name is required.' });
      return;
    }

    const created = await prisma.group.create({
      data: {
        name,
        description: description || null,
        ssoRoleMapping: ssoRoleMapping || null,
      },
    });

    res.status(201).json({ group: created });
  });

  router.put('/api/administration/groups/:groupId', async (req: Request, res: Response): Promise<void> => {
    const { groupId } = req.params;
    const { name, description, ssoRoleMapping } = req.body;

    const updated = await prisma.group.update({
      where: { id: groupId },
      data: {
        ...(name !== undefined ? { name } : {}),
        ...(description !== undefined ? { description } : {}),
        ...(ssoRoleMapping !== undefined ? { ssoRoleMapping: ssoRoleMapping || null } : {}),
      },
    });

    res.json({ group: updated });
  });

  router.delete('/api/administration/groups/:groupId', async (req: Request, res: Response): Promise<void> => {
    const { groupId } = req.params;
    await prisma.group.delete({ where: { id: groupId } });
    res.json({ message: 'Group deleted successfully.' });
  });

  router.post('/api/administration/groups/:groupId/members', async (req: Request, res: Response): Promise<void> => {
    const { groupId } = req.params;
    const { userId } = req.body;

    if (!userId) {
      res.status(400).json({ error: 'userId is required.' });
      return;
    }

    const member = await prisma.member.upsert({
      where: {
        userId_groupId: {
          userId,
          groupId,
        },
      },
      create: { userId, groupId },
      update: {},
      include: { user: { select: { id: true, email: true, displayName: true } } },
    });

    res.status(201).json({ member });
  });

  router.delete('/api/administration/groups/:groupId/members/:userId', async (req: Request, res: Response): Promise<void> => {
    const { groupId, userId } = req.params;
    await prisma.member.deleteMany({
      where: { groupId, userId },
    });
    res.json({ message: 'Member removed from group.' });
  });

  // ==========================================
  // 4. ROLE MANAGEMENT
  // ==========================================
  router.get('/api/administration/roles', async (req: Request, res: Response): Promise<void> => {
    const roles = await prisma.role.findMany({
      include: {
        appointments: true,
      },
      orderBy: { name: 'asc' },
    });
    res.json({ roles });
  });

  router.post('/api/administration/roles', async (req: Request, res: Response): Promise<void> => {
    const {
      name,
      description,
      default: isDefault = false,
      ssoRoleMapping,
      permission_sandboxes_create = true,
      permission_sandboxes_shared = false,
      permission_ehr_simulator = true,
      permission_data_manager = true,
      permission_applications_register = true,
      permission_package_import = true,
      permission_global_manage = false,
    } = req.body;

    if (!name) {
      res.status(400).json({ error: 'Role name is required.' });
      return;
    }

    const created = await prisma.role.create({
      data: {
        name,
        description: description || null,
        default: Boolean(isDefault),
        ssoRoleMapping: ssoRoleMapping || null,
        permission_sandboxes_create: Boolean(permission_sandboxes_create),
        permission_sandboxes_shared: Boolean(permission_sandboxes_shared),
        permission_ehr_simulator: Boolean(permission_ehr_simulator),
        permission_data_manager: Boolean(permission_data_manager),
        permission_applications_register: Boolean(permission_applications_register),
        permission_package_import: Boolean(permission_package_import),
        permission_global_manage: Boolean(permission_global_manage),
      },
    });

    res.status(201).json({ role: created });
  });

  router.put('/api/administration/roles/:roleId', async (req: Request, res: Response): Promise<void> => {
    const { roleId } = req.params;
    const {
      name,
      description,
      default: isDefault,
      ssoRoleMapping,
      permission_sandboxes_create,
      permission_sandboxes_shared,
      permission_ehr_simulator,
      permission_data_manager,
      permission_applications_register,
      permission_package_import,
      permission_global_manage,
    } = req.body;

    const updated = await prisma.role.update({
      where: { id: roleId },
      data: {
        ...(name !== undefined ? { name } : {}),
        ...(description !== undefined ? { description } : {}),
        ...(isDefault !== undefined ? { default: Boolean(isDefault) } : {}),
        ...(ssoRoleMapping !== undefined ? { ssoRoleMapping: ssoRoleMapping || null } : {}),
        ...(permission_sandboxes_create !== undefined ? { permission_sandboxes_create: Boolean(permission_sandboxes_create) } : {}),
        ...(permission_sandboxes_shared !== undefined ? { permission_sandboxes_shared: Boolean(permission_sandboxes_shared) } : {}),
        ...(permission_ehr_simulator !== undefined ? { permission_ehr_simulator: Boolean(permission_ehr_simulator) } : {}),
        ...(permission_data_manager !== undefined ? { permission_data_manager: Boolean(permission_data_manager) } : {}),
        ...(permission_applications_register !== undefined ? { permission_applications_register: Boolean(permission_applications_register) } : {}),
        ...(permission_package_import !== undefined ? { permission_package_import: Boolean(permission_package_import) } : {}),
        ...(permission_global_manage !== undefined ? { permission_global_manage: Boolean(permission_global_manage) } : {}),
      },
    });

    res.json({ role: updated });
  });

  router.delete('/api/administration/roles/:roleId', async (req: Request, res: Response): Promise<void> => {
    const { roleId } = req.params;
    await prisma.role.delete({ where: { id: roleId } });
    res.json({ message: 'Role deleted successfully.' });
  });

  // ==========================================
  // 5. APPOINTMENTS MANAGEMENT
  // ==========================================
  router.get('/api/administration/appointments', async (req: Request, res: Response): Promise<void> => {
    const appointments = await prisma.appointment.findMany({
      include: {
        role: true,
      },
      orderBy: { createdAt: 'desc' },
    });
    res.json({ appointments });
  });

  router.post('/api/administration/appointments', async (req: Request, res: Response): Promise<void> => {
    const { entityType, entityId, roleId } = req.body;
    if (!entityType || !entityId || !roleId) {
      res.status(400).json({ error: 'entityType, entityId, and roleId are required.' });
      return;
    }

    const typeEnum = entityType === 'Group' ? AppointmentEntityType.Group : AppointmentEntityType.User;

    const appointment = await prisma.appointment.upsert({
      where: {
        entityType_entityId_roleId: {
          entityType: typeEnum,
          entityId,
          roleId,
        },
      },
      create: {
        entityType: typeEnum,
        entityId,
        roleId,
      },
      update: {},
      include: { role: true },
    });

    res.status(201).json({ appointment });
  });

  router.delete('/api/administration/appointments/:appointmentId', async (req: Request, res: Response): Promise<void> => {
    const { appointmentId } = req.params;
    await prisma.appointment.delete({ where: { id: appointmentId } });
    res.json({ message: 'Appointment deleted successfully.' });
  });

  // ==========================================
  // 6. PERMANENT TENANT / SANDBOX PURGE
  // ==========================================
  router.get('/api/administration/sandboxes', async (req: Request, res: Response): Promise<void> => {
    const {
      search,
      user,
      fhirVersion,
      agePreset,
      lastUsedPreset,
      sortBy = 'createdAt',
      sortOrder = 'desc',
      page = 1,
      limit = 25,
    } = req.query;

    const pageNumber = Math.max(1, parseInt(String(page), 10) || 1);
    const limitNumber = Math.max(1, Math.min(100, parseInt(String(limit), 10) || 25));
    const skip = (pageNumber - 1) * limitNumber;

    const now = new Date();
    const daysAgo = (days: number) => new Date(now.getTime() - days * 24 * 60 * 60 * 1000);

    const andConditions: Prisma.SandboxWhereInput[] = [];

    // Search filter (name, sandboxId, description)
    if (search && String(search).trim().length > 0) {
      const q = String(search).trim();
      andConditions.push({
        OR: [
          { name: { contains: q, mode: 'insensitive' } },
          { sandboxId: { contains: q, mode: 'insensitive' } },
          { description: { contains: q, mode: 'insensitive' } },
        ],
      });
    }

    // User filter (creator displayName or email)
    if (user && String(user).trim().length > 0) {
      const u = String(user).trim();
      andConditions.push({
        createdByUser: {
          OR: [
            { displayName: { contains: u, mode: 'insensitive' } },
            { email: { contains: u, mode: 'insensitive' } },
          ],
        },
      });
    }

    // FHIR Version filter
    if (fhirVersion && fhirVersion !== 'all') {
      andConditions.push({ fhirVersion: String(fhirVersion) });
    }

    // Age Preset filter
    if (agePreset && agePreset !== 'all') {
      switch (agePreset) {
        case '7d':
          andConditions.push({ createdAt: { gte: daysAgo(7) } });
          break;
        case '30d':
          andConditions.push({ createdAt: { gte: daysAgo(30) } });
          break;
        case '90d':
          andConditions.push({ createdAt: { gte: daysAgo(90) } });
          break;
        case '180d':
          andConditions.push({ createdAt: { gte: daysAgo(180) } });
          break;
        case '365d':
          andConditions.push({ createdAt: { gte: daysAgo(365) } });
          break;
        case 'older_than_30d':
          andConditions.push({ createdAt: { lt: daysAgo(30) } });
          break;
        case 'older_than_90d':
          andConditions.push({ createdAt: { lt: daysAgo(90) } });
          break;
        case 'older_than_180d':
          andConditions.push({ createdAt: { lt: daysAgo(180) } });
          break;
        case 'older_than_365d':
          andConditions.push({ createdAt: { lt: daysAgo(365) } });
          break;
      }
    }

    // Last Used Preset filter
    if (lastUsedPreset && lastUsedPreset !== 'all') {
      switch (lastUsedPreset) {
        case 'never':
          andConditions.push({ lastAccessedAt: null });
          break;
        case 'active_7d':
          andConditions.push({ lastAccessedAt: { gte: daysAgo(7) } });
          break;
        case 'active_30d':
          andConditions.push({ lastAccessedAt: { gte: daysAgo(30) } });
          break;
        case 'inactive_30d':
          andConditions.push({
            OR: [{ lastAccessedAt: { lt: daysAgo(30) } }, { lastAccessedAt: null }],
          });
          break;
        case 'inactive_90d':
          andConditions.push({
            OR: [{ lastAccessedAt: { lt: daysAgo(90) } }, { lastAccessedAt: null }],
          });
          break;
        case 'inactive_180d':
          andConditions.push({
            OR: [{ lastAccessedAt: { lt: daysAgo(180) } }, { lastAccessedAt: null }],
          });
          break;
        case 'inactive_365d':
          andConditions.push({
            OR: [{ lastAccessedAt: { lt: daysAgo(365) } }, { lastAccessedAt: null }],
          });
          break;
      }
    }

    const where: Prisma.SandboxWhereInput = andConditions.length > 0 ? { AND: andConditions } : {};

    // Sort order
    const direction: 'asc' | 'desc' = String(sortOrder).toLowerCase() === 'asc' ? 'asc' : 'desc';
    let orderBy: Prisma.SandboxOrderByWithRelationInput = { createdAt: direction };

    switch (sortBy) {
      case 'name':
        orderBy = { name: direction };
        break;
      case 'sandboxId':
        orderBy = { sandboxId: direction };
        break;
      case 'fhirVersion':
        orderBy = { fhirVersion: direction };
        break;
      case 'partitionId':
        orderBy = { partitionId: direction };
        break;
      case 'lastAccessedAt':
        orderBy = { lastAccessedAt: direction };
        break;
      case 'createdBy':
        orderBy = { createdByUser: { displayName: direction } };
        break;
      case 'createdAt':
      default:
        orderBy = { createdAt: direction };
        break;
    }

    const [total, sandboxes] = await Promise.all([
      prisma.sandbox.count({ where }),
      prisma.sandbox.findMany({
        where,
        include: {
          createdByUser: {
            select: { id: true, email: true, displayName: true },
          },
        },
        orderBy,
        skip,
        take: limitNumber,
      }),
    ]);

    const totalPages = Math.ceil(total / limitNumber) || 1;

    res.json({
      sandboxes,
      total,
      page: pageNumber,
      limit: limitNumber,
      totalPages,
    });
  });

  router.delete('/api/administration/sandboxes/:sandboxId/purge', async (req: Request, res: Response): Promise<void> => {
    const { sandboxId } = req.params;
    const sandbox = await prisma.sandbox.findUnique({ where: { sandboxId } });

    if (!sandbox) {
      res.status(404).json({ error: 'Sandbox not found.' });
      return;
    }

    const jobService = new JobService(prisma);
    const existing = await prisma.job.findFirst({
      where: {
        jobType: 'SANDBOX_PURGE',
        status: { in: ['queued', 'in_progress'] },
        sandboxId: sandbox.id,
      },
      orderBy: { createdAt: 'desc' },
    });

    if (existing) {
      res.status(202).json({
        message: `Sandbox '${sandbox.sandboxId}' purge is already in progress and may take a while to complete.`,
        job: existing,
      });
      return;
    }

    const job = await jobService.enqueueJob(
      {
        name: `Admin purge sandbox '${sandbox.name}'`,
        jobType: 'SANDBOX_PURGE',
        sandboxId: sandbox.id,
        input: {
          sandboxId: sandbox.sandboxId,
          partitionId: sandbox.partitionId,
          fhirVersion: sandbox.fhirVersion,
        },
      },
      req.sessionAuth?.userId,
    );

    res.status(202).json({
      message: `Sandbox '${sandbox.sandboxId}' and its HAPI FHIR partition will be purged asynchronously. It may not disappear immediately.`,
      job,
    });
  });

  // ==========================================
  // 7. IMPLEMENTATION GUIDES MANAGEMENT
  // ==========================================
  router.get('/api/administration/implementation-guides', async (req: Request, res: Response): Promise<void> => {
    const { search, category, fhirVersion } = req.query;

    const where: Prisma.ImplementationGuideWhereInput = {};

    if (search && String(search).trim()) {
      const q = String(search).trim();
      where.OR = [
        { packageId: { contains: q, mode: 'insensitive' } },
        { title: { contains: q, mode: 'insensitive' } },
        { description: { contains: q, mode: 'insensitive' } },
        { author: { contains: q, mode: 'insensitive' } },
      ];
    }

    if (category && String(category) !== 'all') {
      where.category = String(category).toUpperCase();
    }

    if (fhirVersion && String(fhirVersion) !== 'all') {
      where.fhirVersion = String(fhirVersion);
    }

    const implementationGuides = await prisma.implementationGuide.findMany({
      where,
      orderBy: [{ title: 'asc' }],
    });

    res.json({ implementationGuides });
  });

  router.post('/api/administration/implementation-guides', async (req: Request, res: Response): Promise<void> => {
    const {
      packageId,
      version,
      title,
      description,
      fhirVersion = '4.0.1',
      category = 'General',
      canonicalUrl,
      url,
      isSuggested = true,
      author,
      dependencies = {},
      tarballUrl,
    } = req.body;

    if (!packageId || !version || !title) {
      res.status(400).json({ error: 'packageId, version, and title are required.' });
      return;
    }

    const cleanPackageId = packageId.trim().toLowerCase();
    const cleanVersion = version.trim();

    const existing = await prisma.implementationGuide.findUnique({
      where: {
        packageId_version: {
          packageId: cleanPackageId,
          version: cleanVersion,
        },
      },
    });

    if (existing) {
      res.status(409).json({ error: `Implementation Guide '${cleanPackageId}@${cleanVersion}' already exists.` });
      return;
    }

    const created = await prisma.implementationGuide.create({
      data: {
        packageId: cleanPackageId,
        version: cleanVersion,
        title: title.trim(),
        description: description?.trim() || null,
        fhirVersion: fhirVersion.trim(),
        category: category.trim().toUpperCase(),
        canonicalUrl: canonicalUrl?.trim() || null,
        url: url?.trim() || null,
        isSuggested: Boolean(isSuggested),
        author: author?.trim() || null,
        dependencies: dependencies || {},
        tarballUrl: tarballUrl?.trim() || null,
      },
    });

    res.status(201).json({ implementationGuide: created });
  });

  router.put('/api/administration/implementation-guides/:id', async (req: Request, res: Response): Promise<void> => {
    const { id } = req.params;
    const {
      packageId,
      version,
      title,
      description,
      fhirVersion,
      category,
      canonicalUrl,
      url,
      isSuggested,
      author,
      dependencies,
      tarballUrl,
    } = req.body;

    const ig = await prisma.implementationGuide.findUnique({ where: { id } });
    if (!ig) {
      res.status(404).json({ error: `Implementation Guide with ID '${id}' not found.` });
      return;
    }

    const updated = await prisma.implementationGuide.update({
      where: { id },
      data: {
        ...(packageId !== undefined ? { packageId: packageId.trim().toLowerCase() } : {}),
        ...(version !== undefined ? { version: version.trim() } : {}),
        ...(title !== undefined ? { title: title.trim() } : {}),
        ...(description !== undefined ? { description: description?.trim() || null } : {}),
        ...(fhirVersion !== undefined ? { fhirVersion: fhirVersion.trim() } : {}),
        ...(category !== undefined ? { category: category.trim().toUpperCase() } : {}),
        ...(canonicalUrl !== undefined ? { canonicalUrl: canonicalUrl?.trim() || null } : {}),
        ...(url !== undefined ? { url: url?.trim() || null } : {}),
        ...(isSuggested !== undefined ? { isSuggested: Boolean(isSuggested) } : {}),
        ...(author !== undefined ? { author: author?.trim() || null } : {}),
        ...(dependencies !== undefined ? { dependencies } : {}),
        ...(tarballUrl !== undefined ? { tarballUrl: tarballUrl?.trim() || null } : {}),
      },
    });

    res.json({ implementationGuide: updated });
  });

  router.delete('/api/administration/implementation-guides/:id', async (req: Request, res: Response): Promise<void> => {
    const { id } = req.params;
    const ig = await prisma.implementationGuide.findUnique({ where: { id } });
    if (!ig) {
      res.status(404).json({ error: `Implementation Guide with ID '${id}' not found.` });
      return;
    }

    await prisma.implementationGuide.delete({ where: { id } });
    res.json({ message: `Implementation Guide '${ig.packageId}@${ig.version}' deleted successfully.` });
  });

  /**
   * Enqueue PACKAGE_IMPORT jobs targeting the shared DEFAULT partition for each
   * selected enabled HAPI FHIR release.
   */
  async function enqueueDefaultIgInstallJobs(options: {
    packageName: string;
    packageVersion: string;
    tarballUrl?: string | null;
    fhirVersions: unknown;
    excludeExamples?: boolean;
    userId?: string;
  }): Promise<{ jobs: Awaited<ReturnType<JobService['enqueueJob']>>[]; fhirVersions: FhirRelease[] }> {
    const { packageName, packageVersion, tarballUrl, excludeExamples = true, userId } = options;

    if (!Array.isArray(options.fhirVersions) || options.fhirVersions.length === 0) {
      throw Object.assign(new Error('fhirVersions must be a non-empty array of enabled FHIR releases.'), {
        status: 400,
      });
    }

    const releases: FhirRelease[] = [];
    for (const value of options.fhirVersions) {
      try {
        releases.push(assertFhirReleaseEnabled(value));
      } catch (err: unknown) {
        throw Object.assign(
          new Error(err instanceof Error ? err.message : `Invalid FHIR version '${String(value)}'.`),
          { status: 400 },
        );
      }
    }

    const uniqueReleases = [...new Set(releases)];
    const jobService = new JobService(prisma);
    const jobs = [];

    for (const fhirVersion of uniqueReleases) {
      const job = await jobService.enqueueJob(
        {
          name: `Install ${packageName}#${packageVersion} to ${fhirVersion} DEFAULT`,
          jobType: 'PACKAGE_IMPORT',
          input: {
            packageName,
            packageVersion,
            tarballUrl: tarballUrl || undefined,
            target: 'DEFAULT',
            fhirVersion,
            excludeExamples: Boolean(excludeExamples),
          },
        },
        userId,
      );
      jobs.push(job);
    }

    return { jobs, fhirVersions: uniqueReleases };
  }

  router.post('/api/administration/implementation-guides/install', async (req: Request, res: Response): Promise<void> => {
    const { packageName, packageVersion, tarballUrl, fhirVersions, excludeExamples = true } = req.body || {};

    if (!packageName || !packageVersion) {
      res.status(400).json({ error: 'packageName and packageVersion are required.' });
      return;
    }

    try {
      const { jobs, fhirVersions: releases } = await enqueueDefaultIgInstallJobs({
        packageName: String(packageName).trim(),
        packageVersion: String(packageVersion).trim(),
        tarballUrl: tarballUrl ? String(tarballUrl).trim() : null,
        fhirVersions,
        excludeExamples,
        userId: req.sessionAuth?.userId,
      });
      res.status(202).json({
        message: `Queued ${jobs.length} install job(s) to DEFAULT for ${releases.join(', ')}.`,
        jobs,
        fhirVersions: releases,
      });
    } catch (err: unknown) {
      const status = (err as { status?: number }).status || 500;
      res.status(status).json({
        error: err instanceof Error ? err.message : 'Failed to enqueue install jobs.',
      });
    }
  });

  router.post('/api/administration/implementation-guides/:id/install', async (req: Request, res: Response): Promise<void> => {
    const { id } = req.params;
    const { fhirVersions, excludeExamples = true } = req.body || {};

    const ig = await prisma.implementationGuide.findUnique({ where: { id } });
    if (!ig) {
      res.status(404).json({ error: `Implementation Guide with ID '${id}' not found.` });
      return;
    }

    try {
      const { jobs, fhirVersions: releases } = await enqueueDefaultIgInstallJobs({
        packageName: ig.packageId,
        packageVersion: ig.version,
        tarballUrl: ig.tarballUrl,
        fhirVersions,
        excludeExamples,
        userId: req.sessionAuth?.userId,
      });
      res.status(202).json({
        message: `Queued ${jobs.length} install job(s) for ${ig.packageId}#${ig.version} to DEFAULT (${releases.join(', ')}).`,
        implementationGuide: ig,
        jobs,
        fhirVersions: releases,
      });
    } catch (err: unknown) {
      const status = (err as { status?: number }).status || 500;
      res.status(status).json({
        error: err instanceof Error ? err.message : 'Failed to enqueue install jobs.',
      });
    }
  });

  router.post('/api/administration/implementation-guides/fetch-metadata', async (req: Request, res: Response): Promise<void> => {
    const { packageId, version } = req.body;

    if (!packageId) {
      res.status(400).json({ error: 'packageId is required.' });
      return;
    }

    try {
      const cleanPkg = packageId.trim().toLowerCase();
      const url = version
        ? `https://packages.fhir.org/${cleanPkg}/${version.trim()}`
        : `https://packages.fhir.org/${cleanPkg}`;

      const resp = await axios.get(url, {
        timeout: 10_000,
        headers: { Accept: 'application/json' },
      });

      const data = resp.data;
      const latestVer = data['dist-tags']?.latest || Object.keys(data.versions || {})[0] || version || 'current';
      const versionData = data.versions ? data.versions[latestVer] || Object.values(data.versions)[0] : data;

      res.json({
        metadata: {
          packageId: cleanPkg,
          version: versionData?.version || latestVer,
          title: versionData?.title || data.title || cleanPkg,
          description: versionData?.description || data.description || '',
          fhirVersion: versionData?.fhirVersion || (Array.isArray(data.fhirVersions) ? data.fhirVersions[0] : '4.0.1'),
          canonicalUrl: versionData?.canonical || data.canonical || '',
          url: versionData?.url || data.url || `https://packages.fhir.org/${cleanPkg}`,
          author: versionData?.author || data.author || '',
          dependencies: versionData?.dependencies || data.dependencies || {},
        },
      });
    } catch (err: any) {
      res.status(502).json({
        error: `Failed to fetch metadata from packages.fhir.org: ${err?.message}`,
      });
    }
  });

  return router;
}
