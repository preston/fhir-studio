// Author: Preston Lee

import express, { type Request, type Response, type Router } from 'express';
import { getPrisma } from '../db/prisma.js';
import { HapiPartitionClient } from '../hapi/partition_client.js';
import { requirePermission } from '../authorization/requirePermission.js';
import { hasPermission } from '../authorization/permissions.js';
import { JobService } from '../jobs/service.js';

const RESERVED_SLUGS = new Set([
  'check-availability',
  'access',
  'default',
  'system',
  'admin',
  'api',
  'fhir',
  'undefined',
  'null',
  'new',
  'create',
  'search',
]);

export function sanitizeSlug(input: string): string {
  return String(input || '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9-]/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-+|-+$/g, '');
}

export function createSandboxesRouter(): Router {
  const router = express.Router();
  const prisma = getPrisma();
  const hapiClient = new HapiPartitionClient();

  // 1. GET /api/sandboxes (List accessible sandboxes)
  router.get('/api/sandboxes', async (req: Request, res: Response): Promise<void> => {
    const userId = req.sessionAuth?.userId;
    const isGlobalAdmin = hasPermission(req.effectivePermissions, 'global_manage');

    if (isGlobalAdmin) {
      const allSandboxes = await prisma.sandbox.findMany({
        include: {
          createdByUser: {
            select: { id: true, email: true, displayName: true },
          },
          collaborators: {
            include: { user: { select: { id: true, email: true, displayName: true } } },
          },
          _count: {
            select: { applications: true, launchScenarios: true, personas: true },
          },
        },
        orderBy: { updatedAt: 'desc' },
      });
      res.json({ sandboxes: allSandboxes });
      return;
    }

    if (!userId) {
      // Unauthenticated / public list: only public sandboxes
      const publicSandboxes = await prisma.sandbox.findMany({
        where: { visibility: 'PUBLIC' },
        include: {
          createdByUser: { select: { id: true, email: true, displayName: true } },
          _count: { select: { applications: true, launchScenarios: true, personas: true } },
        },
        orderBy: { updatedAt: 'desc' },
      });
      res.json({ sandboxes: publicSandboxes });
      return;
    }

    const sandboxes = await prisma.sandbox.findMany({
      where: {
        OR: [
          { createdByUserId: userId },
          { collaborators: { some: { userId } } },
          { visibility: 'PUBLIC' },
        ],
      },
      include: {
        createdByUser: {
          select: { id: true, email: true, displayName: true },
        },
        collaborators: {
          include: { user: { select: { id: true, email: true, displayName: true } } },
        },
        _count: {
          select: { applications: true, launchScenarios: true, personas: true },
        },
      },
      orderBy: { updatedAt: 'desc' },
    });

    res.json({ sandboxes });
  });

  // 1b. GET /api/sandboxes/check-availability (Check if sandboxId slug is available)
  router.get('/api/sandboxes/check-availability', async (req: Request, res: Response): Promise<void> => {
    const raw = String(req.query.slug || req.query.sandboxId || '');
    const cleanSlug = sanitizeSlug(raw);

    if (!cleanSlug) {
      res.json({
        available: false,
        slug: cleanSlug,
        reason: 'Sandbox ID cannot be empty.',
      });
      return;
    }

    if (cleanSlug.length < 2) {
      res.json({
        available: false,
        slug: cleanSlug,
        reason: 'Sandbox ID must be at least 2 characters long.',
      });
      return;
    }

    if (RESERVED_SLUGS.has(cleanSlug)) {
      res.json({
        available: false,
        slug: cleanSlug,
        reason: `'${cleanSlug}' is a reserved system identifier.`,
      });
      return;
    }

    const existing = await prisma.sandbox.findUnique({
      where: { sandboxId: cleanSlug },
      select: { id: true, sandboxId: true },
    });

    if (existing) {
      res.json({
        available: false,
        slug: cleanSlug,
        reason: `Sandbox ID '${cleanSlug}' is already in use.`,
      });
      return;
    }

    res.json({
      available: true,
      slug: cleanSlug,
    });
  });

  // 2. GET /api/sandboxes/:sandboxId (Sandbox details)
  router.get('/api/sandboxes/:sandboxId', async (req: Request, res: Response): Promise<void> => {
    const sandboxId = req.params.sandboxId;
    const sandbox = await prisma.sandbox.findUnique({
      where: { sandboxId },
      include: {
        createdByUser: {
          select: { id: true, email: true, displayName: true },
        },
        collaborators: {
          include: {
            user: {
              select: { id: true, email: true, displayName: true },
            },
          },
        },
        applications: true,
        launchScenarios: true,
        personas: true,
        cdsEndpoints: true,
      },
    });

    if (!sandbox) {
      res.status(404).json({ error: `Sandbox '${sandboxId}' not found.` });
      return;
    }

    // Record last UI access time asynchronously without blocking response
    prisma.sandbox
      .update({
        where: { id: sandbox.id },
        data: { lastAccessedAt: new Date() },
      })
      .catch(() => {});

    res.json({ sandbox });
  });

  // 2b. POST /api/sandboxes/:sandboxId/access (Explicit UI access tracking)
  router.post('/api/sandboxes/:sandboxId/access', async (req: Request, res: Response): Promise<void> => {
    const sandboxId = req.params.sandboxId;
    try {
      await prisma.sandbox.update({
        where: { sandboxId },
        data: { lastAccessedAt: new Date() },
      });
      res.json({ message: 'Access recorded.' });
    } catch {
      res.status(404).json({ error: `Sandbox '${sandboxId}' not found.` });
    }
  });

  // 3. POST /api/sandboxes (Create new Sandbox)
  router.post(
    '/api/sandboxes',
    requirePermission('sandboxes_create'),
    async (req: Request, res: Response): Promise<void> => {
      const {
        sandboxId,
        name,
        description,
        fhirVersion = 'R4',
        allowOpenAccess = false,
        visibility = 'PRIVATE',
        isShared = false,
        seedData = true,
        initialIgs = [],
      } = req.body;

      if (!sandboxId || !name) {
        res.status(400).json({ error: 'sandboxId and name are required.' });
        return;
      }

      const cleanSlug = sanitizeSlug(sandboxId);
      if (!cleanSlug || cleanSlug.length < 2) {
        res.status(400).json({ error: 'Sandbox ID must be at least 2 characters and contain valid URL characters.' });
        return;
      }

      if (RESERVED_SLUGS.has(cleanSlug)) {
        res.status(400).json({ error: `'${cleanSlug}' is a reserved system identifier.` });
        return;
      }

      if (isShared && !hasPermission(req.effectivePermissions, 'sandboxes_shared')) {
        res.status(403).json({ error: 'Permission denied: shared sandbox creation requires permission_sandboxes_shared.' });
        return;
      }

      const existing = await prisma.sandbox.findUnique({
        where: { sandboxId: cleanSlug },
      });

      if (existing) {
        res.status(409).json({ error: `Sandbox with ID '${cleanSlug}' already exists.` });
        return;
      }

      const normalizedVersion = (fhirVersion || 'R4').toUpperCase();
      const partitionId = await HapiPartitionClient.allocateNextPartitionId(prisma);

      // Create partition dynamically in HAPI JPA v8.10
      await hapiClient.createPartition(
        normalizedVersion,
        partitionId,
        cleanSlug,
        description || name,
      );

      const created = await prisma.sandbox.create({
        data: {
          sandboxId: cleanSlug,
          name,
          description: description || null,
          fhirVersion: normalizedVersion,
          partitionId,
          allowOpenAccess: Boolean(allowOpenAccess),
          visibility: visibility === 'PUBLIC' ? 'PUBLIC' : 'PRIVATE',
          isShared: Boolean(isShared),
          createdByUserId: req.sessionAuth!.userId,
        },
      });

      // Create default synthetic personas for the new sandbox
      const defaultPersonas = [
        {
          personaUserId: 'practitioner-1',
          personaName: 'Dr. Jane Smith, MD',
          fhirResourceType: 'Practitioner',
          fhirResourceId: 'dr-jane-smith',
          fhirResourceName: 'Jane Smith, MD',
        },
        {
          personaUserId: 'practitioner-2',
          personaName: 'Dr. John Miller, MD',
          fhirResourceType: 'Practitioner',
          fhirResourceId: 'dr-john-miller',
          fhirResourceName: 'John Miller, MD',
        },
      ];

      for (const p of defaultPersonas) {
        await prisma.userPersona.create({
          data: {
            sandboxId: created.id,
            personaUserId: p.personaUserId,
            personaName: p.personaName,
            fhirResourceType: p.fhirResourceType,
            fhirResourceId: p.fhirResourceId,
            fhirResourceName: p.fhirResourceName,
            createdByUserId: req.sessionAuth!.userId,
          },
        });
      }

      // If requested, asynchronously seed 4 diverse Synthea patient bundles and 4 launch scenarios
      if (Boolean(seedData)) {
        const jobService = new JobService(prisma);
        await jobService.enqueueJob(
          {
            name: `Initial Data Seeding for '${created.name}'`,
            jobType: 'SANDBOX_DATA_SEED',
            sandboxId: created.id,
            input: { sandboxId: created.sandboxId },
          },
          req.sessionAuth!.userId,
        );
      }

      // Asynchronously import any selected initial implementation guide packages
      if (Array.isArray(initialIgs) && initialIgs.length > 0) {
        const jobService = new JobService(prisma);
        for (const ig of initialIgs) {
          let pkgName = '';
          let pkgVer = '';
          if (typeof ig === 'string') {
            const parts = ig.split(/[@#]/);
            pkgName = parts[0]?.trim() || '';
            pkgVer = parts[1]?.trim() || '';
          } else if (ig && typeof ig === 'object') {
            pkgName = (ig.name || ig.packageId || '').trim();
            pkgVer = (ig.version || '').trim();
          }

          if (pkgName) {
            await jobService.enqueueJob(
              {
                name: `Import Implementation Guide ${pkgName}#${pkgVer || 'latest'} for '${created.name}'`,
                jobType: 'PACKAGE_IMPORT',
                sandboxId: created.id,
                input: {
                  packageName: pkgName,
                  packageVersion: pkgVer || 'latest',
                  sandboxId: created.sandboxId,
                },
              },
              req.sessionAuth!.userId,
            );
          }
        }
      }

      res.status(201).json({ sandbox: created });
    },
  );

  // 4. PUT /api/sandboxes/:sandboxId (Update sandbox settings)
  router.put('/api/sandboxes/:sandboxId', async (req: Request, res: Response): Promise<void> => {
    const sandboxId = req.params.sandboxId;
    const { name, description, allowOpenAccess, visibility, isShared } = req.body;

    const sandbox = await prisma.sandbox.findUnique({
      where: { sandboxId },
      include: { collaborators: true },
    });

    if (!sandbox) {
      res.status(404).json({ error: 'Sandbox not found.' });
      return;
    }

    const userId = req.sessionAuth?.userId;
    const isOwner = sandbox.createdByUserId === userId;
    const isGlobalAdmin = hasPermission(req.effectivePermissions, 'global_manage');
    const isCollaboratorAdmin = sandbox.collaborators.some(
      (c) => c.userId === userId && (c.role === 'OWNER' || c.role === 'MANAGE'),
    );

    if (!isOwner && !isGlobalAdmin && !isCollaboratorAdmin) {
      res.status(403).json({ error: 'Permission denied: cannot modify this sandbox.' });
      return;
    }

    const updated = await prisma.sandbox.update({
      where: { id: sandbox.id },
      data: {
        ...(name !== undefined ? { name } : {}),
        ...(description !== undefined ? { description } : {}),
        ...(allowOpenAccess !== undefined ? { allowOpenAccess: Boolean(allowOpenAccess) } : {}),
        ...(visibility !== undefined ? { visibility: visibility === 'PUBLIC' ? 'PUBLIC' : 'PRIVATE' } : {}),
        ...(isShared !== undefined ? { isShared: Boolean(isShared) } : {}),
      },
    });

    res.json({ sandbox: updated });
  });

  // 5. POST /api/sandboxes/:sandboxId/reset (Reset partition data)
  router.post('/api/sandboxes/:sandboxId/reset', async (req: Request, res: Response): Promise<void> => {
    const sandboxId = req.params.sandboxId;
    const sandbox = await prisma.sandbox.findUnique({ where: { sandboxId } });

    if (!sandbox) {
      res.status(404).json({ error: 'Sandbox not found.' });
      return;
    }

    const userId = req.sessionAuth?.userId;
    const isOwner = sandbox.createdByUserId === userId;
    const isGlobalAdmin = hasPermission(req.effectivePermissions, 'global_manage');

    if (!isOwner && !isGlobalAdmin) {
      res.status(403).json({ error: 'Permission denied: only owners or admins can reset a sandbox.' });
      return;
    }

    // Reset partition in HAPI JPA
    await hapiClient.deletePartition(sandbox.fhirVersion, sandbox.partitionId, sandbox.sandboxId);
    await hapiClient.createPartition(sandbox.fhirVersion, sandbox.partitionId, sandbox.sandboxId, sandbox.description || sandbox.name);

    res.json({ message: `Sandbox '${sandboxId}' FHIR partition successfully reset.` });
  });

  // 6. DELETE /api/sandboxes/:sandboxId (Delete sandbox)
  router.delete('/api/sandboxes/:sandboxId', async (req: Request, res: Response): Promise<void> => {
    const sandboxId = req.params.sandboxId;
    const sandbox = await prisma.sandbox.findUnique({ where: { sandboxId } });

    if (!sandbox) {
      res.status(404).json({ error: 'Sandbox not found.' });
      return;
    }

    const userId = req.sessionAuth?.userId;
    const isOwner = sandbox.createdByUserId === userId;
    const isGlobalAdmin = hasPermission(req.effectivePermissions, 'global_manage');

    if (!isOwner && !isGlobalAdmin) {
      res.status(403).json({ error: 'Permission denied: cannot delete sandbox.' });
      return;
    }

    // Delete HAPI partition
    await hapiClient.deletePartition(sandbox.fhirVersion, sandbox.partitionId, sandbox.sandboxId);

    // Delete from Postgres
    await prisma.sandbox.delete({ where: { id: sandbox.id } });

    res.json({ message: `Sandbox '${sandboxId}' deleted successfully.` });
  });

  // 7. Collaborators: POST /api/sandboxes/:sandboxId/collaborators
  router.post('/api/sandboxes/:sandboxId/collaborators', async (req: Request, res: Response): Promise<void> => {
    const sandboxId = req.params.sandboxId;
    const { email, role = 'READ_WRITE' } = req.body;

    if (!email) {
      res.status(400).json({ error: 'email is required.' });
      return;
    }

    const sandbox = await prisma.sandbox.findUnique({ where: { sandboxId } });
    if (!sandbox) {
      res.status(404).json({ error: 'Sandbox not found.' });
      return;
    }

    const targetUser = await prisma.user.findFirst({
      where: { email: { equals: email.trim(), mode: 'insensitive' } },
    });

    if (!targetUser) {
      res.status(404).json({ error: `User with email '${email}' not found.` });
      return;
    }

    const collaborator = await prisma.sandboxCollaborator.upsert({
      where: {
        sandboxId_userId: {
          sandboxId: sandbox.id,
          userId: targetUser.id,
        },
      },
      create: {
        sandboxId: sandbox.id,
        userId: targetUser.id,
        role,
      },
      update: {
        role,
      },
      include: {
        user: { select: { id: true, email: true, displayName: true } },
      },
    });

    res.status(201).json({ collaborator });
  });

  // 8. Collaborators: DELETE /api/sandboxes/:sandboxId/collaborators/:userId
  router.delete('/api/sandboxes/:sandboxId/collaborators/:userId', async (req: Request, res: Response): Promise<void> => {
    const { sandboxId, userId } = req.params;
    const sandbox = await prisma.sandbox.findUnique({ where: { sandboxId } });
    if (!sandbox) {
      res.status(404).json({ error: 'Sandbox not found.' });
      return;
    }

    await prisma.sandboxCollaborator.deleteMany({
      where: {
        sandboxId: sandbox.id,
        userId,
      },
    });

    res.json({ message: 'Collaborator removed successfully.' });
  });

  return router;
}
