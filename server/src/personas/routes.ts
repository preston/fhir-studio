// Author: Preston Lee

import express, { type Request, type Response, type Router } from 'express';
import { getPrisma } from '../db/prisma.js';

export function createPersonasRouter(): Router {
  const router = express.Router();
  const prisma = getPrisma();

  // 1. GET /api/sandboxes/:sandboxId/personas
  router.get('/api/sandboxes/:sandboxId/personas', async (req: Request, res: Response): Promise<void> => {
    const sandboxId = req.params.sandboxId;
    const sandbox = await prisma.sandbox.findUnique({ where: { sandboxId } });

    if (!sandbox) {
      res.status(404).json({ error: 'Sandbox not found.' });
      return;
    }

    const personas = await prisma.userPersona.findMany({
      where: { sandboxId: sandbox.id },
      orderBy: { personaName: 'asc' },
    });

    res.json({ personas });
  });

  // 2. POST /api/sandboxes/:sandboxId/personas
  router.post('/api/sandboxes/:sandboxId/personas', async (req: Request, res: Response): Promise<void> => {
    const sandboxId = req.params.sandboxId;
    const {
      personaUserId,
      personaName,
      fhirResourceType = 'Practitioner',
      fhirResourceId,
      fhirResourceName,
    } = req.body;

    if (!personaUserId || !personaName || !fhirResourceId) {
      res.status(400).json({ error: 'personaUserId, personaName, and fhirResourceId are required.' });
      return;
    }

    const sandbox = await prisma.sandbox.findUnique({ where: { sandboxId } });
    if (!sandbox) {
      res.status(404).json({ error: 'Sandbox not found.' });
      return;
    }

    const created = await prisma.userPersona.create({
      data: {
        sandboxId: sandbox.id,
        personaUserId,
        personaName,
        fhirResourceType,
        fhirResourceId,
        fhirResourceName: fhirResourceName || personaName,
        createdByUserId: req.sessionAuth?.userId || null,
      },
    });

    res.status(201).json({ persona: created });
  });

  // 3. PUT /api/sandboxes/:sandboxId/personas/:personaId
  router.put('/api/sandboxes/:sandboxId/personas/:personaId', async (req: Request, res: Response): Promise<void> => {
    const { personaId } = req.params;
    const { personaName, fhirResourceType, fhirResourceId, fhirResourceName } = req.body;

    const updated = await prisma.userPersona.update({
      where: { id: personaId },
      data: {
        ...(personaName !== undefined ? { personaName } : {}),
        ...(fhirResourceType !== undefined ? { fhirResourceType } : {}),
        ...(fhirResourceId !== undefined ? { fhirResourceId } : {}),
        ...(fhirResourceName !== undefined ? { fhirResourceName } : {}),
      },
    });

    res.json({ persona: updated });
  });

  // 4. DELETE /api/sandboxes/:sandboxId/personas/:personaId
  router.delete('/api/sandboxes/:sandboxId/personas/:personaId', async (req: Request, res: Response): Promise<void> => {
    const { personaId } = req.params;
    await prisma.userPersona.delete({ where: { id: personaId } });
    res.json({ message: 'User persona deleted successfully.' });
  });

  return router;
}
