import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { tmpdir } from 'node:os';
import { once } from 'node:events';
import type { AddressInfo } from 'node:net';
import { after, before, test } from 'node:test';
import express from 'express';
import type { Server } from 'node:http';
import { createGitHubWebhookRouter, webhookSignature } from '../src/hosted/webhooks.js';
import { getPrisma, disconnectPrisma } from '../src/db/prisma.js';

const savedEnv = { ...process.env };
let server: Server;
let origin: string;

before(async () => {
  Object.assign(process.env, {
    NODE_ENV: 'test',
    FHIR_STUDIO_SERVER_DATABASE_URL: 'postgresql://unused:unused@127.0.0.1:1/unused',
    FHIR_STUDIO_HOSTING_ENABLED: 'true',
    FHIR_STUDIO_HOSTING_ROOT: tmpdir(),
    FHIR_STUDIO_HOSTING_DOMAIN: 'user.studio.test',
    FHIR_STUDIO_HOSTING_STUDIO_ORIGIN: 'https://studio.test',
    FHIR_STUDIO_HOSTING_ANALYTICS_KEY: crypto.randomBytes(32).toString('base64'),
    FHIR_STUDIO_HOSTING_ENCRYPTION_KEY: crypto.randomBytes(32).toString('base64'),
    FHIR_STUDIO_HOSTING_GITHUB_APP_ID: '1',
    FHIR_STUDIO_HOSTING_GITHUB_CLIENT_ID: 'client',
    FHIR_STUDIO_HOSTING_GITHUB_CLIENT_SECRET: 'secret',
    FHIR_STUDIO_HOSTING_GITHUB_PRIVATE_KEY: crypto.generateKeyPairSync('rsa', { modulusLength: 2048 }).privateKey.export({ type: 'pkcs8', format: 'pem' }).toString(),
    FHIR_STUDIO_HOSTING_GITHUB_WEBHOOK_SECRET: 'webhook-secret',
    FHIR_STUDIO_HOSTING_GITHUB_SLUG: 'studio',
  });
  const app = express();
  app.use(createGitHubWebhookRouter());
  server = app.listen(0, '127.0.0.1');
  await once(server, 'listening');
  origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

after(async () => {
  if (server) await new Promise<void>((resolve) => server.close(() => resolve()));
  await disconnectPrisma();
  for (const name of Object.keys(process.env)) if (!(name in savedEnv)) delete process.env[name];
  Object.assign(process.env, savedEnv);
});

test('empty webhook secrets fail closed and public-only hosting registers no GitHub webhook', () => {
  const body = Buffer.from('{"action":"deleted"}');
  const signature = `sha256=${crypto.createHmac('sha256', '').update(body).digest('hex')}`;
  assert.equal(webhookSignature(body, signature, ''), false);
  assert.equal(webhookSignature(body, signature, '   '), false);
  const appId = process.env.FHIR_STUDIO_HOSTING_GITHUB_APP_ID;
  process.env.FHIR_STUDIO_HOSTING_GITHUB_APP_ID = '';
  try { assert.equal(createGitHubWebhookRouter().stack.length, 0); }
  finally { process.env.FHIR_STUDIO_HOSTING_GITHUB_APP_ID = appId; }
});

test('repository webhook notifications reject malformed IDs and only query GitHub-backed applications', async (t) => {
  const queries: unknown[] = [];
  const delegate = getPrisma().hostedApplication;
  const original = delegate.findMany;
  delegate.findMany = (async (query: unknown) => {
    queries.push(query);
    return [];
  }) as typeof delegate.findMany;
  t.after(() => { delegate.findMany = original; });
  const send = async (value: unknown) => {
    const body = JSON.stringify(value);
    return fetch(`${origin}/api/github/webhook`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-GitHub-Event': 'repository',
        'X-Hub-Signature-256': `sha256=${crypto.createHmac('sha256', 'webhook-secret').update(body).digest('hex')}`,
      },
      body,
    });
  };
  assert.equal((await send({ action: 'deleted', repository: { id: '', full_name: 'forged', private: true } })).status, 204);
  assert.equal(queries.length, 0);
  assert.equal((await send({ action: 'deleted', repository: { id: 42, full_name: 'owner/repo', private: true } })).status, 204);
  assert.deepEqual(queries, [{ where: { sourceKind: 'repository', repositoryId: '42' } }]);
});
