// Author: Preston Lee

export type FhirRelease = 'R4' | 'R4B' | 'R5';

export const SUPPORTED_FHIR_RELEASES: readonly FhirRelease[] = ['R4', 'R4B', 'R5'] as const;

export function isSupportedFhirRelease(value: unknown): value is FhirRelease {
  return value === 'R4' || value === 'R4B' || value === 'R5';
}

export interface FhirEndpointConfig {
  release: FhirRelease;
  partitionId: number;
  sandboxId: string;
  allowOpenAccess: boolean;
}

export interface FhirResourceSummary {
  resourceType: string;
  id: string;
  versionId?: string;
  lastUpdated?: string;
  profile?: string[];
  displayName?: string;
}

export interface FhirTypeCount {
  resourceType: string;
  count: number;
}

export interface SubscriptionTopicDefinition {
  id: string;
  url: string;
  title: string;
  status: 'draft' | 'active' | 'retired';
  resourceTrigger?: {
    description?: string;
    resource: string;
    supportedInteraction?: Array<'create' | 'update' | 'delete'>;
    queryCriteria?: {
      previous?: string;
      resultForCreate?: 'test-passes' | 'always';
      current?: string;
      resultForDelete?: 'test-passes' | 'always';
      requireBoth?: boolean;
    };
  };
}

export interface SubscriptionNotificationEvent {
  subscriptionId: string;
  topic: string;
  status: 'requested' | 'active' | 'error' | 'off';
  type: 'handshake' | 'heartbeat' | 'event-notification' | 'query-status';
  eventsSinceSubscriptionStart: number;
  timestamp: string;
  focusResource?: {
    resourceType: string;
    id: string;
    versionId?: string;
  };
}

