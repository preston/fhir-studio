// Author: Preston Lee

import crypto from 'node:crypto';
import { requireEnv } from '../env.js';

export function loadApiTokenPepper(): string {
  return requireEnv('FHIR_STUDIO_SERVER_API_TOKEN_PEPPER', 'API_TOKEN_PEPPER');
}

export function extractBearerToken(header: string | undefined): string | null {
  if (!header) return null;
  const match = header.match(/^Bearer\s+(.+)$/i);
  return match ? match[1].trim() : null;
}

export function hashApiToken(token: string, pepper: string): string {
  return crypto.createHmac('sha256', pepper).update(token).digest('base64url');
}

export function generateApiToken(pepper: string): {
  token: string;
  prefix: string;
  hash: string;
} {
  const random = crypto.randomBytes(32).toString('base64url');
  const token = `fs_${random}`;
  const prefix = token.slice(0, 10);
  const hash = hashApiToken(token, pepper);
  return { token, prefix, hash };
}
