// Author: Preston Lee

import express, { type Request, type Response, type Router } from 'express';
import axios from 'axios';
import { v4 as uuidv4 } from 'uuid';
import { getPrisma } from '../db/prisma.js';
import { HapiPartitionClient, isFhirReleaseEnabled } from '../hapi/partition_client.js';
import type { CdsHookCard, CdsServiceDefinition } from '@fhir-studio/core';
import type { Prisma } from '@prisma/client';

import { routeParam } from '../http/routeParam.js';
import { HostingError, sandboxAccess } from '../hosted/access.js';
import { prefetchPath } from '../fhir-gateway/path.js';
import { PublicRequestError, publicHttpUrl, requestPublicJson } from '../http/public-request.js';

export function createHooksRouter(options: { requestJson?: typeof requestPublicJson } = {}): Router {
  const router = express.Router();
  const prisma = getPrisma();
  const hapiClient = new HapiPartitionClient();
  const requestJson = options.requestJson ?? requestPublicJson;
  router.use('/api/sandboxes/:sandboxId/cds-services', async (req, res, next) => {
    if (!req.sessionAuth) throw new HostingError(401, 'Sign in to use CDS services.');
    const readRequest = ['GET', 'HEAD'].includes(req.method) ||
      (req.method === 'POST' && ['/proxy', '/feedback'].includes(req.path));
    const sandbox = await sandboxAccess(req.sessionAuth.userId, routeParam(req.params.sandboxId), !readRequest, req.effectivePermissions?.global_manage);
    res.locals.sandboxRowId = sandbox.id;
    next();
  });

  // Validate outside discovery/delivery catches: unsafe URLs are request errors, not optional failures.
  function serviceUrl(value: unknown): string {
    if (typeof value !== 'string') throw new HostingError(400, 'A public HTTPS CDS URL is required.');
    try { return publicHttpUrl(value).href; }
    catch { throw new HostingError(400, 'A public HTTPS CDS URL without credentials or a custom port is required.'); }
  }

  // 1. GET /api/sandboxes/:sandboxId/cds-services
  router.get('/api/sandboxes/:sandboxId/cds-services', async (req: Request, res: Response): Promise<void> => {
    const sandboxId = routeParam(req.params.sandboxId);
    const sandbox = await prisma.sandbox.findUnique({ where: { id: String(res.locals.sandboxRowId) } });

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
    const sandboxId = routeParam(req.params.sandboxId);
    const { name, url } = req.body;

    if (!name || !url) {
      res.status(400).json({ error: 'name and url are required.' });
      return;
    }
    const endpointUrl = serviceUrl(url);

    const sandbox = await prisma.sandbox.findUnique({ where: { id: String(res.locals.sandboxRowId) } });
    if (!sandbox || !isFhirReleaseEnabled(sandbox.fhirVersion)) {
      res.status(404).json({ error: 'Sandbox not found.' });
      return;
    }

    // Attempt discovery
    let servicesJson: CdsServiceDefinition[] = [];
    try {
      const discoveryUrl = endpointUrl.endsWith('/cds-services') ? endpointUrl : `${endpointUrl.replace(/\/+$/, '')}/cds-services`;
      const discovery = await requestJson(discoveryUrl, { timeoutMs: 8000, maxBytes: 1024 * 1024, followRedirects: false });
      if (discovery && typeof discovery === 'object' && 'services' in discovery && Array.isArray(discovery.services)) {
        servicesJson = discovery.services as CdsServiceDefinition[];
      }
    } catch (err: any) {
      if (err instanceof PublicRequestError && err.status === 400) throw new HostingError(400, err.message);
      console.warn(`CDS Discovery failed for ${url}:`, err.message);
    }

    const created = await prisma.cdsServiceEndpoint.create({
      data: {
        sandboxId: sandbox.id,
        name,
        url: endpointUrl,
        servicesJson: JSON.parse(JSON.stringify(servicesJson)) as Prisma.InputJsonValue,
      },
    });

    res.status(201).json({ endpoint: created });
  });

  // 3. DELETE /api/sandboxes/:sandboxId/cds-services/:id
  router.delete('/api/sandboxes/:sandboxId/cds-services/:id', async (req: Request, res: Response): Promise<void> => {
    const id = routeParam(req.params.id);
    const deleted = await prisma.cdsServiceEndpoint.deleteMany({ where: { id, sandboxId: String(res.locals.sandboxRowId) } });
    if (!deleted.count) throw new HostingError(404, 'CDS service endpoint not found in this sandbox.');
    res.json({ message: 'CDS Service endpoint deleted.' });
  });

  // 4. POST /api/sandboxes/:sandboxId/cds-services/proxy (Invoke CDS Hook & Resolve Prefetch)
  router.post('/api/sandboxes/:sandboxId/cds-services/proxy', async (req: Request, res: Response): Promise<void> => {
    const sandboxId = routeParam(req.params.sandboxId);
    const { serviceUrl: requestedServiceUrl, hook = 'patient-view', hookInstance, context = {}, prefetch = {}, prefetchTemplates } = req.body;

    if (!requestedServiceUrl) {
      res.status(400).json({ error: 'serviceUrl is required.' });
      return;
    }
    const targetUrl = serviceUrl(requestedServiceUrl);

    const sandbox = await prisma.sandbox.findUnique({ where: { id: String(res.locals.sandboxRowId) } });
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
    const resolvedPrefetch: Record<string, unknown> = { ...prefetch };
    if (prefetchTemplates && typeof prefetchTemplates === 'object') {
      const entries = Object.entries(prefetchTemplates as Record<string, string>);
      if (entries.length > 20) throw new HostingError(400, 'At most 20 prefetch queries are supported.');
      // Validate every substituted path before starting any upstream requests.
      const queries = entries.map(([key, queryTemplate]) => {
        if (typeof queryTemplate !== 'string') throw new HostingError(400, 'Prefetch templates must be strings.');
        const query = queryTemplate.replace(/\{\{\s*context\.([a-zA-Z0-9_-]+)\s*\}\}/g, (_, varName: string) =>
          encodeURIComponent(String(context[varName] || context[varName.replace('Id', '')] || '')),
        );
        if (!query || query.includes('{{')) return { key, query: null };
        try { return { key, query: prefetchPath(query) }; }
        catch { throw new HostingError(400, 'Prefetch queries must stay within this sandbox.'); }
      });
      await Promise.all(
        queries.map(async ({ key, query }) => {
          if (resolvedPrefetch[key]) return; // already populated
          if (!query) return;

          try {
            const resp = await axios.get(`${tenantUrl}/${query}`, {
              headers: { Accept: 'application/fhir+json' },
              timeout: 5000,
              maxRedirects: 0,
              maxContentLength: 5 * 1024 * 1024,
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
      const response = await requestJson(targetUrl, {
        method: 'POST', body: requestPayload, timeoutMs: 10_000,
        maxBytes: 5 * 1024 * 1024, followRedirects: false,
      });

      const responseData = response && typeof response === 'object' ? response as Record<string, unknown> : {};
      const cards = Array.isArray(responseData.cards) ? responseData.cards as CdsHookCard[] : [];

      // Transform SMART launch links if cards have link.type === 'smart'
      for (const card of cards) {
        if (Array.isArray(card.links)) {
          for (const link of card.links) {
            if (link.type === 'smart' && link.url) {
              const launchId = uuidv4();
              await prisma.smartAuthSession.create({
                data: {
                  sandboxId,
                  sandboxRowId: sandbox.id,
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
      console.error(`CDS Hook execution error on ${targetUrl}:`, err.message);
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
    const targetUrl = serviceUrl(feedbackUrl);

    try {
      await requestJson(targetUrl, {
        method: 'POST', body: feedback, timeoutMs: 5000,
        maxBytes: 1024 * 1024, followRedirects: false,
      });
      res.status(200).json({ status: 'feedback_recorded' });
    } catch (err: any) {
      console.warn(`Feedback submission to ${feedbackUrl} failed:`, err.message);
      res.status(200).json({ status: 'feedback_forwarding_failed', detail: err.message });
    }
  });

  return router;
}
