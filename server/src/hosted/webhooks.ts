import crypto from 'node:crypto';
import express from 'express';
import { loadHostingConfig } from './config.js';
import { getPrisma } from '../db/prisma.js';
import { queueReconciliation } from './builds.js';
import { lockApplication } from './github.js';
import { isHostingEnabled, isGitHubHostingEnabled } from '../env.js';

export function webhookSignature(
  body: Buffer,
  signature: string,
  secret: string,
): boolean {
  if (!secret.trim()) return false;
  const expected = Buffer.from(
    `sha256=${crypto.createHmac('sha256', secret).update(body).digest('hex')}`,
  );
  const actual = Buffer.from(signature);
  return (
    actual.length === expected.length &&
    crypto.timingSafeEqual(actual, expected)
  );
}
export function createGitHubWebhookRouter() {
  const router = express.Router();
  if (!isHostingEnabled() || !isGitHubHostingEnabled()) return router;
  const config = loadHostingConfig();
  router.post(
    '/api/github/webhook',
    express.raw({ type: 'application/json', limit: '2mb' }),
    async (req, res) => {
      if (
        !Buffer.isBuffer(req.body) ||
        !webhookSignature(
          req.body,
          req.get('x-hub-signature-256') || '',
          config.webhookSecret,
        )
      ) {
        res.sendStatus(401);
        return;
      }
      const event = JSON.parse(req.body.toString()) as {
        action?: string;
        installation?: { id: number };
        sender?: { id: number };
        repository?: { id: number; full_name: string; private: boolean };
        repositories_removed?: Array<{ id: number }>;
        workflow_run?: { id: number; repository: { id: number } };
      };
      const prisma = getPrisma();
      const kind = req.get('x-github-event');
      const validId = (value: unknown): value is number =>
        typeof value === 'number' && Number.isSafeInteger(value) && value > 0;
      if (
        kind === 'github_app_authorization' &&
        event.action === 'revoked' &&
        validId(event.sender?.id)
      )
        await prisma.$transaction(async (tx) => {
          const connection = await tx.gitHubConnection.findUnique({
            where: { githubUserId: String(event.sender!.id) },
          });
          if (!connection) return;
          await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`github:${connection.userId}`}, 0))`;
          await tx.gitHubConnection.updateMany({
            where: { githubUserId: String(event.sender!.id) },
            data: { status: 'REVOKED', encryptedTokens: '' },
          });
        });
      if (
        validId(event.installation?.id) &&
        ((kind === 'installation' &&
          ['deleted', 'suspend'].includes(event.action || '')) ||
        (kind === 'installation_repositories' &&
          Array.isArray(event.repositories_removed) &&
          event.repositories_removed.length > 0 &&
          event.repositories_removed.every((repository) => validId(repository.id))))
      ) {
        const apps = await prisma.hostedApplication.findMany({
          where: {
            sourceKind: 'repository',
            installationId: String(event.installation?.id),
            ...(kind === 'installation_repositories'
              ? {
                  repositoryId: {
                    in: event.repositories_removed!.map((r) => String(r.id)),
                  },
                }
              : {}),
          },
        });
        for (const app of apps) {
          await prisma.$transaction(async (tx) => {
            await lockApplication(tx, app.id);
            await tx.hostedApplication.update({
              where: { id: app.id },
              data: {
                publishingPaused: true,
                generation: { increment: 1 },
                policyUpdatedAt: new Date(),
              },
            });
            await tx.hostedBuild.updateMany({
              where: {
                applicationId: app.id,
                status: { in: ['WAITING', 'BUILDING', 'IMPORTING'] },
              },
              data: {
                status: 'FAILED',
                error:
                  'GitHub installation or repository access was removed. Restore access and rebuild.',
              },
            });
          });
        }
      }
      if (kind === 'repository' && validId(event.repository?.id)) {
        const apps = await prisma.hostedApplication.findMany({
          where: { sourceKind: 'repository', repositoryId: String(event.repository!.id) },
        });
        for (const app of apps)
          await prisma.$transaction(async (tx) => {
            await lockApplication(tx, app.id);
            await tx.hostedApplication.update({
              where: { id: app.id },
              data: {
                repository: event.repository!.full_name,
                ...(event.repository!.private
                  ? { templateVisibility: 'PRIVATE' }
                  : {}),
                ...(event.action === 'transferred' || event.action === 'deleted'
                  ? {
                      publishingPaused: true,
                      generation: { increment: 1 },
                      policyUpdatedAt: new Date(),
                    }
                  : {}),
              },
            });
          });
      }
      if (
        kind === 'workflow_run' &&
        validId(event.workflow_run?.id) &&
        validId(event.workflow_run?.repository?.id) &&
        validId(event.installation?.id)
      ) {
        const apps = await prisma.hostedApplication.findMany({
          where: {
            sourceKind: 'repository',
            repositoryId: String(event.workflow_run!.repository.id),
            installationId: String(event.installation!.id),
            deletedAt: null,
            suspended: false,
          },
        });
        // The body is only a notification. Canonical run and artifact data come from the API.
        for (const app of apps)
          await queueReconciliation(app.id, String(event.workflow_run!.id));
      }
      res.sendStatus(204);
    },
  );
  return router;
}
