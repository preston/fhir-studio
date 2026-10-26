// Author: Preston Lee

import { deploymentProfileErrors, type StaticSmartRuntimeContract } from '../integrations/catalog-contract.js';
import { performHostingAction } from './operations.js';
import { assertOwnerQuota, lockHostingAllocation } from './quotas.js';
import crypto from 'node:crypto';
import express from 'express';
import type { Request, Response } from 'express';
import type { RepositoryFile } from '@fhir-studio/core';
import { getPrisma } from '../db/prisma.js';
import { loadHostingConfig, appOrigin } from './config.js';
import type { HostingConfig } from './config.js';
import {
  applicationAccess,
  audit,
  capabilities,
  assertCurrentCapability,
  assertDeploymentPermission,
  HostingError,
  repositoryPath,
  sandboxAccess,
} from './access.js';
import {
  decrypt,
  encrypt,
  github,
  oauth,
  repositoryForUser,
  tokenData,
  userToken,
  lockApplication,
  installationToken,
} from './github.js';
import type { GitHubRepo } from './github.js';
import {
  commitFiles,
  copyTemplateSnapshot,
  managedWorkflow,
  readSource,
  sourceSnapshot,
  workflowPath,
} from './source.js';
import { curatedTemplates, templateFiles } from './templates.js';
import { provisionClients, queueImport, reconcileRun, retireSupersededBuilds } from './builds.js';
import { cancelJob } from '../jobs/queue.js';
import { safeAssetPath } from './filesystem.js';
import { isHostingEnabled } from '../env.js';

