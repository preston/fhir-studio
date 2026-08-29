// Author: Preston Lee

import type { FhirRelease } from './fhir.js';

export type SandboxVisibility = 'PUBLIC' | 'PRIVATE';

export interface SandboxSummary {
  id: string;
  sandboxId: string;
  name: string;
  description: string | null;
  fhirVersion: FhirRelease;
  partitionId: number;
  allowOpenAccess: boolean;
  visibility: SandboxVisibility;
  isShared: boolean;
  isPayer?: boolean;
  createdByUserId: string;
  createdByUser?: {
    id: string;
    email: string | null;
    displayName: string | null;
  } | null;
  lastAccessedAt?: string | null;
  createdAt: string;
  updatedAt: string;
}

export type SandboxAgePreset =
  | 'all'
  | '7d'
  | '30d'
  | '90d'
  | '180d'
  | '365d'
  | 'older_than_30d'
  | 'older_than_90d'
  | 'older_than_180d'
  | 'older_than_365d';

export type SandboxLastUsedPreset =
  | 'all'
  | 'never'
  | 'active_7d'
  | 'active_30d'
  | 'inactive_30d'
  | 'inactive_90d'
  | 'inactive_180d'
  | 'inactive_365d';

export type SandboxSortField =
  | 'name'
  | 'sandboxId'
  | 'createdAt'
  | 'lastAccessedAt'
  | 'fhirVersion'
  | 'partitionId'
  | 'createdBy';

export interface AdministrationSandboxFilter {
  search?: string;
  user?: string;
  fhirVersion?: string;
  agePreset?: SandboxAgePreset;
  lastUsedPreset?: SandboxLastUsedPreset;
  sortBy?: SandboxSortField;
  sortOrder?: 'asc' | 'desc';
  page?: number;
  limit?: number;
}

export interface AdministrationSandboxListResponse {
  sandboxes: SandboxSummary[];
  total: number;
  page: number;
  limit: number;
  totalPages: number;
}

export interface SandboxSlugAvailability {
  available: boolean;
  slug: string;
  reason?: string;
}

export interface ApplicationRegistration {
  id: string;
  sandboxId: string | null;
  clientId: string;
  clientSecret: string | null;
  clientName: string;
  clientUri?: string | null;
  logoUri?: string | null;
  launchUri: string;
  redirectUris: string[];
  scope: string;
  isCustom: boolean;
  isSample: boolean;
  briefDescription?: string | null;
  author?: string | null;
  samplePatients?: string | null;
  manifestUrl?: string | null;
  tokenEndpointAuthMethod?: 'none' | 'client_secret_basic' | 'client_secret_post' | 'private_key_jwt';
  jwksUri?: string | null;
  jwks?: Record<string, unknown> | null;
  pkceRequired?: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface LaunchScenarioSummary {
  id: string;
  sandboxId: string;
  title: string;
  description: string | null;
  applicationId: string | null;
  application?: ApplicationRegistration | null;
  userPersonaId: string | null;
  patientFhirId: string | null;
  patientName: string | null;
  encounterFhirId: string | null;
  locationFhirId: string | null;
  intent: string | null;
  smartStyleUrl: string | null;
  needPatientBanner: boolean;
  fhirContext?: Array<{
    type?: string;
    reference?: string;
    [key: string]: unknown;
  }>;
  contextParams: Record<string, string>;
  lastLaunchAt: string | null;
  createdAt: string;
  updatedAt: string;
}


export interface UserPersonaSummary {
  id: string;
  sandboxId: string;
  personaUserId: string;
  personaName: string;
  fhirResourceType: string;
  fhirResourceId: string;
  fhirResourceName: string;
  createdAt: string;
  updatedAt: string;
}
