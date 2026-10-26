import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { after, before, test } from 'node:test';
import axios from 'axios';
import { getPrisma, disconnectPrisma } from '../src/db/prisma.js';
import { HapiPartitionClient } from '../src/hapi/partition_client.js';

const databaseUrl = process.env.FHIR_STUDIO_SECURITY_TEST_DATABASE_URL;
assert.ok(databaseUrl && /test|integration/.test(new URL(databaseUrl).pathname), 'Set a disposable security test database URL.');
const db = getPrisma(databaseUrl);
const userId = crypto.randomUUID();
const slug = `partition-security-${crypto.randomUUID()}`;

before(async () => {
  await db.user.create({ data: { id: userId, ssoIssuer: 'partition-security-test', ssoSubject: userId } });
});

after(async () => {
  await db.sandbox.deleteMany({ where: { createdByUserId: userId } });
  await db.user.deleteMany({ where: { id: userId } });
  await disconnectPrisma();
});

test('concurrent tenant reservations are unique and survive deleting the highest sandbox', async () => {
  const reservations = await Promise.all(Array.from({ length: 12 }, () => HapiPartitionClient.allocateNextPartitionId(db)));
  assert.equal(new Set(reservations).size, reservations.length);
  const highest = Math.max(...reservations);
  const sandbox = await db.sandbox.create({ data: { sandboxId: slug, name: 'Partition isolation', partitionId: highest, createdByUserId: userId } });
  await db.sandbox.delete({ where: { id: sandbox.id } });
  assert.ok(await HapiPartitionClient.allocateNextPartitionId(db) > highest);
});

test('legacy tenant deletion preserves its ID even before any later allocation', async () => {
  const legacyId = await HapiPartitionClient.allocateNextPartitionId(db) + 100;
  const sandbox = await db.sandbox.create({ data: { sandboxId: `${slug}-legacy`, name: 'Legacy partition', partitionId: legacyId, createdByUserId: userId } });
  await HapiPartitionClient.preservePartitionId(db, legacyId);
  await db.sandbox.delete({ where: { id: sandbox.id } });
  assert.ok(await HapiPartitionClient.allocateNextPartitionId(db) > legacyId);
  await HapiPartitionClient.preservePartitionId(db, 1);
  assert.ok(await HapiPartitionClient.allocateNextPartitionId(db) > legacyId);
});

test('failed HAPI provisioning rejects instead of reporting a usable tenant', async () => {
  Object.assign(process.env, {
    FHIR_STUDIO_HAPI_R4_ENABLED: 'true', FHIR_STUDIO_HAPI_R4_BASE_URL: 'https://hapi.example.test/fhir',
    FHIR_STUDIO_HAPI_R4B_ENABLED: 'false', FHIR_STUDIO_HAPI_R5_ENABLED: 'false',
  });
  const adapter = axios.defaults.adapter;
  axios.defaults.adapter = async () => { throw new Error('upstream unavailable'); };
  try {
    await assert.rejects(new HapiPartitionClient().createPartition('R4', 123, 'failed-tenant'), /Failed to create HAPI partition/);
  } finally {
    axios.defaults.adapter = adapter;
  }
});
