// Author: Preston Lee

import crypto from 'node:crypto';
import express, { type Request, type Response, type Router } from 'express';
import * as client from 'openid-client';
import type { OidcBffConfig } from '../auth/sso_config.js';
import { extractSsoRoles } from '../auth/sso_config.js';
import { getPrisma } from '../db/prisma.js';
import {
  appointDefaultRoles,
  applyBootstrapAdminMembership,
  syncIdpRoleMappings,
} from '../authorization/iam.js';
import { loadEffectivePermissions } from '../authorization/effectivePermissions.js';
import {
  getOidcConfig,
  authorizationCodeGrantWithSecretRotation,
  buildEndSessionRedirect,
} from './oidc.js';
import {
  setSessionCookie,
  clearSessionCookie,
  absoluteExpiresAt,
  nextIdleExpiresAt,
  destroySessionByCookie,
} from './session.js';
import { encryptTokenBundle, type TokenBundle } from './token-crypto.js';
import { hmacSign, hmacVerify } from './hmac.js';

const OIDC_STATE_COOKIE = 'fhir_studio_oidc_state';

interface OidcTransientState {
  state: string;
  nonce: string;
  pkceVerifier: string;
  returnTo?: string;
}

export function createAuthRouter(oidc: OidcBffConfig): Router {
  const router = express.Router();
  const prisma = getPrisma(oidc.databaseUrl);

  // 1. GET /sso/login
  router.get('/sso/login', async (req: Request, res: Response): Promise<void> => {
    try {
      const config = await getOidcConfig(oidc);
      const pkceVerifier = client.randomPKCECodeVerifier();
      const codeChallenge = await client.calculatePKCECodeChallenge(pkceVerifier);
      const state = client.randomState();
      const nonce = client.randomNonce();
      const returnTo = typeof req.query.returnTo === 'string' ? req.query.returnTo : undefined;

      const transient: OidcTransientState = {
        state,
        nonce,
        pkceVerifier,
        returnTo,
      };

      const payloadJson = JSON.stringify(transient);
      res.cookie(OIDC_STATE_COOKIE, hmacSign(payloadJson, oidc.sessionSecret), {
        httpOnly: true,
        secure: oidc.nodeEnv === 'production',
        sameSite: 'lax',
        path: '/',
        maxAge: 10 * 60 * 1000,
      });

      const authUrl = client.buildAuthorizationUrl(config, {
        redirect_uri: oidc.redirectUrl,
        scope: oidc.scopes,
        code_challenge: codeChallenge,
        code_challenge_method: 'S256',
        state,
        nonce,
      });

      res.redirect(authUrl.href);
    } catch (err) {
      console.error('SSO login error:', err);
      res.status(500).send('Failed to initialize SSO login.');
    }
  });

  // 2. GET /sso/callback
  router.get('/sso/callback', async (req: Request, res: Response): Promise<void> => {
    try {
      const stateCookie = req.cookies?.[OIDC_STATE_COOKIE] as string | undefined;
      res.clearCookie(OIDC_STATE_COOKIE, { path: '/' });

      if (!stateCookie) {
        res.status(400).send('Missing OIDC state cookie.');
        return;
      }

      const verified = hmacVerify(stateCookie, oidc.sessionSecrets);
      if (!verified) {
        res.status(400).send('Invalid OIDC state signature.');
        return;
      }

      const transient = JSON.parse(verified.payload) as OidcTransientState;
      const currentUrl = new URL(
        req.originalUrl || req.url,
        `${req.protocol}://${req.get('host') || 'localhost:3000'}`,
      );

      const tokenResponse = await authorizationCodeGrantWithSecretRotation(
        oidc,
        currentUrl,
        {
          pkceCodeVerifier: transient.pkceVerifier,
          expectedState: transient.state,
          expectedNonce: transient.nonce,
        },
      );

      const claims = tokenResponse.claims() as Record<string, unknown> | undefined;
      const sub = typeof claims?.sub === 'string' ? claims.sub : null;
      if (!sub) {
        res.status(400).send('ID token is missing the required sub claim.');
        return;
      }

      const email = typeof claims?.email === 'string' ? claims.email : null;
      const displayName =
        typeof claims?.name === 'string'
          ? claims.name
          : typeof claims?.preferred_username === 'string'
          ? claims.preferred_username
          : email || sub;

      const ssoRoles = extractSsoRoles(tokenResponse.access_token, claims, oidc.rolesClaim);

      // Find or create user
      let user = await prisma.user.findUnique({
        where: {
          ssoIssuer_ssoSubject: {
            ssoIssuer: oidc.issuerUrl,
            ssoSubject: sub,
          },
        },
      });

      if (user) {
        if (user.isSuspended) {
          res.redirect(`${oidc.uiBaseUrl}/login?error=account_suspended`);
          return;
        }
        user = await prisma.user.update({
          where: { id: user.id },
          data: {
            email: email || user.email,
            displayName: displayName || user.displayName,
            lastLoginAt: new Date(),
          },
        });
      } else {
        user = await prisma.user.create({
          data: {
            ssoIssuer: oidc.issuerUrl,
            ssoSubject: sub,
            email,
            displayName,
            lastLoginAt: new Date(),
          },
        });
      }

      // Automatically map default roles, IdP group/role mappings, and bootstrap admin
      await appointDefaultRoles(prisma, user.id);
      await syncIdpRoleMappings(prisma, user.id, ssoRoles);
      await applyBootstrapAdminMembership(prisma, user.id, email, oidc.bootstrapAdminEmails);

      // Encrypt tokens for session
      const tokenBundle: TokenBundle = {
        refreshToken: tokenResponse.refresh_token || '',
        idToken: tokenResponse.id_token || '',
      };
      const encryptedBundle = tokenBundle.refreshToken
        ? encryptTokenBundle(tokenBundle, oidc.sessionSecret)
        : null;

      const now = new Date();
      const expiresAt = absoluteExpiresAt(now, oidc);
      const idleExpiresAt = nextIdleExpiresAt(now, expiresAt, oidc);
      const expiresInSec = typeof tokenResponse.expires_in === 'number' ? tokenResponse.expires_in : 3600;

      const session = await prisma.session.create({
        data: {
          userId: user.id,
          expiresAt,
          idleExpiresAt,
          encryptedTokenBundle: encryptedBundle,
          accessTokenExpiresAt: new Date(now.getTime() + expiresInSec * 1000),
          ssoRoles,
        },
      });

      setSessionCookie(res, session.id, oidc, idleExpiresAt);

      const targetUrl = transient.returnTo && transient.returnTo.startsWith('/')
        ? `${oidc.uiBaseUrl}${transient.returnTo}`
        : `${oidc.uiBaseUrl}/`;

      res.redirect(targetUrl);
    } catch (err) {
      console.error('SSO callback error:', err);
      res.status(500).send('Authentication callback failed.');
    }
  });

  // 3. POST & GET /sso/logout
  const logoutHandler = async (req: Request, res: Response): Promise<void> => {
    try {
      const bundle = await destroySessionByCookie(req, oidc);
      clearSessionCookie(res, oidc);

      const endSessionUrl = await buildEndSessionRedirect(oidc, bundle?.idToken);
      if (endSessionUrl) {
        res.redirect(endSessionUrl);
      } else {
        res.redirect(`${oidc.uiBaseUrl}/`);
      }
    } catch (err) {
      console.error('Logout error:', err);
      clearSessionCookie(res, oidc);
      res.redirect(`${oidc.uiBaseUrl}/`);
    }
  };

  router.get('/sso/logout', logoutHandler);
  router.post('/sso/logout', logoutHandler);

  // 4. GET /api/session
  router.get('/api/session', async (req: Request, res: Response): Promise<void> => {
    if (!req.sessionAuth) {
      res.status(200).json({
        authenticated: false,
        user: null,
        permissions: null,
      });
      return;
    }

    res.status(200).json({
      authenticated: true,
      user: {
        id: req.sessionAuth.userId,
        email: req.sessionAuth.email,
        displayName: req.sessionAuth.displayName,
        ssoSubject: req.sessionAuth.sub,
        ssoRoles: req.sessionAuth.ssoRoles,
      },
      permissions: req.effectivePermissions,
    });
  });

  return router;
}
