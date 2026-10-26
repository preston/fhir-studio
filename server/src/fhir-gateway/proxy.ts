// Author: Preston Lee

import express, { type Request, type Response, type Router } from 'express';
import axios from 'axios';
import {
  HAPI_DEFAULT_PARTITION_NAME,
  isKnowledgePublishResourceType,
  isHapiNonPartitionableResourceType,
  resolveHapiPartitionName,
} from '@fhir-studio/core';
import { getPrisma } from '../db/prisma.js';
import {
  HapiPartitionClient,
  isFhirReleaseEnabled,
  assertFhirReleaseEnabled,
} from '../hapi/partition_client.js';
import { postFhirBatchBundle, type FhirBatchBundle } from '../hapi/batch.js';
import { verifySandboxAccess } from './security.js';
import { rewriteFhirPayload, rewriteHeaderUrl } from './url_rewriter.js';
import { hasPermission } from '../authorization/permissions.js';
import { loadStudioOrigin } from '../hosted/config.js';

import { routeParam } from '../http/routeParam.js';
import { isSafeFhirPath, isSafeFhirBundle, isUnsafeHapiOperationPath } from './path.js';

const READ_ONLY_KNOWLEDGE_OPERATIONS = new Set([
  'validate', 'validate-code', 'expand', 'lookup', 'subsumes', 'find-matches', 'meta',
]);

function isKnowledgeMutationRequest(method: string, path: string, resourceType?: string): boolean {
  const pathOnly = path.split('?')[0];
  const operation = /(?:^|\/)\$([^/]+)$/.exec(pathOnly)?.[1].toLowerCase();
  // CQL remote Endpoint parameters can escape the authorized tenant even on a clinical type.
  if (operation && ['evaluate', 'cql', 'evaluate-measure'].includes(operation)) return true;
  if (!isKnowledgePublishResourceType(resourceType) && !isHapiNonPartitionableResourceType(resourceType)) return false;
  if (operation) return !READ_ONLY_KNOWLEDGE_OPERATIONS.has(operation);
  const m = method.toUpperCase();
  if (m === 'GET' || m === 'HEAD' || m === 'OPTIONS') return false;
  if (m === 'POST' && pathOnly.includes('/_search')) {
    return false;
  }
  return m === 'POST' || m === 'PUT' || m === 'PATCH' || m === 'DELETE';
}

function bundleMutatesDefaultKnowledge(bundle: FhirBatchBundle): boolean {
  for (const entry of bundle.entry || []) {
    const rt =
      String(entry.request?.url || '').split('?')[0].split('/')[0] ||
      entry.resource?.resourceType;
    const method = String(entry.request?.method || 'GET').toUpperCase();
    if (isKnowledgeMutationRequest(method, String(entry.request?.url || ''), rt)) return true;
  }
  return false;
}

