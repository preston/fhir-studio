// Author: Preston Lee

import express, { type Request, type Response, type Router } from 'express';
import { getPrisma } from '../db/prisma.js';

export function createScenariosRouter(): Router {
  const router = express.Router();
  const prisma = getPrisma();

  // 1. GET /api/sandboxes/:sandboxId/scenarios
  router.get('/api/sandboxes/:sandboxId/scenarios', async (req: Request, res: Response): Promise<void> => {
    const sandboxId = req.params.sandboxId;
    const sandbox = await prisma.sandbox.findUnique({ where: { sandboxId } });

    if (!sandbox) {
      res.status(404).json({ error: 'Sandbox not found.' });
      return;
    }

    const scenarios = await prisma.launchScenario.findMany({
      where: { sandboxId: sandbox.id },
      include: {
        application: true,
        userPersona: true,
      },
      orderBy: { updatedAt: 'desc' },
    });

    res.json({ scenarios });
  });

  // 2. POST /api/sandboxes/:sandboxId/scenarios
  router.post('/api/sandboxes/:sandboxId/scenarios', async (req: Request, res: Response): Promise<void> => {
    const sandboxId = req.params.sandboxId;
    const {
      title,
      description,
      applicationId,
      userPersonaId,
      patientFhirId,
      patientName,
      encounterFhirId,
      locationFhirId,
      intent,
      smartStyleUrl,
      needPatientBanner = true,
      contextParams = {},
    } = req.body;

    if (!title) {
      res.status(400).json({ error: 'title is required.' });
      return;
    }

    const sandbox = await prisma.sandbox.findUnique({ where: { sandboxId } });
    if (!sandbox) {
      res.status(404).json({ error: 'Sandbox not found.' });
      return;
    }

    const scenario = await prisma.launchScenario.create({
      data: {
        sandboxId: sandbox.id,
        title,
        description: description || null,
        applicationId: applicationId || null,
        userPersonaId: userPersonaId || null,
        patientFhirId: patientFhirId || null,
        patientName: patientName || null,
        encounterFhirId: encounterFhirId || null,
        locationFhirId: locationFhirId || null,
        intent: intent || null,
        smartStyleUrl: smartStyleUrl || null,
        needPatientBanner: Boolean(needPatientBanner),
        contextParams: typeof contextParams === 'object' ? contextParams : {},
        createdByUserId: req.sessionAuth?.userId || null,
      },
      include: {
        application: true,
        userPersona: true,
      },
    });

    res.status(201).json({ scenario });
  });

  // 3. PUT /api/sandboxes/:sandboxId/scenarios/:scenarioId
  router.put('/api/sandboxes/:sandboxId/scenarios/:scenarioId', async (req: Request, res: Response): Promise<void> => {
    const { scenarioId } = req.params;
    const {
      title,
      description,
      applicationId,
      userPersonaId,
      patientFhirId,
      patientName,
      encounterFhirId,
      locationFhirId,
      intent,
      smartStyleUrl,
      needPatientBanner,
      contextParams,
    } = req.body;

    const updated = await prisma.launchScenario.update({
      where: { id: scenarioId },
      data: {
        ...(title !== undefined ? { title } : {}),
        ...(description !== undefined ? { description } : {}),
        ...(applicationId !== undefined ? { applicationId: applicationId || null } : {}),
        ...(userPersonaId !== undefined ? { userPersonaId: userPersonaId || null } : {}),
        ...(patientFhirId !== undefined ? { patientFhirId: patientFhirId || null } : {}),
        ...(patientName !== undefined ? { patientName: patientName || null } : {}),
        ...(encounterFhirId !== undefined ? { encounterFhirId: encounterFhirId || null } : {}),
        ...(locationFhirId !== undefined ? { locationFhirId: locationFhirId || null } : {}),
        ...(intent !== undefined ? { intent: intent || null } : {}),
        ...(smartStyleUrl !== undefined ? { smartStyleUrl: smartStyleUrl || null } : {}),
        ...(needPatientBanner !== undefined ? { needPatientBanner: Boolean(needPatientBanner) } : {}),
        ...(contextParams !== undefined ? { contextParams } : {}),
      },
      include: {
        application: true,
        userPersona: true,
      },
    });

    res.json({ scenario: updated });
  });

  // 4. DELETE /api/sandboxes/:sandboxId/scenarios/:scenarioId
  router.delete('/api/sandboxes/:sandboxId/scenarios/:scenarioId', async (req: Request, res: Response): Promise<void> => {
    const { scenarioId } = req.params;
    await prisma.launchScenario.delete({ where: { id: scenarioId } });
    res.json({ message: 'Launch scenario deleted successfully.' });
  });

  return router;
}
