// Author: Preston Lee

import { gunzipSync } from 'fflate';
import {
  HAPI_DEFAULT_PARTITION_NAME,
  type FhirRelease,
} from '@fhir-studio/core';
import type { JobHandler } from '../types.js';
import { fetchPackageTarball } from '../../implementation-guides/registry.js';
import { postFhirResourceBatch } from '../../hapi/batch.js';
import { assertFhirReleaseEnabled } from '../../hapi/config.js';

interface ExtractedResource {
  path: string;
  resource: Record<string, any>;
}

function isExampleResource(path: string, id: string | undefined): boolean {
  const normalizedPath = path.replace(/\\/g, '/').toLowerCase();
  // Match package/example/..., example/..., package/examples/..., examples/...
  if (/(^|\/)examples?\//.test(normalizedPath)) {
    return true;
  }
  if (id && /example/i.test(id)) {
    return true;
  }
  return false;
}

function extractJsonResourcesFromTar(tarBytes: Uint8Array): ExtractedResource[] {
  const resources: ExtractedResource[] = [];
  let offset = 0;

  while (offset < tarBytes.length - 512) {
    const header = tarBytes.subarray(offset, offset + 512);
    if (header.every((b) => b === 0)) break;

    let filename = '';
    for (let i = 0; i < 100; i++) {
      if (header[i] === 0) break;
      filename += String.fromCharCode(header[i]);
    }

    let sizeStr = '';
    for (let i = 124; i < 136; i++) {
      if (header[i] === 0 || header[i] === 32) break;
      sizeStr += String.fromCharCode(header[i]);
    }
    const fileSize = parseInt(sizeStr.trim(), 8) || 0;
    offset += 512;

    if (
      fileSize > 0 &&
      filename.endsWith('.json') &&
      !filename.includes('package.json') &&
      !filename.includes('.index.json')
    ) {
      const fileContent = tarBytes.subarray(offset, offset + fileSize);
      try {
        const text = new TextDecoder().decode(fileContent);
        const parsed = JSON.parse(text);
        if (parsed.resourceType) {
          resources.push({ path: filename, resource: parsed });
        }
      } catch {
        // ignore malformed
      }
    }

    offset += Math.ceil(fileSize / 512) * 512;
  }

  return resources;
}

function countByResourceType(
  resources: Array<Record<string, any>>,
): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const resource of resources) {
    const type = String(resource.resourceType || 'Unknown');
    counts[type] = (counts[type] || 0) + 1;
  }
  return counts;
}

