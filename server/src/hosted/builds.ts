// Author: Preston Lee

import { assertDeploymentSandboxes } from '../integrations/sandboxes.js';
import type { StaticSmartRuntimeContract } from '../integrations/catalog-contract.js';
import { assertActiveGrant } from '../integrations/oauth.js';
import crypto from 'node:crypto';
import { mkdir, rm, stat } from 'node:fs/promises';
import path from 'node:path';
import type { HostedApplication, HostedBuild, Prisma } from '@prisma/client';
import type { JobExecutionContext } from '../jobs/types.js';
import { getPrisma } from '../db/prisma.js';
import {
  github,
  installationToken,
  repositoryForUser,
  lockApplication,
} from './github.js';
import type { GitHubRun, GitHubRepo } from './github.js';
import { appOrigin, loadHostingConfig } from './config.js';
import type { HostingConfig } from './config.js';
import { HostingError, assertCurrentCapability } from './access.js';
import {
  checkStorage,
  cleanupStorage,
  downloadArtifact,
  extractArtifact,
  finalizeBuild,
  reserveStorage,
} from './filesystem.js';
import {
  normalizeStaticDirectory,
  repositoryStaticDirectory,
} from './source.js';

export const REPOSITORY_DEPLOYMENT_EVENT = 'repository_static_publish';
export const CATALOG_DEPLOYMENT_EVENT = 'catalog_publish';

interface RepositoryDeploymentSource {
  kind: 'repository';
  repositoryId: string;
  installationId: string;
  staticDirectory: string;
}

function repositoryDeploymentSource(
  build: HostedBuild,
): RepositoryDeploymentSource {
  const source = build.artifactSource;
  if (
    !source ||
    typeof source !== 'object' ||
    Array.isArray(source) ||
    source.kind !== 'repository' ||
    typeof source.repositoryId !== 'string' ||
    typeof source.installationId !== 'string' ||
    typeof source.staticDirectory !== 'string' ||
    !/^\d+$/.test(source.repositoryId) ||
    !/^\d+$/.test(source.installationId)
  )
    throw new HostingError(
      409,
      'The deployment has no valid immutable repository source. Deploy the static directory again.',
    );
  return {
    kind: 'repository',
    repositoryId: source.repositoryId,
    installationId: source.installationId,
    staticDirectory: normalizeStaticDirectory(source.staticDirectory),
  };
}