type Body = Record<string, unknown>;
const text = (body: Body, key: string, fallback = ''): string => {
  const value = body[key] ?? fallback;
  if (typeof value !== 'string' || value.length > 4000)
    throw new HostingError(400, `Invalid ${key}.`);
  return value.trim();
};
const branchName = (value: string): string => {
  if (
    !value ||
    value.length > 200 ||
    /[\x00-\x20~^:?*\[\\]/.test(value) ||
    value.includes('..') ||
    value.includes('@{') ||
    value.endsWith('/') ||
    value.startsWith('-')
  )
    throw new HostingError(400, 'Invalid Git branch.');
  return value;
};
function filesFrom(body: Body): RepositoryFile[] {
  if (!Array.isArray(body.files))
    throw new HostingError(400, 'files must be an array.');
  return body.files.map((value: unknown) => {
    if (!value || typeof value !== 'object')
      throw new HostingError(400, 'Invalid file.');
    const file = value as Body;
    if (typeof file.content !== 'string')
      throw new HostingError(400, 'File content must be text.');
    return { path: repositoryPath(text(file, 'path')), content: file.content };
  });
}
export function hostingErrorHandler(
  error: unknown,
  _req: Request,
  res: Response,
  _next: express.NextFunction,
): void {
  if (error instanceof HostingError) {
    res
      .status(error.status)
      .json({ error: error.message, recovery: error.recovery });
    return;
  }
  _next(error);
}
export function createHostingRouter() {
  const router = express.Router();
  if (!isHostingEnabled()) {
    router.use(['/api/github', '/api/hosted-applications', '/api/application-templates'], (_req, res) => {
      res.status(503).json({ error: 'Application hosting is not enabled on this instance.' });
    });
    return router;
  }
  const config = loadHostingConfig();
  const prisma = getPrisma();
  router.use(
    ['/api/github', '/api/hosted-applications', '/api/application-templates'],
    async (req, res, next) => {
      if (!req.sessionAuth) {
        if (
          req.originalUrl.startsWith('/api/github/callback') ||
          req.originalUrl.startsWith('/api/github/setup')
        ) {
          res.redirect(
            `/sso/login?returnTo=${encodeURIComponent(req.originalUrl)}`,
          );
          return;
        }
        res
          .status(401)
          .json({ error: 'Sign in to use application development.' });
        return;
      }
      await assertDeploymentPermission(prisma, req.sessionAuth.userId);
      next();
    },
  );
  const cfg: HostingConfig = config;
  const rateCounters = new Map<string, number>();
  setInterval(() => rateCounters.clear(), 60_000).unref();
  router.use(['/api/github', '/api/hosted-applications'], (req, res, next) => {
    const builds = req.method === 'POST' && /\/(builds|sync)$/.test(req.path);
    const key = `${req.sessionAuth!.userId}:${builds ? 'build' : 'request'}`;
    const count = (rateCounters.get(key) || 0) + 1;
    rateCounters.set(key, count);
    if (count > (builds ? 10 : 180)) {
      res.status(429).json({
        error: 'Application request limit reached. Try again shortly.',
      });
      return;
    }
    next();
  });
  const secure = process.env.NODE_ENV === 'production';
  const cookie = secure ? '__Host-studio_github' : 'studio_github';
  const cookieOptions = {
    httpOnly: true,
    secure,
    sameSite: 'lax' as const,
    path: '/',
    maxAge: 600_000,
  };
  router.get('/api/github/connection', async (req, res) => {
    if (!cfg.appId) {res.json({status:'DISCONNECTED'});return;}
    const row = await prisma.gitHubConnection.findUnique({
      where: { userId: req.sessionAuth!.userId },
    });
    let installations: unknown[] = [];
    let status = row?.status || 'DISCONNECTED';
    if (row?.status === 'CONNECTED')
      try {
        installations = (
          await github<{ installations: unknown[] }>(
            await userToken(row.userId, cfg),
            '/user/installations?per_page=100',
          )
        ).installations;
      } catch (error) {
        status =
          error instanceof HostingError && error.status === 401
            ? 'RECONNECT_REQUIRED'
            : 'GITHUB_UNAVAILABLE';
      }
    res.json({
      login: row?.login,
      status,
      expiresAt: row?.expiresAt,
      installations,
      installUrl: '/api/github/install?returnTo=/profile/connections',
    });
  });
  router.get('/api/github/connect', (req, res) => {
    const state = crypto.randomBytes(32).toString('base64url');
    const verifier = crypto.randomBytes(32).toString('base64url');
    const returnTo =
      typeof req.query.returnTo === 'string' &&
      req.query.returnTo.startsWith('/') &&
      !req.query.returnTo.startsWith('//')
        ? req.query.returnTo
        : '/profile/connections';
    res.cookie(
      cookie,
      encrypt(
        {
          userId: req.sessionAuth!.userId,
          state,
          verifier,
          returnTo,
          expires: Date.now() + 600_000,
        },
        cfg,
      ),
      cookieOptions,
    );
    const url = new URL('https://github.com/login/oauth/authorize');
    for (const [key, value] of Object.entries({
      client_id: cfg.clientId,
      redirect_uri: `${cfg.studioOrigin}/api/github/callback`,
      state,
      scope: 'offline_access',
      code_challenge: crypto
        .createHash('sha256')
        .update(verifier)
        .digest('base64url'),
      code_challenge_method: 'S256',
    }))
      url.searchParams.set(key, value);
    res.redirect(url.toString());
  });
  router.get('/api/github/callback', async (req, res) => {
    if (typeof req.cookies?.[cookie] !== 'string')
      throw new HostingError(400, 'GitHub connection expired. Start again.');
    const state = decrypt<{
      userId: string;
      state: string;
      verifier: string;
      returnTo: string;
      expires: number;
    }>(req.cookies[cookie], cfg);
    res.clearCookie(cookie, cookieOptions);
    if (
      state.userId !== req.sessionAuth!.userId ||
      state.state !== req.query.state ||
      state.expires < Date.now() ||
      typeof req.query.code !== 'string'
    )
      throw new HostingError(400, 'Invalid GitHub authorization callback.');
    const tokens = await oauth(cfg, {
      code: req.query.code,
      code_verifier: state.verifier,
      redirect_uri: `${cfg.studioOrigin}/api/github/callback`,
    });
    const identity = await github<{ id: number; login: string }>(
      tokens.access_token,
      '/user',
    );
    const existing = await prisma.gitHubConnection.findUnique({
      where: { githubUserId: String(identity.id) },
    });
    if (existing && existing.userId !== state.userId)
      throw new HostingError(
        409,
        'This GitHub account is already linked to another Studio account.',
      );
    await prisma.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`github:${state.userId}`}, 0))`;
      await assertDeploymentPermission(tx, state.userId);
      await tx.gitHubConnection.upsert({
        where: { userId: state.userId },
        create: {
          userId: state.userId,
          githubUserId: String(identity.id),
          login: identity.login,
          ...tokenData(tokens, cfg),
        },
        update: {
          githubUserId: String(identity.id),
          login: identity.login,
          ...tokenData(tokens, cfg),
        },
      });
    });
    await audit(null, state.userId, 'GITHUB_CONNECTED');
    res.redirect(`${cfg.studioOrigin}${state.returnTo}`);
  });
  router.get('/api/github/install', (req, res) => {
    const returnTo =
      req.query.returnTo === '/applications/hosted'
        ? '/applications/hosted'
        : '/profile/connections';
    const state = encrypt(
      {
        userId: req.sessionAuth!.userId,
        returnTo,
        expires: Date.now() + 3600_000,
      },
      cfg,
    );
    res.redirect(
      `https://github.com/apps/${cfg.slug}/installations/new?state=${encodeURIComponent(state)}`,
    );
  });
  router.get('/api/github/setup', async (req, res) => {
    let returnTo = '/profile/connections';
    if (typeof req.query.state === 'string') {
      try {
        const saved = decrypt<{
          userId: string;
          returnTo: string;
          expires: number;
        }>(req.query.state, cfg);
        if (
          saved.userId === req.sessionAuth!.userId &&
          saved.expires > Date.now() &&
          saved.returnTo === '/applications/hosted'
        )
          returnTo = saved.returnTo;
      } catch {
        /* An unverified setup URL never grants repository access. */
      }
    }
    const installations = await github<{
      installations: Array<{ id: number }>;
    }>(
      await userToken(req.sessionAuth!.userId, cfg),
      '/user/installations?per_page=100',
    );
    const installed = installations.installations.find(
      (item) => String(item.id) === req.query.installation_id,
    );
    res.redirect(
      `${cfg.studioOrigin}${returnTo}${returnTo === '/applications/hosted' ? (installed ? `?installation=${installed.id}` : '?githubSetup=pending') : ''}`,
    );
  });
  router.delete('/api/github/connection', async (req, res) => {
    const row = await prisma.$transaction(async (tx) => {
      const userId = req.sessionAuth!.userId;
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`github:${userId}`}, 0))`;
      const current = await tx.gitHubConnection.findUnique({
        where: { userId },
      });
      if (current) await tx.gitHubConnection.delete({ where: { userId } });
      return current;
    });
    if (row) {
      const tokens = row.encryptedTokens
        ? decrypt<{ access_token: string }>(row.encryptedTokens, cfg)
        : { access_token: '' };
      const response = await fetch(
        `https://api.github.com/applications/${cfg.clientId}/grant`,
        {
          method: 'DELETE',
          headers: {
            Authorization: `Basic ${Buffer.from(`${cfg.clientId}:${cfg.clientSecret}`).toString('base64')}`,
            'Content-Type': 'application/json',
            Accept: 'application/vnd.github+json',
          },
          body: JSON.stringify({ access_token: tokens.access_token }),
          signal: AbortSignal.timeout(15_000),
        },
      ).catch(() => null);
      res.json({
        disconnected: true,
        remoteRevocationConfirmed:
          !!response && (response.ok || response.status === 404),
        manageUrl: 'https://github.com/settings/applications',
      });
    } else res.json({ disconnected: true });
  });
  router.get('/api/github/repositories', async (req, res) => {
    const installation = String(req.query.installation || '');
    if (!/^\d+$/.test(installation))
      throw new HostingError(400, 'Select an installation.');
    const result = await github<{ repositories: GitHubRepo[] }>(
      await userToken(req.sessionAuth!.userId, cfg),
      `/user/installations/${installation}/repositories?per_page=100&page=${Math.max(1, Number(req.query.page) || 1)}`,
    );
    res.json(result);
  });
  router.post('/api/github/repositories', async (req, res) => {
    if (
      !req.effectivePermissions?.applications_register &&
      !req.effectivePermissions?.global_manage
    )
      throw new HostingError(403, 'Application creation permission required.');
    const body = req.body as Body;
    const token = await userToken(req.sessionAuth!.userId, cfg);
    const me = await github<{ login: string }>(token, '/user');
    const owner = text(body, 'owner') || me.login;
    const name = text(body, 'name');
    if (!/^[\w.-]{1,100}$/.test(name))
      throw new HostingError(400, 'Invalid repository name.');
    const repo = await github<GitHubRepo>(
      token,
      owner.toLowerCase() === me.login.toLowerCase()
        ? '/user/repos'
        : `/orgs/${encodeURIComponent(owner)}/repos`,
      'POST',
      { name, private: body.private !== false, auto_init: true },
    );
    res.status(201).json(repo);
  });
  router.get('/api/github/build-defaults', async (req, res) => {
    const repositoryId = String(req.query.repositoryId || '');
    const projectDirectory = repositoryPath(
      String(req.query.projectDirectory || ''),
      true,
    );
    const { token, base } = await repositoryForUser(
      req.sessionAuth!.userId,
      repositoryId,
      cfg,
    );
    const entries = await github<Array<{ name: string }>>(
      token,
      `${base}/contents/${projectDirectory.split('/').map(encodeURIComponent).join('/')}`,
    );
    if (
      !Array.isArray(entries) ||
      !entries.some((file) => file.name === 'package.json')
    )
      throw new HostingError(
        400,
        'No package.json found. Confirm the project directory or enter a static build command manually.',
      );
    const manifest = JSON.parse(
      await readSource(
        req.sessionAuth!.userId,
        repositoryId,
        req.query.branch ? String(req.query.branch) : 'HEAD',
        [projectDirectory, 'package.json'].filter(Boolean).join('/'),
        cfg,
      ),
    ) as {
      scripts?: Record<string, string>;
      dependencies?: Record<string, string>;
      devDependencies?: Record<string, string>;
      engines?: { node?: string };
    };
    const dependencies = {
      ...manifest.dependencies,
      ...manifest.devDependencies,
    };
    let outputDirectory = dependencies['react-scripts']
      ? 'build'
      : dependencies.next
        ? 'out'
        : 'dist';
    if (dependencies['@angular/core']) {
      const angular = JSON.parse(
        await readSource(
          req.sessionAuth!.userId,
          repositoryId,
          req.query.branch ? String(req.query.branch) : 'HEAD',
          [projectDirectory, 'angular.json'].filter(Boolean).join('/'),
          cfg,
        ),
      ) as {
        projects?: Record<
          string,
          {
            architect?: {
              build?: {
                builder?: string;
                options?: {
                  outputPath?: string | { base: string; browser?: string };
                };
              };
            };
          }
        >;
      };
      const build = Object.values(angular.projects || {})[0]?.architect?.build;
      const output = build?.options?.outputPath;
      outputDirectory =
        typeof output === 'object'
          ? [output.base, output.browser ?? 'browser'].filter(Boolean).join('/')
          : `${output || 'dist'}/${build?.builder?.endsWith(':browser') ? '' : 'browser'}`.replace(
              /\/$/,
              '',
            );
    }
    res.json({
      projectDirectory,
      buildCommand: `${entries.some((file) => file.name === 'package-lock.json') ? 'npm ci' : 'npm install --ignore-scripts'} && npm run build`,
      outputDirectory,
      nodeVersion: manifest.engines?.node?.match(/\d{2}/)?.[0] || '26',
      note: !manifest.scripts?.build
        ? 'This package has no build script. Enter the build command before creating the application.'
        : dependencies.next
          ? 'Next.js must use static export. Server-side rendering and API routes cannot be hosted.'
          : 'Review and confirm these detected settings.',
    });
  });
  const include = {
    collaborators: {
      include: { user: { select: { email: true, displayName: true } } },
    },
    builds: { orderBy: { createdAt: 'desc' as const }, take: 5 },
  };
  type Project = Awaited<ReturnType<typeof applicationAccess>>['app'];
  const serialize = async (app: Project, req: Request) => {
    const missingActive=[app.previewBuildId,app.publishedBuildId,app.desiredBuildId].filter((id):id is string=>!!id&&!app.builds.some(build=>build.id===id));
    if(missingActive.length)app.builds.push(...await prisma.hostedBuild.findMany({where:{applicationId:app.id,id:{in:missingActive}}}));
    return ({
    ...app,
    builds: app.builds.map(
      ({ directory: _dir, byteSize: _size, ...build }) => build,
    ),
    previewUrl: `${appOrigin(cfg, app.id, 'preview')}/${app.builds.find((build) => build.id === app.previewBuildId)?.launchPath || app.launchPath}`,
    publishedUrl: `${appOrigin(cfg, app.id, 'published')}/${app.builds.find((build) => build.id === app.publishedBuildId)?.launchPath || app.launchPath}`,
    capabilities: capabilities(
      app.ownerUserId,
      req.sessionAuth!.userId,
      app.collaborators.find((c) => c.userId === req.sessionAuth!.userId)?.role,
      req.effectivePermissions?.global_manage,
    ),
  });
  };
  router.get('/api/hosted-applications', async (req, res) => {
    const apps = await prisma.hostedApplication.findMany({
      where: {
        deletedAt: null,
        ...(req.effectivePermissions?.global_manage
          ? {}
          : {
              OR: [
                { ownerUserId: req.sessionAuth!.userId },
                { transferToUserId: req.sessionAuth!.userId },
                {
                  collaborators: { some: { userId: req.sessionAuth!.userId } },
                },
              ],
            }),
      },
      include,
      orderBy: { createdAt: 'desc' },
    });
    res.json({ applications: await Promise.all(apps.map((app) => serialize(app, req))) });
  });
  router.get('/api/application-templates', async (req, res) => {
    const apps = await prisma.hostedApplication.findMany({
      where: {
        isTemplate: true,
        deletedAt: null,
        suspended: false,
        OR: [
          { templateVisibility: 'PUBLIC' },
          { ownerUserId: req.sessionAuth!.userId },
          { collaborators: { some: { userId: req.sessionAuth!.userId } } },
        ],
      },
      select: {
        id: true,
        name: true,
        description: true,
        templateCommit: true,
        templateVisibility: true,
        projectDirectory: true,
        buildCommand: true,
        outputDirectory: true,
        nodeVersion: true,
        launchPath: true,
        callbackPath: true,
        scope: true,
      },
    });
    res.json({ curated: curatedTemplates, community: apps });
  });
  router.post('/api/hosted-applications', async (req, res) => {
    const body = req.body as Body;
    const userId = req.sessionAuth!.userId;
    if (
      !req.effectivePermissions?.applications_register &&
      !req.effectivePermissions?.global_manage
    )
      throw new HostingError(403, 'Application creation permission required.');
    const repositoryId = text(body, 'repositoryId');
    const installationId = text(body, 'installationId');
    if (!/^\d+$/.test(repositoryId) || !/^\d+$/.test(installationId))
      throw new HostingError(400, 'Select a repository and installation.');
    const { token, repo, base } = await repositoryForUser(
      userId,
      repositoryId,
      cfg,
      true,
    );
    let installed = false;
    for (let page = 1; page <= 100; page++) {
      const result = await github<{ repositories: GitHubRepo[] }>(
        token,
        `/user/installations/${installationId}/repositories?per_page=100&page=${page}`,
      );
      if (result.repositories.some((r) => String(r.id) === repositoryId)) {
        installed = true;
        break;
      }
      if (result.repositories.length < 100) break;
    }
    if (!installed)
      throw new HostingError(
        403,
        'Add this repository to the Studio GitHub App installation first.',
        'repository-access',
      );
    const starter = text(body, 'starter');
    const branch = branchName(text(body, 'branch', repo.default_branch));
    let originCommit: string | null = null;
    let inherited: Record<string, string> = {};
    if (starter) {
      const head = await github<{ sha: string }>(
        token,
        `${base}/commits/${encodeURIComponent(branch)}`,
      );
      const existing = await github<{
        tree: Array<{ path: string; type: string }>;
      }>(token, `${base}/git/trees/${head.sha}?recursive=1`);
      if (
        existing.tree.some(
          (file) =>
            file.type === 'blob' &&
            !/^(README(?:\.md)?|LICENSE(?:\.md)?|\.gitignore)$/i.test(
              file.path,
            ),
        )
      )
        throw new HostingError(
          409,
          'Create templates in a new, empty repository. Existing project files will not be overwritten.',
        );
      if (curatedTemplates.some((t) => t.id === starter))
        await commitFiles(
          token,
          base,
          branch,
          head.sha,
          templateFiles(starter),
          'Create application from Studio template',
        );
      else {
        const donor = await prisma.hostedApplication.findFirst({
          where: {
            id: starter,
            isTemplate: true,
            deletedAt: null,
            suspended: false,
            OR: [
              { templateVisibility: 'PUBLIC' },
              { ownerUserId: userId },
              { collaborators: { some: { userId } } },
            ],
          },
        });
        if (!donor?.templateCommit)
          throw new HostingError(404, 'Template not available.');
        originCommit = donor.templateCommit;
        inherited = {
          projectDirectory: donor.projectDirectory,
          buildCommand: donor.buildCommand,
          outputDirectory: donor.outputDirectory,
          nodeVersion: donor.nodeVersion,
          launchPath: donor.launchPath,
          callbackPath: donor.callbackPath,
          scope: donor.scope,
        };
        await copyTemplateSnapshot(
          userId,
          donor.repositoryId,
          donor.templateCommit,
          token,
          base,
          branch,
          head.sha,
          cfg,
        );
      }
    }
    const settings = {
      projectDirectory: repositoryPath(
        text(body, 'projectDirectory', inherited.projectDirectory || ''),
        true,
      ),
      buildCommand: text(
        body,
        'buildCommand',
        inherited.buildCommand ||
          (starter
            ? 'npm install --ignore-scripts && npm run build'
            : 'npm ci && npm run build'),
      ),
      outputDirectory: repositoryPath(
        text(
          body,
          'outputDirectory',
          inherited.outputDirectory ||
            (starter === 'angular' ? 'dist/browser' : 'dist'),
        ),
      ),
      nodeVersion: text(body, 'nodeVersion', inherited.nodeVersion || '26'),
      launchPath: safeAssetPath(
        text(body, 'launchPath', inherited.launchPath || 'index.html'),
      ),
      callbackPath: safeAssetPath(
        text(body, 'callbackPath', inherited.callbackPath || 'index.html'),
      ),
      scope: text(
        body,
        'scope',
        inherited.scope || 'launch launch/patient openid fhirUser patient/*.rs',
      ),
    };
    if (
      !settings.buildCommand ||
      !/^\d{1,2}(?:\.\d{1,2})?$/.test(settings.nodeVersion) ||
      settings.scope.includes('system/') ||
      settings.scope.includes('?')
    )
      throw new HostingError(
        400,
        'Confirm a build command, Node runtime, and supported public-client scopes.',
      );
    managedWorkflow({ id: 'validation', ...settings });
    const app = await prisma.$transaction(async (tx) => {
      await lockHostingAllocation(tx, [userId]);
      await assertDeploymentPermission(tx, userId);
      await assertOwnerQuota(tx, cfg, userId, 1);
      return tx.hostedApplication.create({
        data: {
          name: text(body, 'name', repo.full_name),
          ownerUserId: userId,
          createdByUserId: userId,
          repositoryId,
          repository: repo.full_name,
          installationId,
          branch,
          ...settings,
          originatingCommit: originCommit,
        },
      });
    });
    await provisionClients(app, cfg);
    await audit(app.id, userId, 'CREATED');
    try {
      const head = await github<{ sha: string }>(
        token,
        `${base}/commits/${encodeURIComponent(branch)}`,
      );
      await commitFiles(
        token,
        base,
        branch,
        head.sha,
        [{ path: workflowPath(app.id), content: managedWorkflow(app) }],
        'Install FHIR Studio build workflow',
      );
    } catch {
      await prisma.hostedBuild.create({
        data: {
          applicationId: app.id,
          branch,
          commit: '',
          generation: app.generation,
          status: 'FAILED',
          error:
            'Workflow installation needs a writable branch. Use Install / repair workflow, then merge it into the default branch on GitHub.',
        },
      });
    }
    res.status(201).json(
      await serialize(
        await prisma.hostedApplication.findUniqueOrThrow({
          where: { id: app.id },
          include,
        }),
        req,
      ),
    );
  });
  router.get('/api/hosted-applications/:id', async (req, res) => {
    const { app } = await applicationAccess(req, String(req.params.id));
    res.json(await serialize(app, req));
  });
  router.get('/api/hosted-applications/:id/health', async (req, res) => {
    const { app, userId } = await applicationAccess(req, String(req.params.id));
    if(app.sourceKind==='artifact'){
      const preview=app.builds.find(build=>build.id===app.previewBuildId);
      res.json({state:preview?.status==='READY'?'READY':'PREVIEW_REQUIRED',message:preview?.status==='READY'?'Validated catalog content is ready.':'Create or retry the catalog preview in Skycapp.'});return;
    }
    const { token, repo, base } = await repositoryForUser(
      userId,
      app.repositoryId,
      cfg,
    );
    await installationToken(app.installationId, app.repositoryId, cfg);
    try {
      const workflow = await github<{ state: string; html_url: string }>(
        token,
        `${base}/actions/workflows/${encodeURIComponent(workflowPath(app.id))}`,
      );
      res.json({
        state: workflow.state === 'active' ? 'READY' : 'ACTIONS_DISABLED',
        message:
          workflow.state === 'active'
            ? `GitHub access and managed workflow are ready. Deployment branch: ${app.branch}. Default branch: ${repo.default_branch}.`
            : 'Enable the managed workflow in GitHub Actions, then rebuild.',
        url: workflow.html_url,
      });
    } catch (error) {
      if (error instanceof HostingError && error.status === 409)
        res.json({
          state: 'WORKFLOW_SETUP_REQUIRED',
          message:
            'Install or repair the workflow on a writable branch and merge it to the default branch on GitHub. Check that Actions is enabled for this repository.',
        });
      else throw error;
    }
  });
  router.get('/api/hosted-applications/:id/source', async (req, res) => {
    const { app, userId } = await applicationAccess(req, String(req.params.id));
    const branch = branchName(String(req.query.branch || app.branch));
    if (typeof req.query.path === 'string')
      res.json({
        content: await readSource(
          userId,
          app.repositoryId,
          String(req.query.commit || branch),
          req.query.path,
          cfg,
        ),
      });
    else res.json(await sourceSnapshot(userId, app.repositoryId, branch, cfg));
  });
  router.post('/api/hosted-applications/:id/source', async (req, res) => {
    const { app, userId } = await applicationAccess(
      req,
      String(req.params.id),
      'develop',
    );
    const body = req.body as Body;
    const { token, base } = await repositoryForUser(
      userId,
      app.repositoryId,
      cfg,
      true,
    );
    const branch = branchName(text(body, 'branch', app.branch));
    const commit = await commitFiles(
      token,
      base,
      branch,
      text(body, 'expectedCommit'),
      filesFrom(body),
      text(body, 'message', 'Edit application in FHIR Studio'),
    );
    if (body.preview === true)
      await prisma.$transaction(async (tx) => {
        await lockHostingAllocation(tx, [app.ownerUserId, userId]);
        await lockApplication(tx, app.id);
        await assertDeploymentPermission(tx, userId);
        const current = await tx.hostedApplication.findUniqueOrThrow({
          where: { id: app.id },
        });
        if (
          current.repositoryId !== app.repositoryId ||
          current.generation !== app.generation
        )
          throw new HostingError(
            409,
            `Saved ${commit} to GitHub, but the application configuration changed. Refresh before requesting a preview.`,
            'conflict',
          );
        await assertCurrentCapability(
          tx,
          app.id,
          userId,
          'develop',
          req.effectivePermissions?.global_manage,
        );
        // A fast webhook may already have bound the push to this exact commit.
        const matched = await tx.hostedBuild.findFirst({
          where: {
            applicationId: app.id,
            branch,
            commit,
            generation: current.generation,
            status: { notIn: ['CANCELLED', 'FAILED'] },
          },
          orderBy: { createdAt: 'desc' },
        });
        const row =
          matched ||
          (await tx.hostedBuild.create({
            data: {
              applicationId: app.id,
              branch,
              commit,
              generation: current.generation,
              requestedByUserId: userId,
              requestEvent: 'push',
            },
          }));
        await tx.hostedApplication.update({
          where: { id: app.id },
          data: { desiredBuildId: row.id, lastDeveloperActivityAt: new Date() },
        });
      });
    await prisma.hostedApplication.update({ where: { id: app.id }, data: { lastDeveloperActivityAt: new Date() } });
    await audit(app.id, userId, 'SOURCE_SAVED');
    res.json({ commit });
  });
  router.post('/api/hosted-applications/:id/branches', async (req, res) => {
    const { app, userId } = await applicationAccess(
      req,
      String(req.params.id),
      'develop',
    );
    const body = req.body as Body;
    const { token, base } = await repositoryForUser(
      userId,
      app.repositoryId,
      cfg,
      true,
    );
    await github(token, `${base}/git/refs`, 'POST', {
      ref: `refs/heads/${branchName(text(body, 'branch'))}`,
      sha: text(body, 'commit'),
    });
    res.json({ created: true });
  });
  router.post('/api/hosted-applications/:id/workflow', async (req, res) => {
    const { app, userId } = await applicationAccess(
      req,
      String(req.params.id),
      'publish',
    );
    const { token, base } = await repositoryForUser(
      userId,
      app.repositoryId,
      cfg,
      true,
    );
    const branch = branchName(text(req.body as Body, 'branch', app.branch));
    const head = await github<{ sha: string }>(
      token,
      `${base}/commits/${encodeURIComponent(branch)}`,
    );
    await commitFiles(
      token,
      base,
      branch,
      head.sha,
      [{ path: workflowPath(app.id), content: managedWorkflow(app) }],
      'Install or repair FHIR Studio build workflow',
    );
    res.json({
      installed: true,
      mergeUrl: `https://github.com/${app.repository}/compare/${branch}`,
    });
  });
  router.post('/api/hosted-applications/:id/repository', async (req, res) => {
    const { app, userId } = await applicationAccess(
      req,
      String(req.params.id),
      'own',
    );
    const body = req.body as Body;
    const repositoryId = text(body, 'repositoryId');
    const installationId = text(body, 'installationId');
    if (!/^\d+$/.test(repositoryId) || !/^\d+$/.test(installationId))
      throw new HostingError(400, 'Invalid repository or installation ID.');
    const { repo } = await repositoryForUser(userId, repositoryId, cfg, true);
    await installationToken(installationId, repositoryId, cfg);
    await prisma.$transaction(async (tx) => {
      await lockApplication(tx, app.id);
      await assertCurrentCapability(tx, app.id, userId, 'own');
      await tx.hostedApplication.update({
        where: { id: app.id },
        data: {
          repositoryId,
          repository: repo.full_name,
          installationId,
          branch: repo.default_branch,
          previewBuildId: null,
          desiredBuildId: null,
          templateCommit: null,
          isTemplate: false,
          autoPublish: false,
          publishingPaused: true,
          generation: { increment: 1 },
          lastDeveloperActivityAt: new Date(),
          policyUpdatedAt: new Date(),
        },
      });
    });
    await audit(app.id, userId, 'REPOSITORY_RELINKED');
    res.json({ relinked: true });
  });
  router.post('/api/hosted-applications/:id/suspend', async (req, res) => {
    const { app, userId } = await applicationAccess(req, String(req.params.id));
    if (!req.effectivePermissions?.global_manage)
      throw new HostingError(403, 'Platform administration required.');
    const suspended = (req.body as Body).suspended !== false;
    const reason = text(req.body as Body, 'reason').trim();
    if (!reason || reason.length > 2000) throw new HostingError(400, 'An administrative reason is required (1–2000 characters).');
    await performHostingAction(app.id, { ids: [app.id], action: suspended ? 'suspend' : 'resume', reason, expectedGenerations: { [app.id]: app.generation } }, userId);
    res.json({ suspended });
  });
  router.post('/api/hosted-applications/:id/builds', async (req, res) => {
    const { app, userId } = await applicationAccess(
      req,
      String(req.params.id),
      'develop',
    );
    if (app.suspended) throw new HostingError(409, 'Application is suspended.');
    const { token, base } = await repositoryForUser(
      userId,
      app.repositoryId,
      cfg,
      true,
    );
    const branch = branchName(text(req.body as Body, 'branch', app.branch));
    const head = await github<{ sha: string }>(
      token,
      `${base}/commits/${encodeURIComponent(branch)}`,
    );
    const build = await prisma.$transaction(async (tx) => {
      await lockApplication(tx, app.id);
      await assertCurrentCapability(
        tx,
        app.id,
        userId,
        'develop',
        req.effectivePermissions?.global_manage,
      );
      const current = await tx.hostedApplication.findUniqueOrThrow({
        where: { id: app.id },
      });
      if (
        current.repositoryId !== app.repositoryId ||
        current.generation !== app.generation
      )
        throw new HostingError(
          409,
          'Application configuration changed. Refresh before building.',
        );
      const row = await tx.hostedBuild.create({
        data: {
          applicationId: app.id,
          branch,
          commit: head.sha,
          generation: current.generation,
          runtimeContract: current.runtimeContract || undefined,
          publicConfiguration: current.publicConfiguration || {},
          integrationGrantId: null,
          requestedByUserId: userId,
          requestEvent: 'workflow_dispatch',
        },
      });
      await tx.hostedApplication.update({
        where: { id: app.id },
        data: { desiredBuildId: row.id, lastDeveloperActivityAt: new Date() },
      });
      return row;
    });
    try {
      await github(
        token,
        `${base}/actions/workflows/${encodeURIComponent(workflowPath(app.id))}/dispatches`,
        'POST',
        { ref: branch, inputs: { studio_request_id: build.id } },
      );
    } catch (error) {
      await prisma.hostedBuild.update({
        where: { id: build.id },
        data: {
          status: 'FAILED',
          error:
            error instanceof Error
              ? error.message
              : 'Workflow dispatch failed. Merge the workflow to the default branch.',
        },
      });
      throw error;
    }
    res.status(202).json({ buildId: build.id });
  });
  router.post(
    '/api/hosted-applications/:id/builds/:buildId/cancel',
    async (req, res) => {
      const { app, userId } = await applicationAccess(
        req,
        String(req.params.id),
        'develop',
      );
      const build = await prisma.hostedBuild.findFirstOrThrow({
        where: { id: String(req.params.buildId), applicationId: app.id },
      });
      const { token, base } = await repositoryForUser(
        userId,
        app.repositoryId,
        cfg,
        true,
      );
      await prisma.$transaction(async (tx) => {
        await lockApplication(tx, app.id);
        await assertCurrentCapability(tx, app.id, userId, 'develop');
        const current = await tx.hostedBuild.findUniqueOrThrow({
          where: { id: build.id },
        });
        if (!['WAITING', 'BUILDING', 'IMPORTING'].includes(current.status))
          throw new HostingError(409, 'Only an active build can be cancelled.');
        await tx.hostedApplication.updateMany({
          where: { id: app.id, desiredBuildId: build.id },
          data: {
            desiredBuildId: null,
            generation: { increment: 1 },
          lastDeveloperActivityAt: new Date(),
            policyUpdatedAt: new Date(),
          },
        });
        await tx.hostedBuild.update({
          where: { id: build.id },
          data: { status: 'CANCELLED' },
        });
      });
      if (build.jobId) await cancelJob(build.jobId);
      let remoteCancellationConfirmed = true;
      if (build.runId && build.status === 'BUILDING') {
        try {
          await github(
            token,
            `${base}/actions/runs/${build.runId}/cancel`,
            'POST',
          );
        } catch {
          remoteCancellationConfirmed = false;
        }
      }
      res.json({ cancelled: true, remoteCancellationConfirmed });
    },
  );
  router.post(
    '/api/hosted-applications/:id/builds/:buildId/retry',
    async (req, res) => {
      const { app, userId } = await applicationAccess(
        req,
        String(req.params.id),
        'develop',
      );
      if(app.sourceKind==='repository') await repositoryForUser(userId, app.repositoryId, cfg, true);
      const build = await prisma.hostedBuild.findFirstOrThrow({
        where: { id: String(req.params.buildId), applicationId: app.id },
      });
      if (
        app.desiredBuildId !== build.id ||
        build.generation !== app.generation ||
        !build.runId ||
        !build.jobId ||
        build.status !== 'FAILED'
      )
        throw new HostingError(409, 'Build the current source again.');
      await queueImport(build);
      res.status(202).json({ queued: true });
    },
  );
  router.post('/api/hosted-applications/:id/sync', async (req, res) => {
    const { app, userId } = await applicationAccess(
      req,
      String(req.params.id),
      'develop',
    );
    const { token, base } = await repositoryForUser(
      userId,
      app.repositoryId,
      cfg,
      true,
    );
    const runs = await github<{ workflow_runs: Array<{ id: number }> }>(
      token,
      `${base}/actions/workflows/${encodeURIComponent(workflowPath(app.id))}/runs?per_page=10`,
    );
    for (const run of runs.workflow_runs.reverse())
      await reconcileRun(app, String(run.id), cfg);
    res.json({ synchronized: true });
  });
  router.patch('/api/hosted-applications/:id', async (req, res) => {
    const { app, userId, rights } = await applicationAccess(
      req,
      String(req.params.id),
      'publish',
    );
    const body = req.body as Body;
    if (
      body.suspended !== undefined &&
      !req.effectivePermissions?.global_manage
    )
      throw new HostingError(
        403,
        'Only platform administrators can suspend applications.',
      );
    if (body.suspended !== undefined) throw new HostingError(400, 'Use the suspension endpoint with an administrative reason.');
    if (app.sourceKind==='artifact') throw new HostingError(409,'Use the catalog runtime-configuration controls to update artifact applications.');
    const { repo } = await repositoryForUser(userId, app.repositoryId, cfg);
    if (body.templateVisibility === 'PUBLIC' && repo.private)
      throw new HostingError(
        400,
        'Public templates require a public GitHub repository.',
      );
    const nodeVersion = text(body, 'nodeVersion', app.nodeVersion);
    if (!/^\d{1,2}(?:\.\d{1,2})?$/.test(nodeVersion))
      throw new HostingError(400, 'Invalid Node runtime version.');
    safeAssetPath(text(body, 'launchPath', app.launchPath));
    safeAssetPath(text(body, 'callbackPath', app.callbackPath));
    if (
      text(body, 'scope', app.scope).includes('system/') ||
      text(body, 'scope', app.scope).includes('?')
    )
      throw new HostingError(
        400,
        'Hosted public clients do not support system or filtered scopes.',
      );
    managedWorkflow({
      id: app.id,
      nodeVersion,
      projectDirectory: text(body, 'projectDirectory', app.projectDirectory),
      outputDirectory: text(body, 'outputDirectory', app.outputDirectory),
      buildCommand: text(body, 'buildCommand', app.buildCommand),
    });
    const existingContract = app.runtimeContract as unknown as StaticSmartRuntimeContract | null;
    const nextContract = existingContract ? {
      ...existingContract,
      launch_path: text(body, 'launchPath', app.launchPath),
      callback_paths: [text(body, 'callbackPath', app.callbackPath), ...existingContract.callback_paths.slice(1)].filter((path,index,all)=>all.indexOf(path)===index),
      scopes: text(body, 'scope', app.scope).split(/\s+/).filter(Boolean),
    } : null;
    if(nextContract){
      const errors=deploymentProfileErrors({name:app.name,artifact_id:'installed-content',runtime_contract:nextContract,source_project:null});
      if(Object.keys(errors).length)throw new HostingError(400,'Catalog applications require static HTML callbacks and supported SMART scopes.');
    }
    const templateCommit =
      body.isTemplate === true
        ? (
            await sourceSnapshot(
              userId,
              app.repositoryId,
              branchName(text(body, 'branch', app.branch)),
              cfg,
            )
          ).commit
        : app.templateCommit;
    const updated = await prisma.$transaction(async (tx) => {
      await lockApplication(tx, app.id);
      await assertCurrentCapability(
        tx,
        app.id,
        userId,
        'publish',
        req.effectivePermissions?.global_manage,
      );
      const updated = await tx.hostedApplication.update({
        where: { id: app.id },
        data: {
          name: text(body, 'name', app.name),
          description: text(body, 'description', app.description),
          branch: branchName(text(body, 'branch', app.branch)),
          projectDirectory: repositoryPath(
            text(body, 'projectDirectory', app.projectDirectory),
            true,
          ),
          buildCommand: text(body, 'buildCommand', app.buildCommand),
          outputDirectory: repositoryPath(
            text(body, 'outputDirectory', app.outputDirectory),
          ),
          nodeVersion,
          launchPath: repositoryPath(text(body, 'launchPath', app.launchPath)),
          callbackPath: repositoryPath(
            text(body, 'callbackPath', app.callbackPath),
          ),
          scope: text(body, 'scope', app.scope),
          ...(nextContract ? {runtimeContract:JSON.parse(JSON.stringify(nextContract)),integrationGrantId:null}:{}),
          autoPublish:
            app.integrationClientId ? false : typeof body.autoPublish === 'boolean'
              ? body.autoPublish
              : app.autoPublish,
          publishingPaused: body.resume === true ? false : app.publishingPaused,
          isTemplate:
            typeof body.isTemplate === 'boolean'
              ? body.isTemplate
              : app.isTemplate,
          templateVisibility:
            body.templateVisibility === 'PUBLIC'
              ? 'PUBLIC'
              : body.templateVisibility === 'PRIVATE'
                ? 'PRIVATE'
                : app.templateVisibility,
          templateCommit,
          ...(req.effectivePermissions?.global_manage &&
          typeof body.suspended === 'boolean'
            ? { suspended: body.suspended }
            : {}),
          generation: { increment: 1 },
          lastDeveloperActivityAt: new Date(),
          policyUpdatedAt: new Date(),
        },
      });
      await provisionClients(updated, cfg, tx);
      return retireSupersededBuilds(tx, updated);
    });
    await audit(app.id, userId, 'SETTINGS_UPDATED');
    res.json({ updated: true, own: rights.own });
  });
  router.post('/api/hosted-applications/:id/publish', async (req, res) => {
    const { app, userId } = await applicationAccess(
      req,
      String(req.params.id),
      'publish',
    );
    const expected = text(req.body as Body, 'buildId');
    await prisma.$transaction(async (tx) => {
      await lockApplication(tx, app.id);
      await assertCurrentCapability(
        tx,
        app.id,
        userId,
        'publish',
        req.effectivePermissions?.global_manage,
      );
      const current = await tx.hostedApplication.findUniqueOrThrow({
        where: { id: app.id },
      });
      const build = await tx.hostedBuild.findUnique({
        where: { id: expected },
      });
      if (
        current.suspended ||
        current.deletedAt ||
        current.generation !== app.generation ||
        current.previewBuildId !== expected ||
        !build?.directory ||
        build.status !== 'READY' ||
        build.applicationId !== app.id
      )
        throw new HostingError(
          409,
          'The preview changed or is unavailable. Review the current preview first.',
        );
      if (current.integrationClientId) {
        const review = await tx.integrationReview.findUnique({where:{applicationId_userId:{applicationId:app.id,userId}}});
        if (review?.buildId !== expected || review.revisionDigest !== build.revisionDigest) throw new HostingError(409, 'Mark this exact preview reviewed before publishing.');
      }
      const published = await tx.hostedApplication.update({
        where: { id: app.id },
        data: { publishedBuildId: expected },
      });
      await provisionClients(published, cfg, tx);
    });
    await audit(app.id, userId, 'PUBLISHED');
    res.json({ published: true });
  });
  router.post('/api/hosted-applications/:id/unpublish', async (req, res) => {
    const { app, userId, rights } = await applicationAccess(
      req,
      String(req.params.id),
      'read',
    );
    if (!rights.publish && !req.effectivePermissions?.global_manage)
      throw new HostingError(
        403,
        'Application publishing or platform moderation permission required.',
      );
    await prisma.$transaction(async (tx) => {
      await lockApplication(tx, app.id);
      await assertCurrentCapability(
        tx,
        app.id,
        userId,
        req.effectivePermissions?.global_manage ? 'read' : 'publish',
        req.effectivePermissions?.global_manage,
      );
      await tx.hostedApplication.update({
        where: { id: app.id },
        data: {
          publishedBuildId: null,
          publishingPaused: true,
          generation: { increment: 1 },
          lastDeveloperActivityAt: new Date(),
          policyUpdatedAt: new Date(),
        },
      });
    });
    await prisma.smartAuthSession.updateMany({
      where: { clientId: `hosted-${app.id}-published` },
      data: { isRevoked: true },
    });
    await audit(app.id, userId, 'UNPUBLISHED');
    res.json({ unpublished: true });
  });
  router.put('/api/hosted-applications/:id/collaborators', async (req, res) => {
    const { app, rights } = await applicationAccess(
      req,
      String(req.params.id),
      'manageCollaborators',
    );
    const body = req.body as Body;
    const role = text(body, 'role');
    if (!['MANAGE', 'READ_WRITE', 'READ_ONLY'].includes(role))
      throw new HostingError(400, 'Invalid collaborator role.');
    const user = await prisma.user.findFirst({
      where: {
        email: { equals: text(body, 'email'), mode: 'insensitive' },
        isSuspended: false,
      },
    });
    if (!user || user.id === app.ownerUserId)
      throw new HostingError(
        400,
        'Select an existing non-owner Studio account.',
      );
    const existing = app.collaborators.find((c) => c.userId === user.id);
    if (!rights.own && (role === 'MANAGE' || existing?.role === 'MANAGE'))
      throw new HostingError(403, 'Only the owner can manage Administrators.');
    await prisma.$transaction(async (tx) => {
      await lockApplication(tx, app.id);
      await assertCurrentCapability(
        tx,
        app.id,
        req.sessionAuth!.userId,
        'manageCollaborators',
      );
      const currentApp = await tx.hostedApplication.findUniqueOrThrow({
        where: { id: app.id },
      });
      const currentMember = await tx.hostedCollaborator.findUnique({
        where: {
          applicationId_userId: { applicationId: app.id, userId: user.id },
        },
      });
      if (
        user.id === currentApp.ownerUserId ||
        (currentApp.ownerUserId !== req.sessionAuth!.userId &&
          (role === 'MANAGE' || currentMember?.role === 'MANAGE'))
      )
        throw new HostingError(
          403,
          'Only the owner can manage Administrators.',
        );
      await tx.hostedCollaborator.upsert({
        where: {
          applicationId_userId: { applicationId: app.id, userId: user.id },
        },
        create: { applicationId: app.id, userId: user.id, role },
        update: { role },
      });
      await tx.hostedApplication.update({
        where: { id: app.id },
        data: { generation: { increment: 1 },
          lastDeveloperActivityAt: new Date(), policyUpdatedAt: new Date() },
      });
    });
    await audit(app.id, req.sessionAuth!.userId, 'COLLABORATOR_CHANGED');
    res.json({ updated: true });
  });
  router.delete(
    '/api/hosted-applications/:id/collaborators/:userId',
    async (req, res) => {
      const { app, rights } = await applicationAccess(
        req,
        String(req.params.id),
        'manageCollaborators',
      );
      const target = app.collaborators.find(
        (c) => c.userId === String(req.params.userId),
      );
      if (!rights.own && target?.role === 'MANAGE')
        throw new HostingError(
          403,
          'Only the owner can remove Administrators.',
        );
      await prisma.$transaction(async (tx) => {
        await lockApplication(tx, app.id);
        await assertCurrentCapability(
          tx,
          app.id,
          req.sessionAuth!.userId,
          'manageCollaborators',
        );
        const currentApp = await tx.hostedApplication.findUniqueOrThrow({
          where: { id: app.id },
        });
        const currentMember = await tx.hostedCollaborator.findUnique({
          where: {
            applicationId_userId: {
              applicationId: app.id,
              userId: String(req.params.userId),
            },
          },
        });
        if (
          currentApp.ownerUserId !== req.sessionAuth!.userId &&
          currentMember?.role === 'MANAGE'
        )
          throw new HostingError(
            403,
            'Only the owner can remove Administrators.',
          );
        await tx.hostedCollaborator.deleteMany({
          where: { applicationId: app.id, userId: String(req.params.userId) },
        });
        await tx.hostedApplication.update({
          where: { id: app.id },
          data: { generation: { increment: 1 },
          lastDeveloperActivityAt: new Date(), policyUpdatedAt: new Date() },
        });
      });
      await audit(app.id, req.sessionAuth!.userId, 'COLLABORATOR_REMOVED');
      res.json({ removed: true });
    },
  );
  router.post('/api/hosted-applications/:id/transfer', async (req, res) => {
    const { app, rights } = await applicationAccess(req, String(req.params.id));
    if (!rights.own && !req.effectivePermissions?.global_manage)
      throw new HostingError(403, 'Owner or platform administration required.');
    const user = await prisma.user.findFirst({
      where: {
        email: { equals: text(req.body as Body, 'email'), mode: 'insensitive' },
        isSuspended: false,
      },
    });
    if (!user)
      throw new HostingError(404, 'Recipient must have a Studio account.');
    if (user.id === app.ownerUserId)
      throw new HostingError(400, 'Choose a different owner.');
    await prisma.$transaction(async (tx) => {
      await lockApplication(tx, app.id);
      const current = await tx.hostedApplication.findUniqueOrThrow({
        where: { id: app.id },
      });
      if (
        current.deletedAt ||
        current.repositoryId !== app.repositoryId ||
        (current.ownerUserId !== req.sessionAuth!.userId &&
          !req.effectivePermissions?.global_manage)
      )
        throw new HostingError(
          409,
          'Application ownership or repository changed.',
        );
      await tx.hostedApplication.update({
        where: { id: app.id },
        data: { transferToUserId: user.id },
      });
    });
    res.json({ pending: true });
  });
  router.post(
    '/api/hosted-applications/:id/accept-transfer',
    async (req, res) => {
      const userId = req.sessionAuth!.userId;
      const app = await prisma.hostedApplication.findFirst({
        where: {
          id: String(req.params.id),
          transferToUserId: userId,
          deletedAt: null,
        },
      });
      if (!app) throw new HostingError(404, 'No pending transfer.');
      if(app.sourceKind==='repository') await repositoryForUser(userId, app.repositoryId, cfg, true);
      await prisma.$transaction(async (tx) => {
        await lockHostingAllocation(tx, [app.ownerUserId, userId]);
        await lockApplication(tx, app.id);
        await assertDeploymentPermission(tx, userId);
        const current = await tx.hostedApplication.findUniqueOrThrow({
          where: { id: app.id },
        });
        if (
          current.transferToUserId !== userId ||
          current.deletedAt ||
          current.suspended ||
          current.repositoryId !== app.repositoryId
        )
          throw new HostingError(
            409,
            'The transfer invitation or repository changed.',
          );
        const allocation = await tx.hostedBuild.aggregate({ where: { applicationId: app.id }, _sum: { byteSize: true } });
        await assertOwnerQuota(tx, cfg, userId, 1, allocation._sum.byteSize ?? 0n);
        await tx.hostedApplication.update({
          where: { id: app.id },
          data: {
            ownerUserId: userId,
            transferToUserId: null,
            generation: { increment: 1 },
          lastDeveloperActivityAt: new Date(),
            policyUpdatedAt: new Date(),
          },
        });
        await tx.hostedCollaborator.deleteMany({
          where: { applicationId: app.id, userId },
        });
      });
      await audit(app.id, userId, 'OWNERSHIP_TRANSFERRED');
      res.json({ accepted: true });
    },
  );
  router.post(
    '/api/hosted-applications/:id/sandboxes/:sandboxId',
    async (req, res) => {
      const app = await prisma.hostedApplication.findFirst({
        where: {
          id: String(req.params.id),
          deletedAt: null,
          suspended: false,
          publishedBuildId: { not: null },
        },
      });
      if (!app) throw new HostingError(404, 'Published application not found.');
      const sandbox = await sandboxAccess(
        req.sessionAuth!.userId,
        String(req.params.sandboxId),
        true,
        req.effectivePermissions?.global_manage,
      );
      if (!app.publishedBuildId || app.suspended)
        throw new HostingError(409, 'Publish the application first.');
      await prisma.hostedSandbox.upsert({
        where: {
          applicationId_sandboxId: {
            applicationId: app.id,
            sandboxId: sandbox.id,
          },
        },
        create: { applicationId: app.id, sandboxId: sandbox.id },
        update: {},
      });
      res.json({ enabled: true });
    },
  );
  router.delete(
    '/api/hosted-applications/:id/sandboxes/:sandboxId',
    async (req, res) => {
      const sandbox = await sandboxAccess(
        req.sessionAuth!.userId,
        String(req.params.sandboxId),
        true,
        req.effectivePermissions?.global_manage,
      );
      const applicationId = String(req.params.id);
      await prisma.hostedSandbox.deleteMany({
        where: { applicationId, sandboxId: sandbox.id },
      });
      await prisma.smartAuthSession.updateMany({
        where: {
          clientId: `hosted-${applicationId}-published`,
          sandboxId: sandbox.sandboxId,
        },
        data: { isRevoked: true },
      });
      res.json({ enabled: false });
    },
  );
  router.delete('/api/hosted-applications/:id', async (req, res) => {
    const { app, userId } = await applicationAccess(req, String(req.params.id));
    if (app.ownerUserId !== userId && !req.effectivePermissions?.global_manage)
      throw new HostingError(
        403,
        'Only the owner or a platform administrator can delete this application.',
      );
    await prisma.$transaction(async (tx) => {
      await lockApplication(tx, app.id);
      const current = await tx.hostedApplication.findUniqueOrThrow({
        where: { id: app.id },
      });
      if (
        current.ownerUserId !== userId &&
        !req.effectivePermissions?.global_manage
      )
        throw new HostingError(403, 'Application ownership changed.');
      await tx.hostedApplication.update({
        where: { id: app.id },
        data: {
          deletedAt: new Date(),
          deleteAfter: new Date(Date.now() + 30 * 86400000),
          desiredBuildId: null,
          publishingPaused: true,
          generation: { increment: 1 },
          lastDeveloperActivityAt: new Date(),
          policyUpdatedAt: new Date(),
        },
      });
    });
    await prisma.smartAuthSession.updateMany({
      where: {
        clientId: {
          in: [`hosted-${app.id}-preview`, `hosted-${app.id}-published`],
        },
      },
      data: { isRevoked: true },
    });
    await audit(app.id, userId, 'DELETED');
    res.json({ deleted: true });
  });
  return router;
}
