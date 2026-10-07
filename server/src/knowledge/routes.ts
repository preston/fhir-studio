// Author: Preston Lee

import axios from 'axios';
import { Router, type Request, type Response } from 'express';
import {
  HAPI_DEFAULT_PARTITION_NAME,
  KNOWLEDGE_HELPER_LIBRARY_NAMES,
  isKnowledgePublishResourceType,
  type FhirRelease,
  type KnowledgeCapabilitiesResponse,
  type KnowledgeHelperStatus,
  type KnowledgePublishSummary,
} from '@fhir-studio/core';
import { loadSsoConfig } from '../auth/sso_config.js';
import { createSessionAuth } from '../authentication/requireAuthentication.js';
import { requirePermission } from '../authorization/requirePermission.js';
import { hasPermission } from '../authorization/permissions.js';
import {
  assertFhirReleaseEnabled,
  loadHapiConfig,
  HapiPartitionClient,
} from '../hapi/partition_client.js';
import {
  postFhirBatchBundle,
  type FhirBatchBundle,
} from '../hapi/batch.js';

async function lookupHelperLibraries(
  hapiBaseUrl: string,
): Promise<KnowledgeHelperStatus[]> {
  const results: KnowledgeHelperStatus[] = [];
  for (const name of KNOWLEDGE_HELPER_LIBRARY_NAMES) {
    try {
      const response = await axios.get(`${hapiBaseUrl}/${HAPI_DEFAULT_PARTITION_NAME}/Library`, {
        params: { name, _count: 1 },
        headers: { Accept: 'application/fhir+json' },
        timeout: 15_000,
        validateStatus: () => true,
      });
      const entries = (response.data?.entry || []) as Array<{
        resource?: { id?: string; url?: string; version?: string; name?: string };
      }>;
      const resource = entries[0]?.resource;
      if (resource) {
        results.push({
          name,
          present: true,
          id: resource.id,
          url: resource.url,
          version: resource.version,
        });
      } else {
        results.push({ name, present: false });
      }
    } catch {
      results.push({ name, present: false });
    }
  }
  return results;
}

function validateKnowledgeBundle(body: unknown): {
  ok: true;
  bundle: FhirBatchBundle;
} | {
  ok: false;
  status: number;
  error: string;
  diagnostics?: string[];
} {
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    return { ok: false, status: 400, error: 'Request body must be a FHIR Bundle.' };
  }
  const bundle = body as FhirBatchBundle;
  if (bundle.resourceType !== 'Bundle') {
    return { ok: false, status: 400, error: 'resourceType must be Bundle.' };
  }
  if (bundle.type !== 'transaction') {
    return {
      ok: false,
      status: 400,
      error: 'Bundle.type must be transaction (batch is not allowed for knowledge publish).',
    };
  }
  const entries = bundle.entry || [];
  if (entries.length === 0) {
    return { ok: false, status: 400, error: 'Bundle.entry must not be empty.' };
  }
  const diagnostics: string[] = [];
  entries.forEach((entry, index) => {
    const resourceType = entry.resource?.resourceType;
    if (!resourceType) {
      diagnostics.push(`Bundle.entry[${index}] is missing resource.resourceType.`);
      return;
    }
    if (!isKnowledgePublishResourceType(resourceType)) {
      diagnostics.push(
        `Bundle.entry[${index}] resourceType '${resourceType}' is not allowed in global knowledge publish.`,
      );
      return;
    }

    const method = String(entry.request?.method || '').toUpperCase();
    const requestUrl = String(entry.request?.url || '').split('?')[0];
    const ifNoneExistRaw = String(entry.request?.ifNoneExist || '');
    if (method !== 'POST') {
      diagnostics.push(
        `Bundle.entry[${index}] must use POST with ifNoneExist (conditional create); ${method || 'missing method'} is not allowed.`,
      );
    }
    if (requestUrl !== resourceType) {
      diagnostics.push(
        `Bundle.entry[${index}] request.url must be '${resourceType}' (no id path); got '${requestUrl || ''}'.`,
      );
    }
    const resource = entry.resource;
    if (!resource) {
      diagnostics.push(`Bundle.entry[${index}] is missing a resource.`);
      return;
    }
    const canonicalUrl = typeof resource.url === 'string' ? resource.url.trim() : '';
    const version = typeof resource.version === 'string' ? resource.version.trim() : '';
    if (!canonicalUrl) {
      diagnostics.push(`Bundle.entry[${index}] canonical resources must include url.`);
    }
    let ifNoneExistParams: URLSearchParams;
    ifNoneExistParams = new URLSearchParams(ifNoneExistRaw);
    const ifNoneUrl = (ifNoneExistParams.get('url') || '').trim();
    const ifNoneVersion = (ifNoneExistParams.get('version') || '').trim();
    if (!ifNoneUrl) {
      diagnostics.push(
        `Bundle.entry[${index}] ifNoneExist must include an exact url= parameter for idempotent canonical publish.`,
      );
    } else if (canonicalUrl && ifNoneUrl !== canonicalUrl) {
      diagnostics.push(
        `Bundle.entry[${index}] ifNoneExist url= must match resource.url.`,
      );
    }
    if (version) {
      if (!ifNoneVersion) {
        diagnostics.push(
          `Bundle.entry[${index}] ifNoneExist must include version= when the resource has a version.`,
        );
      } else if (ifNoneVersion !== version) {
        diagnostics.push(
          `Bundle.entry[${index}] ifNoneExist version= must match resource.version.`,
        );
      }
    }
  });
  if (diagnostics.length) {
    return {
      ok: false,
      status: 400,
      error: 'Bundle contains disallowed or invalid entries.',
      diagnostics,
    };
  }
  return { ok: true, bundle };
}

