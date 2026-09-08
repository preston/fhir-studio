// Author: Preston Lee

import {
  SUPPORTED_FHIR_RELEASES,
  isSupportedFhirRelease,
  type FhirRelease,
} from '@fhir-studio/core';
import { exitMissingEnv, readEnv } from '../env.js';

export interface HapiReleaseConfig {
  release: FhirRelease;
  enabled: boolean;
  baseUrl?: string;
}

export interface HapiPartitionConfig {
  releases: readonly HapiReleaseConfig[];
  enabledReleases: readonly FhirRelease[];
  /** Base URLs keyed by enabled release only. */
  baseUrls: Readonly<Partial<Record<FhirRelease, string>>>;
}

const ENABLED_ENV: Record<FhirRelease, string> = {
  R4: 'FHIR_STUDIO_HAPI_R4_ENABLED',
  R4B: 'FHIR_STUDIO_HAPI_R4B_ENABLED',
  R5: 'FHIR_STUDIO_HAPI_R5_ENABLED',
};

const BASE_URL_ENV: Record<FhirRelease, string> = {
  R4: 'FHIR_STUDIO_HAPI_R4_BASE_URL',
  R4B: 'FHIR_STUDIO_HAPI_R4B_BASE_URL',
  R5: 'FHIR_STUDIO_HAPI_R5_BASE_URL',
};

/** Parse enable flags: true/1/yes → true; false/0/no → false; unset → true. */
export function parseEnvBoolean(value: string | undefined, defaultValue = true): boolean {
  if (value === undefined || value.trim() === '') {
    return defaultValue;
  }
  const normalized = value.trim().toLowerCase();
  if (['true', '1', 'yes'].includes(normalized)) {
    return true;
  }
  if (['false', '0', 'no'].includes(normalized)) {
    return false;
  }
  return defaultValue;
}

function normalizeBaseUrl(url: string): string {
  return url.replace(/\/+$/, '');
}

let cachedConfig: HapiPartitionConfig | undefined;

/**
 * Load HAPI FHIR release enablement and base URLs from env.
 * Enabled releases require a base URL (no localhost fallback).
 * At least one release must be enabled.
 */
export function loadHapiConfig(): HapiPartitionConfig {
  if (cachedConfig) {
    return cachedConfig;
  }

  const missing: string[] = [];
  const releases: HapiReleaseConfig[] = [];
  const enabledReleases: FhirRelease[] = [];
  const baseUrls: Partial<Record<FhirRelease, string>> = {};

  for (const release of SUPPORTED_FHIR_RELEASES) {
    const enabled = parseEnvBoolean(readEnv(ENABLED_ENV[release]));
    if (!enabled) {
      releases.push({ release, enabled: false });
      continue;
    }

    const rawUrl = readEnv(BASE_URL_ENV[release]);
    if (!rawUrl) {
      missing.push(BASE_URL_ENV[release]);
      releases.push({ release, enabled: true });
      continue;
    }

    const baseUrl = normalizeBaseUrl(rawUrl);
    releases.push({ release, enabled: true, baseUrl });
    enabledReleases.push(release);
    baseUrls[release] = baseUrl;
  }

  if (missing.length > 0) {
    exitMissingEnv(missing);
  }

  if (enabledReleases.length === 0) {
    console.error(
      'No FHIR releases are enabled. Set at least one of:\n' +
        SUPPORTED_FHIR_RELEASES.map((r) => `  - ${ENABLED_ENV[r]}=true`).join('\n') +
        '\n\nFor local development with docker/docker-compose.development.yml:\n' +
        '  cp server/.env.example server/.env\n',
    );
    process.exit(1);
  }

  cachedConfig = { releases, enabledReleases, baseUrls };
  return cachedConfig;
}

/** Whether a FHIR release string is both supported and enabled for this deployment. */
export function isFhirReleaseEnabled(value: unknown): value is FhirRelease {
  if (!isSupportedFhirRelease(value)) {
    return false;
  }
  return loadHapiConfig().enabledReleases.includes(value);
}

/**
 * Assert a release is enabled. Returns the normalized FhirRelease or throws Error
 * with a message suitable for HTTP 400 responses.
 */
export function assertFhirReleaseEnabled(value: unknown): FhirRelease {
  const normalized = typeof value === 'string' ? value.toUpperCase() : value;
  if (!isSupportedFhirRelease(normalized)) {
    throw new Error(
      `Unsupported FHIR version '${String(value)}'. Supported versions are ${SUPPORTED_FHIR_RELEASES.join(', ')}.`,
    );
  }
  if (!isFhirReleaseEnabled(normalized)) {
    throw new Error(
      `FHIR version '${normalized}' is not enabled on this deployment.`,
    );
  }
  return normalized;
}

/** Prisma / query filter: only sandboxes whose fhirVersion is currently enabled. */
export function enabledFhirVersionWhere(): { fhirVersion: { in: FhirRelease[] } } {
  return { fhirVersion: { in: [...loadHapiConfig().enabledReleases] } };
}
