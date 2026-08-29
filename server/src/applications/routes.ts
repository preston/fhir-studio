// Author: Preston Lee

import express, { type Request, type Response, type Router } from 'express';
import { v4 as uuidv4 } from 'uuid';
import { getPrisma } from '../db/prisma.js';
import { requirePermission } from '../authorization/requirePermission.js';

export function createApplicationsRouter(): Router {
  const router = express.Router();
  const prisma = getPrisma();

  // 1. GET /api/applications (Global & sample applications)
  router.get('/api/applications', async (req: Request, res: Response): Promise<void> => {
    const applications = await prisma.application.findMany({
      where: { sandboxId: null },
      orderBy: { clientName: 'asc' },
    });
    res.json({ applications });
  });

  // 2. GET /api/sandboxes/:sandboxId/applications (Sandbox custom applications + sample applications)
  router.get('/api/sandboxes/:sandboxId/applications', async (req: Request, res: Response): Promise<void> => {
    const sandboxId = req.params.sandboxId;
    const sandbox = await prisma.sandbox.findUnique({ where: { sandboxId } });

    const applications = await prisma.application.findMany({
      where: {
        OR: [
          { sandboxId: sandbox ? sandbox.id : undefined },
          { isSample: true },
        ],
      },
      orderBy: { clientName: 'asc' },
    });

    res.json({ applications });
  });

  // 3. POST /api/sandboxes/:sandboxId/applications (Register new SMART Application)
  router.post(
    '/api/sandboxes/:sandboxId/applications',
    requirePermission('applications_register'),
    async (req: Request, res: Response): Promise<void> => {
      const sandboxId = req.params.sandboxId;
      const {
        clientName,
        launchUri,
        redirectUris = [],
        scope = 'patient/*.read openid profile launch/patient',
        briefDescription,
        author,
        clientUri,
        logoUri,
        isCustom = true,
      } = req.body;

      if (!clientName || !launchUri) {
        res.status(400).json({ error: 'clientName and launchUri are required.' });
        return;
      }

      const sandbox = await prisma.sandbox.findUnique({ where: { sandboxId } });
      if (!sandbox) {
        res.status(404).json({ error: 'Sandbox not found.' });
        return;
      }

      const clientId = `application-${uuidv4().slice(0, 8)}`;
      const clientSecret = uuidv4();

      const created = await prisma.application.create({
        data: {
          sandboxId: sandbox.id,
          clientId,
          clientSecret,
          clientName,
          launchUri,
          redirectUris: Array.isArray(redirectUris) ? redirectUris : [redirectUris],
          scope,
          briefDescription: briefDescription || null,
          author: author || null,
          clientUri: clientUri || null,
          logoUri: logoUri || null,
          isCustom: Boolean(isCustom),
          isSample: false,
          createdByUserId: req.sessionAuth?.userId || null,
        },
      });

      res.status(201).json({ application: created });
    },
  );

  // 4. PUT /api/sandboxes/:sandboxId/applications/:applicationId
  router.put('/api/sandboxes/:sandboxId/applications/:applicationId', async (req: Request, res: Response): Promise<void> => {
    const { applicationId } = req.params;
    const existing = await prisma.application.findUnique({ where: { id: applicationId } });
    if (!existing) {
      res.status(404).json({ error: 'Application not found.' });
      return;
    }
    if (existing.isSample || existing.clientId === 'example-application' || existing.clientId === 'example-app') {
      res.status(403).json({ error: 'Built-in and sample applications cannot be modified.' });
      return;
    }

    const {
      clientName,
      launchUri,
      redirectUris,
      scope,
      briefDescription,
      author,
      clientUri,
      logoUri,
    } = req.body;

    const updated = await prisma.application.update({
      where: { id: applicationId },
      data: {
        ...(clientName !== undefined ? { clientName } : {}),
        ...(launchUri !== undefined ? { launchUri } : {}),
        ...(redirectUris !== undefined ? { redirectUris: Array.isArray(redirectUris) ? redirectUris : [redirectUris] } : {}),
        ...(scope !== undefined ? { scope } : {}),
        ...(briefDescription !== undefined ? { briefDescription } : {}),
        ...(author !== undefined ? { author } : {}),
        ...(clientUri !== undefined ? { clientUri } : {}),
        ...(logoUri !== undefined ? { logoUri } : {}),
      },
    });

    res.json({ application: updated });
  });

  // 5. DELETE /api/sandboxes/:sandboxId/applications/:applicationId
  router.delete('/api/sandboxes/:sandboxId/applications/:applicationId', async (req: Request, res: Response): Promise<void> => {
    const { applicationId } = req.params;
    const existing = await prisma.application.findUnique({ where: { id: applicationId } });
    if (!existing) {
      res.status(404).json({ error: 'Application not found.' });
      return;
    }
    if (existing.isSample || existing.clientId === 'example-application' || existing.clientId === 'example-app') {
      res.status(403).json({ error: 'Built-in and sample applications cannot be deleted.' });
      return;
    }

    await prisma.application.delete({ where: { id: applicationId } });
    res.json({ message: 'Application deleted successfully.' });
  });

  return router;
}
