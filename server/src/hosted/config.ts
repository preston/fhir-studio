import path from 'node:path';
import {
  requireEnvAll,
  HOSTING_REQUIRED_ENV,
  HOSTING_STATIC_REQUIRED_ENV,
  requireEnv,
  isHostingEnabled,
} from '../env.js';
import crypto from 'node:crypto';
import { accessSync, constants, statSync } from 'node:fs';

export interface HostingConfig {
  domain: string;
  analyticsKey?: string;
  root: string;
  studioOrigin: string;
  encryptionKey: string;
  appId: string;
  clientId: string;
  clientSecret: string;
  privateKey: string;
  webhookSecret: string;
  slug: string;
  maxArchiveBytes: number;
  maxExpandedBytes: number;
  maxFiles: number;
  maxApps: number;
  maxStorageBytes: number;
  trustProxyHops?: number;
}
export function loadHostingConfig(
  mode: 'api' | 'worker' | 'host' = 'api',
): HostingConfig {
  if (!isHostingEnabled())
    throw new Error('Application hosting is disabled. Set FHIR_STUDIO_HOSTING_ENABLED=true and complete the hosting configuration to enable it.');
  const values = requireEnvAll(
    mode === 'host' ? HOSTING_STATIC_REQUIRED_ENV : HOSTING_REQUIRED_ENV,
  );
  const get = (name: string): string =>
    values.get(`FHIR_STUDIO_HOSTING_${name}`) || '';
  const root = get('ROOT');
  if (!/^[A-Za-z0-9+/]{43}=$/.test(get('ANALYTICS_KEY')) || Buffer.from(get('ANALYTICS_KEY'), 'base64').length !== 32)
    throw new Error('FHIR_STUDIO_HOSTING_ANALYTICS_KEY must be an independent base64-encoded 32-byte key.');
  const domain = get('DOMAIN').toLowerCase();
  const origin = new URL(get('STUDIO_ORIGIN'));
  if (
    !path.isAbsolute(root) ||
    domain.length > 253 ||
    !domain
      .split('.')
      .every((label) => /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(label)) ||
    !domain.endsWith(`.${origin.hostname}`) ||
    origin.origin !== get('STUDIO_ORIGIN')
  )
    throw new Error(
      'Hosting requires an absolute ROOT, a valid DNS sub-zone beneath STUDIO_ORIGIN, and an origin-only STUDIO_ORIGIN.',
    );
  if (!['https:', 'http:'].includes(origin.protocol))
    throw new Error('Hosting STUDIO_ORIGIN must use HTTP or HTTPS.');
  try {
    if (!statSync(root).isDirectory()) throw new Error('Not a directory');
    accessSync(
      root,
      constants.R_OK |
        constants.X_OK |
        (mode === 'worker' ? constants.W_OK : 0),
    );
  } catch {
    throw new Error(
      `Hosting ROOT must be an existing ${mode === 'worker' ? 'readable/writable' : 'readable'} directory accessible to this process: ${root}`,
    );
  }
  if (process.env.NODE_ENV === 'production' && origin.protocol !== 'https:')
    throw new Error('Production hosting requires HTTPS.');
  if (
    mode !== 'host' &&
    Buffer.from(get('ENCRYPTION_KEY'), 'base64').length !== 32
  )
    throw new Error(
      'FHIR_STUDIO_HOSTING_ENCRYPTION_KEY must be a base64-encoded 32-byte key.',
    );
  if (mode !== 'host') {
    if (
      !/^\d+$/.test(get('GITHUB_APP_ID')) ||
      !/^[a-z0-9-]+$/.test(get('GITHUB_SLUG'))
    )
      throw new Error('Invalid GitHub App ID or slug.');
    const key = crypto.createPrivateKey(
      get('GITHUB_PRIVATE_KEY').replace(/\\n/g, '\n'),
    );
    if (
      key.asymmetricKeyType !== 'rsa' ||
      (key.asymmetricKeyDetails?.modulusLength || 0) < 2048
    )
      throw new Error(
        'GitHub App signing requires an RSA private key of at least 2048 bits.',
      );
  }
  const limit = (name: string, fallback: number): number => {
    const value = Number(
      process.env[`FHIR_STUDIO_HOSTING_${name}`] || fallback,
    );
    if (!Number.isSafeInteger(value) || value < 1)
      throw new Error(`Invalid hosting limit: ${name}`);
    return value;
  };
  const trustProxyHops = Number(
    process.env.FHIR_STUDIO_HOSTING_TRUST_PROXY_HOPS || 0,
  );
  if (
    !Number.isSafeInteger(trustProxyHops) ||
    trustProxyHops < 0 ||
    trustProxyHops > 5
  )
    throw new Error('Invalid HOSTING_TRUST_PROXY_HOPS (0-5).');
  return {
    domain,
    analyticsKey: get('ANALYTICS_KEY'),
    root,
    studioOrigin: origin.origin,
    encryptionKey: get('ENCRYPTION_KEY'),
    appId: get('GITHUB_APP_ID'),
    clientId: get('GITHUB_CLIENT_ID'),
    clientSecret: get('GITHUB_CLIENT_SECRET'),
    privateKey: get('GITHUB_PRIVATE_KEY').replace(/\\n/g, '\n'),
    webhookSecret: get('GITHUB_WEBHOOK_SECRET'),
    slug: get('GITHUB_SLUG'),
    trustProxyHops,
    maxArchiveBytes: limit('MAX_ARCHIVE_BYTES', 20 * 1024 * 1024),
    maxExpandedBytes: limit('MAX_EXPANDED_BYTES', 50 * 1024 * 1024),
    maxFiles: limit('MAX_FILES', 1000),
    maxApps: limit('MAX_APPS_PER_USER', 10),
    maxStorageBytes: limit('MAX_STORAGE_BYTES', 10 * 1024 ** 3),
  };
}
/** Canonical browser origin remains explicit even when hosting is disabled. */
export function loadStudioOrigin(): string {
  return isHostingEnabled()
    ? loadHostingConfig().studioOrigin
    : new URL(requireEnv('FHIR_STUDIO_SERVER_UI_BASE_URL', 'UI_BASE_URL')).origin;
}
export function appOrigin(
  config: HostingConfig,
  id: string,
  channel: 'preview' | 'published',
): string {
  return `https://${channel === 'preview' ? 'preview' : 'app'}-${id}.${config.domain}`;
}
