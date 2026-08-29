// Author: Preston Lee

import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import cookieParser from 'cookie-parser';
import { loadSsoConfig } from './auth/sso_config.js';
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
import { createJobsRouter } from './jobs/routes.js';
import { JobWorker } from './jobs/worker.js';
import { disconnectPrisma } from './db/prisma.js';

const oidcConfig = loadSsoConfig();
const app = express();
const port = process.env.PORT || 3000;

// CORS setup supporting Angular UI
app.use(
  cors({
    origin: (origin, callback) => {
      // Allow requests with no origin (like mobile apps or curl) or matching CORS origins
      if (!origin || oidcConfig.corsOrigins.includes(origin) || origin.startsWith('http://localhost:')) {
        callback(null, true);
      } else {
        callback(null, true); // Permissive in dev mode for SMART iframes
      }
    },
    credentials: true,
  }),
);

app.use(cookieParser());
app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ extended: true, limit: '50mb' }));

// Global optional authentication to populate session & permissions
const sessionAuth = createSessionAuth(oidcConfig);
app.use(sessionAuth.optionalAuthentication);

// Health Check
app.get('/api/health', (req, res) => {
  res.json({
    status: 'ok',
    timestamp: new Date().toISOString(),
    service: 'fhir-studio-server',
    nodeEnv: oidcConfig.nodeEnv,
  });
});

// Mount Routes
app.use(createAuthRouter(oidcConfig));
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
app.use(createJobsRouter());

// Global Error Handler
app.use((err: any, req: express.Request, res: express.Response, next: express.NextFunction) => {
  console.error('Unhandled Server Error:', err);
  if (res.headersSent) {
    return next(err);
  }
  res.status(500).json({
    error: 'Internal Server Error',
    message: err?.message || 'An unexpected error occurred',
  });
});

export const server = app.listen(port, () => {
  console.log(`FHIR Studio Server listening on http://localhost:${port}`);
  SubscriptionHub.getInstance().init(server);
  void JobWorker.getInstance().start();
});

let isShuttingDown = false;
export async function shutdown(signal?: string): Promise<void> {
  if (isShuttingDown) return;
  isShuttingDown = true;
  if (signal) {
    console.log(`\nReceived ${signal}, shutting down gracefully...`);
  }
  JobWorker.getInstance().stop();
  SubscriptionHub.getInstance().close();
  await new Promise<void>((resolve) => {
    server.close(() => resolve());
    setTimeout(resolve, 500).unref();
  });
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
