// Author: Preston Lee

export type FhirRelease = 'R4' | 'R4B' | 'R5';

export const SUPPORTED_FHIR_RELEASES: readonly FhirRelease[] = ['R4', 'R4B', 'R5'] as const;

export function isSupportedFhirRelease(value: unknown): value is FhirRelease {
  return value === 'R4' || value === 'R4B' || value === 'R5';
}

/** HAPI URL-tenant name for the always-present default partition. */
export const HAPI_DEFAULT_PARTITION_NAME = 'DEFAULT';

/**
 * Resource types that HAPI FHIR refuses to store outside the DEFAULT partition
 * (HAPI-1318). IG conformance/terminology artifacts fall into this set.
 * @see https://hapifhir.io/hapi-fhir/docs/server_jpa_partitioning/partitioning.html
 */
export const HAPI_NON_PARTITIONABLE_RESOURCE_TYPES = [
  'CapabilityStatement',
  'CodeSystem',
  'CompartmentDefinition',
  'ConceptMap',
  'Library',
  'NamingSystem',
  'OperationDefinition',
  'Questionnaire',
  'SearchParameter',
  'StructureDefinition',
  'StructureMap',
  'ValueSet',
] as const;

export type HapiNonPartitionableResourceType =
  (typeof HAPI_NON_PARTITIONABLE_RESOURCE_TYPES)[number];

const HAPI_NON_PARTITIONABLE_RESOURCE_TYPE_SET: ReadonlySet<string> = new Set(
  HAPI_NON_PARTITIONABLE_RESOURCE_TYPES,
);

export function isHapiNonPartitionableResourceType(
  resourceType: string | null | undefined,
): boolean {
  return !!resourceType && HAPI_NON_PARTITIONABLE_RESOURCE_TYPE_SET.has(resourceType);
}

/** Resolve the HAPI URL partition segment for a given FHIR resource type. */
export function resolveHapiPartitionName(
  sandboxPartitionName: string,
  resourceType: string | null | undefined,
): string {
  return isHapiNonPartitionableResourceType(resourceType)
    ? HAPI_DEFAULT_PARTITION_NAME
    : sandboxPartitionName;
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


