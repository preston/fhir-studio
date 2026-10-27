// Author: Preston Lee

import { createIntegrationOAuthRouter } from './integrations/oauth.js';
import { createIntegrationRouter } from './integrations/routes.js';
import { createJobSchedulesRouter } from './jobs/schedule-routes.js';
import { createHostingAdministrationRouter } from './hosted/admin-routes.js';
import { apiUsage } from './hosted/usage.js';
import 'dotenv/config';
import express from 'express';
import cookieParser from 'cookie-parser';
import { loadSsoConfig } from './auth/sso_config.js';
import { loadHapiConfig } from './hapi/partition_client.js';
import { createSessionAuth } from './authentication/requireAuthentication.js';
import { createAuthRouter } from './authentication/routes.js';
import { createSmartIdpRouter } from './smart-idp/routes.js';
import { createFhirGatewayRouter } from './fhir-gateway/proxy.js';
import { createSandboxesRouter } from './sandboxes/routes.js';
import { createApplicationsRouter } from './applications/routes.js';
import { createScenariosRouter } from './scenarios/routes.js';
import { createPersonasRouter } from './personas/routes.js';
import { createHooksRouter } from './hooks/routes.js';
import { createBulkExportRouter } from './bulk-export/routes.js';
import { createSubscriptionsRouter } from './subscriptions/routes.js';
import { SubscriptionHub } from './subscriptions/hub.js';
import { createAdministrationRouter } from './administration/routes.js';
import { createImplementationGuidesRouter } from './implementation-guides/routes.js';
import { createJobsRouter } from './jobs/routes.js';
import { createApiTokensRouter } from './authentication/apiTokenRoutes.js';
import { createKnowledgeRouter } from './knowledge/routes.js';
import { disconnectPrisma } from './db/prisma.js';
import { browserSecurity, controlPlaneAuthentication } from './authentication/browser-security.js';
import { createHostingRouter, hostingErrorHandler } from './hosted/routes.js';
import { createGitHubWebhookRouter } from './hosted/webhooks.js';
import { isHostingEnabled } from './env.js';
import { PublicRequestError } from './http/public-request.js';

const oidcConfig = loadSsoConfig();
const hapiConfig = loadHapiConfig();
const app = express();
const port = process.env.PORT || 3000;
// Apache terminates TLS. Without this, req.protocol stays http and the SSO
// callback URL no longer matches the registered https redirect.
const trustProxyHops = Number(process.env.FHIR_STUDIO_SERVER_TRUST_PROXY_HOPS || '0');
if (!Number.isInteger(trustProxyHops) || trustProxyHops < 0 || trustProxyHops > 5) {
  throw new Error('FHIR_STUDIO_SERVER_TRUST_PROXY_HOPS must be an integer from 0 to 5.');
}
if (trustProxyHops > 0) {
  app.set('trust proxy', trustProxyHops);
}
if (isHostingEnabled()) apiUsage.start();

// CORS setup supporting Angular UI
app.use(createGitHubWebhookRouter());
app.use(browserSecurity(oidcConfig));

app.use(cookieParser());
app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ extended: true, limit: '50mb' }));

// Global optional authentication to populate session & permissions
const sessionAuth = createSessionAuth(oidcConfig);
app.use(controlPlaneAuthentication(sessionAuth.optionalAuthentication));

// Health Check
app.get('/api/health', (req, res) => {
  res.json({
    status: 'ok',
    timestamp: new Date().toISOString(),
    service: 'fhir-studio-server',
    nodeEnv: oidcConfig.nodeEnv,
  });
});

// Public FHIR release availability (no auth)
app.get('/api/fhir-releases', (_req, res) => {
  res.json({
    releases: hapiConfig.releases.map(({ release, enabled }) => ({ release, enabled })),
  });
});

// Mount Routes
app.use(createAuthRouter(oidcConfig));
app.use(createIntegrationOAuthRouter());
app.use(createIntegrationRouter());
app.use(createHostingRouter());
app.use(createSmartIdpRouter());
app.use(createFhirGatewayRouter());
app.use(createSandboxesRouter());
app.use(createApplicationsRouter());
app.use(createScenariosRouter());
app.use(createPersonasRouter());
app.use(createHooksRouter());
app.use(createBulkExportRouter());
app.use(createSubscriptionsRouter());
app.use(createAdministrationRouter());
app.use(createImplementationGuidesRouter());
app.use(createJobsRouter());
app.use(createJobSchedulesRouter());
app.use(createHostingAdministrationRouter());
app.use(createApiTokensRouter());
app.use(createKnowledgeRouter());
app.use(hostingErrorHandler);

// Global Error Handler
app.use((err: unknown, req: express.Request, res: express.Response, next: express.NextFunction) => {
  console.error('Unhandled Server Error:', err);
  if (res.headersSent) {
    return next(err);
  }
  const status = err instanceof PublicRequestError ? err.status : 500;
  res.status(status).json({
    error: status < 500 ? 'Invalid outbound request' : 'Internal Server Error',
    message: err instanceof Error ? err.message : 'An unexpected error occurred',
  });
});

export const server = app.listen(port, () => {
  console.log(`FHIR Studio Server listening on http://localhost:${port}`);
  SubscriptionHub.getInstance().init(server, oidcConfig);
});

let isShuttingDown = false;
export async function shutdown(signal?: string): Promise<void> {
  if (isShuttingDown) return;
  isShuttingDown = true;
  if (signal) {
    console.log(`\nReceived ${signal}, shutting down gracefully...`);
  }
  SubscriptionHub.getInstance().close();
  await new Promise<void>((resolve) => {
    server.close(() => resolve());
    setTimeout(resolve, 500).unref();
  });
  if (isHostingEnabled()) await apiUsage.stop().catch(() => console.error('Hosting usage shutdown flush failed'));
  await disconnectPrisma();
  process.exit(0);
}

process.on('SIGINT', () => {
  void shutdown('SIGINT');
});

process.on('SIGTERM', () => {
  void shutdown('SIGTERM');
});

export default app;