export function createKnowledgeRouter(): Router {
  const router = Router();
  const oidc = loadSsoConfig();
  const { requireAuthentication } = createSessionAuth(oidc);
  const hapiClient = new HapiPartitionClient();
  const hapiConfig = loadHapiConfig();

  router.get(
    '/api/knowledge/capabilities',
    requireAuthentication,
    async (req: Request, res: Response): Promise<void> => {
      const fhirVersionParam = String(req.query.fhirVersion || 'R4');
      let fhirVersion: FhirRelease = 'R4';
      try {
        fhirVersion = assertFhirReleaseEnabled(fhirVersionParam);
      } catch {
        res.status(400).json({
          error: `Unsupported or disabled FHIR version '${fhirVersionParam}'.`,
          enabled: hapiConfig.enabledReleases,
        });
        return;
      }

      const hapiBaseUrl = hapiClient.getHapiBaseUrl(fhirVersion);
      const helpers = await lookupHelperLibraries(hapiBaseUrl);
      const knowledgePublish = hasPermission(req.effectivePermissions, 'knowledge_publish');

      const body: KnowledgeCapabilitiesResponse = {
        product: 'fhir-studio',
        apiVersion: '1',
        fhirVersions: [...hapiConfig.enabledReleases],
        knowledgePublish,
        deepLinks: {
          dataManagerShared: '/data-manager?partition=DEFAULT&resourceType=Library',
          cqlWithFhirExample: '/cql-with-fhir-example',
        },
        helpers,
      };
      res.json(body);
    },
  );

  router.post(
    '/api/knowledge/publish',
    requireAuthentication,
    requirePermission('knowledge_publish'),
    async (req: Request, res: Response): Promise<void> => {
      const fhirVersionParam = String(req.query.fhirVersion || req.body?.fhirVersion || 'R4');
      let fhirVersion: FhirRelease;
      try {
        fhirVersion = assertFhirReleaseEnabled(fhirVersionParam);
      } catch {
        res.status(400).json({
          error: `Unsupported or disabled FHIR version '${fhirVersionParam}'.`,
        });
        return;
      }

      const validated = validateKnowledgeBundle(req.body);
      if (!validated.ok) {
        res.status(validated.status).json({
          resourceType: 'OperationOutcome',
          issue: [
            {
              severity: 'error',
              code: 'invalid',
              diagnostics: validated.error,
            },
            ...(validated.diagnostics || []).map((d) => ({
              severity: 'error' as const,
              code: 'invalid' as const,
              diagnostics: d,
            })),
          ],
        });
        return;
      }

      const hapiBaseUrl = hapiClient.getHapiBaseUrl(fhirVersion);
      try {
        const result = await postFhirBatchBundle(
          hapiBaseUrl,
          HAPI_DEFAULT_PARTITION_NAME,
          validated.bundle,
          { timeoutMs: 60_000 },
        );
        const summary: KnowledgePublishSummary = {
          imported: result.imported,
          failed: result.failed,
          errors: result.errors,
          fhirVersion,
        };
        res.status(result.status >= 400 ? result.status : 200).json({
          ...result.response,
          _knowledgePublish: summary,
        });
      } catch (err: any) {
        console.error('Knowledge publish failed:', err?.message || err);
        res.status(502).json({
          resourceType: 'OperationOutcome',
          issue: [
            {
              severity: 'error',
              code: 'transient',
              diagnostics: 'Unable to publish to HAPI DEFAULT. See server logs for details.',
            },
          ],
        });
      }
    },
  );

  router.post(
    '/api/knowledge/ensure-dependencies',
    requireAuthentication,
    requirePermission('knowledge_publish'),
    async (req: Request, res: Response): Promise<void> => {
      const fhirVersionParam = String(req.query.fhirVersion || req.body?.fhirVersion || 'R4');
      let fhirVersion: FhirRelease;
      try {
        fhirVersion = assertFhirReleaseEnabled(fhirVersionParam);
      } catch {
        res.status(400).json({
          error: `Unsupported or disabled FHIR version '${fhirVersionParam}'.`,
        });
        return;
      }

      const hapiBaseUrl = hapiClient.getHapiBaseUrl(fhirVersion);
      const helpers = await lookupHelperLibraries(hapiBaseUrl);
      const missing = helpers.filter((h) => !h.present).map((h) => h.name);

      // Do not write placeholder Libraries under HL7 canonical URLs — that would
      // block real FHIRHelpers/ModelInfo installs and mislead CQL engines.
      res.json({
        fhirVersion,
        ensured: [] as string[],
        missing,
        imported: 0,
        failed: 0,
        errors:
          missing.length > 0
            ? [
                `Missing helper Libraries: ${missing.join(', ')}. Install them via FHIR Studio Package Importer (e.g. hl7.fhir.r4.core / FHIRHelpers) into DEFAULT before publishing dependent CQL.`,
              ]
            : [],
        helpers,
      });
    },
  );

  return router;
}