/** Select committed static files. This operation never creates commits or runs repository workflows. */
export async function queueRepositoryDeployment(
  applicationId: string,
  userId: string,
  branch: string,
  config: HostingConfig,
  options: { integrationGrantId?: string | null } = {},
): Promise<HostedBuild> {
  if (
    !branch ||
    branch.length > 200 ||
    /[\x00-\x20~^:?*\[\\]/.test(branch) ||
    branch.includes('..') ||
    branch.includes('@{') ||
    branch.endsWith('/') ||
    branch.startsWith('-')
  )
    throw new HostingError(400, 'Invalid Git branch.');
  const prisma = getPrisma();
  await assertCurrentCapability(prisma, applicationId, userId, 'publish');
  const app = await prisma.hostedApplication.findUniqueOrThrow({
    where: { id: applicationId },
  });
  if (app.sourceKind !== 'repository' || app.deletedAt || app.suspended)
    throw new HostingError(
      409,
      'Select an active repository application to deploy.',
    );
  const staticDirectory = repositoryStaticDirectory(app);
  const { token, base } = await repositoryForUser(
    userId,
    app.repositoryId,
    config,
  );
  const head = await github<{ sha: string }>(
    token,
    `${base}/commits/${encodeURIComponent(branch)}`,
  );
  if (!/^[a-f0-9]{40,64}$/.test(head.sha))
    throw new HostingError(
      502,
      'GitHub returned an invalid repository commit.',
    );
  const contents = await github<unknown>(
    token,
    `${base}/contents${staticDirectory === '.' ? '' : `/${staticDirectory.split('/').map(encodeURIComponent).join('/')}`}?ref=${head.sha}`,
  );
  if (!Array.isArray(contents))
    throw new HostingError(
      400,
      'Static assets path must reference a committed repository directory.',
    );
  await installationToken(app.installationId, app.repositoryId, config);
  const build = await prisma.$transaction(async (tx) => {
    await lockApplication(tx, app.id);
    await assertCurrentCapability(tx, app.id, userId, 'publish');
    const current = await tx.hostedApplication.findUniqueOrThrow({
      where: { id: app.id },
    });
    if (
      current.generation !== app.generation ||
      current.repositoryId !== app.repositoryId ||
      current.installationId !== app.installationId
    )
      throw new HostingError(
        409,
        'Application configuration changed. Refresh before deploying.',
      );
    const integrationGrantId =
      options.integrationGrantId === undefined
        ? current.integrationGrantId
        : options.integrationGrantId;
    if (integrationGrantId) {
      await assertActiveGrant(tx, integrationGrantId, 'applications:write');
      await assertActiveGrant(tx, integrationGrantId, 'applications:publish');
    }
    const pending = await tx.hostedBuild.findMany({
      where: {
        applicationId: app.id,
        status: { in: ['WAITING', 'BUILDING', 'IMPORTING'] },
      },
      select: { id: true, jobId: true },
    });
    if (pending.length) {
      await tx.job.updateMany({
        where: {
          id: {
            in: pending.flatMap((item) => (item.jobId ? [item.jobId] : [])),
          },
          status: { in: ['queued', 'in_progress'] },
        },
        data: {
          status: 'cancelled',
          cancelledAt: new Date(),
          stage: 'Superseded by a newer deployment',
        },
      });
      await tx.hostedBuild.updateMany({
        where: { id: { in: pending.map((item) => item.id) } },
        data: {
          status: 'CANCELLED',
          error: 'Superseded by a newer deployment.',
        },
      });
    }
    const source: RepositoryDeploymentSource = {
      kind: 'repository',
      repositoryId: current.repositoryId,
      installationId: current.installationId,
      staticDirectory,
    };
    const row = await tx.hostedBuild.create({
      data: {
        applicationId: app.id,
        branch,
        commit: head.sha,
        generation: current.generation,
        requestedByUserId: userId,
        requestEvent: REPOSITORY_DEPLOYMENT_EVENT,
        artifactSource: { ...source },
        runtimeContract: current.runtimeContract || undefined,
        publicConfiguration: current.publicConfiguration || {},
        integrationGrantId,
        revisionDigest: crypto
          .createHash('sha256')
          .update(
            JSON.stringify({
              source,
              commit: head.sha,
              contract: current.runtimeContract,
              configuration: current.publicConfiguration,
            }),
          )
          .digest('hex'),
        launchPath: current.launchPath,
        callbackPath: current.callbackPath,
        scope: current.scope,
        githubUrl: `https://github.com/${current.repository}/tree/${head.sha}${staticDirectory === '.' ? '' : `/${staticDirectory.split('/').map(encodeURIComponent).join('/')}`}`,
      },
    });
    await tx.hostedApplication.update({
      where: { id: app.id },
      data: { desiredBuildId: row.id, lastDeveloperActivityAt: new Date() },
    });
    return row;
  });
  await queueImport(build);
  return prisma.hostedBuild.findUniqueOrThrow({ where: { id: build.id } });
}

/** Caller holds the application lock. Obsolete requests must not block future pushes. */
export async function retireSupersededBuilds(
  tx: Prisma.TransactionClient,
  app: HostedApplication,
): Promise<HostedApplication> {
  const pending = await tx.hostedBuild.findMany({
    where: {
      applicationId: app.id,
      generation: { not: app.generation },
      status: { in: ['WAITING', 'BUILDING', 'IMPORTING'] },
    },
    select: { id: true, jobId: true },
  });
  if (!pending.length) return app;
  await tx.job.updateMany({
    where: {
      id: {
        in: pending.flatMap((build) => (build.jobId ? [build.jobId] : [])),
      },
      status: { in: ['queued', 'in_progress'] },
    },
    data: {
      status: 'cancelled',
      cancelledAt: new Date(),
      stage: 'Application configuration changed',
    },
  });
  await tx.hostedBuild.updateMany({
    where: { id: { in: pending.map((build) => build.id) } },
    data: {
      status: 'CANCELLED',
      error:
        'Application configuration or authorization changed. Request a new build.',
    },
  });
  return pending.some((build) => build.id === app.desiredBuildId)
    ? tx.hostedApplication.update({
        where: { id: app.id },
        data: { desiredBuildId: null },
      })
    : app;
}

export async function queueImport(build: HostedBuild): Promise<void> {
  await getPrisma().$transaction(async (tx) => {
    await lockApplication(tx, build.applicationId);
    const current = await tx.hostedBuild.findUniqueOrThrow({
      where: { id: build.id },
    });
    if (current.status === 'READY' || current.status === 'CANCELLED') return;
    const app = await tx.hostedApplication.findUniqueOrThrow({
      where: { id: build.applicationId },
    });
    if (
      app.deletedAt ||
      app.suspended ||
      app.desiredBuildId !== build.id ||
      app.generation !== current.generation
    )
      throw new HostingError(
        409,
        'This build was superseded. Request a new deployment.',
      );
    if (current.jobId) {
      const job = await tx.job.findUnique({ where: { id: current.jobId } });
      if (job?.status === 'queued' || job?.status === 'in_progress') return;
    }
    const job = await tx.job.create({
      data: {
        name:
          current.requestEvent === REPOSITORY_DEPLOYMENT_EVENT
            ? 'Deploy repository static assets'
            : 'Import hosted application build',
        jobType: 'HOSTED_IMPORT',
        input: { buildId: build.id },
      },
    });
    await tx.hostedBuild.update({
      where: { id: build.id },
      data: { jobId: job.id, status: 'IMPORTING', error: null },
    });
  });
}
/** Kept as a compatibility boundary for stale jobs; workflow events never select content. */
export async function reconcileRun(
  _app: HostedApplication,
  _runId: string,
  _config: HostingConfig,
): Promise<void> {
  return;
}

export async function queueReconciliation(
  _applicationId: string,
  _runId: string,
): Promise<void> {
  return;
}

export async function reconcileJob(
  _ctx: JobExecutionContext,
): Promise<Record<string, unknown>> {
  return {
    ignored: true,
    reason: 'Deploy a new deployment from committed static files.',
  };
}

/** Legacy workflow events cannot publish deployments. */
export async function publisherForRun(
  _app: HostedApplication,
  _run: GitHubRun,
  _config: HostingConfig,
): Promise<boolean> {
  return false;
}

async function assertRepositoryDeploymentAuthority(
  db: Prisma.TransactionClient,
  app: HostedApplication,
  build: HostedBuild,
  source: RepositoryDeploymentSource,
): Promise<void> {
  if (
    !build.requestedByUserId ||
    source.repositoryId !== app.repositoryId ||
    source.installationId !== app.installationId ||
    source.staticDirectory !== repositoryStaticDirectory(app)
  )
    throw new HostingError(
      409,
      'Repository deployment configuration changed. Deploy the static assets again.',
    );
  if (build.integrationGrantId) {
    await assertActiveGrant(db, build.integrationGrantId, 'applications:write');
    await assertActiveGrant(
      db,
      build.integrationGrantId,
      'applications:publish',
    );
    await assertDeploymentSandboxes(
      db,
      app.id,
      build.requestedByUserId,
      build.runtimeContract as unknown as
        StaticSmartRuntimeContract | undefined,
    );
  }
  await assertCurrentCapability(db, app.id, build.requestedByUserId, 'publish');
  const connection = await db.gitHubConnection.findUnique({
    where: { userId: build.requestedByUserId },
    select: { status: true },
  });
  if (connection?.status !== 'CONNECTED')
    throw new HostingError(
      401,
      'GitHub authorization was disconnected or revoked. Reconnect before deploying.',
    );
}

async function importRepositoryDeployment(
  ctx: JobExecutionContext,
  app: HostedApplication,
  build: HostedBuild,
  config: HostingConfig,
): Promise<Record<string, unknown>> {
  const prisma = getPrisma();
  const source = repositoryDeploymentSource(build);
  const attemptRoot = path.join(
    config.root,
    '.staging',
    `${ctx.job.id}-${crypto.randomUUID()}`,
  );
  const signal = AbortSignal.any([ctx.signal, AbortSignal.timeout(300_000)]);
  try {
    await assertRepositoryDeploymentAuthority(prisma, app, build, source);
    const { token, repo, base } = await repositoryForUser(
      build.requestedByUserId!,
      source.repositoryId,
      config,
    );
    await installationToken(source.installationId, source.repositoryId, config);
    await mkdir(attemptRoot, { recursive: true, mode: 0o700 });
    await checkStorage(config);
    await reserveStorage(config, build.id);
    await ctx.updateProgress(10, 'Downloading committed static assets');
    const response = await fetch(
      `https://api.github.com${base}/zipball/${build.commit}`,
      {
        redirect: 'manual',
        headers: {
          Authorization: `Bearer ${token}`,
          Accept: 'application/vnd.github+json',
        },
        signal,
      },
    );
    if (response.status !== 302 || !response.headers.get('location'))
      throw new HostingError(
        502,
        'Repository archive download could not be started. Retry deployment.',
      );
    const archive = path.join(attemptRoot, 'repository.zip');
    // downloadArtifact validates the GitHub redirect host and does not forward credentials.
    const digest = await downloadArtifact(
      response.headers.get('location')!,
      archive,
      config.maxArchiveBytes,
      signal,
    );
    await ctx.updateProgress(50, 'Validating the selected static directory');
    const content = path.join(attemptRoot, 'content');
    const bytes = await extractArtifact(archive, content, config, signal, {
      repositoryDirectory: source.staticDirectory,
    });
    const contract = build.runtimeContract as {
      launch_path?: string;
      callback_paths?: string[];
      scopes?: string[];
    } | null;
    const launchPath = contract?.launch_path || build.launchPath;
    const callbackPaths = contract?.callback_paths || [build.callbackPath];
    for (const entry of [launchPath, ...callbackPaths]) {
      if (!(await stat(path.join(content, entry)).catch(() => null))?.isFile())
        throw new HostingError(
          400,
          `Missing committed static entrypoint: ${entry}. Commit the ready-to-serve files to ${source.staticDirectory} before deploying.`,
        );
    }
    // Recheck personal repository access after the download, before acquiring the activation lock.
    await repositoryForUser(
      build.requestedByUserId!,
      source.repositoryId,
      config,
    );
    await prisma.$transaction(
      async (tx) => {
        await lockApplication(tx, app.id);
        const current = await tx.hostedApplication.findUniqueOrThrow({
          where: { id: app.id },
        });
        const assertLease = async (): Promise<void> => {
          const lease = await tx.job.findUniqueOrThrow({
            where: { id: ctx.job.id },
          });
          if (
            signal.aborted ||
            lease.lockedBy !== ctx.job.lockedBy ||
            lease.status !== 'in_progress' ||
            !lease.leaseExpiresAt ||
            lease.leaseExpiresAt < new Date() ||
            current.generation !== build.generation ||
            current.desiredBuildId !== build.id ||
            current.deletedAt ||
            current.suspended
          )
            throw new HostingError(
              409,
              'Deployment lease or application state changed.',
            );
        };
        await assertLease();
        await assertRepositoryDeploymentAuthority(tx, current, build, source);
        if (current.publishedBuildId !== build.id)
          await rm(path.join(config.root, 'apps', app.id, build.id), {
            recursive: true,
            force: true,
          });
        const directory = await finalizeBuild(
          config,
          app.id,
          build.id,
          content,
        );
        await ctx.updateProgress(80, 'Publishing static assets');
        await assertRepositoryDeploymentAuthority(tx, current, build, source);
        await assertLease();
        await tx.hostedBuild.update({
          where: { id: build.id },
          data: {
            directory,
            byteSize: BigInt(bytes),
            launchPath,
            callbackPath: callbackPaths[0] || build.callbackPath,
            scope: contract?.scopes?.join(' ') || build.scope,
            artifactSource: { ...source, sha256: digest },
            status: 'READY',
            error: null,
          },
        });
        const activated = await tx.hostedApplication.update({
          where: { id: app.id },
          data: {
            publishedBuildId: build.id,
            repository: repo.full_name,
            ...(build.integrationGrantId ? {} : { integrationGrantId: null }),
          },
        });
        await provisionClients(activated, config, tx);
        await tx.hostedAudit.create({
          data: {
            applicationId: app.id,
            userId: build.requestedByUserId,
            action: 'STATIC_DEPLOYMENT_PUBLISHED',
            detail: {
              buildId: build.id,
              commit: build.commit,
              staticDirectory: source.staticDirectory,
            },
          },
        });
      },
      { timeout: 30_000 },
    );
    return { buildId: build.id, deploymentId: build.id };
  } catch (error) {
    const lease = await prisma.job.findUnique({ where: { id: ctx.job.id } });
    if (lease?.lockedBy === ctx.job.lockedBy && lease.status === 'in_progress')
      await prisma.hostedBuild.updateMany({
        where: { id: build.id, status: { notIn: ['READY', 'CANCELLED'] } },
        data: {
          status: 'FAILED',
          error:
            error instanceof Error
              ? error.message
              : 'Static deployment failed.',
        },
      });
    throw error;
  } finally {
    await rm(attemptRoot, { recursive: true, force: true }).catch(() => {});
    await prisma.hostedBuild.updateMany({
      where: { id: build.id, directory: null, status: { not: 'IMPORTING' } },
      data: { byteSize: 0 },
    });
  }
}

export async function importBuild(
  ctx: JobExecutionContext,
): Promise<Record<string, unknown>> {
  const config = loadHostingConfig('worker');
  const input = ctx.job.input as { buildId?: string };
  const prisma = getPrisma();
  const build = await prisma.hostedBuild.findUniqueOrThrow({
    where: { id: input.buildId },
  });
  if (build.status === 'READY') return { buildId: build.id };
  if (build.requestEvent !== REPOSITORY_DEPLOYMENT_EVENT) {
    const message =
      'This deployment workflow is no longer supported. Deploy the committed static files again.';
    await prisma.hostedBuild.updateMany({
      where: { id: build.id, status: { notIn: ['READY', 'CANCELLED'] } },
      data: { status: 'FAILED', error: message, byteSize: 0 },
    });
    throw new HostingError(410, message);
  }
  const app = await prisma.hostedApplication.findUniqueOrThrow({
    where: { id: build.applicationId },
  });
  if (
    app.deletedAt ||
    app.suspended ||
    app.generation !== build.generation ||
    app.desiredBuildId !== build.id
  )
    throw new HostingError(
      409,
      'Deployment was superseded or application configuration changed.',
    );
  return importRepositoryDeployment(ctx, app, build, config);
}
export async function provisionClients(
  app: HostedApplication,
  config: HostingConfig,
  database: Prisma.TransactionClient = getPrisma(),
): Promise<void> {
  const activeId = app.publishedBuildId;
  const active = activeId
    ? await database.hostedBuild.findUnique({ where: { id: activeId } })
    : null;
  const launchPath = active?.launchPath || app.launchPath;
  const callbackPath = active?.callbackPath || app.callbackPath;
  const scope = active?.scope || app.scope;
  const callbacks = (
    active?.runtimeContract as { callback_paths?: string[] } | null
  )?.callback_paths || [callbackPath];
  const redirectUris = callbacks.map(
    (path) => `${appOrigin(config, app.id)}/${path}`,
  );
  const clientId = `hosted-${app.id}-published`;
  const origin = appOrigin(config, app.id);
  const existing = await database.application.findUnique({
    where: { clientId },
  });
  if (
    existing &&
    (existing.scope !== scope ||
      JSON.stringify(existing.redirectUris) !== JSON.stringify(redirectUris))
  )
    await database.smartAuthSession.updateMany({
      where: { clientId },
      data: { isRevoked: true },
    });
  await database.application.upsert({
    where: { clientId },
    create: {
      clientId,
      clientName: app.name,
      clientSecret: null,
      launchUri: `${origin}/${launchPath}`,
      redirectUris,
      scope,
      tokenEndpointAuthMethod: 'none',
      pkceRequired: true,
      hostedApplicationId: app.id,
      hostedChannel: 'published',
      createdByUserId: app.createdByUserId,
    },
    update: {
      clientName: app.name,
      launchUri: `${origin}/${launchPath}`,
      redirectUris,
      scope,
    },
  });
}
let sweepRunning = false;
export async function sweepHosting(
  checkCancelled: () => Promise<void> = async () => {},
): Promise<void> {
  const config = loadHostingConfig('worker');
  await getPrisma().integrationAuthorization.deleteMany({
    where: { expiresAt: { lt: new Date() } },
  });
  await getPrisma().integrationRetiredToken.deleteMany({
    where: { expiresAt: { lt: new Date() } },
  });
  if (sweepRunning) return;
  sweepRunning = true;
  try {
    const apps = await getPrisma().hostedApplication.findMany({
      where: { deletedAt: null, suspended: false, sourceKind: 'repository' },
      orderBy: { lastReconciledAt: { sort: 'asc', nulls: 'first' } },
      take: 20,
    });
    for (const app of apps) {
      await checkCancelled();
      try {
        const token = await installationToken(
          app.installationId,
          app.repositoryId,
          config,
        );
        const repo = await github<GitHubRepo>(
          token,
          `/repositories/${app.repositoryId}`,
        );
        if (repo.private && app.templateVisibility === 'PUBLIC')
          await getPrisma().hostedApplication.update({
            where: { id: app.id },
            data: { templateVisibility: 'PRIVATE' },
          });
        await getPrisma().hostedApplication.updateMany({
          where: { id: app.id },
          data: { reconciliationError: null },
        });
      } catch {
        await getPrisma().hostedApplication.updateMany({
          where: { id: app.id },
          data: {
            reconciliationError:
              'GitHub reconciliation failed. Check installation/repository access and retry.',
          },
        });
      }
      await getPrisma().hostedApplication.update({
        where: { id: app.id },
        data: { lastReconciledAt: new Date() },
      });
    }
  } finally {
    sweepRunning = false;
  }
}
