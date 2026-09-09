// Author: Preston Lee

import axios from 'axios';
import type { FhirRelease } from '@fhir-studio/core';
import type { HapiPartitionClient } from './partition_client.js';

const FHIR_JSON_HEADERS = {
  'Content-Type': 'application/fhir+json',
  Accept: 'application/fhir+json',
} as const;

const REQUEST_TIMEOUT_MS = 120_000;
const PATIENT_PAGE_SIZE = 20;
/** Keep each cascade/conflict batch small so HAPI's delete-conflict budget is not exhausted. */
const EVERYTHING_PAGE_SIZE = 25;
const MAX_COMPARTMENT_PASSES = 500;

export interface TenantPurgeProgress {
  (message: string): void | Promise<void>;
}

export interface TenantPurgeOptions {
  signal?: AbortSignal;
  onProgress?: TenantPurgeProgress;
  isCancelled?: () => Promise<boolean>;
}

function formatHapiError(err: any): string {
  const data = err?.response?.data;
  if (data?.issue && Array.isArray(data.issue)) {
    const diagnostics = data.issue
      .map((i: { diagnostics?: string }) => i.diagnostics)
      .filter(Boolean)
      .join('; ');
    if (diagnostics) return diagnostics;
  }
  if (typeof data === 'string' && data.trim()) return data;
  return err?.message || String(err);
}

async function assertNotCancelled(
  signal: AbortSignal | undefined,
  isCancelled: (() => Promise<boolean>) | undefined,
): Promise<void> {
  if (signal?.aborted || (isCancelled && (await isCancelled()))) {
    throw new Error('Tenant purge was cancelled.');
  }
}

interface FhirBundleEntry {
  resource?: { resourceType?: string; id?: string };
}

async function deleteResource(
  tenantUrl: string,
  resourceType: string,
  id: string,
  cascade: boolean,
): Promise<{ ok: boolean; status: number; detail: string }> {
  const response = await axios.delete(
    `${tenantUrl}/${resourceType}/${encodeURIComponent(id)}`,
    {
      params: cascade ? { _cascade: 'delete' } : undefined,
      headers: {
        Accept: 'application/fhir+json',
        ...(cascade ? { 'X-Cascade': 'delete' } : {}),
      },
      timeout: REQUEST_TIMEOUT_MS,
      validateStatus: () => true,
    },
  );

  return {
    ok: response.status >= 200 && response.status < 300,
    status: response.status,
    detail: formatHapiError({ response }),
  };
}

/**
 * Drain a patient's compartment via `$everything` in small pages, then delete the Patient.
 * Avoids HAPI's per-request cascading-delete conflict budget (default ~10×60) which Synthea
 * sample patients routinely exceed.
 */
async function deletePatientAndCompartment(
  tenantUrl: string,
  patientId: string,
  options: TenantPurgeOptions,
): Promise<number> {
  const { signal, isCancelled } = options;
  let deletedRelated = 0;

  for (let pass = 1; pass <= MAX_COMPARTMENT_PASSES; pass++) {
    await assertNotCancelled(signal, isCancelled);

    const everything = await axios.get(
      `${tenantUrl}/Patient/${encodeURIComponent(patientId)}/$everything`,
      {
        params: { _count: EVERYTHING_PAGE_SIZE },
        headers: { Accept: 'application/fhir+json' },
        timeout: REQUEST_TIMEOUT_MS,
        validateStatus: () => true,
      },
    );

    if (everything.status === 404) {
      return deletedRelated;
    }
    if (everything.status < 200 || everything.status >= 300) {
      throw new Error(
        `Patient/${patientId}/$everything failed (HTTP ${everything.status}): ${formatHapiError({ response: everything })}`,
      );
    }

    const entries = (everything.data?.entry || []) as FhirBundleEntry[];
    const related = entries.filter((e) => {
      const type = e.resource?.resourceType;
      const id = e.resource?.id;
      return !!type && !!id && !(type === 'Patient' && id === patientId);
    });

    if (related.length === 0) {
      break;
    }

    let deletedThisPass = 0;
    for (const entry of related) {
      await assertNotCancelled(signal, isCancelled);
      const type = entry.resource!.resourceType!;
      const id = entry.resource!.id!;
      // Prefer non-cascade deletes for leaves to stay under HAPI conflict limits.
      let result = await deleteResource(tenantUrl, type, id, false);
      if (!result.ok && result.status === 409) {
        result = await deleteResource(tenantUrl, type, id, true);
      }
      if (result.ok) {
        deletedThisPass += 1;
        deletedRelated += 1;
      }
    }

    if (deletedThisPass === 0) {
      throw new Error(
        `Unable to delete Patient/${patientId} compartment resources after pass ${pass} (HAPI rejected deletes).`,
      );
    }
  }

  await assertNotCancelled(signal, isCancelled);
  let patientDelete = await deleteResource(tenantUrl, 'Patient', patientId, true);
  if (!patientDelete.ok && patientDelete.status === 409) {
    // Last resort: one more compartment drain, then retry.
    await deletePatientAndCompartmentDrainOnce(tenantUrl, patientId, options);
    patientDelete = await deleteResource(tenantUrl, 'Patient', patientId, true);
  }
  if (!patientDelete.ok && patientDelete.status !== 404) {
    throw new Error(
      `DELETE Patient/${patientId} failed (HTTP ${patientDelete.status}): ${patientDelete.detail}`,
    );
  }

  return deletedRelated;
}

