// Author: Preston Lee

import { exitMissingEnv, requireEnvAll, SERVER_REQUIRED_ENV } from '../env.js';

export interface OidcBffConfig {
  issuerUrl: string;
  clientId: string;
  clientSecret: string;
  clientSecretPrevious: string[];
  redirectUrl: string;
  scopes: string;
  postLogoutRedirectUrl: string;
  uiBaseUrl: string;
  corsOrigins: string[];
  sessionSecret: string;
  sessionSecrets: string[];
  sessionIdleHours: number;
  sessionAbsoluteHours: number;
  databaseUrl: string;
  rolesClaim: string;
  bootstrapAdminEmails: string[];
  apiTokenPepper: string;
  nodeEnv: string;
}

function csv(name: string, fallback = ''): string[] {
  const raw = process.env[name]?.trim() ?? fallback;
  return raw
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
}

function parsePreviousSecrets(current: string, raw: string | undefined): string[] {
  if (!raw?.trim()) {
    return [];
  }
  const seen = new Set<string>([current]);
  const previous: string[] = [];
  for (const part of raw.split(/[,\s]+/)) {
    const secret = part.trim();
    if (!secret || seen.has(secret)) {
      continue;
    }
    seen.add(secret);
    previous.push(secret);
  }
  return previous;
}

function positiveHours(name: string, fallback: number): number {
  const raw = process.env[name]?.trim();
  if (!raw) {
    return fallback;
  }
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) {
    return fallback;
  }
  return n;
}

export function loadSsoConfig(): OidcBffConfig {
  const values = requireEnvAll(SERVER_REQUIRED_ENV);

  const issuerUrl = values.get('FHIR_STUDIO_SERVER_SSO_ISSUER_URL')!;
  const clientId = values.get('FHIR_STUDIO_SERVER_SSO_CLIENT_ID')!;
  const clientSecret = values.get('FHIR_STUDIO_SERVER_SSO_CLIENT_SECRET')!;
  const redirectUrl = values.get('FHIR_STUDIO_SERVER_SSO_REDIRECT_URL')!;
  const postLogoutRedirectUrl = values.get('FHIR_STUDIO_SERVER_SSO_POST_LOGOUT_REDIRECT_URL')!;
  const uiBaseUrl = values.get('FHIR_STUDIO_SERVER_UI_BASE_URL')!;
  const sessionSecret = values.get('FHIR_STUDIO_SERVER_SESSION_SECRET')!;
  const databaseUrl = values.get('FHIR_STUDIO_SERVER_DATABASE_URL')!;
  const apiTokenPepper = values.get('FHIR_STUDIO_SERVER_API_TOKEN_PEPPER')!;
  const corsOrigins = csv('FHIR_STUDIO_SERVER_CORS_ORIGINS');
  if (corsOrigins.length === 0) {
    exitMissingEnv(['FHIR_STUDIO_SERVER_CORS_ORIGINS']);
  }

  const nodeEnv = process.env.NODE_ENV?.trim() || 'development';

  const sessionSecrets = [sessionSecret, ...parsePreviousSecrets(sessionSecret, process.env.FHIR_STUDIO_SERVER_SESSION_SECRET_PREVIOUS)];
  const clientSecretPrevious = parsePreviousSecrets(
    clientSecret,
    process.env.FHIR_STUDIO_SERVER_SSO_CLIENT_SECRET_PREVIOUS,
  );

  return {
    issuerUrl,
    clientId,
    clientSecret,
    clientSecretPrevious,
    redirectUrl,
    scopes: process.env.FHIR_STUDIO_SERVER_SSO_SCOPES?.trim() || 'openid profile email offline_access',
    postLogoutRedirectUrl,
    uiBaseUrl: uiBaseUrl.replace(/\/+$/, ''),
    corsOrigins,
    sessionSecret,
    sessionSecrets,
    sessionIdleHours: positiveHours('FHIR_STUDIO_SERVER_SESSION_IDLE_HOURS', 8),
    sessionAbsoluteHours: positiveHours('FHIR_STUDIO_SERVER_SESSION_ABSOLUTE_HOURS', 12),
    databaseUrl,
    rolesClaim: process.env.FHIR_STUDIO_SERVER_SSO_ROLES_CLAIM?.trim() || 'roles',
    bootstrapAdminEmails: csv('FHIR_STUDIO_SERVER_BOOTSTRAP_ADMIN_EMAILS', 'administrator@localhost'),
    apiTokenPepper,
    nodeEnv,
  };
}

export function decodeJwtPayload(token: string): Record<string, unknown> | null {
  const parts = token.split('.');
  if (parts.length < 2 || !parts[1]) {
    return null;
  }
  try {
    const json = Buffer.from(parts[1], 'base64url').toString('utf8');
    const parsed = JSON.parse(json) as unknown;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return null;
    }
    return parsed as Record<string, unknown>;
  } catch {
    return null;
  }
}

export function rolesFromClaims(claims: Record<string, unknown>, claim: string): string[] {
  const raw = claims[claim];
  if (Array.isArray(raw)) {
    return raw.map(String);
  }
  if (typeof raw === 'string' && raw.length > 0) {
    return [raw];
  }
  return [];
}

export function extractSsoRoles(
  accessToken: string | undefined,
  idTokenClaims: Record<string, unknown> | undefined,
  rolesClaim: string,
): string[] {
  if (accessToken) {
    const payload = decodeJwtPayload(accessToken);
    if (payload) {
      const fromAccess = rolesFromClaims(payload, rolesClaim);
      if (fromAccess.length > 0) {
        return fromAccess;
      }
    }
  }
  if (idTokenClaims) {
    return rolesFromClaims(idTokenClaims, rolesClaim);
  }
  return [];
}
