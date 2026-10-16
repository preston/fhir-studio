import { apiUsage } from '../hosted/usage.js';
// Author: Preston Lee

import express, { type Request, type Response, type Router } from 'express';
import { v4 as uuidv4 } from 'uuid';
import { getPrisma } from '../db/prisma.js';
import { isFhirReleaseEnabled } from '../hapi/partition_client.js';
import { generateSmartConfiguration } from './smart_config.js';
import {
  generateIdToken,
  generateRandomToken,
  getPublicJwks,
  verifyClientAssertionJwt,
  verifyPkceChallenge,
  initializeSmartSigning,
} from './crypto.js';

import { routeParam } from '../http/routeParam.js';
import { HostingError, sandboxAccess, applicationAccess } from '../hosted/access.js';
import { parseSmartV2Scopes, isSmartScopePermitted } from './scopes.js';
import crypto from 'node:crypto';
import { loadStudioOrigin } from '../hosted/config.js';
import { requireEnv } from '../env.js';
import { standalonePatient } from './patient-selection.js';
import { ClientKeyResolver, keySetUrl } from './client-keys.js';

function scopesWithin(requested: string, allowed: string, backend = false): boolean {
  const permitted = parseSmartV2Scopes(allowed);
  return requested.split(/\s+/).filter(Boolean).every(scope => {
    if (scope.includes('?') || (!backend && scope.startsWith('system/'))) return false;
    if (allowed.split(/\s+/).includes(scope)) return true;
    const parsed = parseSmartV2Scopes(scope)[0];
    if (!parsed?.actions || !parsed.resourceType) return false;
    return parsed.actions.every(action => isSmartScopePermitted(permitted.filter(s => s.context === parsed.context), { resourceType: parsed.resourceType, action: action as 'c' | 'r' | 'u' | 'd' | 's' }));
  });
}
const studioBase = () => requireEnv('FHIR_STUDIO_SERVER_UI_BASE_URL', 'UI_BASE_URL');

