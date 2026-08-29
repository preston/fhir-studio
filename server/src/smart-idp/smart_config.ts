// Author: Preston Lee

import type { SmartConfiguration } from '@fhir-studio/core';

export function generateSmartConfiguration(baseUrl: string): SmartConfiguration {
  const root = baseUrl.replace(/\/+$/, '');
  return {
    authorization_endpoint: `${root}/oauth/authorize`,
    token_endpoint: `${root}/oauth/token`,
    introspection_endpoint: `${root}/oauth/introspect`,
    revocation_endpoint: `${root}/oauth/revoke`,
    management_endpoint: `${root}/oauth/manage`,
    registration_endpoint: `${root}/oauth/register`,
    jwks_uri: `${root}/oauth/jwks.json`,
    capabilities: [
      'launch-ehr',
      'launch-standalone',
      'client-public',
      'client-confidential-symmetric',
      'client-confidential-asymmetric',
      'sso-openid-connect',
      'context-ehr-patient',
      'context-ehr-encounter',
      'context-standalone-patient',
      'permission-patient',
      'permission-user',
      'permission-system',
      'permission-v2',
      'smart-v2',
    ],
    code_challenge_methods_supported: ['S256'],
    response_types_supported: ['code'],
    grant_types_supported: ['authorization_code', 'refresh_token', 'client_credentials'],
    scopes_supported: [
      'openid',
      'profile',
      'email',
      'fhirUser',
      'launch',
      'launch/patient',
      'launch/encounter',
      'offline_access',
      'patient/*.rs',
      'patient/*.cruds',
      'user/*.rs',
      'user/*.cruds',
      'system/*.rs',
      'system/*.cruds',
      'patient/Patient.rs',
      'patient/Observation.rs',
      'patient/Condition.rs',
      'patient/Encounter.rs',
      'patient/MedicationRequest.rs',
      'patient/DocumentReference.rs',
    ],
    token_endpoint_auth_methods_supported: [
      'client_secret_basic',
      'client_secret_post',
      'private_key_jwt',
      'none',
    ],
    token_endpoint_auth_signing_alg_values_supported: ['RS256', 'ES256', 'HS256'],
  };
}
