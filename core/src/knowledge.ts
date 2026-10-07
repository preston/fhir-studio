// Author: Preston Lee

import type { FhirRelease } from './fhir.js';

/** Resource types accepted by POST /api/knowledge/publish into HAPI DEFAULT. */
export const KNOWLEDGE_PUBLISH_RESOURCE_TYPES = [
  'Library',
  'ValueSet',
  'CodeSystem',
  'ConceptMap',
  'NamingSystem',
  'ImplementationGuide',
] as const;

export type KnowledgePublishResourceType = (typeof KNOWLEDGE_PUBLISH_RESOURCE_TYPES)[number];

const KNOWLEDGE_PUBLISH_RESOURCE_TYPE_SET: ReadonlySet<string> = new Set(
  KNOWLEDGE_PUBLISH_RESOURCE_TYPES,
);

export function isKnowledgePublishResourceType(
  resourceType: string | null | undefined,
): resourceType is KnowledgePublishResourceType {
  return !!resourceType && KNOWLEDGE_PUBLISH_RESOURCE_TYPE_SET.has(resourceType);
}

/** Well-known helper Library names checked during capabilities / ensure-dependencies. */
export const KNOWLEDGE_HELPER_LIBRARY_NAMES = ['FHIRHelpers', 'FHIR-ModelInfo'] as const;

export type KnowledgeHelperLibraryName = (typeof KNOWLEDGE_HELPER_LIBRARY_NAMES)[number];

export interface KnowledgeHelperStatus {
  name: KnowledgeHelperLibraryName;
  present: boolean;
  id?: string;
  url?: string;
  version?: string;
}

export interface KnowledgeCapabilitiesResponse {
  product: 'fhir-studio';
  apiVersion: string;
  fhirVersions: FhirRelease[];
  knowledgePublish: boolean;
  deepLinks: {
    dataManagerShared: string;
    cqlWithFhirExample: string;
  };
  helpers: KnowledgeHelperStatus[];
}

export interface KnowledgePublishSummary {
  imported: number;
  failed: number;
  errors: string[];
  fhirVersion: FhirRelease;
}

export interface PersonalAccessTokenListItem {
  id: string;
  name: string;
  expiresAt: string | null;
  lastUsedAt: string | null;
  createdAt: string;
}

export interface PersonalAccessTokenMintResponse {
  token: string;
  id: string;
  name: string;
  expiresAt: string | null;
  createdAt: string;
}

/** @deprecated Use PersonalAccessTokenListItem */
export type ApiTokenListItem = PersonalAccessTokenListItem;
/** @deprecated Use PersonalAccessTokenMintResponse */
export type ApiTokenMintResponse = PersonalAccessTokenMintResponse;