export function createSmartIdpRouter(options: { clientKeys?: ClientKeyResolver } = {}): Router {
  initializeSmartSigning();
  const router = express.Router();
  const prisma = getPrisma();
  const studioOrigin = loadStudioOrigin();
  const clientKeys = options.clientKeys ?? new ClientKeyResolver();

  // 1. SMART Configuration Discovery Endpoints
  const configHandler = (req: Request, res: Response): void => {
    const baseUrl = studioOrigin;
    const smartConfig = generateSmartConfiguration(baseUrl);
    res.setHeader('Content-Type', 'application/json');
    res.status(200).json(smartConfig);
  };

  router.get('/api/sandboxes/:sandboxId/fhir/:version/.well-known/smart-configuration', configHandler);
  router.get('/api/sandboxes/:sandboxId/.well-known/smart-configuration', configHandler);
  router.get('/.well-known/smart-configuration', configHandler);

  // 2. JWKS Public Keys Endpoint (RFC 7517)
  const jwksHandler = (_req: Request, res: Response): void => {
    res.setHeader('Content-Type', 'application/json');
    res.status(200).json(getPublicJwks());
  };
  router.get('/oauth/jwks.json', jwksHandler);
  router.get('/.well-known/jwks.json', jwksHandler);

  // 3. RFC 7591 Dynamic Client Registration Endpoint
  router.post('/oauth/register', async (req: Request, res: Response): Promise<void> => {
    if (!req.sessionAuth || !req.effectivePermissions?.applications_register) throw new HostingError(403, 'Authenticated application registration permission required.');
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
      if (jwks_uri) {
        try { keySetUrl(String(jwks_uri)); }
        catch { throw new HostingError(400, 'Register a public HTTPS JWKS URL without credentials or a custom port.'); }
      }
      if (jwks_uri && jwks) throw new HostingError(400, 'Register either jwks or jwks_uri, not both.');
      if (scope.includes('system/') && !req.effectivePermissions?.global_manage) throw new HostingError(403, 'Backend system scopes require platform administration.');
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
          createdByUserId: req.sessionAuth.userId,
          pkceRequired: token_endpoint_auth_method === 'none',
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
      if (err instanceof HostingError) { res.status(err.status).json({ error: 'invalid_client_metadata', error_description: err.message }); return; }
      console.error('Dynamic client registration error:', err);
      res.status(500).json({
        error: 'server_error',
        error_description: 'Failed to register client.',
      });
    }
  });

  // 4. Create SMART Launch Context (invoked by EHR Simulator or Launch Scenario)
  router.post('/api/sandboxes/:sandboxId/launch-context', async (req: Request, res: Response): Promise<void> => {
    const sandboxId = routeParam(req.params.sandboxId);
    const access = await sandboxAccess(req.sessionAuth?.userId, sandboxId, false, req.effectivePermissions?.global_manage);
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

    if (!sandbox || !isFhirReleaseEnabled(sandbox.fhirVersion)) {
      res.status(404).json({ error: `Sandbox '${sandboxId}' not found.` });
      return;
    }

    const client = clientId ? await prisma.application.findUnique({ where: { clientId }, include: { hostedApplication: true } }) : null;
    if (!client || (applicationId && client.id !== applicationId) || (client.sandboxId && client.sandboxId !== sandbox.id)) throw new HostingError(400, 'Registered application does not match this launch.');
    if (!scopesWithin(scope, client.scope)) throw new HostingError(400, 'Launch scopes exceed the registered scopes.');
    const readOnly = access.createdByUserId !== req.sessionAuth?.userId && !req.effectivePermissions?.global_manage && access.collaborators.some(member => member.userId === req.sessionAuth?.userId && member.role === 'READ_ONLY');
    if (readOnly && parseSmartV2Scopes(scope).some(item => item.actions?.some(action => ['c', 'u', 'd'].includes(action)))) throw new HostingError(403, 'Read-only sandbox access cannot grant SMART write scopes.');
    if (userPersonaId && (typeof userPersonaId !== 'string' || !/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(userPersonaId))) throw new HostingError(400, 'Select a valid sandbox persona.');
    const persona = userPersonaId ? await prisma.userPersona.findFirst({ where: { id: userPersonaId, sandboxId: sandbox.id } }) : null;
    if (userPersonaId && !persona) throw new HostingError(400, 'Persona does not belong to this sandbox.');
    if (client.hostedApplication) {
      const app = client.hostedApplication;
      if (client.hostedChannel === 'preview') await applicationAccess(req, app.id);
      if (app.deletedAt || app.suspended || (client.hostedChannel === 'preview' ? !app.previewBuildId : !app.publishedBuildId)) throw new HostingError(403, 'Hosted application channel is unavailable.');
      if (client.hostedChannel === 'published' && !await prisma.hostedSandbox.findUnique({ where: { applicationId_sandboxId: { applicationId: app.id, sandboxId: sandbox.id } } })) throw new HostingError(403, 'Enable this published application in the sandbox first.');
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
        fhirUser: persona ? `${studioOrigin}/api/sandboxes/${encodeURIComponent(sandboxId)}/fhir/${sandbox.fhirVersion.toLowerCase()}/${encodeURIComponent(persona.fhirResourceType)}/${encodeURIComponent(persona.fhirResourceId)}` : null,
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

      const application = await prisma.application.findUnique({ where: { clientId: client_id }, include: { hostedApplication: true } });
      const redirects = application && Array.isArray(application.redirectUris) ? application.redirectUris : [];
      if (!application || !redirects.some(uri => typeof uri === 'string' && new URL(uri, studioBase()).href === redirect_uri)) { res.status(400).send('Unregistered redirect URI.'); return; }
      if (!code_challenge || !/^[A-Za-z0-9_-]{43}$/.test(code_challenge) || code_challenge_method !== 'S256' || !state) { res.status(400).send('State and PKCE S256 are required.'); return; }
      if (!scopesWithin(scope, application.scope)) { res.status(400).send('Requested scopes exceed registration.'); return; }
      const hosted = application.hostedApplication;
      if (hosted && (hosted.deletedAt || hosted.suspended || (application.hostedChannel === 'preview' ? !hosted.previewBuildId : !hosted.publishedBuildId))) { res.status(403).send('Application unavailable.'); return; }

      // Determine target sandbox
      let targetSandboxId = 'default';
      if (aud) {
        const audience = new URL(aud);
        const trustedOrigins = [studioOrigin, studioBase()];
        if (!trustedOrigins.includes(audience.origin)) { res.status(400).send('Invalid FHIR audience.'); return; }
        const match = audience.pathname.match(/^\/api\/sandboxes\/([^/]+)\/fhir\/(r4|r4b|r5)$/i);
        if (match && match[1]) {
          targetSandboxId = match[1];
        }
      }
      if (targetSandboxId === 'default') { res.status(400).send('A sandbox-specific FHIR audience is required.'); return; }
      const targetSandbox = await prisma.sandbox.findUnique({ where: { sandboxId: targetSandboxId } });
      if (!targetSandbox || (application.sandboxId && application.sandboxId !== targetSandbox.id)) { res.status(403).send('Application sandbox mismatch.'); return; }

      const generatedCode = generateRandomToken(32);
      const codeExpiresAt = new Date(Date.now() + 5 * 60 * 1000); // 5 min code validity

      if (launch) {
        // EHR Launch Flow
        const existingSession = await prisma.smartAuthSession.findFirst({
          where: { launchId: launch },
        });

        if (!existingSession || existingSession.isRevoked || existingSession.code || existingSession.accessToken || existingSession.clientId !== client_id || existingSession.sandboxId !== targetSandboxId || !existingSession.codeExpiresAt || existingSession.codeExpiresAt < new Date() || !scopesWithin(scope, existingSession.scope)) { res.status(400).send('Invalid, expired, or consumed launch context.'); return; }
        if (existingSession) {
          const consumed = await prisma.smartAuthSession.updateMany({
            where: { id: existingSession.id, code: null, accessToken: null, isRevoked: false, codeExpiresAt: { gt: new Date() } },
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
          if (consumed.count !== 1) { res.status(400).send('Launch context has already been consumed.'); return; }
          if (hosted) apiUsage.record({ applicationId: hosted.id, channel: application.hostedChannel === 'preview' ? 'preview' : 'published', launch: true });
        }
      } else {
        if (hosted) { res.status(400).send('Launch this hosted application from Studio to grant sandbox context.'); return; }
        const access = await sandboxAccess(req.sessionAuth?.userId, targetSandboxId, false, req.effectivePermissions?.global_manage);
        if (access.createdByUserId !== req.sessionAuth?.userId && !req.effectivePermissions?.global_manage && access.collaborators.some(member => member.userId === req.sessionAuth?.userId && member.role === 'READ_ONLY') && parseSmartV2Scopes(scope).some(item => item.actions?.some(action => ['c', 'u', 'd'].includes(action)))) { res.status(403).send('Read-only sandbox access cannot grant SMART write scopes.'); return; }
        if (!application.isSample && application.createdByUserId !== req.sessionAuth?.userId) { res.status(403).send('Launch context or application ownership required.'); return; }
        const needsPatient = parseSmartV2Scopes(scope).some(item => item.context === 'patient') || scope.split(/\s+/).includes('launch/patient');
        const patientFhirId = needsPatient ? await standalonePatient(req, res, targetSandbox) : null;
        if (needsPatient && !patientFhirId) return;
        // Standalone Launch Flow
        await prisma.smartAuthSession.create({
          data: {
            sandboxId: targetSandboxId,
            clientId: client_id,
            patientFhirId,
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
      if (err instanceof HostingError) { res.status(err.status).send(err.message); return; }
      console.error('OAuth Authorize Error:', err);
      res.status(500).send('OAuth authorization failed.');
    }
  });

  // 6. POST /oauth/token (SMART v2 Token Endpoint)
  router.post('/oauth/token', async (req: Request, res: Response): Promise<void> => {
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
      if (!clientId && typeof client_assertion === 'string') {
        try { clientId = (JSON.parse(Buffer.from(client_assertion.split('.')[1], 'base64url').toString()) as { sub?: string }).sub; } catch { /* invalid_client below */ }
      }
      const registeredClient = typeof clientId === 'string' ? await prisma.application.findUnique({ where: { clientId }, include: { hostedApplication: true } }) : null;
      if (!registeredClient) { res.status(401).json({ error: 'invalid_client' }); return; }
      if (registeredClient.tokenEndpointAuthMethod === 'private_key_jwt' && (client_assertion_type !== 'urn:ietf:params:oauth:client-assertion-type:jwt-bearer' || typeof client_assertion !== 'string')) { res.status(401).json({ error: 'invalid_client' }); return; }
      const hostedClient = registeredClient.hostedApplication;
      if (hostedClient && (hostedClient.deletedAt || hostedClient.suspended || (registeredClient.hostedChannel === 'preview' ? !hostedClient.previewBuildId : !hostedClient.publishedBuildId))) { res.status(401).json({ error: 'invalid_client' }); return; }
      const suppliedSecret = authHeader?.startsWith('Basic ') ? Buffer.from(authHeader.slice(6), 'base64').toString().split(':').slice(1).join(':') : req.body.client_secret;
      const secretMatches = typeof suppliedSecret === 'string' && !!registeredClient.clientSecret && Buffer.byteLength(suppliedSecret) === Buffer.byteLength(registeredClient.clientSecret) && crypto.timingSafeEqual(Buffer.from(suppliedSecret), Buffer.from(registeredClient.clientSecret));
      const needsSecret = ['client_secret_basic', 'client_secret_post'].includes(registeredClient.tokenEndpointAuthMethod) && !registeredClient.isSample;
      if (needsSecret && !secretMatches) { res.status(401).json({ error: 'invalid_client' }); return; }

      // Handle Asymmetric Client Assertion (private_key_jwt)
      if (client_assertion_type === 'urn:ietf:params:oauth:client-assertion-type:jwt-bearer' && client_assertion) {
        const expectedAudience = `${studioOrigin}/oauth/token`;
        let keys: unknown;
        try {
          if (typeof client_assertion !== 'string' || client_assertion.length > 16384) throw new Error('Invalid client assertion.');
          keys = await clientKeys.resolve(registeredClient, client_assertion);
        } catch {
          res.status(401).json({ error: 'invalid_client', error_description: 'Could not resolve the registered client signing keys.' });
          return;
        }
        const assertionResult = verifyClientAssertionJwt(client_assertion, expectedAudience, keys, registeredClient.jwksUri);
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
        if (assertionResult.subject !== registeredClient.clientId) { res.status(401).json({ error: 'invalid_client' }); return; }
        await prisma.smartClientAssertion.deleteMany({ where: { expiresAt: { lt: new Date() } } });
        const assertionId = crypto.createHash('sha256').update(`${registeredClient.clientId}\0${assertionResult.jti}`).digest('hex');
        const consumed = await prisma.smartClientAssertion.createMany({ data: [{ id: assertionId, expiresAt: assertionResult.expiresAt! }], skipDuplicates: true });
        if (consumed.count !== 1) { res.status(401).json({ error: 'invalid_client', error_description: 'Client assertion was already used.' }); return; }
      }

      // Grant Type: client_credentials (SMART Backend Services Profile)
      if (grant_type === 'client_credentials') {
        // Public browser clients must never mint backend or cross-sandbox tokens.
        if (!registeredClient.sandboxId || registeredClient.tokenEndpointAuthMethod === 'none' || (!secretMatches && !(registeredClient.tokenEndpointAuthMethod === 'private_key_jwt' && client_assertion))) { res.status(401).json({ error: 'invalid_client', error_description: 'A provisioned, authenticated sandbox backend client is required.' }); return; }
        const backendSandbox = await prisma.sandbox.findUniqueOrThrow({ where: { id: registeredClient.sandboxId } });
        const requestedScope = req.body.scope || 'system/*.rs';
        if (!scopesWithin(requestedScope, registeredClient.scope, true)) { res.status(400).json({ error: 'invalid_scope' }); return; }
        const accessToken = generateRandomToken(32);
        const expiresInSec = 3600;
        const tokenExpiresAt = new Date(Date.now() + expiresInSec * 1000);

        await prisma.smartAuthSession.create({
          data: {
            sandboxId: backendSandbox.sandboxId,
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

        if (!session || session.clientId !== clientId || (session.refreshTokenExpiresAt && session.refreshTokenExpiresAt < new Date())) {
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

        const rotated = await prisma.smartAuthSession.updateMany({
          where: { id: session.id, refreshToken: refresh_token, isRevoked: false },
          data: {
            accessToken: newAccessToken,
            refreshToken: newRefreshToken,
            tokenExpiresAt,
            refreshTokenExpiresAt,
          },
        });
        if (rotated.count !== 1) { res.status(400).json({ error: 'invalid_grant' }); return; }

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

        if (!session || session.isRevoked || session.clientId !== clientId || session.redirectUri !== req.body.redirect_uri) {
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
        const consumed = await prisma.smartAuthSession.updateMany({
          where: { id: session.id, code, isRevoked: false },
          data: {
            code: null,
            accessToken,
            refreshToken,
            tokenExpiresAt,
            refreshTokenExpiresAt,
          },
        });
        if (consumed.count !== 1) { res.status(400).json({ error: 'invalid_grant' }); return; }

        const serverIssuer = studioOrigin;

        const idToken = generateIdToken(
          {
            iss: serverIssuer,
            sub: session.userPersonaId || session.id,
            aud: session.clientId,
            fhirUser: session.fhirUser || undefined,
            name: 'SMART Practitioner',
          },
          'fhir-studio-jwt-secret-key',
        );

        const responsePayload: Record<string, any> = {
          access_token: accessToken,
          token_type: 'Bearer',
          expires_in: expiresInSec,
          scope: session.scope,
          id_token: session.scope.split(/\s+/).includes('openid') ? idToken : undefined,
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
      fhirUser: session.fhirUser || undefined,
      fhirContext: session.fhirContext || undefined,
    });
  });

  // 8. POST /oauth/revoke (RFC 7009 Token Revocation)
  router.post('/oauth/revoke', async (req: Request, res: Response): Promise<void> => {
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
