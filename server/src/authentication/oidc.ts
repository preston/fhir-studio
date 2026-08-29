// Author: Preston Lee

import * as client from 'openid-client';
import type { Configuration } from 'openid-client';
import type { OidcBffConfig } from '../auth/sso_config.js';

const configBySecret = new Map<string, Configuration>();

function discoveryOptionsForIssuer(
  issuerUrl: string,
): client.DiscoveryRequestOptions | undefined {
  if (!issuerUrl.startsWith('http://')) {
    return undefined;
  }
  return { execute: [client.allowInsecureRequests] };
}

function wrapOidcDiscoveryError(err: unknown, issuerUrl: string): Error {
  const message = err instanceof Error ? err.message : String(err);
  const cause = err instanceof Error && err.cause instanceof Error ? err.cause.message : '';
  const detail = cause || message;
  const unreachable =
    message === 'fetch failed' || /ECONNREFUSED|ENOTFOUND|EHOSTUNREACH|connect/i.test(detail);
  if (unreachable) {
    return new Error(
      `Cannot reach SSO issuer at ${issuerUrl}. Start the IdP or fix FHIR_STUDIO_SERVER_SSO_ISSUER_URL. (${detail})`,
    );
  }
  return err instanceof Error ? err : new Error(message);
}

export async function getOidcConfig(
  oidc: OidcBffConfig,
  clientSecret: string = oidc.clientSecret,
): Promise<Configuration> {
  const cached = configBySecret.get(clientSecret);
  if (cached) {
    return cached;
  }
  let config: Configuration;
  try {
    config = await client.discovery(
      new URL(oidc.issuerUrl),
      oidc.clientId,
      clientSecret,
      undefined,
      discoveryOptionsForIssuer(oidc.issuerUrl),
    );
  } catch (err) {
    throw wrapOidcDiscoveryError(err, oidc.issuerUrl);
  }
  configBySecret.set(clientSecret, config);
  return config;
}

export async function authorizationCodeGrantWithSecretRotation(
  oidc: OidcBffConfig,
  callbackUrl: URL,
  checks: {
    pkceCodeVerifier: string;
    expectedState: string;
    expectedNonce: string;
  },
): Promise<Awaited<ReturnType<typeof client.authorizationCodeGrant>>> {
  const secrets = [oidc.clientSecret, ...oidc.clientSecretPrevious];
  let lastError: unknown;
  for (let i = 0; i < secrets.length; i++) {
    const secret = secrets[i];
    if (!secret) {
      continue;
    }
    try {
      const config = await getOidcConfig(oidc, secret);
      return await client.authorizationCodeGrant(config, callbackUrl, checks);
    } catch (err) {
      lastError = err;
      if (i === secrets.length - 1 || !isLikelyClientAuthenticationError(err)) {
        throw err;
      }
      console.warn(
        'Token exchange failed with current/previous client secret; trying next secret during rotation',
      );
    }
  }
  throw lastError instanceof Error ? lastError : new Error('Token exchange failed');
}

export async function refreshTokenGrant(
  oidc: OidcBffConfig,
  refreshToken: string,
): Promise<Awaited<ReturnType<typeof client.refreshTokenGrant>>> {
  const config = await getOidcConfig(oidc);
  return client.refreshTokenGrant(config, refreshToken);
}

export async function buildEndSessionRedirect(
  oidc: OidcBffConfig,
  idTokenHint: string | undefined,
): Promise<string | null> {
  try {
    const config = await getOidcConfig(oidc);
    const endSession = config.serverMetadata().end_session_endpoint;
    if (!endSession) {
      return null;
    }
    const params: Record<string, string> = {
      post_logout_redirect_uri: oidc.postLogoutRedirectUrl,
    };
    if (idTokenHint) {
      params['id_token_hint'] = idTokenHint;
    }
    return client.buildEndSessionUrl(config, params).href;
  } catch {
    return null;
  }
}

function isLikelyClientAuthenticationError(err: unknown): boolean {
  const message = err instanceof Error ? err.message : String(err);
  const lower = message.toLowerCase();
  return (
    lower.includes('invalid_client') ||
    lower.includes('unauthorized_client') ||
    lower.includes('client authentication') ||
    lower.includes('401')
  );
}

export function clearOidcConfigCache(): void {
  configBySecret.clear();
}

export { client as oidcClient };
