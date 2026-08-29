// Author: Preston Lee

import express, { type Request, type Response, type Router } from 'express';
import { v4 as uuidv4 } from 'uuid';
import { getPrisma } from '../db/prisma.js';
import { generateSmartConfiguration } from './smart_config.js';
import {
  generateIdToken,
  generateRandomToken,
  getPublicJwks,
  verifyClientAssertionJwt,
  verifyPkceChallenge,
} from './crypto.js';

export function createSmartIdpRouter(): Router {
  const router = express.Router();
  const prisma = getPrisma();

  // 1. SMART Configuration Discovery Endpoints
  const configHandler = (req: Request, res: Response): void => {
    const host = req.get('host') || 'localhost:3000';
    const protocol = req.protocol || 'http';
    const baseUrl = `${protocol}://${host}`;
    const smartConfig = generateSmartConfiguration(baseUrl);
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Content-Type', 'application/json');
    res.status(200).json(smartConfig);
  };

  router.get('/api/sandboxes/:sandboxId/fhir/:version/.well-known/smart-configuration', configHandler);
  router.get('/api/sandboxes/:sandboxId/.well-known/smart-configuration', configHandler);
  router.get('/.well-known/smart-configuration', configHandler);

  // 2. JWKS Public Keys Endpoint (RFC 7517)
  const jwksHandler = (_req: Request, res: Response): void => {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Content-Type', 'application/json');
    res.status(200).json(getPublicJwks());
  };
  router.get('/oauth/jwks.json', jwksHandler);
  router.get('/.well-known/jwks.json', jwksHandler);

  // 3. RFC 7591 Dynamic Client Registration Endpoint
  router.post('/oauth/register', async (req: Request, res: Response): Promise<void> => {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Content-Type', 'application/json');

    try {
      const {
        client_name = 'Dynamic SMART Application',
        redirect_uris = [],
        token_endpoint_auth_method = 'client_secret_basic',
        scope = 'openid profile email patient/*.rs launch launch/patient',
        jwks_uri,
        jwks,
        logo_uri,
        client_uri,
      } = req.body;

      if (!Array.isArray(redirect_uris) || redirect_uris.length === 0) {
        res.status(400).json({
          error: 'invalid_redirect_uri',
          error_description: 'At least one redirect_uri is required.',
        });
        return;
      }

      const clientId = `application-${uuidv4()}`;
      const clientSecret = token_endpoint_auth_method === 'none' ? null : generateRandomToken(32);

      const application = await prisma.application.create({
        data: {

          clientId,
          clientSecret,
          clientName: client_name,
          clientUri: client_uri || null,
          logoUri: logo_uri || null,
        launchUri: redirect_uris[0],
        redirectUris: redirect_uris,
        scope,
          tokenEndpointAuthMethod: token_endpoint_auth_method,
          jwksUri: jwks_uri || null,
          jwks: jwks ? JSON.parse(JSON.stringify(jwks)) : null,
          isCustom: true,
          isSample: false,
        },
      });

      const host = req.get('host') || 'localhost:3000';
      const protocol = req.protocol || 'http';
      const baseUrl = `${protocol}://${host}`;

      res.status(201).json({
        client_id: application.clientId,
        client_secret: application.clientSecret || undefined,
        client_name: application.clientName,
        redirect_uris: application.redirectUris,
        token_endpoint_auth_method: application.tokenEndpointAuthMethod,
        scope: application.scope,
        jwks_uri: application.jwksUri || undefined,
        registration_client_uri: `${baseUrl}/oauth/register/${application.clientId}`,
        client_id_issued_at: Math.floor(application.createdAt.getTime() / 1000),
      });
    } catch (err: any) {
      console.error('Dynamic client registration error:', err);
      res.status(500).json({
        error: 'server_error',
        error_description: 'Failed to register client.',
      });
    }
  });

  // 4. Create SMART Launch Context (invoked by EHR Simulator or Launch Scenario)
  router.post('/api/sandboxes/:sandboxId/launch-context', async (req: Request, res: Response): Promise<void> => {
    const sandboxId = req.params.sandboxId;
    const {
      patientFhirId,
      patientName,
      encounterFhirId,
      userPersonaId,
      applicationId,
      clientId,
      fhirContext,
      scope = 'launch launch/patient patient/*.rs openid profile fhirUser',
    } = req.body;

    const sandbox = await prisma.sandbox.findUnique({
      where: { sandboxId },
    });

    if (!sandbox) {
      res.status(404).json({ error: `Sandbox '${sandboxId}' not found.` });
      return;
    }

    const launchId = uuidv4();
    const codeExpiresAt = new Date(Date.now() + 15 * 60 * 1000); // 15 minutes to initiate launch

    await prisma.smartAuthSession.create({
      data: {
        sandboxId,
        clientId: clientId || 'default-client',
        launchId,
        patientFhirId: patientFhirId || null,
        encounterFhirId: encounterFhirId || null,
        userPersonaId: userPersonaId || null,
        fhirVersion: sandbox.fhirVersion,
        fhirContext: fhirContext ? JSON.parse(JSON.stringify(fhirContext)) : null,
        redirectUri: '',
        scope,
        codeExpiresAt,
      },
    });

    res.status(201).json({
      launch: launchId,
      sandboxId,
      expiresIn: 900,
    });
  });

  // 5. GET /oauth/authorize (SMART Authorize Endpoint)
  router.get('/oauth/authorize', async (req: Request, res: Response): Promise<void> => {
    try {
      const {
        response_type,
        client_id,
        redirect_uri,
        scope = 'patient/*.rs openid profile',
        state,
        launch,
        code_challenge,
        code_challenge_method = 'S256',
        aud,
      } = req.query as Record<string, string | undefined>;

      if (response_type !== 'code') {
        res.status(400).send('Invalid response_type. Must be "code".');
        return;
      }

      if (!client_id || !redirect_uri) {
        res.status(400).send('Missing client_id or redirect_uri.');
        return;
      }

      // Determine target sandbox
      let targetSandboxId = 'default';
      if (aud) {
        const match = aud.match(/\/api\/sandboxes\/([^\/]+)/);
        if (match && match[1]) {
          targetSandboxId = match[1];
        }
      }

      const generatedCode = generateRandomToken(32);
      const codeExpiresAt = new Date(Date.now() + 5 * 60 * 1000); // 5 min code validity

      if (launch) {
        // EHR Launch Flow
        const existingSession = await prisma.smartAuthSession.findFirst({
          where: { launchId: launch },
        });

        if (existingSession) {
          await prisma.smartAuthSession.update({
            where: { id: existingSession.id },
            data: {
              clientId: client_id,
              redirectUri: redirect_uri,
              code: generatedCode,
              codeChallenge: code_challenge || null,
              codeChallengeMethod: code_challenge_method || 'S256',
              scope: scope || existingSession.scope,
              codeExpiresAt,
            },
          });
        } else {
          await prisma.smartAuthSession.create({
            data: {
              sandboxId: targetSandboxId,
              clientId: client_id,
              redirectUri: redirect_uri,
              launchId: launch,
              code: generatedCode,
              codeChallenge: code_challenge || null,
              codeChallengeMethod: code_challenge_method || 'S256',
              scope,
              codeExpiresAt,
            },
          });
        }
      } else {
        // Standalone Launch Flow
        await prisma.smartAuthSession.create({
          data: {
            sandboxId: targetSandboxId,
            clientId: client_id,
            redirectUri: redirect_uri,
            code: generatedCode,
            codeChallenge: code_challenge || null,
            codeChallengeMethod: code_challenge_method || 'S256',
            scope,
            codeExpiresAt,
          },
        });
      }

      const redirectUrl = new URL(redirect_uri);
      redirectUrl.searchParams.set('code', generatedCode);
      if (state) {
        redirectUrl.searchParams.set('state', state);
      }

      res.redirect(redirectUrl.toString());
    } catch (err: any) {
      console.error('OAuth Authorize Error:', err);
      res.status(500).send('OAuth authorization failed.');
    }
  });

  // 6. POST /oauth/token (SMART v2 Token Endpoint)
  router.post('/oauth/token', async (req: Request, res: Response): Promise<void> => {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('Pragma', 'no-cache');

    try {
      const grant_type = req.body.grant_type;
      const code = req.body.code;
      const refresh_token = req.body.refresh_token;
      const client_assertion_type = req.body.client_assertion_type;
      const client_assertion = req.body.client_assertion;
      const code_verifier = req.body.code_verifier;

      let clientId = req.body.client_id;
      const authHeader = req.get('authorization');
      if (!clientId && authHeader?.startsWith('Basic ')) {
        const decoded = Buffer.from(authHeader.slice(6), 'base64').toString();
        clientId = decoded.split(':')[0];
      }

      // Handle Asymmetric Client Assertion (private_key_jwt)
      if (client_assertion_type === 'urn:ietf:params:oauth:client-assertion-type:jwt-bearer' && client_assertion) {
        const host = req.get('host') || 'localhost:3000';
        const protocol = req.protocol || 'http';
        const expectedAudience = `${protocol}://${host}/oauth/token`;
        const assertionResult = verifyClientAssertionJwt(client_assertion, expectedAudience);
        if (!assertionResult.valid) {
          res.status(401).json({
            error: 'invalid_client',
            error_description: assertionResult.error || 'Client assertion failed verification.',
          });
          return;
        }
        if (!clientId && assertionResult.subject) {
          clientId = assertionResult.subject;
        }
      }

      // Grant Type: client_credentials (SMART Backend Services Profile)
      if (grant_type === 'client_credentials') {
        const requestedScope = req.body.scope || 'system/*.rs';
        const accessToken = generateRandomToken(32);
        const expiresInSec = 3600;
        const tokenExpiresAt = new Date(Date.now() + expiresInSec * 1000);

        await prisma.smartAuthSession.create({
          data: {
            sandboxId: 'default',
            clientId: clientId || 'system-backend-client',
            redirectUri: '',
            scope: requestedScope,
            accessToken,
            tokenExpiresAt,
          },
        });

        res.status(200).json({
          access_token: accessToken,
          token_type: 'Bearer',
          expires_in: expiresInSec,
          scope: requestedScope,
        });
        return;
      }

      // Grant Type: refresh_token
      if (grant_type === 'refresh_token') {
        if (!refresh_token) {
          res.status(400).json({
            error: 'invalid_request',
            error_description: 'Missing refresh_token parameter.',
          });
          return;
        }

        const session = await prisma.smartAuthSession.findFirst({
          where: { refreshToken: refresh_token, isRevoked: false },
        });

        if (!session || (session.refreshTokenExpiresAt && session.refreshTokenExpiresAt < new Date())) {
          res.status(400).json({
            error: 'invalid_grant',
            error_description: 'Refresh token is invalid, expired, or revoked.',
          });
          return;
        }

        const newAccessToken = generateRandomToken(32);
        const newRefreshToken = generateRandomToken(32);
        const expiresInSec = 3600;
        const tokenExpiresAt = new Date(Date.now() + expiresInSec * 1000);
        const refreshTokenExpiresAt = new Date(Date.now() + 30 * 24 * 3600 * 1000); // 30 days

        await prisma.smartAuthSession.update({
          where: { id: session.id },
          data: {
            accessToken: newAccessToken,
            refreshToken: newRefreshToken,
            tokenExpiresAt,
            refreshTokenExpiresAt,
          },
        });

        res.status(200).json({
          access_token: newAccessToken,
          token_type: 'Bearer',
          expires_in: expiresInSec,
          refresh_token: newRefreshToken,
          scope: session.scope,
          patient: session.patientFhirId || undefined,
          encounter: session.encounterFhirId || undefined,
        });
        return;
      }

      // Grant Type: authorization_code
      if (grant_type === 'authorization_code') {
        if (!code) {
          res.status(400).json({
            error: 'invalid_request',
            error_description: 'Missing authorization code.',
          });
          return;
        }

        const session = await prisma.smartAuthSession.findUnique({
          where: { code },
        });

        if (!session) {
          res.status(400).json({
            error: 'invalid_grant',
            error_description: 'Authorization code is invalid or already used.',
          });
          return;
        }

        if (session.codeExpiresAt && session.codeExpiresAt < new Date()) {
          res.status(400).json({
            error: 'invalid_grant',
            error_description: 'Authorization code has expired.',
          });
          return;
        }

        // PKCE verification if challenge was supplied
        if (session.codeChallenge) {
          if (!code_verifier) {
            res.status(400).json({
              error: 'invalid_request',
              error_description: 'code_verifier required for PKCE validation.',
            });
            return;
          }

          const validPkce = verifyPkceChallenge(
            code_verifier,
            session.codeChallenge,
            session.codeChallengeMethod || 'S256',
          );

          if (!validPkce) {
            res.status(400).json({
              error: 'invalid_grant',
              error_description: 'PKCE code_verifier challenge verification failed.',
            });
            return;
          }
        }

        const accessToken = generateRandomToken(32);
        const expiresInSec = 3600;
        const tokenExpiresAt = new Date(Date.now() + expiresInSec * 1000);

        const issuesRefreshToken = session.scope.includes('offline_access');
        const refreshToken = issuesRefreshToken ? generateRandomToken(32) : null;
        const refreshTokenExpiresAt = issuesRefreshToken ? new Date(Date.now() + 30 * 24 * 3600 * 1000) : null;

        // Invalidate code and set access token
        await prisma.smartAuthSession.update({
          where: { id: session.id },
          data: {
            code: null,
            accessToken,
            refreshToken,
            tokenExpiresAt,
            refreshTokenExpiresAt,
          },
        });

        const host = req.get('host') || 'localhost:3000';
        const protocol = req.protocol || 'http';
        const serverIssuer = `${protocol}://${host}`;

        const idToken = generateIdToken(
          {
            iss: serverIssuer,
            sub: session.userPersonaId || 'practitioner-1',
            aud: session.clientId,
            fhirUser: session.userPersonaId ? `Practitioner/${session.userPersonaId}` : undefined,
            name: 'SMART Practitioner',
          },
          'fhir-studio-jwt-secret-key',
        );

        const responsePayload: Record<string, any> = {
          access_token: accessToken,
          token_type: 'Bearer',
          expires_in: expiresInSec,
          scope: session.scope,
          id_token: idToken,
          need_patient_banner: true,
        };

        if (refreshToken) {
          responsePayload.refresh_token = refreshToken;
        }
        if (session.patientFhirId) {
          responsePayload.patient = session.patientFhirId;
        }
        if (session.encounterFhirId) {
          responsePayload.encounter = session.encounterFhirId;
        }
        if (session.fhirContext) {
          responsePayload.fhirContext = session.fhirContext;
        }

        res.status(200).json(responsePayload);
        return;
      }

      res.status(400).json({
        error: 'unsupported_grant_type',
        error_description: `Grant type '${grant_type}' is not supported.`,
      });
    } catch (err: any) {
      console.error('OAuth Token Error:', err);
      res.status(500).json({
        error: 'server_error',
        error_description: 'Failed to process token exchange.',
      });
    }
  });

  // 7. POST /oauth/introspect (RFC 7662 Token Introspection)
  router.post('/oauth/introspect', async (req: Request, res: Response): Promise<void> => {
    res.setHeader('Access-Control-Allow-Origin', '*');
    const token = req.body.token;

    if (!token) {
      res.status(200).json({ active: false });
      return;
    }

    const session = await prisma.smartAuthSession.findFirst({
      where: {
        OR: [{ accessToken: token }, { refreshToken: token }],
        isRevoked: false,
      },
    });

    if (!session || (session.tokenExpiresAt && session.tokenExpiresAt < new Date())) {
      res.status(200).json({ active: false });
      return;
    }

    const isRefresh = session.refreshToken === token;

    res.status(200).json({
      active: true,
      scope: session.scope,
      client_id: session.clientId,
      token_type: isRefresh ? 'refresh_token' : 'Bearer',
      sub: session.userPersonaId || 'smart-client',
      exp: session.tokenExpiresAt ? Math.floor(session.tokenExpiresAt.getTime() / 1000) : undefined,
      patient: session.patientFhirId || undefined,
      encounter: session.encounterFhirId || undefined,
      fhirUser: session.userPersonaId ? `Practitioner/${session.userPersonaId}` : undefined,
      fhirContext: session.fhirContext || undefined,
    });
  });

  // 8. POST /oauth/revoke (RFC 7009 Token Revocation)
  router.post('/oauth/revoke', async (req: Request, res: Response): Promise<void> => {
    res.setHeader('Access-Control-Allow-Origin', '*');
    const token = req.body.token;

    if (!token) {
      res.status(200).send();
      return;
    }

    const session = await prisma.smartAuthSession.findFirst({
      where: {
        OR: [{ accessToken: token }, { refreshToken: token }],
      },
    });

    if (session) {
      await prisma.smartAuthSession.update({
        where: { id: session.id },
        data: { isRevoked: true },
      });
    }

    res.status(200).send();
  });

  return router;
}
