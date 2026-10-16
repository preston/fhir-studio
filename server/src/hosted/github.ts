import crypto from 'node:crypto';
import type { Prisma } from '@prisma/client';
import { getPrisma } from '../db/prisma.js';
import { HostingError, assertDeploymentPermission } from './access.js';
import type { HostingConfig } from './config.js';

export interface GitHubRepo {
  id: number;
  full_name: string;
  private: boolean;
  default_branch: string;
  archived: boolean;
  permissions?: { push?: boolean; pull?: boolean };
}
export interface GitHubRun {
  id: number;
  display_title?: string;
  created_at?: string;
  run_attempt: number;
  workflow_id: number;
  path: string;
  head_sha: string;
  head_branch: string;
  event: string;
  status: string;
  conclusion: string | null;
  html_url: string;
  actor: { id: number; type: string; login?: string };
  triggering_actor: { id: number; type: string; login?: string };
  repository: { id: number };
  head_repository: { id: number } | null;
}
interface Tokens {
  access_token: string;
  refresh_token: string;
  expires_in: number;
  refresh_token_expires_in: number;
}
export function encrypt(value: unknown, config: HostingConfig): string {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv(
    'aes-256-gcm',
    Buffer.from(config.encryptionKey, 'base64'),
    iv,
  );
  const data = Buffer.concat([
    cipher.update(JSON.stringify(value)),
    cipher.final(),
  ]);
  return Buffer.concat([iv, cipher.getAuthTag(), data]).toString('base64url');
}
export function decrypt<T>(value: string, config: HostingConfig): T {
  const data = Buffer.from(value, 'base64url');
  const cipher = crypto.createDecipheriv(
    'aes-256-gcm',
    Buffer.from(config.encryptionKey, 'base64'),
    data.subarray(0, 12),
  );
  cipher.setAuthTag(data.subarray(12, 28));
  return JSON.parse(
    Buffer.concat([
      cipher.update(data.subarray(28)),
      cipher.final(),
    ]).toString(),
  ) as T;
}
export async function github<T>(
  token: string,
  endpoint: string,
  method = 'GET',
  body?: unknown,
): Promise<T> {
  if (!endpoint.startsWith('/') || endpoint.startsWith('//'))
    throw new HostingError(400, 'Invalid GitHub API path.');
  const response = await fetch(`https://api.github.com${endpoint}`, {
    method,
    redirect: 'error',
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2026-03-10',
      ...(body ? { 'Content-Type': 'application/json' } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(30_000),
  });
  if (!response.ok) {
    if (
      response.status === 429 ||
      (response.status === 403 &&
        (response.headers.get('x-ratelimit-remaining') === '0' ||
          response.headers.has('retry-after')))
    )
      throw new HostingError(
        503,
        'GitHub rate limit reached. Retry after the GitHub reset time.',
        'retry',
      );
    const recovery =
      response.status === 401
        ? 'reconnect'
        : response.status === 403 || response.status === 404
          ? 'repository-access'
          : response.status === 409 || response.status === 422
            ? 'conflict'
            : 'retry';
    throw new HostingError(
      response.status === 401
        ? 401
        : response.status === 429 || response.status >= 500
          ? 503
          : 409,
      `GitHub request failed (${response.status}). ${recovery === 'conflict' ? 'Refresh the branch or choose a writable branch; your changes were not overwritten.' : 'Check repository permissions, organization approval, and Actions availability.'}`,
      recovery,
    );
  }
  return response.status === 204
    ? (undefined as T)
    : ((await response.json()) as T);
}
export async function oauth(
  config: HostingConfig,
  body: Record<string, string>,
): Promise<Tokens> {
  const res = await fetch('https://github.com/login/oauth/access_token', {
    method: 'POST',
    headers: { Accept: 'application/json', 'Content-Type': 'application/json' },
    body: JSON.stringify({
      client_id: config.clientId,
      client_secret: config.clientSecret,
      ...body,
    }),
    signal: AbortSignal.timeout(20_000),
  });
  const tokens = (await res.json()) as Tokens;
  if (res.status === 429 || res.status >= 500)
    throw new HostingError(
      503,
      'GitHub authorization service is temporarily unavailable. Your connection has been preserved.',
      'retry',
    );
  if (
    !res.ok ||
    !tokens.access_token ||
    !tokens.refresh_token ||
    !tokens.expires_in
  )
    throw new HostingError(
      401,
      'GitHub authorization expired or was revoked. Reconnect GitHub.',
      'reconnect',
    );
  return tokens;
}
export function tokenData(tokens: Tokens, config: HostingConfig) {
  return {
    encryptedTokens: encrypt(tokens, config),
    expiresAt: new Date(Date.now() + tokens.expires_in * 1000),
    refreshExpiresAt: new Date(
      Date.now() + tokens.refresh_token_expires_in * 1000,
    ),
    status: 'CONNECTED',
  };
}
export async function userToken(
  userId: string,
  config: HostingConfig,
): Promise<string> {
  // A PostgreSQL advisory lock serializes rotation across all API and worker instances.
  try {
    return await getPrisma().$transaction(
      async (tx) => {
        await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`github:${userId}`}, 0))`;
        await assertDeploymentPermission(tx, userId);
        const row = await tx.gitHubConnection.findUnique({ where: { userId } });
        if (
          !row ||
          row.status !== 'CONNECTED' ||
          row.refreshExpiresAt < new Date()
        )
          throw new HostingError(
            401,
            'Reconnect GitHub in Profile → Connections.',
            'reconnect',
          );
        let tokens = decrypt<Tokens>(row.encryptedTokens, config);
        if (row.expiresAt.getTime() < Date.now() + 60_000) {
          tokens = await oauth(config, {
            grant_type: 'refresh_token',
            refresh_token: tokens.refresh_token,
          });
          await tx.gitHubConnection.update({
            where: { userId },
            data: tokenData(tokens, config),
          });
        }
        return tokens.access_token;
      },
      { timeout: 30_000 },
    );
  } catch (error) {
    if (error instanceof HostingError && error.status === 401)
      await getPrisma().gitHubConnection.updateMany({
        where: { userId },
        data: { status: 'RECONNECT_REQUIRED' },
      });
    throw error;
  }
}
export async function repositoryForUser(
  userId: string,
  repositoryId: string,
  config: HostingConfig,
  write = false,
) {
  const token = await userToken(userId, config);
  try {
    const repo = await github<GitHubRepo>(
      token,
      `/repositories/${encodeURIComponent(repositoryId)}`,
    );
    if (write && (!repo.permissions?.push || repo.archived))
      throw new HostingError(
        403,
        'GitHub repository write access is required.',
        'repository-access',
      );
    return { token, repo, base: `/repos/${repo.full_name}` };
  } catch (error) {
    if (error instanceof HostingError && error.status === 401)
      await getPrisma().gitHubConnection.updateMany({
        where: { userId },
        data: { status: 'RECONNECT_REQUIRED' },
      });
    throw error;
  }
}
export async function installationToken(
  installationId: string,
  repositoryId: string,
  config: HostingConfig,
): Promise<string> {
  const encode = (value: unknown) =>
    Buffer.from(JSON.stringify(value)).toString('base64url');
  const now = Math.floor(Date.now() / 1000);
  const payload = `${encode({ alg: 'RS256', typ: 'JWT' })}.${encode({ iat: now - 60, exp: now + 540, iss: config.appId })}`;
  const jwt = `${payload}.${crypto.sign('RSA-SHA256', Buffer.from(payload), config.privateKey).toString('base64url')}`;
  return (
    await github<{ token: string }>(
      jwt,
      `/app/installations/${encodeURIComponent(installationId)}/access_tokens`,
      'POST',
      {
        repository_ids: [Number(repositoryId)],
        permissions: { actions: 'read', contents: 'read' },
      },
    )
  ).token;
}
export async function lockApplication(
  tx: Prisma.TransactionClient,
  id: string,
): Promise<void> {
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`hosted:${id}`}, 0))`;
}
