// Author: Preston Lee

import type { SmartV2ParsedScope, SmartScopeAction } from '@fhir-studio/core';

/**
 * Parses SMART on FHIR v2 and v1 scope strings into structured scope definitions.
 * Example SMART v2 scopes:
 * - patient/Observation.rs?category=vital-signs
 * - user/Condition.cruds
 * - system/*.cruds
 * - launch/patient
 * - openid fhirUser offline_access
 */
export function parseSmartV2Scopes(scopeString?: string): SmartV2ParsedScope[] {
  if (!scopeString) return [];
  const rawScopes = scopeString.trim().split(/\s+/).filter(Boolean);
  const parsed: SmartV2ParsedScope[] = [];

  for (const raw of rawScopes) {
    if (['openid', 'profile', 'email', 'fhirUser', 'offline_access'].includes(raw)) {
      parsed.push({
        raw,
        context: raw as any,
      });
      continue;
    }

    if (raw === 'launch' || raw === 'launch/patient' || raw === 'launch/encounter') {
      parsed.push({
        raw,
        context: 'launch',
      });
      continue;
    }

    // Format: <context>/<resourceType>.<actions>?<queryParams>
    // e.g. patient/Observation.rs?category=vital-signs or user/*.read or system/*.cruds
    const match = raw.match(/^([a-z]+)\/([A-Za-z*]+)\.([A-Za-z*]+)(?:\?(.*))?$/);
    if (match) {
      const [, contextStr, resourceType, actionsStr, queryString] = match;
      if (['patient', 'user', 'system'].includes(contextStr)) {
        const filterParams: Record<string, string> = {};
        if (queryString) {
          const searchParams = new URLSearchParams(queryString);
          for (const [key, value] of searchParams.entries()) {
            filterParams[key] = value;
          }
        }

        const actions = parseScopeActions(actionsStr);
        parsed.push({
          raw,
          context: contextStr as 'patient' | 'user' | 'system',
          resourceType,
          actions,
          filterParams,
        });
      }
    }
  }

  return parsed;
}

function parseScopeActions(actionsStr: string): string[] {
  const actions: string[] = [];
  const lower = actionsStr.toLowerCase();

  if (lower === '*' || lower === 'all') {
    return ['c', 'r', 'u', 'd', 's'];
  }
  if (lower === 'read') {
    return ['r', 's'];
  }
  if (lower === 'write') {
    return ['c', 'u', 'd'];
  }

  // SMART v2 granular action letters: c (create), r (read), u (update), d (delete), s (search)
  for (const char of lower) {
    if (['c', 'r', 'u', 'd', 's'].includes(char)) {
      actions.push(char);
    }
  }

  return actions;
}

export function mapHttpMethodToAction(method: string, path: string): 'c' | 'r' | 'u' | 'd' | 's' {
  const m = method.toUpperCase();
  if (m === 'GET' || m === 'HEAD') {
    // If path ends with /_search or has query parameters, could be search or read
    const segments = path.split('?')[0].split('/').filter(Boolean);
    // e.g. /Patient (search), /Patient/123 (read), /Patient/_search (search)
    if (segments.length === 1 || segments[segments.length - 1] === '_search') {
      return 's';
    }
    return 'r';
  }
  if (m === 'POST') {
    if (path.includes('/_search')) {
      return 's';
    }
    return 'c';
  }
  if (m === 'PUT' || m === 'PATCH') {
    return 'u';
  }
  if (m === 'DELETE') {
    return 'd';
  }
  return 'r';
}

export function isSmartScopePermitted(
  parsedScopes: SmartV2ParsedScope[],
  requested: {
    resourceType?: string;
    action: 'c' | 'r' | 'u' | 'd' | 's';
    patientId?: string;
  },
): boolean {
  if (parsedScopes.length === 0) {
    return false;
  }

  for (const scope of parsedScopes) {
    if (!['patient', 'user', 'system'].includes(scope.context)) {
      continue;
    }

    // Check resource type match (* or exact match)
    if (scope.resourceType && scope.resourceType !== '*' && requested.resourceType) {
      if (scope.resourceType.toLowerCase() !== requested.resourceType.toLowerCase()) {
        continue;
      }
    }

    // Check action match
    if (scope.actions && scope.actions.length > 0) {
      if (scope.actions.includes(requested.action)) {
        return true;
      }
    }
  }

  return false;
}
