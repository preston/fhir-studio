// Author: Preston Lee

import type { Request, Response } from 'express';
import type { Session, User } from '@prisma/client';
import type { OidcBffConfig } from '../auth/sso_config.js';
import { extractSsoRoles } from '../auth/sso_config.js';
import { getPrisma } from '../db/prisma.js';
import { hmacSign, hmacVerify } from './hmac.js';
import { decryptTokenBundle, encryptTokenBundle, type TokenBundle } from './token-crypto.js';
import { refreshTokenGrant } from './oidc.js';

export const SESSION_COOKIE = 'fhir_studio_session';

const ACCESS_TOKEN_REFRESH_SKEW_MS = 60_000;

function decryptBundleForConfig(ciphertext: string, oidc: OidcBffConfig): TokenBundle | null {
  for (const secret of oidc.sessionSecrets) {
    const bundle = decryptTokenBundle(ciphertext, secret);
    if (bundle) {
      return bundle;
    }
  }
  return null;
}

const refreshInFlight = new Map<string, Promise<Session | null>>();

export function sessionCookieOptions(oidc: OidcBffConfig): {
  httpOnly: true;
  secure: boolean;
  sameSite: 'lax' | 'none';
  path: '/';
} {
  const secure = oidc.nodeEnv === 'production';
  return {
    httpOnly: true,
    secure,
    sameSite: secure ? 'none' : 'lax',
    path: '/',
  };
}

export function setSessionCookie(
  res: Response,
  sessionId: string,
  oidc: OidcBffConfig,
  expiresAt: Date,
): void {
  res.cookie(SESSION_COOKIE, hmacSign(sessionId, oidc.sessionSecret), {
    ...sessionCookieOptions(oidc),
    expires: expiresAt,
  });
}

export function clearSessionCookie(res: Response, oidc: OidcBffConfig): void {
  res.clearCookie(SESSION_COOKIE, sessionCookieOptions(oidc));
}

export function verifySessionCookie(
  cookieValue: string,
  secrets: readonly string[],
): { sessionId: string; usedPreviousSecret: boolean } | null {
  const result = hmacVerify(cookieValue, secrets);
  if (!result) {
    return null;
  }
  return { sessionId: result.payload, usedPreviousSecret: result.usedPreviousSecret };
}

export function sessionTtl(oidc: OidcBffConfig): { idleMs: number; absoluteMs: number } {
  return {
    idleMs: oidc.sessionIdleHours * 60 * 60 * 1000,
    absoluteMs: oidc.sessionAbsoluteHours * 60 * 60 * 1000,
  };
}

export function absoluteExpiresAt(createdAt: Date, oidc: OidcBffConfig): Date {
  return new Date(createdAt.getTime() + sessionTtl(oidc).absoluteMs);
}

export function nextIdleExpiresAt(now: Date, absolute: Date, oidc: OidcBffConfig): Date {
  const idle = new Date(now.getTime() + sessionTtl(oidc).idleMs);
  return idle < absolute ? idle : absolute;
}

export function isSessionExpired(session: Session, now: Date = new Date()): boolean {
  return session.idleExpiresAt <= now || session.expiresAt <= now;
}

function accessTokenNeedsRefresh(session: Session, now: Date = new Date()): boolean {
  if (!session.encryptedTokenBundle) {
    return false;
  }
  if (!session.accessTokenExpiresAt) {
    return true;
  }
  return session.accessTokenExpiresAt.getTime() - ACCESS_TOKEN_REFRESH_SKEW_MS <= now.getTime();
}

function parseSsoRolesJson(value: unknown): string[] {
  if (Array.isArray(value)) {
    return value.map(String);
  }
  return [];
}