export const packageImportHandler: JobHandler = async (ctx) => {
  const input = (ctx.job.input as Record<string, any>) || {};
  const {
    packageName,
    packageVersion,
    tarballUrl,
    sandboxId: inputSandboxId,
    target: rawTarget,
    fhirVersion: inputFhirVersion,
    excludeExamples = false,
  } = input;

  const target = rawTarget === 'DEFAULT' ? 'DEFAULT' : 'sandbox';
  let fhirVersion: FhirRelease;
  let partitionName: string;
  let sandboxSlug: string | undefined;

  if (target === 'DEFAULT') {
    if (!inputFhirVersion) {
      throw new Error('fhirVersion is required when target is DEFAULT.');
    }
    fhirVersion = assertFhirReleaseEnabled(inputFhirVersion);
    partitionName = HAPI_DEFAULT_PARTITION_NAME;
  } else {
    const sandboxId = inputSandboxId || ctx.job.sandboxId;
    if (!sandboxId) {
      throw new Error('Sandbox ID is required for sandbox-targeted package import.');
    }

    const isUuid =
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(sandboxId);
    const sandbox = await ctx.prisma.sandbox.findFirst({
      where: isUuid ? { OR: [{ id: sandboxId }, { sandboxId }] } : { sandboxId },
    });

    if (!sandbox) {
      throw new Error(`Sandbox '${sandboxId}' not found.`);
    }

    fhirVersion = assertFhirReleaseEnabled(sandbox.fhirVersion);
    partitionName = sandbox.sandboxId;
    sandboxSlug = sandbox.sandboxId;
  }

  if (!packageName) {
    throw new Error('packageName is required for package import.');
  }

  await ctx.updateProgress(10, `Downloading FHIR Package ${packageName}#${packageVersion || 'latest'}...`);

  const { buffer } = await fetchPackageTarball(packageName, packageVersion, tarballUrl);

  if (ctx.signal.aborted || (await ctx.isCancelled())) {
    throw new Error('Job was cancelled.');
  }

  await ctx.updateProgress(30, 'Decompressing package archive...');
  const gz = new Uint8Array(buffer);
  const tar = gunzipSync(gz);
  let extracted = extractJsonResourcesFromTar(tar);

  if (excludeExamples) {
    const before = extracted.length;
    extracted = extracted.filter(
      (item) => !isExampleResource(item.path, item.resource.id ? String(item.resource.id) : undefined),
    );
    await ctx.updateProgress(
      40,
      `Excluded examples: ${before - extracted.length} of ${before} resources removed.`,
    );
  }

  const resources = extracted.map((item) => item.resource);

  if (resources.length === 0) {
    throw new Error('No valid FHIR resources found in package.');
  }

  const destinationLabel =
    target === 'DEFAULT'
      ? `DEFAULT partition (${fhirVersion})`
      : `sandbox '${sandboxSlug}'`;

  await ctx.updateProgress(
    45,
    `Submitting ${resources.length} resources to ${destinationLabel} in batches...`,
  );

  const hapiBaseUrl = ctx.hapiClient.getHapiBaseUrl(fhirVersion);
  const batchSize = 40;
  const totalBatches = Math.ceil(resources.length / batchSize);
  let importedCount = 0;
  let failedCount = 0;
  const errors: string[] = [];
  const importedByType: Record<string, number> = {};
  const failedByType: Record<string, number> = {};

  for (let i = 0; i < totalBatches; i++) {
    if (ctx.signal.aborted || (await ctx.isCancelled())) {
      throw new Error('Job was cancelled.');
    }

    const chunk = resources.slice(i * batchSize, (i + 1) * batchSize);

    try {
      const result = await postFhirResourceBatch(hapiBaseUrl, partitionName, chunk, {
        timeoutMs: 30_000,
      });

      // HTTP-level failure with no per-entry outcomes (e.g. non-Bundle error body).
      if (result.status >= 400 && result.imported === 0 && result.failed === 0) {
        failedCount += chunk.length;
        for (const resource of chunk) {
          const type = String(resource.resourceType || 'Unknown');
          failedByType[type] = (failedByType[type] || 0) + 1;
        }
        if (errors.length < 100) {
          errors.push(`Batch HTTP ${result.status}`);
        }
      } else {
        importedCount += result.imported;
        failedCount += result.failed;

        const responseEntries = result.response.entry || [];
        for (let j = 0; j < chunk.length; j++) {
          const resource = chunk[j];
          const type = String(resource?.resourceType || 'Unknown');
          const status = String(
            (responseEntries[j] as { response?: { status?: string } } | undefined)?.response
              ?.status || '',
          );
          const code = parseInt(status, 10);
          const ok = Number.isFinite(code) && code >= 200 && code < 300;
          if (ok) {
            importedByType[type] = (importedByType[type] || 0) + 1;
          } else {
            failedByType[type] = (failedByType[type] || 0) + 1;
          }
        }

        for (const err of result.errors) {
          if (errors.length < 100) errors.push(err);
        }
      }
    } catch (err: any) {
      failedCount += chunk.length;
      for (const resource of chunk) {
        const type = String(resource.resourceType || 'Unknown');
        failedByType[type] = (failedByType[type] || 0) + 1;
      }
      console.warn(`Batch ${i + 1} warning:`, err?.message);
      if (errors.length < 100) errors.push(err?.message || 'batch failed');
    }

    const percent = Math.min(
      95,
      45 + Math.round(((importedCount + failedCount) / resources.length) * 50),
    );
    await ctx.updateProgress(
      percent,
      `Imported batch ${i + 1}/${totalBatches} (${importedCount} ok, ${failedCount} failed / ${resources.length} resources)`,
    );
  }

  if (importedCount === 0 && failedCount > 0) {
    throw new Error(
      `Package import failed for all resources. Sample errors: ${errors.slice(0, 10).join(' | ')}`,
    );
  }

  await ctx.updateProgress(
    100,
    `Package ${packageName}#${packageVersion} imported to ${destinationLabel} (${importedCount} ok, ${failedCount} failed).`,
  );

  return {
    packageName,
    packageVersion,
    target,
    fhirVersion,
    sandboxId: sandboxSlug,
    partitionName,
    excludeExamples: Boolean(excludeExamples),
    totalResources: resources.length,
    resourceTypeCounts: countByResourceType(resources),
    importedResources: importedCount,
    failedResources: failedCount,
    importedByType,
    failedByType,
    errors,
    importedAt: new Date().toISOString(),
  };
};
