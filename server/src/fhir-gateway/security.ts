// Author: Preston Lee

import type { PrismaClient, Sandbox } from '@prisma/client';
import { extractBearerToken } from '../authentication/apiToken.js';
import { hasPermission } from '../authorization/permissions.js';
import { isSmartScopePermitted, mapHttpMethodToAction, parseSmartV2Scopes } from '../smart-idp/scopes.js';

export interface SandboxAuthResult {
  authorized: boolean;
  reason?: string;
  isSmartClient?: boolean;
  smartSession?: any;
}

export async function verifySandboxAccess(
  prisma: PrismaClient,
  sandbox: Sandbox,
  authHeader: string | undefined,
  sessionAuth: any | undefined,
  effectivePermissions: any | undefined,
  requestDetails?: {
    method: string;
    path: string;
    resourceType?: string;
  },
): Promise<SandboxAuthResult> {
  // 1. Open Access Mode allows anonymous read/write
  if (sandbox.allowOpenAccess) {
    return { authorized: true };
  }

  // 2. Global management permission allows access to all sandboxes
  if (hasPermission(effectivePermissions, 'global_manage')) {
    return { authorized: true };
  }

  // 3. Authenticated User Session (Owner or Collaborator)
  if (sessionAuth && sessionAuth.userId) {
    if (sandbox.createdByUserId === sessionAuth.userId) {
      return { authorized: true };
    }
    const collaborator = await prisma.sandboxCollaborator.findUnique({
      where: {
        sandboxId_userId: {
          sandboxId: sandbox.id,
          userId: sessionAuth.userId,
        },
      },
    });
    if (collaborator) {
      return { authorized: true };
    }
  }

  // 4. SMART OAuth Bearer Token Verification & Scope Evaluation
  const bearerToken = extractBearerToken(authHeader);
  if (bearerToken) {
    const smartSession = await prisma.smartAuthSession.findFirst({
      where: {
        accessToken: bearerToken,
        isRevoked: false,
        OR: [{ sandboxId: sandbox.sandboxId }, { sandboxId: 'default' }],
      },
    });

    if (smartSession) {
      if (smartSession.tokenExpiresAt && smartSession.tokenExpiresAt < new Date()) {
        return { authorized: false, reason: 'SMART access token has expired' };
      }

      // Check SMART granular scopes if request details are supplied
      if (requestDetails) {
        const parsedScopes = parseSmartV2Scopes(smartSession.scope);
        const action = mapHttpMethodToAction(requestDetails.method, requestDetails.path);
        const resourceType = requestDetails.resourceType;

        // Skip metadata / .well-known / capability statement checks
        if (requestDetails.path.includes('metadata') || requestDetails.path.includes('.well-known')) {
          return { authorized: true, isSmartClient: true, smartSession };
        }

        const isAllowed = isSmartScopePermitted(parsedScopes, {
          resourceType,
          action,
          patientId: smartSession.patientFhirId || undefined,
        });

        if (!isAllowed && parsedScopes.length > 0) {
          return {
            authorized: false,
            reason: `Forbidden: Granted SMART scopes ('${smartSession.scope}') do not permit action '${action}' on resource '${resourceType || 'unknown'}'.`,
          };
        }
      }

      return {
        authorized: true,
        isSmartClient: true,
        smartSession,
      };
    }
  }

  return { authorized: false, reason: 'Unauthorized: Sandbox is secured and requires valid authentication' };
}
