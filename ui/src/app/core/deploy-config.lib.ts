// Author: Preston Lee

/** `window` keys injected by `ui/public/configuration.template.js`. */
export const DeployConfigKeys = {
  PUBLIC_API_BASE_URL: 'FHIR_STUDIO_SERVER_PUBLIC_API_BASE_URL',
} as const;

type DeployConfigKey = (typeof DeployConfigKeys)[keyof typeof DeployConfigKeys];

const DeployConfigDefaults: Partial<Record<DeployConfigKey, string>> = {
  // Local split UI/API: UI on :4200, API on :3000.
  [DeployConfigKeys.PUBLIC_API_BASE_URL]: 'http://localhost:3000',
};

export function readDeployConfig(key: DeployConfigKey | string, fallback?: string): string {
  const raw = (window as unknown as Record<string, string | undefined>)[key];
  const trimmed = typeof raw === 'string' ? raw.trim() : '';
  // Unsubstituted ${VAR} templates should fall through to defaults.
  if (!trimmed || /^\$\{.+\}$/.test(trimmed)) {
    return fallback ?? DeployConfigDefaults[key as DeployConfigKey] ?? '';
  }
  return trimmed;
}

export function readDeployConfigUrl(key: DeployConfigKey | string, fallback?: string): string {
  return readDeployConfig(key, fallback).replace(/\/+$/, '');
}
