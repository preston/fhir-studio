// Author: Preston Lee

import axios from 'axios';
import { gunzipSync } from 'fflate';
import type { JobHandler } from '../types.js';

function extractJsonResourcesFromTar(tarBytes: Uint8Array): any[] {
  const resources: any[] = [];
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
          resources.push(parsed);
        }
      } catch {
        // ignore malformed
      }
    }

    offset += Math.ceil(fileSize / 512) * 512;
  }

  return resources;
}

export const packageImportHandler: JobHandler = async (ctx) => {
  const input = (ctx.job.input as Record<string, any>) || {};
  const { packageName, packageVersion, sandboxId: inputSandboxId } = input;
  const sandboxId = inputSandboxId || ctx.job.sandboxId;

  if (!sandboxId) {
    throw new Error('Sandbox ID is required for package import.');
  }

  const isUuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(sandboxId);
  const sandbox = await ctx.prisma.sandbox.findFirst({
    where: isUuid ? { OR: [{ id: sandboxId }, { sandboxId }] } : { sandboxId },
  });

  if (!sandbox) {
    throw new Error(`Sandbox '${sandboxId}' not found.`);
  }

  await ctx.updateProgress(10, `Downloading FHIR Package ${packageName}#${packageVersion}...`);

  const tarballUrl = `https://packages.fhir.org/${packageName}/${packageVersion}`;
  const resp = await axios.get(tarballUrl, {
    responseType: 'arraybuffer',
    timeout: 60_000,
  });

  if (ctx.signal.aborted || (await ctx.isCancelled())) {
    throw new Error('Job was cancelled.');
  }

  await ctx.updateProgress(30, 'Decompressing package archive...');
  const gz = new Uint8Array(resp.data);
  const tar = gunzipSync(gz);
  const resources = extractJsonResourcesFromTar(tar);

  if (resources.length === 0) {
    throw new Error('No valid FHIR resources found in package.');
  }

  await ctx.updateProgress(45, `Submitting ${resources.length} resources to sandbox in batches...`);

  const hapiBaseUrl = ctx.hapiClient.getHapiBaseUrl(sandbox.fhirVersion);
  const tenantUrl = `${hapiBaseUrl}/${sandbox.sandboxId}`;
  const batchSize = 40;
  const totalBatches = Math.ceil(resources.length / batchSize);
  let importedCount = 0;

  for (let i = 0; i < totalBatches; i++) {
    if (ctx.signal.aborted || (await ctx.isCancelled())) {
      throw new Error('Job was cancelled.');
    }

    const chunk = resources.slice(i * batchSize, (i + 1) * batchSize);
    const bundle = {
      resourceType: 'Bundle',
      type: 'batch',
      entry: chunk.map((res) => ({
        resource: res,
        request: {
          method: res.id ? 'PUT' : 'POST',
          url: res.id ? `${res.resourceType}/${res.id}` : res.resourceType,
        },
      })),
    };

    try {
      await axios.post(tenantUrl, bundle, {
        headers: { 'Content-Type': 'application/fhir+json' },
        timeout: 30_000,
      });
      importedCount += chunk.length;
    } catch (err: any) {
      console.warn(`Batch ${i + 1} warning:`, err?.message);
    }

    const percent = Math.min(95, 45 + Math.round((importedCount / resources.length) * 50));
    await ctx.updateProgress(percent, `Imported batch ${i + 1}/${totalBatches} (${importedCount}/${resources.length} resources)`);
  }

  await ctx.updateProgress(100, `Package ${packageName}#${packageVersion} imported successfully.`);

  return {
    packageName,
    packageVersion,
    sandboxId: sandbox.sandboxId,
    totalResources: resources.length,
    importedResources: importedCount,
    importedAt: new Date().toISOString(),
  };
};