async function refreshSessionTokens(session: Session, oidc: OidcBffConfig): Promise<Session | null> {
  const prisma = getPrisma(oidc.databaseUrl);
  const bundle = session.encryptedTokenBundle
    ? decryptBundleForConfig(session.encryptedTokenBundle, oidc)
    : null;
  if (!bundle?.refreshToken) {
    return session;
  }
  try {
    const tokens = await refreshTokenGrant(oidc, bundle.refreshToken);
    const nextBundle: TokenBundle = {
      refreshToken: tokens.refresh_token ?? bundle.refreshToken,
      idToken: tokens.id_token ?? bundle.idToken,
    };
    const expiresIn =
      typeof tokens.expires_in === 'number' && Number.isFinite(tokens.expires_in)
        ? tokens.expires_in
        : 3600;
    const idClaims = tokens.claims() as Record<string, unknown> | undefined;
    const ssoRoles = extractSsoRoles(tokens.access_token, idClaims, oidc.rolesClaim);
    return prisma.session.update({
      where: { id: session.id },
      data: {
        encryptedTokenBundle: encryptTokenBundle(nextBundle, oidc.sessionSecret),
        accessTokenExpiresAt: new Date(Date.now() + expiresIn * 1000),
        ...(ssoRoles.length > 0 ? { ssoRoles } : {}),
      },
    });
  } catch (err) {
    console.warn('IdP token refresh failed; destroying session', err);
    await prisma.session.delete({ where: { id: session.id } }).catch(() => undefined);
    return null;
  }
}

function refreshSessionTokensSerialized(
  session: Session,
  oidc: OidcBffConfig,
): Promise<Session | null> {
  const existing = refreshInFlight.get(session.id);
  if (existing) {
    return existing;
  }
  const pending = refreshSessionTokens(session, oidc).finally(() => {
    refreshInFlight.delete(session.id);
  });
  refreshInFlight.set(session.id, pending);
  return pending;
}

export async function slideSessionIdle(session: Session, oidc: OidcBffConfig): Promise<Session> {
  const prisma = getPrisma(oidc.databaseUrl);
  const now = new Date();
  const nextIdle = nextIdleExpiresAt(now, session.expiresAt, oidc);
  if (Math.abs(nextIdle.getTime() - session.idleExpiresAt.getTime()) < 30_000) {
    return session;
  }
  return prisma.session.update({
    where: { id: session.id },
    data: { idleExpiresAt: nextIdle },
  });
}

export interface ResolvedSession {
  session: Session;
  user: User;
  ssoRoles: string[];
  usedPreviousSecret: boolean;
}

export async function resolveSessionFromRequest(
  req: Request,
  oidc: OidcBffConfig,
): Promise<ResolvedSession | null> {
  const prisma = getPrisma(oidc.databaseUrl);
  const raw = req.cookies?.[SESSION_COOKIE] as string | undefined;
  if (!raw) {
    return null;
  }
  const verified = verifySessionCookie(raw, oidc.sessionSecrets);
  if (!verified) {
    return null;
  }
  let row = await prisma.session.findUnique({
    where: { id: verified.sessionId },
    include: { user: true },
  });
  if (!row || isSessionExpired(row)) {
    if (row) {
      await prisma.session.delete({ where: { id: row.id } }).catch(() => undefined);
    }
    return null;
  }

  // Account suspension enforcement:
  if (row.user.isSuspended) {
    await prisma.session.delete({ where: { id: row.id } }).catch(() => undefined);
    return null;
  }

  if (accessTokenNeedsRefresh(row)) {
    const refreshed = await refreshSessionTokensSerialized(row, oidc);
    if (!refreshed) {
      return null;
    }
    row = { ...row, ...refreshed, user: row.user };
  }

  const slid = await slideSessionIdle(row, oidc);
  const session = { ...row, ...slid };
  return {
    session,
    user: row.user,
    ssoRoles: parseSsoRolesJson(session.ssoRoles),
    usedPreviousSecret: verified.usedPreviousSecret,
  };
}

export async function destroySessionByCookie(
  req: Request,
  oidc: OidcBffConfig,
): Promise<TokenBundle | null> {
  const prisma = getPrisma(oidc.databaseUrl);
  const raw = req.cookies?.[SESSION_COOKIE] as string | undefined;
  if (!raw) {
    return null;
  }
  const verified = verifySessionCookie(raw, oidc.sessionSecrets);
  if (!verified) {
    return null;
  }
  const row = await prisma.session.findUnique({ where: { id: verified.sessionId } });
  if (!row) {
    return null;
  }
  const bundle = row.encryptedTokenBundle
    ? decryptBundleForConfig(row.encryptedTokenBundle, oidc)
    : null;
  await prisma.session.delete({ where: { id: row.id } }).catch(() => undefined);
  return bundle;
}

export function sessionSsoRoles(session: Session): string[] {
  return parseSsoRolesJson(session.ssoRoles);
}