async function deletePatientAndCompartmentDrainOnce(
  tenantUrl: string,
  patientId: string,
  options: TenantPurgeOptions,
): Promise<void> {
  const { signal, isCancelled } = options;
  await assertNotCancelled(signal, isCancelled);
  const everything = await axios.get(
    `${tenantUrl}/Patient/${encodeURIComponent(patientId)}/$everything`,
    {
      params: { _count: EVERYTHING_PAGE_SIZE },
      headers: { Accept: 'application/fhir+json' },
      timeout: REQUEST_TIMEOUT_MS,
      validateStatus: () => true,
    },
  );
  const entries = (everything.data?.entry || []) as FhirBundleEntry[];
  for (const entry of entries) {
    const type = entry.resource?.resourceType;
    const id = entry.resource?.id;
    if (!type || !id || (type === 'Patient' && id === patientId)) continue;
    await deleteResource(tenantUrl, type, id, true);
  }
}

/**
 * Page through Patients and delete each patient's compartment, then the Patient.
 */
async function cascadeDeleteAllPatients(
  tenantUrl: string,
  options: TenantPurgeOptions,
): Promise<{ patientsDeleted: number; relatedDeleted: number }> {
  const { signal, isCancelled, onProgress } = options;
  let patientsDeleted = 0;
  let relatedDeleted = 0;

  for (;;) {
    await assertNotCancelled(signal, isCancelled);

    const search = await axios.get(`${tenantUrl}/Patient`, {
      params: { _count: PATIENT_PAGE_SIZE, _elements: 'id' },
      headers: { Accept: 'application/fhir+json' },
      timeout: REQUEST_TIMEOUT_MS,
      validateStatus: () => true,
    });

    if (search.status < 200 || search.status >= 300) {
      throw new Error(
        `Failed searching Patients in tenant (HTTP ${search.status}): ${formatHapiError({ response: search })}`,
      );
    }

    const entries = (search.data?.entry || []) as FhirBundleEntry[];
    const patientIds = entries
      .map((e) => e.resource?.id)
      .filter((id): id is string => typeof id === 'string' && id.length > 0);

    if (patientIds.length === 0) {
      break;
    }

    for (const patientId of patientIds) {
      await assertNotCancelled(signal, isCancelled);
      await onProgress?.(
        `Deleting Patient/${patientId} and compartment resources (${patientsDeleted + 1} so far)...`,
      );
      relatedDeleted += await deletePatientAndCompartment(tenantUrl, patientId, options);
      patientsDeleted += 1;
    }
  }

  return { patientsDeleted, relatedDeleted };
}

/**
 * Expunge soft-deleted resources / history in this tenant only.
 * Never uses `expungeEverything` (unsafe across partitions / DEFAULT).
 */
async function expungeDeletedInPartition(
  tenantUrl: string,
  options: TenantPurgeOptions,
): Promise<number> {
  const { signal, isCancelled, onProgress } = options;
  await assertNotCancelled(signal, isCancelled);
  await onProgress?.('Expunging deleted resources from the HAPI partition...');

  const response = await axios.post(
    `${tenantUrl}/$expunge`,
    {
      resourceType: 'Parameters',
      parameter: [
        { name: 'expungeDeletedResources', valueBoolean: true },
        { name: 'expungePreviousVersions', valueBoolean: true },
      ],
    },
    {
      headers: FHIR_JSON_HEADERS,
      timeout: REQUEST_TIMEOUT_MS,
      validateStatus: () => true,
    },
  );

  if (response.status < 200 || response.status >= 300) {
    throw new Error(
      `Partition $expunge failed (HTTP ${response.status}): ${formatHapiError({ response })}`,
    );
  }

  const countParam = (response.data?.parameter || []).find(
    (p: { name?: string }) => p.name === 'count',
  );
  return typeof countParam?.valueInteger === 'number' ? countParam.valueInteger : 0;
}

/**
 * Purge tenant clinical data via Patient compartment deletes + partition $expunge,
 * then remove the HAPI partition registry entry.
 */
export async function destroyHapiTenant(
  hapiClient: HapiPartitionClient,
  fhirVersion: FhirRelease | string,
  partitionId: number,
  partitionName: string,
  options: TenantPurgeOptions = {},
): Promise<{ patientsDeleted: number; relatedDeleted: number; expungedCount: number }> {
  const { signal, isCancelled, onProgress } = options;

  await assertNotCancelled(signal, isCancelled);

  // Fail closed: never skip HAPI cleanup and still delete Postgres metadata upstream.
  const baseUrl = hapiClient.getHapiBaseUrl(fhirVersion);
  const tenantUrl = `${baseUrl}/${partitionName}`;

  await onProgress?.(
    `Deleting Patients and compartments in HAPI tenant '${partitionName}'...`,
  );
  const { patientsDeleted, relatedDeleted } = await cascadeDeleteAllPatients(tenantUrl, options);

  const expungedCount = await expungeDeletedInPartition(tenantUrl, options);

  await assertNotCancelled(signal, isCancelled);
  await onProgress?.(
    `Removing HAPI partition registry entry #${partitionId} ('${partitionName}')...`,
  );
  await hapiClient.deletePartition(fhirVersion, partitionId, partitionName, {
    throwOnError: true,
  });

  return { patientsDeleted, relatedDeleted, expungedCount };
}
