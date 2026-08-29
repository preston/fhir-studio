// Author: Preston Lee

import express, { type Request, type Response, type Router } from 'express';
import axios from 'axios';
import { getPrisma } from '../db/prisma.js';
import { HapiPartitionClient, loadHapiConfig } from '../hapi/partition_client.js';
import { verifySandboxAccess } from './security.js';
import { rewriteFhirPayload, rewriteHeaderUrl } from './url_rewriter.js';

export function createFhirGatewayRouter(): Router {
  const router = express.Router();
  const prisma = getPrisma();
  const hapiClient = new HapiPartitionClient();
  const hapiConfig = loadHapiConfig();

  // Handler for /api/sandboxes/:sandboxId/fhir/:version and all subpaths
  const proxyHandler = async (req: Request, res: Response): Promise<void> => {
    const sandboxId = req.params.sandboxId;
    const versionParam = (req.params.version || 'r4').toUpperCase();

    if (versionParam !== 'R4' && versionParam !== 'R4B' && versionParam !== 'R5') {
      res.status(400).json({
        resourceType: 'OperationOutcome',
        issue: [
          {
            severity: 'error',
            code: 'invalid',
            diagnostics: `Unsupported FHIR version '${versionParam}'. Supported versions are R4, R4B, and R5.`,
          },
        ],
      });
      return;
    }

    const sandbox = await prisma.sandbox.findUnique({
      where: { sandboxId },
    });

    if (!sandbox) {
      res.status(404).json({
        resourceType: 'OperationOutcome',
        issue: [
          {
            severity: 'error',
            code: 'not-found',
            diagnostics: `Sandbox '${sandboxId}' not found.`,
          },
        ],
      });
      return;
    }

    if (sandbox.fhirVersion.toUpperCase() !== versionParam) {
      res.status(400).json({
        resourceType: 'OperationOutcome',
        issue: [
          {
            severity: 'error',
            code: 'invalid',
            diagnostics: `Sandbox '${sandboxId}' is configured for FHIR ${sandbox.fhirVersion}, but request specified ${versionParam}.`,
          },
        ],
      });
      return;
    }

    // Determine subpath within FHIR endpoint
    const pathParam = req.params.path;
    const subpath = Array.isArray(pathParam)
      ? (pathParam.length > 0 ? `/${pathParam.join('/')}` : '')
      : pathParam
        ? `/${pathParam}`
        : '';

    // Extract potential resourceType from subpath
    const pathSegments = subpath.split('/').filter(Boolean);
    let resourceType: string | undefined = undefined;
    if (pathSegments.length > 0 && /^[A-Z][A-Za-z0-9]+$/.test(pathSegments[0])) {
      resourceType = pathSegments[0];
    }

    // Access control verification
    const authHeader = req.get('authorization');
    const accessResult = await verifySandboxAccess(
      prisma,
      sandbox,
      authHeader,
      req.sessionAuth,
      req.effectivePermissions,
      {
        method: req.method,
        path: subpath,
        resourceType,
      },
    );

    if (!accessResult.authorized) {
      res.status(401).json({
        resourceType: 'OperationOutcome',
        issue: [
          {
            severity: 'error',
            code: 'security',
            diagnostics: accessResult.reason || 'Unauthorized sandbox access',
          },
        ],
      });
      return;
    }

    const hapiBaseUrl = hapiClient.getHapiBaseUrl(versionParam);
    const targetUrl = `${hapiBaseUrl}/${sandbox.sandboxId}${subpath}`;

    const host = req.get('host') || 'localhost:3000';
    const protocol = req.protocol || 'http';
    const proxyBaseUrl = `${protocol}://${host}/api/sandboxes/${sandboxId}/fhir/${versionParam.toLowerCase()}`;
    const hapiTenantBaseUrl = `${hapiBaseUrl}/${sandbox.sandboxId}`;

    try {
      const response = await axios({
        method: req.method,
        url: targetUrl,
        params: req.query,
        data: ['POST', 'PUT', 'PATCH'].includes(req.method) ? req.body : undefined,
        headers: {
          'Content-Type': req.get('Content-Type') || 'application/fhir+json',
          Accept: req.get('Accept') || 'application/fhir+json',
        },
        validateStatus: () => true, // Forward all status codes from HAPI
        timeout: 30_000,
      });

      // Rewrite response headers
      if (response.headers['location']) {
        res.setHeader('Location', rewriteHeaderUrl(response.headers['location'], hapiTenantBaseUrl, proxyBaseUrl) || '');
      }
      if (response.headers['content-location']) {
        res.setHeader('Content-Location', rewriteHeaderUrl(response.headers['content-location'], hapiTenantBaseUrl, proxyBaseUrl) || '');
      }
      if (response.headers['content-type']) {
        res.setHeader('Content-Type', String(response.headers['content-type']));
      }

      // Rewrite response payload URLs
      const rewrittenBody = rewriteFhirPayload(response.data, hapiTenantBaseUrl, proxyBaseUrl);

      res.status(response.status).send(rewrittenBody);
    } catch (err: any) {
      console.error(`FHIR Gateway Proxy Error on ${targetUrl}:`, err.message);
      res.status(502).json({
        resourceType: 'OperationOutcome',
        issue: [
          {
            severity: 'error',
            code: 'transient',
            diagnostics: `FHIR Gateway unable to reach backend HAPI FHIR JPA server at ${targetUrl}. Ensure the container is running.`,
          },
        ],
      });
    }
  };

  router.all('/api/sandboxes/:sandboxId/fhir/:version{/*path}', proxyHandler);

  return router;
}