export function createFhirGatewayRouter(): Router {
  const router = express.Router();
  const prisma = getPrisma();
  const hapiClient = new HapiPartitionClient();
  const studioOrigin = loadStudioOrigin();

  // Handler for /api/sandboxes/:sandboxId/fhir/:version and all subpaths
  const proxyHandler = async (req: Request, res: Response): Promise<void> => {
    // FHIR Binary and narrative content must never become executable Studio-origin documents.
    res.setHeader('Content-Security-Policy', "sandbox; default-src 'none'; frame-ancestors 'none'");
    res.setHeader('X-Content-Type-Options', 'nosniff');
    const sandboxId = routeParam(req.params.sandboxId);
    const versionParam = (routeParam(req.params.version) || 'r4').toUpperCase();

    try {
      assertFhirReleaseEnabled(versionParam);
    } catch (err: any) {
      res.status(400).json({
        resourceType: 'OperationOutcome',
        issue: [
          {
            severity: 'error',
            code: 'invalid',
            diagnostics: err?.message || `Unsupported or disabled FHIR version '${versionParam}'.`,
          },
        ],
      });
      return;
    }

    const sandbox = await prisma.sandbox.findUnique({
      where: { sandboxId },
    });

    if (!sandbox || !isFhirReleaseEnabled(sandbox.fhirVersion)) {
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

    // Determine subpath within FHIR endpoint (`*path` is string[] under Express 5 types)
    const pathParam = req.params.path;
    let subpath = Array.isArray(pathParam)
      ? (pathParam.length > 0 ? `/${pathParam.join('/')}` : '')
      : pathParam
        ? `/${pathParam}`
        : '';
    if (!isSafeFhirPath(subpath)) { res.sendStatus(400); return; }
    if (isUnsafeHapiOperationPath(subpath) || subpath.split('/').filter(Boolean)[0]?.startsWith('$')) { res.status(403).json({ error: 'HAPI system administration is not exposed through sandbox endpoints.' }); return; }
    const forwardedQuery = { ...req.query };
    let forwardedBody: unknown = req.body;

    // Extract potential resourceType from subpath
    const pathSegments = subpath.split('/').filter(Boolean);
    let resourceType: string | undefined = undefined;
    if (pathSegments.length > 0 && /^[A-Z][A-Za-z0-9]+$/.test(pathSegments[0])) {
      resourceType = pathSegments[0];
    }
    if (resourceType === 'Binary') res.setHeader('Content-Disposition', 'attachment');

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
      const status = accessResult.reason?.startsWith('Forbidden:') ? 403 : 401;
      res.status(status).json({
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
    const postSearch = req.method === 'POST' && pathSegments.length === 2 && pathSegments[1] === '_search';
    const searchBody: Record<string, unknown> = postSearch && req.body && typeof req.body === 'object' && !Array.isArray(req.body)
      ? req.body as Record<string, unknown>
      : {};
    if (accessResult.isSmartClient && [req.query, searchBody].some(params =>
      Object.keys(params).some(key => key.startsWith('_include') || key.startsWith('_revinclude')),
    )) {
      res.status(403).json({ error: 'SMART include and revinclude searches are not supported; request each resource type using its granted scopes.' });
      return;
    }
    if (postSearch && !req.is('application/x-www-form-urlencoded')) {
      res.status(415).json({ error: 'FHIR POST searches require application/x-www-form-urlencoded parameters.' });
      return;
    }
    if (accessResult.patientRestricted && accessResult.smartSession?.patientFhirId && resourceType) {
      const patientId = accessResult.smartSession.patientFhirId;
      const parts = subpath.split('/').filter(Boolean);
      const search = postSearch || (parts.length === 1 && ['GET', 'HEAD'].includes(req.method));
      if (!search && !['GET', 'HEAD'].includes(req.method) && (Object.keys(forwardedQuery).length || (req.method !== 'POST' && !parts[1]))) { res.status(403).json({ error: 'Conditional patient-scoped writes are not supported.' }); return; }
      if ([req.query, searchBody].some(params => Object.keys(params).some(key => key === '_has' || key.startsWith('_has:'))) || parts.some(p => p.startsWith('$') || p === '_history') || parts.length > 2) {
        res.status(403).json({ error: 'Patient-scoped operations must stay within the launch patient compartment.' }); return;
      }
      if (search) {
        if (resourceType === 'Patient') {
          forwardedQuery['_id'] = patientId;
          if (postSearch) forwardedBody = { ...searchBody, _id: patientId };
        } else {
          subpath = `/Patient/${encodeURIComponent(patientId)}/${resourceType}${postSearch ? '/_search' : ''}`;
        }
      } else if (resourceType === 'Patient') {
        if ((parts[1] && parts[1] !== patientId) || (!['GET', 'HEAD'].includes(req.method))) { res.sendStatus(403); return; }
      } else {
        if (parts[1]) {
          const existing = await axios.get<{ entry?: Array<{ resource?: { id?: string } }> }>(`${hapiBaseUrl}/${sandbox.sandboxId}/Patient/${encodeURIComponent(patientId)}/${resourceType}`, { params: { _id: parts[1], _count: 1 }, timeout: 15_000 });
          if (!existing.data.entry?.some(entry => entry.resource?.id === parts[1])) { res.sendStatus(403); return; }
        }
        if (['POST', 'PUT', 'PATCH'].includes(req.method)) {
          const body = req.body as { subject?: { reference?: string }; patient?: { reference?: string } };
          if (req.method === 'PATCH' || ![body.subject?.reference, body.patient?.reference].includes(`Patient/${patientId}`)) { res.sendStatus(403); return; }
        }
      }
    }

    // Global knowledge (HAPI DEFAULT / HAPI-1318 types) is write-gated by knowledge_publish.
    // Sandbox owners, collaborators, open-access, and SMART clients must not bypass
    // POST /api/knowledge/publish by writing Library/ValueSet/… via the sandbox FHIR base.
    const denyKnowledgeWrite = () => {
      res.status(403).json({
        resourceType: 'OperationOutcome',
        issue: [
          {
            severity: 'error',
            code: 'forbidden',
            diagnostics:
              'Writing global knowledge resources (Library, ValueSet, CodeSystem, …) requires the knowledge_publish permission via POST /api/knowledge/publish.',
          },
        ],
      });
    };
    const canPublishKnowledge =
      hasPermission(req.effectivePermissions, 'knowledge_publish') ||
      hasPermission(req.effectivePermissions, 'global_manage');

    const publicOrigin = studioOrigin;
    const proxyBaseUrl = `${publicOrigin}/api/sandboxes/${sandboxId}/fhir/${versionParam.toLowerCase()}`;

    // Root batch/transaction Bundles may mix partitionable clinical resources with
    // HAPI non-partitionable conformance types (StructureDefinition, ValueSet, …).
    const body = req.body;
    const isRootBundlePost =
      req.method === 'POST' &&
      !resourceType &&
      body &&
      typeof body === 'object' &&
      !Array.isArray(body) &&
      (body as { resourceType?: string }).resourceType === 'Bundle' &&
      ['batch', 'transaction'].includes(String((body as { type?: string }).type || ''));

    if (isRootBundlePost) {
      if (!isSafeFhirBundle(body)) {
        res.status(400).json({ error: 'Bundle entries must use relative FHIR URLs within this sandbox; partition administration is forbidden.' });
        return;
      }
      if (bundleMutatesDefaultKnowledge(body as FhirBatchBundle) && !canPublishKnowledge) {
        denyKnowledgeWrite();
        return;
      }
      try {
        const result = await postFhirBatchBundle(
          hapiBaseUrl,
          sandbox.sandboxId,
          body as FhirBatchBundle,
          { timeoutMs: 30_000 },
        );
        // Mixed batches may return absolute URLs from both the sandbox and DEFAULT partitions.
        let rewrittenBody = rewriteFhirPayload(
          result.response,
          `${hapiBaseUrl}/${sandbox.sandboxId}`,
          proxyBaseUrl,
        );
        rewrittenBody = rewriteFhirPayload(
          rewrittenBody,
          `${hapiBaseUrl}/${HAPI_DEFAULT_PARTITION_NAME}`,
          proxyBaseUrl,
        );
        res.status(result.status).send(rewrittenBody);
      } catch (err: any) {
        console.error(`FHIR Gateway Bundle partition routing error:`, err.message);
        res.status(502).json({
          resourceType: 'OperationOutcome',
          issue: [
            {
              severity: 'error',
              code: 'transient',
              diagnostics: `FHIR Gateway unable to submit batch Bundle to HAPI FHIR (${err.message}).`,
            },
          ],
        });
      }
      return;
    }

    if (isKnowledgeMutationRequest(req.method, subpath, resourceType) && !canPublishKnowledge) {
      denyKnowledgeWrite();
      return;
    }

    // Conformance/terminology types must hit DEFAULT (HAPI-1318); clinical types use the sandbox partition.
    const hapiPartitionName = resolveHapiPartitionName(sandbox.sandboxId, resourceType);
    const targetUrl = `${hapiBaseUrl}/${hapiPartitionName}${subpath}`;
    const hapiTenantBaseUrl = `${hapiBaseUrl}/${hapiPartitionName}`;

    try {
      const response = await axios({
        method: req.method,
        url: targetUrl,
        params: forwardedQuery,
        data: ['POST', 'PUT', 'PATCH'].includes(req.method) ? forwardedBody : undefined,
        headers: {
          'Content-Type': req.get('Content-Type') || 'application/fhir+json',
          Accept: req.get('Accept') || 'application/fhir+json',
          ...Object.fromEntries(['Prefer', 'If-Match', 'If-None-Match', 'If-None-Exist', 'If-Modified-Since', 'If-Unmodified-Since']
            .flatMap(name => req.get(name) ? [[name, req.get(name)!]] : [])),
        },
        validateStatus: () => true, // Forward all status codes from HAPI
        timeout: 30_000,
      });

      // Rewrite response headers so clients always see the sandbox gateway base URL
      if (response.headers['location']) {
        res.setHeader('Location', rewriteHeaderUrl(response.headers['location'], hapiTenantBaseUrl, proxyBaseUrl) || '');
      }
      if (response.headers['content-location']) {
        res.setHeader('Content-Location', rewriteHeaderUrl(response.headers['content-location'], hapiTenantBaseUrl, proxyBaseUrl) || '');
      }
      if (response.headers['content-type']) {
        res.setHeader('Content-Type', String(response.headers['content-type']));
      }
      for (const name of ['etag', 'last-modified', 'preference-applied', 'retry-after']) {
        if (response.headers[name]) res.setHeader(name, String(response.headers[name]));
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
