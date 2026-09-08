// Author: Preston Lee

import express, { type Request, type Response, type Router } from 'express';
import axios from 'axios';
import { v4 as uuidv4 } from 'uuid';
import { getPrisma } from '../db/prisma.js';
import { HapiPartitionClient, isFhirReleaseEnabled } from '../hapi/partition_client.js';

export function createHooksRouter(): Router {
  const router = express.Router();
  const prisma = getPrisma();
  const hapiClient = new HapiPartitionClient();

  // 1. GET /api/sandboxes/:sandboxId/cds-services
  router.get('/api/sandboxes/:sandboxId/cds-services', async (req: Request, res: Response): Promise<void> => {
    const sandboxId = req.params.sandboxId;
    const sandbox = await prisma.sandbox.findUnique({ where: { sandboxId } });

    if (!sandbox || !isFhirReleaseEnabled(sandbox.fhirVersion)) {
      res.status(404).json({ error: 'Sandbox not found.' });
      return;
    }

    const endpoints = await prisma.cdsServiceEndpoint.findMany({
      where: { sandboxId: sandbox.id },
      orderBy: { name: 'asc' },
    });

    res.json({ endpoints });
  });

  // 2. POST /api/sandboxes/:sandboxId/cds-services (Register and discover services)
  router.post('/api/sandboxes/:sandboxId/cds-services', async (req: Request, res: Response): Promise<void> => {
    const sandboxId = req.params.sandboxId;
    const { name, url } = req.body;

    if (!name || !url) {
      res.status(400).json({ error: 'name and url are required.' });
      return;
    }

    const sandbox = await prisma.sandbox.findUnique({ where: { sandboxId } });
    if (!sandbox || !isFhirReleaseEnabled(sandbox.fhirVersion)) {
      res.status(404).json({ error: 'Sandbox not found.' });
      return;
    }

    // Attempt discovery
    let servicesJson: any[] = [];
    try {
      const discoveryUrl = url.endsWith('/cds-services') ? url : `${url.replace(/\/+$/, '')}/cds-services`;
      const discoveryResp = await axios.get(discoveryUrl, { timeout: 8000 });
      if (Array.isArray(discoveryResp.data?.services)) {
        servicesJson = discoveryResp.data.services;
      }
    } catch (err: any) {
      console.warn(`CDS Discovery failed for ${url}:`, err.message);
    }

    const created = await prisma.cdsServiceEndpoint.create({
      data: {
        sandboxId: sandbox.id,
        name,
        url,
        servicesJson,
      },
    });

    res.status(201).json({ endpoint: created });
  });

  // 3. DELETE /api/sandboxes/:sandboxId/cds-services/:id
  router.delete('/api/sandboxes/:sandboxId/cds-services/:id', async (req: Request, res: Response): Promise<void> => {
    const { id } = req.params;
    await prisma.cdsServiceEndpoint.delete({ where: { id } });
    res.json({ message: 'CDS Service endpoint deleted.' });
  });

  // 4. POST /api/sandboxes/:sandboxId/cds-services/proxy (Invoke CDS Hook & Resolve Prefetch)
  router.post('/api/sandboxes/:sandboxId/cds-services/proxy', async (req: Request, res: Response): Promise<void> => {
    const sandboxId = req.params.sandboxId;
    const { serviceUrl, hook = 'patient-view', hookInstance, context = {}, prefetch = {}, prefetchTemplates } = req.body;

    if (!serviceUrl) {
      res.status(400).json({ error: 'serviceUrl is required.' });
      return;
    }

    const sandbox = await prisma.sandbox.findUnique({ where: { sandboxId } });
    if (!sandbox || !isFhirReleaseEnabled(sandbox.fhirVersion)) {
      res.status(404).json({ error: 'Sandbox not found.' });
      return;
    }

    const host = req.get('host') || 'localhost:3000';
    const protocol = req.protocol || 'http';
    const versionPath = sandbox.fhirVersion.toLowerCase();
    const fhirServer = `${protocol}://${host}/api/sandboxes/${sandboxId}/fhir/${versionPath}`;
    const hapiBaseUrl = hapiClient.getHapiBaseUrl(sandbox.fhirVersion);
    const tenantUrl = `${hapiBaseUrl}/${sandbox.sandboxId}`;

    // Resolve prefetch templates dynamically if template map is passed
    const resolvedPrefetch: Record<string, any> = { ...prefetch };
    if (prefetchTemplates && typeof prefetchTemplates === 'object') {
      const entries = Object.entries(prefetchTemplates as Record<string, string>);
      await Promise.all(
        entries.map(async ([key, queryTemplate]) => {
          if (resolvedPrefetch[key]) return; // already populated

          // Substitute context variables e.g. {{context.patientId}}
          let query = queryTemplate.replace(/\{\{\s*context\.([a-zA-Z0-9_-]+)\s*\}\}/g, (_, varName) => {
            return context[varName] || context[varName.replace('Id', '')] || '';
          });

          if (!query || query.includes('{{')) return;

          try {
            const resp = await axios.get(`${tenantUrl}/${query.replace(/^\/+/, '')}`, {
              headers: { Accept: 'application/fhir+json' },
              timeout: 5000,
            });
            resolvedPrefetch[key] = resp.data;
          } catch (err: any) {
            console.warn(`Prefetch query '${query}' failed:`, err.message);
          }
        }),
      );
    }

    const requestPayload = {
      hook,
      hookInstance: hookInstance || uuidv4(),
      fhirServer,
      context,
      prefetch: resolvedPrefetch,
    };

    try {
      const resp = await axios.post(serviceUrl, requestPayload, {
        headers: { 'Content-Type': 'application/json' },
        timeout: 10_000,
      });

      const responseData = resp.data || {};
      const cards = Array.isArray(responseData.cards) ? responseData.cards : [];

      // Transform SMART launch links if cards have link.type === 'smart'
      for (const card of cards) {
        if (Array.isArray(card.links)) {
          for (const link of card.links) {
            if (link.type === 'smart' && link.url) {
              const launchId = uuidv4();
              await prisma.smartAuthSession.create({
                data: {
                  sandboxId,
                  clientId: 'smart-card-launch',
                  launchId,
                  patientFhirId: context.patientId || null,
                  encounterFhirId: context.encounterId || null,
                  fhirVersion: sandbox.fhirVersion,
                  redirectUri: '',
                  scope: 'launch launch/patient patient/*.rs openid profile fhirUser',
                  codeExpiresAt: new Date(Date.now() + 15 * 60 * 1000),
                },
              });
              const urlObj = new URL(link.url, 'http://localhost');
              urlObj.searchParams.set('iss', fhirServer);
              urlObj.searchParams.set('launch', launchId);
              link.url = urlObj.toString();
            }
          }
        }
      }

      res.json({
        cards,
        systemActions: responseData.systemActions || [],
      });
    } catch (err: any) {
      console.error(`CDS Hook execution error on ${serviceUrl}:`, err.message);
      res.status(502).json({
        cards: [
          {
            summary: `Error invoking CDS service: ${err.message}`,
            indicator: 'warning',
            source: { label: 'FHIR Studio CDS Gateway' },
          },
        ],
        systemActions: [],
      });
    }
  });

  // 5. POST /api/sandboxes/:sandboxId/cds-services/feedback (CDS Hooks 2.0 Feedback)
  router.post('/api/sandboxes/:sandboxId/cds-services/feedback', async (req: Request, res: Response): Promise<void> => {
    const { feedbackUrl, feedback } = req.body;

    if (!feedbackUrl || !feedback) {
      res.status(400).json({ error: 'feedbackUrl and feedback payload are required.' });
      return;
    }

    try {
      await axios.post(feedbackUrl, feedback, {
        headers: { 'Content-Type': 'application/json' },
        timeout: 5000,
      });
      res.status(200).json({ status: 'feedback_recorded' });
    } catch (err: any) {
      console.warn(`Feedback submission to ${feedbackUrl} failed:`, err.message);
      res.status(200).json({ status: 'feedback_forwarding_failed', detail: err.message });
    }
  });

  return router;
}
