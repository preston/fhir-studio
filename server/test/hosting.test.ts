import { test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { mkdtemp, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { createDefaultEffectivePermissions } from '@fhir-studio/core';
import {
  hasPermission,
  mergeBooleanPermissions,
} from '../src/authorization/permissions.js';
import { zipSync, strToU8 } from 'fflate';
import { capabilities, repositoryPath } from '../src/hosted/access.js';
import { encrypt, decrypt } from '../src/hosted/github.js';
import {
  extractArtifact,
  safeAssetPath,
  buildDirectory,
} from '../src/hosted/filesystem.js';
import { webhookSignature } from '../src/hosted/webhooks.js';
import { managedWorkflow } from '../src/hosted/source.js';
import { templateFiles } from '../src/hosted/templates.js';
import { verifyClientAssertionJwt } from '../src/smart-idp/crypto.js';
import type { HostingConfig } from '../src/hosted/config.js';
import { loadHostingConfig } from '../src/hosted/config.js';
import { ClientKeyResolver, publicKeyAddress, keySetUrl } from '../src/smart-idp/client-keys.js';
import { parseSmartV2Scopes, isSmartScopePermitted } from '../src/smart-idp/scopes.js';

test('deployment is denied by default, OR-merged explicitly, and included in the existing administrator bypass', () => {
  const defaults = createDefaultEffectivePermissions();
  assert.equal(defaults.applications_deployment, false);
  assert.equal(hasPermission(defaults, 'applications_deployment'), false);
  assert.equal(
    mergeBooleanPermissions([defaults, { applications_deployment: true }])
      .applications_deployment,
    true,
  );
  assert.equal(
    hasPermission(
      { ...defaults, global_manage: true },
      'applications_deployment',
    ),
    true,
  );
});

test('hosting configuration is required in API/worker startup; static hosts require no GitHub secrets', () => {
  const env = Object.fromEntries(
    Object.entries(process.env).filter(
      ([name]) => !name.startsWith('FHIR_STUDIO_HOSTING_'),
    ),
  );
  for (const entry of [
    "import { loadHostingConfig } from './src/hosted/config.ts'; loadHostingConfig()",
    "import { loadWorkerConfig } from './src/env.ts'; loadWorkerConfig()",
    "import { loadSsoConfig } from './src/auth/sso_config.ts'; loadSsoConfig()",
  ]) {
    const result = spawnSync(
      process.execPath,
      ['--import', 'tsx', '--input-type=module', '-e', entry],
      { env, encoding: 'utf8' },
    );
    assert.equal(result.status, 1, result.stderr);
    assert.match(result.stderr, /FHIR_STUDIO_HOSTING_GITHUB_APP_ID/);
    assert.match(result.stderr, /cp server\/\.env.example server\/\.env/);
  }
  const saved = { ...process.env };
  try {
    Object.assign(process.env, {
      FHIR_STUDIO_HOSTING_ANALYTICS_KEY: Buffer.alloc(32, 7).toString('base64'),
      FHIR_STUDIO_HOSTING_DOMAIN: 'user.studio.test',
      FHIR_STUDIO_HOSTING_STUDIO_ORIGIN: 'https://studio.test',
      FHIR_STUDIO_HOSTING_ROOT: '/definitely-missing-studio-storage',
    });
    assert.throws(() => loadHostingConfig('host'), /existing.*directory/);
    process.env.FHIR_STUDIO_HOSTING_ROOT = tmpdir();
    assert.equal(loadHostingConfig('host').root, tmpdir());
    process.env.FHIR_STUDIO_HOSTING_STUDIO_ORIGIN = 'http://studio.test';
    process.env.NODE_ENV = 'production';
    assert.throws(() => loadHostingConfig('host'), /HTTPS/);
  } finally {
    for (const name of Object.keys(process.env))
      if (!(name in saved)) delete process.env[name];
    Object.assign(process.env, saved);
  }
});

const config: HostingConfig = {
  root: '/tmp',
  domain: 'user.example.org',
  studioOrigin: 'https://studio.example.org',
  encryptionKey: crypto.randomBytes(32).toString('base64'),
  appId: '1',
  clientId: '',
  clientSecret: '',
  privateKey: '',
  webhookSecret: '',
  slug: '',
  maxArchiveBytes: 1024 * 1024,
  maxExpandedBytes: 1024,
  maxFiles: 10,
  maxApps: 10,
  maxStorageBytes: 1024 ** 3,
};
test('roles grant development and publication independently; platform moderation cannot borrow source rights', () => {
  assert.equal(capabilities('owner', 'owner').own, true);
  assert.equal(capabilities('owner', 'manager', 'MANAGE').publish, true);
  assert.equal(capabilities('owner', 'developer', 'READ_WRITE').develop, true);
  assert.equal(capabilities('owner', 'developer', 'READ_WRITE').publish, false);
  assert.equal(capabilities('owner', 'viewer', 'READ_ONLY').develop, false);
  assert.equal(capabilities('owner', 'stranger').read, false);
  assert.equal(
    capabilities('owner', 'operator', undefined, true).develop,
    false,
  );
  assert.equal(
    capabilities('owner', 'operator', undefined, true).publish,
    false,
  );
});
test('stored GitHub credentials authenticate ciphertext and key', () => {
  const secret = { access_token: 'access', refresh_token: 'refresh' };
  const value = encrypt(secret, config);
  assert.equal(value.includes('refresh'), false);
  assert.deepEqual(decrypt(value, config), secret);
  const bytes = Buffer.from(value, 'base64url');
  bytes[20] ^= 1;
  assert.throws(() => decrypt(bytes.toString('base64url'), config));
  assert.throws(() =>
    decrypt(value, {
      ...config,
      encryptionKey: crypto.randomBytes(32).toString('base64'),
    }),
  );
});
test('webhook verification authenticates raw bytes and rejects malformed signatures', () => {
  const bytes = Buffer.from('{"action":"completed"}');
  const signature = `sha256=${crypto.createHmac('sha256', 'secret').update(bytes).digest('hex')}`;
  assert.equal(webhookSignature(bytes, signature, 'secret'), true);
  assert.equal(
    webhookSignature(Buffer.from('changed'), signature, 'secret'),
    false,
  );
  assert.equal(webhookSignature(bytes, 'sha256=bad', 'secret'), false);
});
test('filesystem paths reject traversal, hidden secrets, devices and reserved runtime config', () => {
  for (const name of [
    '../secret.js',
    '/etc/passwd',
    '.env',
    'assets/../../index.html',
    'a\\b.js',
    'a:b.js',
    '_studio/config.json',
    'node.sh',
    'assets//a.js',
  ])
    assert.throws(() => safeAssetPath(name), name);
  assert.equal(safeAssetPath('assets/main.js'), 'assets/main.js');
  assert.throws(() => buildDirectory(config, '../etc', 'bad'));
  assert.throws(() => repositoryPath('../repo'));
  assert.equal(repositoryPath('packages/app'), 'packages/app');
});
test('artifact extraction bounds actual bytes and entries and rejects duplicate and link entries', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'studio-zip-'));
  try {
    const good = zipSync({
      'index.html': strToU8('<p>Hello</p>'),
      'assets/app.js': strToU8('export {}'),
    });
    const archive = path.join(root, 'good.zip');
    await writeFile(archive, good);
    assert.equal(
      await extractArtifact(
        archive,
        path.join(root, 'good'),
        config,
        new AbortController().signal,
      ),
      21,
    );
    assert.equal(
      await readFile(path.join(root, 'good/index.html'), 'utf8'),
      '<p>Hello</p>',
    );
    const bomb = path.join(root, 'large.zip');
    await writeFile(bomb, zipSync({ 'index.html': new Uint8Array(4096) }));
    await assert.rejects(
      extractArtifact(
        bomb,
        path.join(root, 'large'),
        config,
        new AbortController().signal,
      ),
      /size|limit/i,
    );
    const duplicate = path.join(root, 'duplicate.zip');
    await writeFile(
      duplicate,
      zipSync({ 'App.js': strToU8('a'), 'app.js': strToU8('b') }),
    );
    await assert.rejects(
      extractArtifact(
        duplicate,
        path.join(root, 'duplicate'),
        config,
        new AbortController().signal,
      ),
      /duplicate/i,
    );
    const link = path.join(root, 'link.zip');
    await writeFile(
      link,
      zipSync({
        'index.html': [strToU8('/etc/passwd'), { os: 3, attrs: 0xa1ff0000 }],
      }),
    );
    await assert.rejects(
      extractArtifact(
        link,
        path.join(root, 'link'),
        config,
        new AbortController().signal,
      ),
      /links|devices/i,
    );
    await assert.rejects(
      extractArtifact(
        archive,
        path.join(root, 'count'),
        { ...config, maxFiles: 1 },
        new AbortController().signal,
      ),
      /count/i,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
test('managed workflow has no Studio secrets and disambiguates run attempts', () => {
  const workflow = managedWorkflow({
    id: 'project',
    projectDirectory: 'packages/app',
    outputDirectory: 'dist',
    buildCommand: 'npm ci && npm run build',
    nodeVersion: '26',
  });
  assert.match(workflow, /persist-credentials: false/);
  assert.match(workflow, /github.run_attempt/);
  assert.match(workflow, /timeout-minutes: 15/);
  assert.doesNotMatch(workflow, /secrets\.|id-token: write/);
  assert.throws(() =>
    managedWorkflow({
      id: 'app',
      projectDirectory: '',
      outputDirectory: 'dist',
      buildCommand: '${{ secrets.KEY }}',
      nodeVersion: '26',
    }),
  );
  for (const kind of ['javascript', 'react', 'angular']) {
    const files = templateFiles(kind);
    assert.ok(files.some((file) => file.path === 'package.json'));
    assert.ok(
      files.some((file) => file.content.includes('/_studio/config.json')),
    );
  }
});
test('asymmetric client authentication rejects unsigned or mismatched assertions', () => {
  const fake =
    Buffer.from(JSON.stringify({ alg: 'none' })).toString('base64url') +
    '.' +
    Buffer.from(
      JSON.stringify({
        sub: 'client',
        iss: 'client',
        jti: 'nonce',
        exp: Math.floor(Date.now() / 1000) + 60,
        aud: 'https://studio/oauth/token',
      }),
    ).toString('base64url') +
    '.bad';
  assert.equal(
    verifyClientAssertionJwt(fake, 'https://studio/oauth/token', { keys: [] })
      .valid,
    false,
  );
});

test('filtered grants never authorize broader unfiltered resource access', () => {
  const filtered = parseSmartV2Scopes('patient/Observation.rs?category=vital-signs');
  assert.equal(isSmartScopePermitted(filtered, { resourceType: 'Observation', action: 'r' }), false);
  assert.equal(isSmartScopePermitted(parseSmartV2Scopes('patient/Observation.rs'), { resourceType: 'Observation', action: 'r' }), true);
});

test('SMART asymmetric assertions verify RS384 and ES384 without algorithm confusion', () => {
  for (const algorithm of ['RS384', 'ES384'] as const) {
    const keys = algorithm === 'RS384'
      ? crypto.generateKeyPairSync('rsa', { modulusLength: 2048 })
      : crypto.generateKeyPairSync('ec', { namedCurve: 'secp384r1' });
    const encode = (value: unknown) => Buffer.from(JSON.stringify(value)).toString('base64url');
    const input = `${encode({ alg: algorithm, kid: 'key', typ: 'JWT' })}.${encode({ iss: 'client', sub: 'client', aud: 'https://studio/oauth/token', jti: crypto.randomUUID(), exp: Math.floor(Date.now() / 1000) + 60 })}`;
    const assertion = `${input}.${crypto.sign('sha384', Buffer.from(input), { key: keys.privateKey, dsaEncoding: 'ieee-p1363' }).toString('base64url')}`;
    const key = { ...keys.publicKey.export({ format: 'jwk' }), kid: 'key', alg: algorithm };
    assert.equal(verifyClientAssertionJwt(assertion, 'https://studio/oauth/token', { keys: [key] }).valid, true);
    assert.equal(verifyClientAssertionJwt(assertion, 'https://studio/oauth/token', { keys: [key, key] }).valid, false);
    assert.equal(verifyClientAssertionJwt(assertion, 'https://other/oauth/token', { keys: [key] }).valid, false);
  }
});

test('registered key URLs cache within HTTP freshness and reject unregistered jku values', async () => {
  let downloads = 0;
  const keys = { keys: [{ kty: 'RSA', kid: 'key' }] };
  const resolver = new ClientKeyResolver(async () => {
    downloads++;
    return { keys, cacheControl: 'max-age=300' };
  });
  const assertion = (jku?: string) => `${Buffer.from(JSON.stringify({ alg: 'RS384', kid: 'key', ...(jku ? { jku } : {}) })).toString('base64url')}.payload.signature`;
  const client = { jwks: null, jwksUri: 'https://keys.example.org/jwks.json' };
  assert.deepEqual(await resolver.resolve(client, assertion()), keys);
  assert.deepEqual(await resolver.resolve(client, assertion(client.jwksUri)), keys);
  assert.equal(downloads, 1);
  await assert.rejects(resolver.resolve(client, assertion('https://attacker.example.org/keys')), /registered/);
  assert.equal(downloads, 1);
  const uncached = new ClientKeyResolver(async () => {
    downloads++;
    return { keys, cacheControl: 'no-store, max-age=300' };
  });
  await uncached.resolve(client, assertion());
  await uncached.resolve(client, assertion());
  assert.equal(downloads, 3);
});

test('remote signing keys cannot target private, loopback, or credentialed endpoints', async () => {
  for (const address of ['127.0.0.1', '10.1.2.3', '169.254.169.254', '172.16.0.1', '192.168.1.1', '100.64.1.1', '::1', '::ffff:127.0.0.1', 'fe80::1', 'fc00::1', '2002:7f00:1::'])
    assert.equal(publicKeyAddress(address), false, address);
  assert.equal(publicKeyAddress('8.8.8.8'), true);
  assert.equal(publicKeyAddress('2606:4700:4700::1111'), true);
  for (const url of ['http://keys.example.org', 'https://user:secret@keys.example.org', 'https://keys.example.org:8443/keys', 'https://localhost/keys'])
    assert.throws(() => keySetUrl(url), url);
  const assertion = `${Buffer.from('{}').toString('base64url')}.payload.signature`;
  await assert.rejects(new ClientKeyResolver().resolve({ jwks: null, jwksUri: 'https://127.0.0.1/keys' }, assertion), /public internet/);
});

test('the copied local environment starts base API and worker configuration without hosting setup', () => {
  const env = Object.fromEntries(Object.entries(process.env).filter(([name]) => !name.startsWith('FHIR_STUDIO_') && name !== 'DATABASE_URL'));
  const result = spawnSync(process.execPath, ['--env-file=.env.example', '--import', 'tsx', '--input-type=module', '-e', `
    import { loadSsoConfig } from './src/auth/sso_config.ts';
    import { loadWorkerConfig, isHostingEnabled } from './src/env.ts';
    import { browserSecurity } from './src/authentication/browser-security.ts';
    import { createSmartIdpRouter } from './src/smart-idp/routes.ts';
    import { createFhirGatewayRouter } from './src/fhir-gateway/proxy.ts';
    import { createHostingRouter } from './src/hosted/routes.ts';
    if (isHostingEnabled()) throw Error('Local hosting must be explicitly disabled.');
    browserSecurity(loadSsoConfig()); loadWorkerConfig();
    createSmartIdpRouter(); createFhirGatewayRouter(); createHostingRouter();
  `], { env: { ...env, NODE_ENV: 'development' }, encoding: 'utf8' });
  assert.equal(result.status, 0, result.stdout + result.stderr);
});
