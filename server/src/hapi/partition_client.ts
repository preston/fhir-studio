// Author: Preston Lee

import axios from 'axios';
import type { PrismaClient } from '@prisma/client';
import type { FhirRelease } from '@fhir-studio/core';
import {
  assertFhirReleaseEnabled,
  loadHapiConfig,
  type HapiPartitionConfig,
} from './config.js';

export type { HapiPartitionConfig } from './config.js';
export {
  assertFhirReleaseEnabled,
  enabledFhirVersionWhere,
  isFhirReleaseEnabled,
  loadHapiConfig,
  parseEnvBoolean,
} from './config.js';

export class HapiPartitionClient {
  private config: HapiPartitionConfig;

  constructor(config?: HapiPartitionConfig) {
    this.config = config || loadHapiConfig();
  }

  public getHapiBaseUrl(fhirVersion: FhirRelease | string): string {
    const release = assertFhirReleaseEnabled(fhirVersion);
    const baseUrl = this.config.baseUrls[release];
    if (!baseUrl) {
      throw new Error(`FHIR version '${release}' has no configured HAPI base URL.`);
    }
    return baseUrl;
  }

  /** Allocates the next sequential integer partition ID (1, 2, 3...) */
  public static async allocateNextPartitionId(prisma: PrismaClient): Promise<number> {
    const maxPartition = await prisma.sandbox.aggregate({
      _max: { partitionId: true },
    });
    return (maxPartition._max.partitionId ?? 0) + 1;
  }

  /** Dynamic Zero-Restart Partition Creation in Stock HAPI FHIR JPA v8.10 */
  public async createPartition(
    fhirVersion: FhirRelease | string,
    partitionId: number,
    partitionName: string,
    description?: string,
  ): Promise<void> {
    const baseUrl = this.getHapiBaseUrl(fhirVersion);
    const url = `${baseUrl}/DEFAULT/$partition-management-create-partition`;

    const parametersResource = {
      resourceType: 'Parameters',
      parameter: [
        {
          name: 'id',
          valueInteger: partitionId,
        },
        {
          name: 'name',
          valueString: partitionName,
        },
        ...(description
          ? [
              {
                name: 'description',
                valueString: description,
              },
            ]
          : []),
      ],
    };

    try {
      await axios.post(url, parametersResource, {
        headers: {
          'Content-Type': 'application/fhir+json',
          Accept: 'application/fhir+json',
        },
        timeout: 10_000,
      });
      console.log(`Created HAPI partition ${partitionId} ("${partitionName}") on ${fhirVersion}`);
    } catch (err: any) {
      // If HAPI is not currently running or returns an error, log warning so dev mode can proceed gracefully
      console.warn(
        `Failed to invoke $partition-management-create-partition on ${url}:`,
        err?.response?.data || err?.message || err,
      );
    }
  }

  /**
   * Dynamic Zero-Restart Partition Deletion in Stock HAPI FHIR JPA v8.10.
   *
   * Note: this only removes the partition registry row. FHIR resources tagged with the
   * partition ID are not deleted — call `destroyHapiTenant` (tenant_purge.ts) first.
   */
  public async deletePartition(
    fhirVersion: FhirRelease | string,
    partitionId: number,
    partitionName?: string,
    options: { throwOnError?: boolean } = {},
  ): Promise<void> {
    const throwOnError = options.throwOnError === true;

    // Admin purge may target sandboxes on disabled releases — skip HAPI when unavailable.
    let baseUrl: string;
    try {
      baseUrl = this.getHapiBaseUrl(fhirVersion);
    } catch (err: any) {
      const message = `Skipping HAPI partition delete for ${fhirVersion} partition ${partitionId}: ${err?.message || err}`;
      if (throwOnError) {
        throw new Error(message);
      }
      console.warn(message);
      return;
    }

    const url = `${baseUrl}/DEFAULT/$partition-management-delete-partition`;

    const parametersResource = {
      resourceType: 'Parameters',
      parameter: [
        {
          name: 'id',
          valueInteger: partitionId,
        },
        ...(partitionName
          ? [
              {
                name: 'name',
                valueString: partitionName,
              },
            ]
          : []),
      ],
    };

    try {
      const response = await axios.post(url, parametersResource, {
        headers: {
          'Content-Type': 'application/fhir+json',
          Accept: 'application/fhir+json',
        },
        timeout: 10_000,
        validateStatus: () => true,
      });

      if (response.status >= 200 && response.status < 300) {
        console.log(`Deleted HAPI partition ${partitionId} on ${fhirVersion}`);
        return;
      }

      const detail = response.data || `HTTP ${response.status}`;
      const detailText = typeof detail === 'string' ? detail : JSON.stringify(detail);
      // Idempotent: HAPI returns 500 IllegalArgumentException "No partition exists with ID …"
      // when the registry row is already gone.
      if (
        response.status === 404 ||
        /no partition exists/i.test(detailText) ||
        /unknown partition/i.test(detailText)
      ) {
        console.warn(
          `HAPI partition ${partitionId} already absent on ${fhirVersion}; treating delete as success.`,
        );
        return;
      }

      const message = `Failed to invoke $partition-management-delete-partition on ${url}: ${detailText}`;
      if (throwOnError) {
        throw new Error(message);
      }
      console.warn(message);
    } catch (err: any) {
      if (err?.message?.startsWith('Failed to invoke $partition-management-delete-partition')) {
        throw err;
      }
      const detail = err?.response?.data || err?.message || err;
      const message = `Failed to invoke $partition-management-delete-partition on ${url}: ${
        typeof detail === 'string' ? detail : JSON.stringify(detail)
      }`;
      if (throwOnError) {
        throw new Error(message);
      }
      console.warn(message);
    }
  }
}
