import { test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import {
  addVisitor,
  estimateVisitors,
  mergeVisitors,
  HLL_SIZE,
  visitorCookie,
} from '../src/hosted/hll.js';
import {
  nextRunAt,
  parseTiming,
  validateJobInput,
} from '../src/jobs/definitions.js';
import { utcHour, isKnownBot } from '../src/hosted/usage.js';
import { csv, usageRange } from '../src/hosted/admin-routes.js';
import { actionRequest } from '../src/hosted/operations.js';

test('bounded HLL deduplicates, merges and estimates large populations', () => {
  const a = new Uint8Array(HLL_SIZE),
    b = new Uint8Array(HLL_SIZE);
  for (let i = 0; i < 10000; i++) {
    if (i < 7000) addVisitor(a, `visitor-${i}`);
    if (i >= 3000) addVisitor(b, `visitor-${i}`);
  }
  const merged = mergeVisitors(a, b);
  assert.equal(merged.length, 1024);
  assert.ok(Math.abs(estimateVisitors(merged) - 10000) < 1000);
  assert.deepEqual(mergeVisitors(merged, merged), merged);
  const one = new Uint8Array(HLL_SIZE);
  for (let i = 0; i < 10000; i++) addVisitor(one, 'one');
  assert.equal(estimateVisitors(one), 1);
  assert.equal(estimateVisitors(new Uint8Array(HLL_SIZE)), 0);
});
test('visitor cookies are signed, host-bound, expire, and require a returned cookie', () => {
  const key = crypto.randomBytes(32).toString('base64'),
    now = Date.now();
  const initial = visitorCookie(
    key,
    'preview-app.example.test',
    undefined,
    now,
  );
  assert.equal(initial.visitor, null);
  assert.ok(initial.fresh);
  const returned = visitorCookie(
    key,
    'preview-app.example.test',
    initial.token,
    now + 1000,
  );
  assert.ok(returned.visitor);
  assert.equal(returned.fresh, false);
  assert.equal(
    visitorCookie(key, 'published-app.example.test', initial.token, now + 1000)
      .visitor,
    null,
  );
  assert.equal(
    visitorCookie(
      key,
      'preview-app.example.test',
      initial.token + 'x',
      now + 1000,
    ).visitor,
    null,
  );
  assert.equal(
    visitorCookie(
      key,
      'preview-app.example.test',
      initial.token,
      now + 91 * 86400000,
    ).visitor,
    null,
  );
});
test('UTC schedule boundaries are stable across days, years and DST transitions', () => {
  assert.equal(
    nextRunAt(
      { frequency: 'EVERY_MINUTE', hourOfDay: 0, minuteOfHour: 0 },
      new Date('2026-12-31T23:59:59Z'),
    ).toISOString(),
    '2027-01-01T00:00:00.000Z',
  );
  assert.equal(
    nextRunAt(
      { frequency: 'HOURLY', hourOfDay: 0, minuteOfHour: 15 },
      new Date('2026-03-08T09:15:00Z'),
    ).toISOString(),
    '2026-03-08T10:15:00.000Z',
  );
  assert.equal(
    nextRunAt(
      { frequency: 'DAILY', hourOfDay: 3, minuteOfHour: 5 },
      new Date('2026-10-15T03:05:00Z'),
    ).toISOString(),
    '2026-10-16T03:05:00.000Z',
  );
  assert.throws(() => parseTiming({ frequency: 'DAILY', hourOfDay: 24 }));
  assert.throws(() => parseTiming({ frequency: 'WEEKLY' }));
});
test('destructive maintenance requires explicit valid inputs and defaults to dry run', () => {
  assert.equal(validateJobInput('HOSTED_STALE_APPLICATIONS', {}).dryRun, true);
  assert.throws(() => validateJobInput('HOSTED_HISTORY_PURGE', {}));
  assert.throws(() =>
    validateJobInput('HOSTED_HISTORY_PURGE', {
      before: '2020-01-01T00:00:00Z',
      datasets: ['users'],
    }),
  );
  assert.throws(() =>
    validateJobInput('HOSTED_STALE_APPLICATIONS', { inactiveDays: 0 }),
  );
  assert.throws(() =>
    validateJobInput('HOSTED_STORAGE_CLEANUP', { dryRun: 'false' }),
  );
  assert.throws(() =>
    actionRequest({ ids: [crypto.randomUUID()], action: 'purge', reason: '' }),
  );
});
test('traffic ranges and CSV exports are bounded and spreadsheet safe', () => {
  assert.equal(
    utcHour(new Date('2026-10-15T23:59:59.999Z')).toISOString(),
    '2026-10-15T23:00:00.000Z',
  );
  assert.ok(isKnownBot('Googlebot'));
  assert.ok(!isKnownBot('Mozilla/5.0 Firefox/144'));
  assert.throws(() => usageRange({ from: 'not a date' }));
  assert.throws(() => usageRange({ from: '2020-01-01', to: '2026-01-01' }));
  assert.match(
    csv([{ name: '=HYPERLINK("bad")', bytes: '123' }]),
    /'=HYPERLINK/,
  );
});
