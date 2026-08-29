// Author: Preston Lee

import type { NextFunction, Request, Response } from 'express';
import type { OidcBffConfig } from '../auth/sso_config.js';
import { getPrisma } from '../db/prisma.js';
import { loadEffectivePermissions } from '../authorization/effectivePermissions.js';
import type { EffectivePermissions } from '@fhir-studio/core';
import { resolveSessionFromRequest, setSessionCookie } from './session.js';
import { extractBearerToken, hashApiToken, loadApiTokenPepper } from './apiToken.js';

export interface SessionAuthContext {
  sub: string;
  ssoRoles: string[];
  userId: string;
  sessionId: string;
  email: string | null;
  displayName: string | null;
  isSuspended: boolean;
}

declare global {
  namespace Express {
    interface Request {
      sessionAuth?: SessionAuthContext;
      effectivePermissions?: EffectivePermissions;
    }
  }
}

export function createSessionAuth(oidc: OidcBffConfig) {
  const apiTokenPepper = loadApiTokenPepper();

  async function attachFromSession(req: Request, res: Response): Promise<boolean> {
    const resolved = await resolveSessionFromRequest(req, oidc);
    if (!resolved) {
      return false;
    }
    if (resolved.user.isSuspended) {
      return false;
    }
    const prisma = getPrisma(oidc.databaseUrl);
    const permissions = await loadEffectivePermissions(prisma, resolved.user.id);
    req.sessionAuth = {
      sub: resolved.user.ssoSubject,
      ssoRoles: resolved.ssoRoles,
      userId: resolved.user.id,
      sessionId: resolved.session.id,
      email: resolved.user.email,
      displayName: resolved.user.displayName,
      isSuspended: resolved.user.isSuspended,
    };
    req.effectivePermissions = permissions;
    setSessionCookie(res, resolved.session.id, oidc, resolved.session.idleExpiresAt);
    return true;
  }

  async function attachFromApiToken(req: Request): Promise<boolean> {
    const token = extractBearerToken(req.get('authorization') ?? undefined);
    if (!token) {
      return false;
    }
    const prisma = getPrisma(oidc.databaseUrl);
    const tokenHash = hashApiToken(token, apiTokenPepper);
    const record = await prisma.apiToken.findFirst({
      where: { tokenHash },
      include: { user: true },
    });
    if (!record || record.user.isSuspended) {
      return false;
    }
    const permissions = await loadEffectivePermissions(prisma, record.userId);
    req.sessionAuth = {
      sub: record.user.ssoSubject,
      ssoRoles: [],
      userId: record.userId,
      sessionId: '',
      email: record.user.email,
      displayName: record.user.displayName,
      isSuspended: record.user.isSuspended,
    };
    req.effectivePermissions = permissions;
    void prisma.apiToken.update({
      where: { id: record.id },
      data: { lastUsedAt: new Date() },
    }).catch((err) => {
      console.warn('Failed to update API token lastUsedAt', err);
    });
    return true;
  }

  async function attachAuth(req: Request, res: Response, sessionOnly: boolean): Promise<boolean> {
    if (await attachFromSession(req, res)) {
      return true;
    }
    if (sessionOnly) {
      return false;
    }
    return attachFromApiToken(req);
  }

  async function optionalAuthentication(
    req: Request,
    res: Response,
    next: NextFunction,
  ): Promise<void> {
    try {
      await attachAuth(req, res, false);
      next();
    } catch (err) {
      next(err);
    }
  }

  async function requireAuthentication(
    req: Request,
    res: Response,
    next: NextFunction,
  ): Promise<void> {
    try {
      const ok = await attachAuth(req, res, false);
      if (!ok) {
        res.status(401).json({ error: 'Unauthorized' });
        return;
      }
      next();
    } catch (err) {
      next(err);
    }
  }

  async function requireSessionAuthentication(
    req: Request,
    res: Response,
    next: NextFunction,
  ): Promise<void> {
    try {
      const ok = await attachAuth(req, res, true);
      if (!ok) {
        res.status(401).json({ error: 'Unauthorized' });
        return;
      }
      next();
    } catch (err) {
      next(err);
    }
  }

  return {
    optionalAuthentication,
    requireAuthentication,
    requireSessionAuthentication,
  };
}
