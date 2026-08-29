// Author: Preston Lee

import express, { type Request, type Response, type Router } from 'express';
import axios from 'axios';
import { v4 as uuidv4 } from 'uuid';
import { getPrisma } from '../db/prisma.js';
import { HapiPartitionClient } from '../hapi/partition_client.js';

// In-memory file cache for completed NDJSON exports
const ndjsonFilesCache = new Map<string, { resourceType: string; ndjson: string; count: number }>();

export function createBulkExportRouter(): Router {
  const router = express.Router();
  const prisma = getPrisma();
  const hapiClient = new HapiPartitionClient();

  // Helper to kick off background export
  async function startExportJob(
    sandboxId: string,
    version: string,
    exportType: 'system' | 'patient' | 'group',
    groupId?: string,
    requestedTypes?: string[],
  ): Promise<string> {
    const sandbox = await prisma.sandbox.findUnique({ where: { sandboxId } });
    if (!sandbox) {
      throw new Error(`Sandbox '${sandboxId}' not found.`);
    }

    const jobId = uuidv4();
    const expiresAt = new Date(Date.now() + 24 * 60 * 60 * 1000); // 24 hours

    const job = await prisma.bulkExportJob.create({
      data: {
        id: jobId,
        sandboxId: sandbox.id,
        exportType,
        status: 'in_progress',
        requestUrl: `/api/sandboxes/${sandboxId}/fhir/${version.toLowerCase()}${exportType === 'system' ? '' : '/' + (exportType === 'patient' ? 'Patient' : `Group/${groupId}`)}/$export`,
        expiresAt,
      },
    });

    // Execute export asynchronously
    setImmediate(async () => {
      try {
        const hapiBaseUrl = hapiClient.getHapiBaseUrl(sandbox.fhirVersion);
        const tenantUrl = `${hapiBaseUrl}/${sandbox.sandboxId}`;

        // Standard resources to query for bulk export
        const resourceTypesToExport = requestedTypes && requestedTypes.length > 0
          ? requestedTypes
          : ['Patient', 'Condition', 'Observation', 'Encounter', 'MedicationRequest', 'DiagnosticReport', 'DocumentReference', 'AllergyIntolerance', 'Procedure', 'Immunization'];

        const outputFiles: Array<{ type: string; url: string; count: number }> = [];

        for (const type of resourceTypesToExport) {
          try {
            const resp = await axios.get(`${tenantUrl}/${type}?_count=500`, {
              headers: { Accept: 'application/fhir+json' },
              timeout: 15_000,
            });

            const bundle = resp.data;
            if (bundle && Array.isArray(bundle.entry) && bundle.entry.length > 0) {
              const resources = bundle.entry.map((e: any) => e.resource).filter(Boolean);
              const ndjson = resources.map((r: any) => JSON.stringify(r)).join('\n');
              const fileId = uuidv4();

              ndjsonFilesCache.set(fileId, {
                resourceType: type,
                ndjson,
                count: resources.length,
              });

              outputFiles.push({
                type,
                url: `/api/sandboxes/${sandboxId}/bulk-export/files/${fileId}`,
                count: resources.length,
              });
            }
          } catch (err: any) {
            // If resource type not found or empty, continue gracefully
          }
        }

        await prisma.bulkExportJob.update({
          where: { id: job.id },
          data: {
            status: 'completed',
            outputFiles: JSON.parse(JSON.stringify(outputFiles)),
          },
        });
      } catch (err: any) {
        console.error('Bulk export background job error:', err);
        await prisma.bulkExportJob.update({
          where: { id: job.id },
          data: {
            status: 'failed',
            error: err.message || 'Export execution failed',
          },
        });
      }
    });

    return jobId;
  }

  // 1. Kick off $export endpoints
  const exportInitiator = async (req: Request, res: Response, exportType: 'system' | 'patient' | 'group'): Promise<void> => {
    const sandboxId = req.params.sandboxId;
    const version = (req.params.version || 'r4').toUpperCase();
    const groupId = req.params.groupId;
    const typesParam = req.query._type ? String(req.query._type).split(',').map((t) => t.trim()) : undefined;

    try {
      const jobId = await startExportJob(sandboxId, version, exportType, groupId, typesParam);
      const host = req.get('host') || 'localhost:3000';
      const protocol = req.protocol || 'http';
      const statusUrl = `${protocol}://${host}/api/sandboxes/${sandboxId}/bulk-export/jobs/${jobId}`;

      res.setHeader('Content-Location', statusUrl);
      res.setHeader('Access-Control-Expose-Headers', 'Content-Location');
      res.status(202).json({
        message: 'Bulk export request accepted for processing.',
        jobId,
        statusUrl,
      });
    } catch (err: any) {
      res.status(400).json({
        resourceType: 'OperationOutcome',
        issue: [
          {
            severity: 'error',
            code: 'invalid',
            diagnostics: err.message,
          },
        ],
      });
    }
  };

  router.get('/api/sandboxes/:sandboxId/fhir/:version/Patient/\\$export', (req, res) => exportInitiator(req, res, 'patient'));
  router.get('/api/sandboxes/:sandboxId/fhir/:version/Group/:groupId/\\$export', (req, res) => exportInitiator(req, res, 'group'));
  router.get('/api/sandboxes/:sandboxId/fhir/:version/\\$export', (req, res) => exportInitiator(req, res, 'system'));

  // 2. GET /api/sandboxes/:sandboxId/bulk-export/jobs/:jobId (Poll Status)
  router.get('/api/sandboxes/:sandboxId/bulk-export/jobs/:jobId', async (req: Request, res: Response): Promise<void> => {
    const { jobId } = req.params;

    const job = await prisma.bulkExportJob.findUnique({
      where: { id: jobId },
    });

    if (!job) {
      res.status(404).json({
        resourceType: 'OperationOutcome',
        issue: [{ severity: 'error', code: 'not-found', diagnostics: `Job '${jobId}' not found.` }],
      });
      return;
    }

    if (job.status === 'in_progress' || job.status === 'queued') {
      res.setHeader('X-Progress', 'Processing export dataset');
      res.setHeader('Retry-After', '2');
      res.status(202).send();
      return;
    }

    if (job.status === 'failed') {
      res.status(500).json({
        resourceType: 'OperationOutcome',
        issue: [{ severity: 'error', code: 'processing', diagnostics: job.error || 'Bulk export failed.' }],
      });
      return;
    }

    // Status is completed: Return SMART Bulk Data 2.0 manifest
    const host = req.get('host') || 'localhost:3000';
    const protocol = req.protocol || 'http';
    const baseUrl = `${protocol}://${host}`;

    const rawOutput = (job.outputFiles as any[]) || [];
    const absoluteOutput = rawOutput.map((file) => ({
      type: file.type,
      url: file.url.startsWith('http') ? file.url : `${baseUrl}${file.url}`,
      count: file.count,
    }));

    res.setHeader('Content-Type', 'application/json');
    res.status(200).json({
      transactionTime: job.transactionTime.toISOString(),
      request: `${baseUrl}${job.requestUrl}`,
      requiresAccessToken: true,
      output: absoluteOutput,
      error: [],
    });
  });

  // 3. DELETE /api/sandboxes/:sandboxId/bulk-export/jobs/:jobId (Cancel Job)
  router.delete('/api/sandboxes/:sandboxId/bulk-export/jobs/:jobId', async (req: Request, res: Response): Promise<void> => {
    const { jobId } = req.params;
    await prisma.bulkExportJob.deleteMany({ where: { id: jobId } });
    res.status(202).send();
  });

  // 4. GET /api/sandboxes/:sandboxId/bulk-export/files/:fileId (Download NDJSON)
  router.get('/api/sandboxes/:sandboxId/bulk-export/files/:fileId', (req: Request, res: Response): void => {
    const { fileId } = req.params;
    const file = ndjsonFilesCache.get(fileId);

    if (!file) {
      res.status(404).json({
        resourceType: 'OperationOutcome',
        issue: [{ severity: 'error', code: 'not-found', diagnostics: `NDJSON File '${fileId}' not found or expired.` }],
      });
      return;
    }

    res.setHeader('Content-Type', 'application/fhir+ndjson');
    res.setHeader('Content-Disposition', `attachment; filename="${file.resourceType}.ndjson"`);
    res.status(200).send(file.ndjson);
  });

  return router;
}
