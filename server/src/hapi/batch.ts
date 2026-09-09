// Author: Preston Lee

import axios from 'axios';
import {
  HAPI_DEFAULT_PARTITION_NAME,
  isHapiNonPartitionableResourceType,
} from '@fhir-studio/core';

export interface FhirBatchRequestEntry {
  resource?: Record<string, unknown> & { resourceType?: string; id?: string };
  request?: {
    method?: string;
    url?: string;
  };
  fullUrl?: string;
}

export interface FhirBatchBundle {
  resourceType: 'Bundle';
  type?: string;
  entry?: FhirBatchRequestEntry[];
  [key: string]: unknown;
}

export interface FhirBatchPostResult {
  response: FhirBatchBundle;
  status: number;
  imported: number;
  failed: number;
  errors: string[];
}

function buildEntryRequest(resource: Record<string, any>): FhirBatchRequestEntry['request'] {
  const resourceType = String(resource.resourceType || '');
  const id = resource.id ? String(resource.id) : '';
  return {
    method: id ? 'PUT' : 'POST',
    url: id ? `${resourceType}/${id}` : resourceType,
  };
}

export function buildBatchBundle(
  resources: Array<Record<string, any>>,
  type: 'batch' | 'transaction' = 'batch',
): FhirBatchBundle {
  return {
    resourceType: 'Bundle',
    type,
    entry: resources.map((resource) => ({
      resource,
      request: buildEntryRequest(resource),
    })),
  };
}

export function partitionBatchEntries(entries: FhirBatchRequestEntry[]): {
  partitionable: Array<{ index: number; entry: FhirBatchRequestEntry }>;
  nonPartitionable: Array<{ index: number; entry: FhirBatchRequestEntry }>;
} {
  const partitionable: Array<{ index: number; entry: FhirBatchRequestEntry }> = [];
  const nonPartitionable: Array<{ index: number; entry: FhirBatchRequestEntry }> = [];

  entries.forEach((entry, index) => {
    const resourceType =
      entry.resource?.resourceType ||
      (typeof entry.request?.url === 'string' ? entry.request.url.split('/')[0] : undefined);
    if (isHapiNonPartitionableResourceType(resourceType)) {
      nonPartitionable.push({ index, entry });
    } else {
      partitionable.push({ index, entry });
    }
  });

  return { partitionable, nonPartitionable };
}

export function summarizeBatchResponse(bundle: FhirBatchBundle | null | undefined): {
  imported: number;
  failed: number;
  errors: string[];
} {
  const errors: string[] = [];
  let imported = 0;
  let failed = 0;

  for (const entry of bundle?.entry || []) {
    const status = String((entry as { response?: { status?: string } }).response?.status || '');
    const code = parseInt(status, 10);
    const ok = Number.isFinite(code) && code >= 200 && code < 300;
    if (ok) {
      imported += 1;
      continue;
    }
    failed += 1;
    const outcome = (entry as { resource?: { resourceType?: string; issue?: Array<{ diagnostics?: string }> } })
      .resource;
    const diagnostics =
      outcome?.resourceType === 'OperationOutcome'
        ? outcome.issue?.map((i) => i.diagnostics).filter(Boolean).join('; ')
        : undefined;
    errors.push(diagnostics || status || 'unknown batch entry failure');
  }

  return { imported, failed, errors };
}

/**
 * POST a batch/transaction Bundle, routing HAPI non-partitionable resource types
 * (StructureDefinition, ValueSet, …) to DEFAULT and the rest to the sandbox partition.
 */
