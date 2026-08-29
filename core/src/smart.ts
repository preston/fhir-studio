// Author: Preston Lee

import type { FhirRelease } from './fhir.js';

export interface SmartConfiguration {
  authorization_endpoint: string;
  token_endpoint: string;
  introspection_endpoint?: string;
  revocation_endpoint?: string;
  management_endpoint?: string;
  registration_endpoint?: string;
  jwks_uri?: string;
  capabilities: string[];
  token_endpoint_auth_methods_supported?: string[];
  token_endpoint_auth_signing_alg_values_supported?: string[];
  response_types_supported?: string[];
  grant_types_supported?: string[];
  scopes_supported?: string[];
  code_challenge_methods_supported?: string[];
}

export type SmartScopeAction = 'c' | 'r' | 'u' | 'd' | 's' | 'cruds' | 'read' | 'write' | '*';

export interface SmartV2ParsedScope {
  raw: string;
  context: 'patient' | 'user' | 'system' | 'launch' | 'openid' | 'fhirUser' | 'profile' | 'email' | 'offline_access';
  resourceType?: string;
  actions?: string[];
  filterParams?: Record<string, string>;
}

export interface SmartLaunchContext {
  launchId: string;
  sandboxId: string;
  fhirVersion: FhirRelease;
  applicationId?: string;
  userPersonaId?: string;
  patientFhirId?: string;
  patientName?: string;
  encounterFhirId?: string;
  locationFhirId?: string;
  intent?: string;
  smartStyleUrl?: string;
  needPatientBanner?: boolean;
  fhirContext?: Array<{
    type?: string;
    reference?: string;
    canonical?: string;
    identifier?: { system?: string; value?: string };
    [key: string]: unknown;
  }>;
  params?: Record<string, string>;
  createdAt: string;
  expiresAt: string;
}

export interface SmartTokenResponse {
  access_token: string;
  token_type: 'Bearer';
  expires_in: number;
  scope: string;
  id_token?: string;
  refresh_token?: string;
  patient?: string;
  encounter?: string;
  location?: string;
  intent?: string;
  smart_style_url?: string;
  need_patient_banner?: boolean;
  fhirContext?: Array<{
    type?: string;
    reference?: string;
    [key: string]: unknown;
  }>;
  [key: string]: unknown;
}

export interface SmartIdTokenClaims {
  iss: string;
  sub: string;
  aud: string;
  exp: number;
  iat: number;
  auth_time?: number;
  nonce?: string;
  fhirUser?: string;
  name?: string;
  email?: string;
  profile?: string;
}

export interface SmartIntrospectionResponse {
  active: boolean;
  scope?: string;
  client_id?: string;
  sub?: string;
  exp?: number;
  iat?: number;
  nbf?: number;
  aud?: string | string[];
  iss?: string;
  token_type?: string;
  patient?: string;
  encounter?: string;
  fhirUser?: string;
  fhirContext?: Array<{
    type?: string;
    reference?: string;
    [key: string]: unknown;
  }>;
}

export interface SmartClientRegistrationRequest {
  client_name: string;
  redirect_uris: string[];
  grant_types?: string[];
  response_types?: string[];
  token_endpoint_auth_method?: 'none' | 'client_secret_basic' | 'client_secret_post' | 'private_key_jwt';
  scope?: string;
  jwks_uri?: string;
  jwks?: Record<string, unknown>;
  logo_uri?: string;
  client_uri?: string;
  contacts?: string[];
}

export interface SmartClientRegistrationResponse extends SmartClientRegistrationRequest {
  client_id: string;
  client_secret?: string;
  client_id_issued_at?: number;
  client_secret_expires_at?: number;
  registration_access_token?: string;
  registration_client_uri?: string;
}

export interface BulkExportRequest {
  exportType: 'system' | 'patient' | 'group';
  groupId?: string;
  _since?: string;
  _type?: string[];
  _elements?: string[];
  _typeFilter?: string[];
  _outputFormat?: string;
}

export interface BulkExportFileEntry {
  type: string;
  url: string;
  count?: number;
}

export interface BulkExportStatusResponse {
  transactionTime: string;
  request: string;
  requiresAccessToken: boolean;
  output: BulkExportFileEntry[];
  error: Array<{ type: string; url: string }>;
}

