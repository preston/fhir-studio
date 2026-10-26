import type { PrismaClient, Sandbox, SmartAuthSession } from '@prisma/client';
import type { EffectivePermissions } from '@fhir-studio/core';
import type { SessionAuthContext } from '../authentication/requireAuthentication.js';
import { extractBearerToken } from '../authentication/apiToken.js';
import { hasPermission } from '../authorization/permissions.js';
import {
  isSmartScopePermitted,
  mapHttpMethodToAction,
  parseSmartV2Scopes,
} from '../smart-idp/scopes.js';

export interface SandboxAuthResult {
  authorized: boolean;
  reason?: string;
  isSmartClient?: boolean;
  smartSession?: SmartAuthSession;
  patientRestricted?: boolean;
}
export async function verifySandboxAccess(
  prisma: PrismaClient,
  sandbox: Sandbox,
  authHeader: string | undefined,
  sessionAuth: SessionAuthContext | undefined,
  effectivePermissions: EffectivePermissions | undefined,
  request?: { method: string; path: string; resourceType?: string },
): Promise<SandboxAuthResult> {
  const bearer = extractBearerToken(authHeader);
  // Explicit SMART credentials never inherit a browser session or open-access authority.
  if (bearer && sessionAuth?.sessionId !== '') {
    const session = await prisma.smartAuthSession.findFirst({
      where: {
        accessToken: bearer,
        isRevoked: false,
        sandboxId: sandbox.sandboxId,
        sandboxRowId: sandbox.id,
      },
    });
    if (
      !session ||
      session.sandboxRowId !== sandbox.id ||
      !session.tokenExpiresAt ||
      session.tokenExpiresAt < new Date()
    )
      return { authorized: false, reason: 'Invalid or expired sandbox token' };
    const client = await prisma.application.findUnique({
      where: { clientId: session.clientId },
      include: { hostedApplication: true },
    });
    if (!client)
      return { authorized: false, reason: 'Unregistered SMART client' };
    const app = client.hostedApplication;
    // Operations may read or mutate resource types beyond the URL's first type.
    // An ordinary resource grant cannot authorize $everything, $graphql, or CQL endpoints.
    if (request?.path.split('/').some(segment => segment.startsWith('$')))
      return { authorized: false, reason: 'Forbidden: SMART applications require an explicitly supported FHIR resource operation' };
    if (
      app &&
      (app.deletedAt ||
        app.suspended ||
        (client.hostedChannel === 'preview'
          ? !app.previewBuildId
          : !app.publishedBuildId))
    )
      return { authorized: false, reason: 'Hosted application is unavailable' };
    const scopes = parseSmartV2Scopes(session.scope);
    if (
      request &&
      !['/metadata', '/.well-known/smart-configuration'].includes(request.path)
    ) {
      if (!request.resourceType)
        return {
          authorized: false,
          reason:
            'Forbidden: SMART batch and untyped operations are not permitted',
        };
      const parts = request.path.split('/').filter(Boolean);
      const ordinaryPath = parts.length === 1 ||
        (parts.length === 2 && (!parts[1].startsWith('_') || ['_search', '_history'].includes(parts[1]))) ||
        ([3, 4].includes(parts.length) && !parts[1].startsWith('_') && parts[2] === '_history');
      if (!ordinaryPath)
        return { authorized: false, reason: 'Forbidden: SMART compartment and extended paths require explicit resource authorization' };
      const action = parts.length === 2 && parts[1] === '_history' && ['GET', 'HEAD'].includes(request.method)
        ? 's'
        : mapHttpMethodToAction(request.method, request.path);
      if (
        !isSmartScopePermitted(scopes, {
          resourceType: request.resourceType,
          action,
        })
      )
        return {
          authorized: false,
          reason: 'Forbidden: granted scopes do not permit this operation',
        };
      const unrestricted = isSmartScopePermitted(
        scopes.filter((s) => s.context === 'user' || s.context === 'system'),
        { resourceType: request.resourceType, action },
      );
      if (!unrestricted && !session.patientFhirId)
        return {
          authorized: false,
          reason: 'Forbidden: patient launch context is required',
        };
      return {
        authorized: true,
        isSmartClient: true,
        smartSession: session,
        patientRestricted: !unrestricted,
      };
    }
    return { authorized: true, isSmartClient: true, smartSession: session };
  }
  if (
    hasPermission(effectivePermissions, 'global_manage') ||
    sandbox.createdByUserId === sessionAuth?.userId
  )
    return { authorized: true };
  if (sessionAuth) {
    const member = await prisma.sandboxCollaborator.findUnique({
      where: {
        sandboxId_userId: { sandboxId: sandbox.id, userId: sessionAuth.userId },
      },
    });
    if (member) {
      if (
        member.role === 'READ_ONLY' &&
        request &&
        !['GET', 'HEAD', 'OPTIONS'].includes(request.method) &&
        !(request.method === 'POST' && request.path.endsWith('/_search'))
      )
        return {
          authorized: false,
          reason: 'Forbidden: read-only sandbox collaborator',
        };
      return { authorized: true };
    }
  }
  return sandbox.allowOpenAccess
    ? { authorized: true }
    : { authorized: false, reason: 'Sandbox authorization required' };
}
