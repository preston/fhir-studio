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
import {
  capabilities,
  HostingError,
  deploymentAllowed,
  assertCurrentCapability,
} from './access.js';
import {
  checkStorage,
  cleanupStorage,
  downloadArtifact,
  extractArtifact,
  finalizeBuild,
  reserveStorage,
} from './filesystem.js';
import { workflowPath } from './source.js';

/** Caller holds the application lock. Obsolete requests must not block future pushes. */
export async function retireSupersededBuilds(
  tx: Prisma.TransactionClient,
  app: HostedApplication,
): Promise<HostedApplication> {
  const pending = await tx.hostedBuild.findMany({
    where: { applicationId: app.id, generation: { not: app.generation }, status: { in: ['WAITING', 'BUILDING', 'IMPORTING'] } },
    select: { id: true, jobId: true },
  });
  if (!pending.length) return app;
  await tx.job.updateMany({
    where: { id: { in: pending.flatMap(build => build.jobId ? [build.jobId] : []) }, status: { in: ['queued', 'in_progress'] } },
    data: { status: 'cancelled', cancelledAt: new Date(), stage: 'Application configuration changed' },
  });
  await tx.hostedBuild.updateMany({
    where: { id: { in: pending.map(build => build.id) } },
    data: { status: 'CANCELLED', error: 'Application configuration or authorization changed. Request a new build.' },
  });
  return pending.some(build => build.id === app.desiredBuildId)
    ? tx.hostedApplication.update({ where: { id: app.id }, data: { desiredBuildId: null } })
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
        'This build was superseded. Request a new preview.',
      );
    if (current.jobId) {
      const job = await tx.job.findUnique({ where: { id: current.jobId } });
      if (job?.status === 'queued' || job?.status === 'in_progress') return;
    }
    const job = await tx.job.create({
      data: {
        name: 'Import hosted application build',
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
export async function reconcileRun(
  app: HostedApplication,
  runId: string,
  config: HostingConfig,
): Promise<void> {
  const prisma = getPrisma();
  app = await prisma.$transaction(async tx => {
    await lockApplication(tx, app.id);
    return retireSupersededBuilds(tx, await tx.hostedApplication.findUniqueOrThrow({ where: { id: app.id } }));
  });
  if (app.deletedAt || app.suspended) return;
  const token = await installationToken(
    app.installationId,
    app.repositoryId,
    config,
  );
  const repo = await github<GitHubRepo>(
    token,
    `/repositories/${app.repositoryId}`,
  );
  const base = `/repos/${repo.full_name}`;
  const run = await github<GitHubRun>(token, `${base}/actions/runs/${runId}`);
  if (
    String(run.repository.id) !== app.repositoryId ||
    String(run.head_repository?.id) !== app.repositoryId ||
    run.path.split('@')[0] !== workflowPath(app.id) ||
    !['push', 'workflow_dispatch'].includes(run.event)
  )
    return;
  let build = await prisma.hostedBuild.findUnique({
    where: {
      applicationId_runId_runAttempt: {
        applicationId: app.id,
        runId: String(run.id),
        runAttempt: run.run_attempt,
      },
    },
  });
  if (!build) {
    const desired = app.desiredBuildId
      ? await prisma.hostedBuild.findUnique({
          where: { id: app.desiredBuildId },
        })
      : null;
    if (
      desired &&
      !desired.runId &&
      run.event === 'workflow_dispatch' &&
      run.display_title === `Studio preview ${desired.id}` &&
      (run.head_sha !== desired.commit || run.head_branch !== desired.branch)
    ) {
      await prisma.$transaction(async (tx) => {
        await lockApplication(tx, app.id);
        const current = await tx.hostedApplication.findUniqueOrThrow({
          where: { id: app.id },
        });
        if (
          current.desiredBuildId === desired.id &&
          current.generation === desired.generation
        )
          await tx.hostedBuild.update({
            where: { id: desired.id },
            data: {
              status: 'FAILED',
              runId: String(run.id),
              runAttempt: run.run_attempt,
              githubUrl: run.html_url,
              error:
                'The branch changed before GitHub started this request. Build the current commit again.',
            },
          });
      });
      return;
    }
    const requested =
      desired?.commit === run.head_sha &&
      desired.branch === run.head_branch &&
      desired.generation === app.generation &&
      !desired.runId &&
      desired.requestEvent === run.event &&
      run.run_attempt === 1 &&
      (run.event !== 'workflow_dispatch' ||
        run.display_title === `Studio preview ${desired.id}`);
    if (!requested) {
      const rerun =
        desired?.runId === String(run.id) &&
        run.run_attempt > desired.runAttempt;
      if (
        desired &&
        !rerun &&
        (['WAITING', 'BUILDING', 'IMPORTING'].includes(desired.status) ||
          (desired.runId && BigInt(run.id) <= BigInt(desired.runId)))
      )
        return;
      if (run.head_branch !== app.branch || (run.event !== 'push' && !rerun))
        return;
      const head = await github<{ sha: string }>(
        token,
        `${base}/commits/${encodeURIComponent(app.branch)}`,
      );
      if (head.sha !== run.head_sha) return;
    }
    build = await prisma.$transaction(async (tx) => {
      await lockApplication(tx, app.id);
      const current = await tx.hostedApplication.findUniqueOrThrow({
        where: { id: app.id },
      });
      if (
        current.deletedAt ||
        current.suspended ||
        current.generation !== app.generation ||
        current.desiredBuildId !== app.desiredBuildId
      )
        return null;
      const row =
        requested && desired
          ? await tx.hostedBuild.update({
              where: { id: desired.id },
              data: {
                runId: String(run.id),
                runAttempt: run.run_attempt,
                githubUrl: run.html_url,
                githubActor:
                  run.triggering_actor.login || `#${run.triggering_actor.id}`,
              },
            })
          : await tx.hostedBuild.upsert({
              where: {
                applicationId_runId_runAttempt: {
                  applicationId: app.id,
                  runId: String(run.id),
                  runAttempt: run.run_attempt,
                },
              },
              create: {
                applicationId: app.id,
                generation: app.generation,
                commit: run.head_sha,
                branch: run.head_branch,
                runId: String(run.id),
                runAttempt: run.run_attempt,
                githubUrl: run.html_url,
                githubActor:
                  run.triggering_actor.login || `#${run.triggering_actor.id}`,
              },
              update: {},
            });
      await tx.hostedApplication.update({
        where: { id: app.id },
        data: { desiredBuildId: row.id, repository: repo.full_name },
      });
      return row;
    });
  }
  const current = await prisma.hostedApplication.findUniqueOrThrow({
    where: { id: app.id },
  });
  if (
    !build ||
    ['READY', 'FAILED', 'CANCELLED'].includes(build.status) ||
    build.generation !== current.generation ||
    current.desiredBuildId !== build.id
  )
    return;
  if (run.status === 'completed' && run.conclusion === 'success')
    await queueImport(build);
  else
    await prisma.hostedBuild.updateMany({
      where: { id: build.id, status: { in: ['WAITING', 'BUILDING'] } },
      data: {
        status: run.status === 'completed' ? 'FAILED' : 'BUILDING',
        error:
          run.status === 'completed'
            ? `GitHub build ${run.conclusion}. Open the workflow run to diagnose or rebuild.`
            : null,
      },
    });
}

export async function queueReconciliation(
  applicationId: string,
  runId: string,
): Promise<void> {
  await getPrisma().$transaction(async (tx) => {
    await lockApplication(tx, applicationId);
    const app = await tx.hostedApplication.findUniqueOrThrow({
      where: { id: applicationId },
    });
    const existing = await tx.job.findFirst({
      where: {
        jobType: 'HOSTED_RECONCILE',
        status: { in: ['queued', 'in_progress'] },
        input: { path: ['key'], equals: `${applicationId}:${runId}` },
      },
    });
    if (!existing)
      await tx.job.create({
        data: {
          name: 'Reconcile GitHub workflow',
          jobType: 'HOSTED_RECONCILE',
          input: {
            applicationId,
            runId,
            generation: app.generation,
            key: `${applicationId}:${runId}`,
          },
        },
      });
  });
}
export async function reconcileJob(
  ctx: JobExecutionContext,
): Promise<Record<string, unknown>> {
  const config = loadHostingConfig('worker');
  const input = ctx.job.input as {
    applicationId: string;
    runId: string;
    generation: number;
  };
  const app = await getPrisma().hostedApplication.findUniqueOrThrow({
    where: { id: input.applicationId },
  });
  if (app.generation !== input.generation) return { ignored: true };
  await reconcileRun(app, input.runId, config);
  return { applicationId: app.id, runId: input.runId };
}
export async function publisherForRun(
  app: HostedApplication,
  run: GitHubRun,
  config: HostingConfig,
): Promise<boolean> {
  if (
    !app.autoPublish ||
    app.publishingPaused ||
    run.head_branch !== app.branch ||
    !run.created_at ||
    !Number.isFinite(Date.parse(run.created_at)) ||
    Date.parse(run.created_at) < app.policyUpdatedAt.getTime()
  )
    return false;
  for (const actor of [run.actor, run.triggering_actor]) {
    if (!actor || actor.type !== 'User') return false;
    const connection = await getPrisma().gitHubConnection.findUnique({
      where: { githubUserId: String(actor.id) },
      include: { user: true },
    });
    if (
      !connection ||
      connection.status !== 'CONNECTED' ||
      connection.user.isSuspended ||
      !(await deploymentAllowed(getPrisma(), connection.userId))
    )
      return false;
    const member = await getPrisma().hostedCollaborator.findUnique({
      where: {
        applicationId_userId: {
          applicationId: app.id,
          userId: connection.userId,
        },
      },
    });
    if (!capabilities(app.ownerUserId, connection.userId, member?.role).publish)
      return false;
    try {
      await repositoryForUser(
        connection.userId,
        app.repositoryId,
        config,
        true,
      );
    } catch {
      return false;
    }
  }
  return true;
}

/** Explicit requests retain their requester. Repository automation uses the linked
 * initiator, or the owner's delegated hosting authority for unlinked actors/bots. */
async function assertBuildAuthority(
  db: Prisma.TransactionClient,
  app: HostedApplication,
  build: HostedBuild,
  run: GitHubRun,
): Promise<void> {
  const initiator = run.triggering_actor
    ? await db.gitHubConnection.findUnique({
        where: { githubUserId: String(run.triggering_actor.id) },
        select: { userId: true },
      })
    : null;
  await assertCurrentCapability(
    db,
    app.id,
    build.requestedByUserId || initiator?.userId || app.ownerUserId,
    'develop',
  );
  if (initiator && initiator.userId !== build.requestedByUserId)
    await assertCurrentCapability(db, app.id, initiator.userId, 'develop');
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
      'Build was superseded or publication policy changed.',
    );
  const attemptRoot = path.join(
    config.root,
    '.staging',
    `${ctx.job.id}-${crypto.randomUUID()}`,
  );
  const importSignal = AbortSignal.any([
    ctx.signal,
    AbortSignal.timeout(300_000),
  ]);
  try {
    await mkdir(attemptRoot, { recursive: true, mode: 0o700 });
    await checkStorage(config);
    await reserveStorage(config, build.id);
    await ctx.updateProgress(10, 'Downloading GitHub artifact');
    const token = await installationToken(
      app.installationId,
      app.repositoryId,
      config,
    );
    const repo = await github<GitHubRepo>(
      token,
      `/repositories/${app.repositoryId}`,
    );
    const base = `/repos/${repo.full_name}`;
    const run = await github<GitHubRun>(
      token,
      `${base}/actions/runs/${build.runId}`,
    );
    await assertBuildAuthority(prisma, app, build, run);
    if (
      run.conclusion !== 'success' ||
      run.run_attempt !== build.runAttempt ||
      String(run.repository.id) !== app.repositoryId ||
      run.head_sha !== build.commit ||
      run.head_branch !== build.branch ||
      String(run.head_repository?.id) !== app.repositoryId ||
      run.path.split('@')[0] !== workflowPath(app.id) ||
      !['push', 'workflow_dispatch'].includes(run.event)
    )
      throw new HostingError(
        409,
        'Artifact run identity no longer matches the requested build.',
      );
    const list = await github<{
      artifacts: Array<{
        id: number;
        name: string;
        digest: string;
        expired: boolean;
        size_in_bytes: number;
      }>;
    }>(token, `${base}/actions/runs/${build.runId}/artifacts?per_page=100`);
    const artifact = list.artifacts.find(
      (a) => a.name === `studio-${app.id}-${build.runId}-${build.runAttempt}`,
    );
    if (!artifact || artifact.expired)
      throw new HostingError(
        410,
        'Build artifact is missing or expired. Rebuild the application.',
      );
    const response = await fetch(
      `https://api.github.com${base}/actions/artifacts/${artifact.id}/zip`,
      {
        redirect: 'manual',
        headers: {
          Authorization: `Bearer ${token}`,
          Accept: 'application/vnd.github+json',
        },
        signal: importSignal,
      },
    );
    if (response.status !== 302 || !response.headers.get('location'))
      throw new HostingError(502, 'Artifact download could not be started.');
    const archive = path.join(attemptRoot, 'artifact.zip');
    const digest = await downloadArtifact(
      response.headers.get('location')!,
      archive,
      config.maxArchiveBytes,
      importSignal,
    );
    if (digest !== artifact.digest)
      throw new HostingError(400, 'Artifact integrity check failed.');
    await ctx.updateProgress(50, 'Validating static content');
    const content = path.join(attemptRoot, 'content');
    const bytes = await extractArtifact(archive, content, config, importSignal);
    for (const entry of [app.launchPath, app.callbackPath])
      if (!(await stat(path.join(content, entry))).isFile())
        throw new HostingError(400, `Missing static entrypoint: ${entry}`);
    const auto = await publisherForRun(app, run, config);
    const head = await github<{ sha: string }>(
      token,
      `${base}/commits/${encodeURIComponent(build.branch)}`,
    );
    if (head.sha !== build.commit)
      throw new HostingError(
        409,
        'A newer source commit exists. Build the latest commit.',
      );
    await prisma.$transaction(
      async (tx) => {
        await lockApplication(tx, app.id);
        const current = await tx.hostedApplication.findUniqueOrThrow({
          where: { id: app.id },
        });
        const lease = await tx.job.findUniqueOrThrow({
          where: { id: ctx.job.id },
        });
        if (
          importSignal.aborted ||
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
            'Import lease or application state changed.',
          );
        await assertBuildAuthority(tx, current, build, run);
        if (
          current.previewBuildId !== build.id &&
          current.publishedBuildId !== build.id
        )
          await rm(path.join(config.root, 'apps', app.id, build.id), {
            recursive: true,
            force: true,
          });
        // Finalization can take time. Recheck authorization and the lease after
        // the files are durable and immediately before activating database references.
        const directory = await finalizeBuild(
          config,
          app.id,
          build.id,
          content,
        );
        await ctx.updateProgress(80, 'Activating validated static content');
        await assertBuildAuthority(tx, current, build, run);
        const activationLease = await tx.job.findUniqueOrThrow({
          where: { id: ctx.job.id },
        });
        if (
          importSignal.aborted ||
          activationLease.lockedBy !== ctx.job.lockedBy ||
          activationLease.status !== 'in_progress' ||
          !activationLease.leaseExpiresAt ||
          activationLease.leaseExpiresAt < new Date()
        )
          throw new HostingError(
            409,
            'Import lease changed before activation.',
          );
        let canPublish =
          auto && current.autoPublish && !current.publishingPaused;
        for (const actor of [run.actor, run.triggering_actor]) {
          const connection = await tx.gitHubConnection.findUnique({
            where: { githubUserId: String(actor.id) },
            include: { user: true },
          });
          const member = connection
            ? await tx.hostedCollaborator.findUnique({
                where: {
                  applicationId_userId: {
                    applicationId: app.id,
                    userId: connection.userId,
                  },
                },
              })
            : null;
          if (
            !connection ||
            connection.status !== 'CONNECTED' ||
            connection.user.isSuspended ||
            !(await deploymentAllowed(tx, connection.userId)) ||
            !capabilities(current.ownerUserId, connection.userId, member?.role)
              .publish
          )
            canPublish = false;
        }
        await tx.hostedBuild.update({
          where: { id: build.id },
          data: {
            directory,
            byteSize: BigInt(bytes),
            artifactId: String(artifact.id),
            launchPath: app.launchPath,
            callbackPath: app.callbackPath,
            scope: app.scope,
            status: 'READY',
            error: null,
          },
        });
        const activated = await tx.hostedApplication.update({
          where: { id: app.id },
          data: {
            previewBuildId: build.id,
            ...(canPublish ? { publishedBuildId: build.id } : {}),
          },
        });
        await provisionClients(activated, config, tx);
        await tx.hostedAudit.create({
          data: {
            applicationId: app.id,
            action: canPublish ? 'BUILD_AUTO_PUBLISHED' : 'PREVIEW_ACTIVATED',
            detail: { buildId: build.id, commit: build.commit },
          },
        });
      },
      { timeout: 30_000 },
    );
    return { buildId: build.id };
  } catch (error) {
    const lease = await prisma.job.findUnique({ where: { id: ctx.job.id } });
    if (lease?.lockedBy === ctx.job.lockedBy && lease.status === 'in_progress')
      await prisma.hostedBuild.updateMany({
        where: { id: build.id, status: { not: 'READY' } },
        data: {
          status: 'FAILED',
          error:
            error instanceof Error ? error.message : 'Artifact import failed.',
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
export async function provisionClients(
  app: HostedApplication,
  config: HostingConfig,
  database: Prisma.TransactionClient = getPrisma(),
): Promise<void> {
  for (const channel of ['preview', 'published'] as const) {
    const activeId =
      channel === 'preview' ? app.previewBuildId : app.publishedBuildId;
    const active = activeId
      ? await database.hostedBuild.findUnique({ where: { id: activeId } })
      : null;
    const launchPath = active?.launchPath || app.launchPath;
    const callbackPath = active?.callbackPath || app.callbackPath;
    const scope = active?.scope || app.scope;
    const clientId = `hosted-${app.id}-${channel}`;
    const origin = appOrigin(config, app.id, channel);
    const existing = await database.application.findUnique({
      where: { clientId },
    });
    if (
      existing &&
      (existing.scope !== scope ||
        JSON.stringify(existing.redirectUris) !==
          JSON.stringify([`${origin}/${callbackPath}`]))
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
        redirectUris: [`${origin}/${callbackPath}`],
        scope,
        tokenEndpointAuthMethod: 'none',
        pkceRequired: true,
        hostedApplicationId: app.id,
        hostedChannel: channel,
        createdByUserId: app.createdByUserId,
      },
      update: {
        clientName: app.name,
        launchUri: `${origin}/${launchPath}`,
        redirectUris: [`${origin}/${callbackPath}`],
        scope,
      },
    });
  }
}
let sweepRunning = false;
export async function sweepHosting(checkCancelled: () => Promise<void> = async () => {}): Promise<void> {
  const config = loadHostingConfig('worker');
  if (sweepRunning) return;
  sweepRunning = true;
  try {
    const apps = await getPrisma().hostedApplication.findMany({
      where: { deletedAt: null, suspended: false },
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
        const runs = await github<{ workflow_runs: GitHubRun[] }>(
          token,
          `/repos/${repo.full_name}/actions/workflows/${encodeURIComponent(workflowPath(app.id))}/runs?per_page=5`,
        );
        for (const run of runs.workflow_runs.reverse())
          await reconcileRun(app, String(run.id), config);
        await getPrisma().hostedApplication.updateMany({ where: { id: app.id }, data: { reconciliationError: null } });
      } catch {
        await getPrisma().hostedApplication.updateMany({ where: { id: app.id }, data: { reconciliationError: 'GitHub reconciliation failed. Check installation/repository access and retry.' } });
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
