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

export interface FhirCapabilityStatementInteraction {
  code: string;
  documentation?: string;
}

export interface FhirCapabilityStatementSearchParam {
  name: string;
  definition?: string;
  type?: 'number' | 'date' | 'string' | 'token' | 'reference' | 'composite' | 'quantity' | 'uri' | 'special' | string;
  documentation?: string;
}

export interface FhirCapabilityStatementResource {
  type: string;
  profile?: string;
  supportedProfile?: string[];
  documentation?: string;
  interaction?: FhirCapabilityStatementInteraction[];
  searchParam?: FhirCapabilityStatementSearchParam[];
  searchInclude?: string[];
  searchRevInclude?: string[];
  conditionalCreate?: boolean;
  conditionalUpdate?: boolean;
  conditionalDelete?: string;
}

export interface FhirCapabilityStatementRest {
  mode: 'client' | 'server' | string;
  documentation?: string;
  security?: {
    cors?: boolean;
    service?: Array<{
      coding?: Array<{
        system?: string;
        code?: string;
        display?: string;
      }>;
      text?: string;
    }>;
    description?: string;
  };
  resource?: FhirCapabilityStatementResource[];
  interaction?: FhirCapabilityStatementInteraction[];
  searchParam?: FhirCapabilityStatementSearchParam[];
}

export interface FhirCapabilityStatement {
  resourceType: 'CapabilityStatement';
  id?: string;
  url?: string;
  version?: string;
  name?: string;
  title?: string;
  status: 'draft' | 'active' | 'retired' | 'unknown' | string;
  experimental?: boolean;
  date?: string;
  publisher?: string;
  kind?: 'instance' | 'capability' | 'requirements' | string;
  software?: {
    name: string;
    version?: string;
    releaseDate?: string;
  };
  implementation?: {
    description: string;
    url?: string;
  };
  fhirVersion: string;
  format?: string[];
  rest?: FhirCapabilityStatementRest[];
}