export async function postFhirBatchBundle(
  hapiBaseUrl: string,
  sandboxPartitionName: string,
  bundle: FhirBatchBundle,
  options?: { timeoutMs?: number },
): Promise<FhirBatchPostResult> {
  const timeout = options?.timeoutMs ?? 30_000;
  const entries = bundle.entry || [];
  const { partitionable, nonPartitionable } = partitionBatchEntries(entries);

  if (partitionable.length === 0 && nonPartitionable.length === 0) {
    return {
      response: { resourceType: 'Bundle', type: `${bundle.type || 'batch'}-response`, entry: [] },
      status: 200,
      imported: 0,
      failed: 0,
      errors: [],
    };
  }

  // Fast path: everything targets one partition
  if (nonPartitionable.length === 0 || partitionable.length === 0) {
    const partitionName =
      nonPartitionable.length > 0 ? HAPI_DEFAULT_PARTITION_NAME : sandboxPartitionName;
    const response = await axios.post(`${hapiBaseUrl}/${partitionName}`, bundle, {
      headers: { 'Content-Type': 'application/fhir+json', Accept: 'application/fhir+json' },
      timeout,
      validateStatus: () => true,
    });
    const responseBundle = (response.data || {}) as FhirBatchBundle;
    const summary = summarizeBatchResponse(responseBundle);
    return {
      response: responseBundle,
      status: response.status,
      ...summary,
    };
  }

  const bundleType = (bundle.type === 'transaction' ? 'transaction' : 'batch') as
    | 'batch'
    | 'transaction';

  const [partitionableResult, nonPartitionableResult] = await Promise.all([
    axios.post(
      `${hapiBaseUrl}/${sandboxPartitionName}`,
      {
        resourceType: 'Bundle',
        type: bundleType,
        entry: partitionable.map((e) => e.entry),
      },
      {
        headers: { 'Content-Type': 'application/fhir+json', Accept: 'application/fhir+json' },
        timeout,
        validateStatus: () => true,
      },
    ),
    axios.post(
      `${hapiBaseUrl}/${HAPI_DEFAULT_PARTITION_NAME}`,
      {
        resourceType: 'Bundle',
        type: bundleType,
        entry: nonPartitionable.map((e) => e.entry),
      },
      {
        headers: { 'Content-Type': 'application/fhir+json', Accept: 'application/fhir+json' },
        timeout,
        validateStatus: () => true,
      },
    ),
  ]);

  const mergedEntries: FhirBatchRequestEntry[] = new Array(entries.length);
  const partitionableEntries = (partitionableResult.data?.entry || []) as FhirBatchRequestEntry[];
  const nonPartitionableEntries = (nonPartitionableResult.data?.entry ||
    []) as FhirBatchRequestEntry[];

  partitionable.forEach((item, i) => {
    mergedEntries[item.index] = partitionableEntries[i] || {
      response: { status: '502 Bad Gateway' },
      resource: {
        resourceType: 'OperationOutcome',
        issue: [
          {
            severity: 'error',
            code: 'transient',
            diagnostics: 'Missing batch entry response from sandbox partition.',
          },
        ],
      },
    };
  });
  nonPartitionable.forEach((item, i) => {
    mergedEntries[item.index] = nonPartitionableEntries[i] || {
      response: { status: '502 Bad Gateway' },
      resource: {
        resourceType: 'OperationOutcome',
        issue: [
          {
            severity: 'error',
            code: 'transient',
            diagnostics: 'Missing batch entry response from DEFAULT partition.',
          },
        ],
      },
    };
  });

  const responseBundle: FhirBatchBundle = {
    resourceType: 'Bundle',
    type: `${bundleType}-response`,
    entry: mergedEntries,
  };
  const summary = summarizeBatchResponse(responseBundle);
  const status =
    partitionableResult.status >= 500 || nonPartitionableResult.status >= 500
      ? Math.max(partitionableResult.status, nonPartitionableResult.status)
      : 200;

  return {
    response: responseBundle,
    status,
    ...summary,
  };
}

export async function postFhirResourceBatch(
  hapiBaseUrl: string,
  sandboxPartitionName: string,
  resources: Array<Record<string, any>>,
  options?: { timeoutMs?: number },
): Promise<FhirBatchPostResult> {
  return postFhirBatchBundle(
    hapiBaseUrl,
    sandboxPartitionName,
    buildBatchBundle(resources),
    options,
  );
}
