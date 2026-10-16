import 'dotenv/config';
import express from 'express';
import type { Request, Response } from 'express';
import type { HostedChannel } from '@fhir-studio/core';
import path from 'node:path';
import { loadHostingConfig } from './config.js';
import { buildDirectory, safeAssetPath } from './filesystem.js';
import { getPrisma } from '../db/prisma.js';
import { UsageCollector, isKnownBot } from './usage.js';
import { VISITOR_COOKIE, visitorCookie, visitorCookieOptions } from './hll.js';
import cookieParser from 'cookie-parser';

const config = loadHostingConfig('host');
const app = express();
const usage = new UsageCollector('host');
usage.start();
app.use(cookieParser());
app.disable('x-powered-by');
app.set('trust proxy', config.trustProxyHops || 0);
const rates = new Map<string, { start: number; count: number }>();
setInterval(() => rates.clear(), 60_000).unref();
const knownApplications = new Set<string>();
setInterval(() => knownApplications.clear(), 60000).unref();
function track(
  req: Request,
  res: Response,
  applicationId: string,
  channel: HostedChannel,
  started: number,
): void {
  const bot = isKnownBot(req.get('user-agent') || '');
  const visitor = visitorCookie(
    config.analyticsKey!,
    req.hostname.toLowerCase(),
    req.cookies?.[VISITOR_COOKIE],
  );
  let recorded = false;
  const record = (aborted: boolean) => {
    if (recorded) return;
    recorded = true;
    const document =
      req.method === 'GET' &&
      String(res.getHeader('Content-Type') || '').includes('text/html');
    usage.record({
      applicationId: applicationId,
      channel,
      status: res.statusCode,
      document,
      bot,
      aborted,
      bytes:
        req.method === 'HEAD' || res.statusCode === 304 || aborted
          ? 0
          : Number(res.getHeader('Content-Length') || 0),
      durationMs: performance.now() - started,
      visitor: req.method === 'GET' ? visitor.visitor : null,
    });
  };
  res.on('finish', () => record(false));
  res.on('close', () => record(!res.writableFinished));
  // Issue only for document requests, avoiding independent cookies for parallel assets.
  if (
    !bot &&
    visitor.fresh &&
    req.method === 'GET' &&
    (req.path === '/' || req.path.endsWith('.html'))
  )
    res.cookie(VISITOR_COOKIE, visitor.token, visitorCookieOptions);
}
app.use(async (req, res) => {
  const started = performance.now();
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Origin-Agent-Cluster', '?1');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader(
    'Permissions-Policy',
    'camera=(), microphone=(), geolocation=(), payment=(), usb=()',
  );
  res.setHeader(
    'Content-Security-Policy',
    `default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; font-src 'self'; connect-src 'self' ${config.studioOrigin}/api/sandboxes/ ${config.studioOrigin}/oauth/token ${config.studioOrigin}/oauth/revoke ${config.studioOrigin}/oauth/jwks.json ${config.studioOrigin}/.well-known/; frame-src ${config.studioOrigin}/oauth/; frame-ancestors ${config.studioOrigin}; worker-src 'none'; object-src 'none'; base-uri 'self'; form-action ${config.studioOrigin}/oauth/`,
  );
  const host = req.hostname.toLowerCase();
  const suffix = `.${config.domain}`;
  if (!host.endsWith(suffix)) {
    res.sendStatus(404);
    return;
  }
  const match = host
    .slice(0, -suffix.length)
    .match(
      /^(app|preview)-([a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12})$/,
    );
  if (!match || !['GET', 'HEAD'].includes(req.method)) {
    res.sendStatus(404);
    return;
  }
  const key = req.ip || 'unknown';
  const rate = rates.get(key) || { start: Date.now(), count: 0 };
  rates.set(key, rate);
  const channel: HostedChannel =
    match[1] === 'preview' ? 'preview' : 'published';
  if (++rate.count > 600) {
    if (knownApplications.has(match[2]))
      track(req, res, match[2], channel, started);
    res.sendStatus(429);
    return;
  }
  const project = await getPrisma().hostedApplication.findFirst({
    where: { id: match[2], deletedAt: null, suspended: false },
  });
  const buildId =
    channel === 'preview' ? project?.previewBuildId : project?.publishedBuildId;
  if (project) {
    if (knownApplications.size < 4096) knownApplications.add(project.id);
    track(req, res, project.id, channel, started);
  }
  if (!project || !buildId) {
    res.sendStatus(404);
    return;
  }
  const build = await getPrisma().hostedBuild.findFirst({
    where: { id: buildId, applicationId: project.id, status: 'READY' },
  });
  if (!build?.directory) {
    res.sendStatus(404);
    return;
  }
  if (req.path === '/_studio/config.json') {
    res.setHeader('Cache-Control', 'no-store');
    res.json({
      clientId: `hosted-${project.id}-${channel}`,
      studioOrigin: config.studioOrigin,
      callbackPath: build.callbackPath,
      scope: build.scope,
    });
    return;
  }
  let file: string;
  try {
    file = safeAssetPath(
      decodeURIComponent(req.path).replace(/^\//, '') || build.launchPath,
    );
  } catch {
    res.sendStatus(404);
    return;
  }
  const root = buildDirectory(config, project.id, build.id);
  res.setHeader('Cache-Control', 'no-cache');
  res.sendFile(
    path.join(root, file),
    { dotfiles: 'deny', cacheControl: false },
    (error) => {
      if (error && !res.headersSent) res.sendStatus(404);
    },
  );
});
app.listen(Number(process.env.PORT || 8081), '0.0.0.0', () =>
  console.log('Static application host listening.'),
);

for (const signal of ['SIGTERM', 'SIGINT'])
  process.on(signal, () => {
    void usage
      .stop()
      .catch(() => console.error('Hosting usage shutdown flush failed'))
      .finally(() => process.exit(0));
  });
