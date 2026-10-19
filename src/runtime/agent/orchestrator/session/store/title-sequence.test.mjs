import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { assignSessionTitlePrefix, reserveSessionTitle } from './title-sequence.mjs';
import { sessionTitleDateKey, sessionTitleDatePrefix, splitSessionTitleDatePrefix } from '../../../../shared/session-title-format.mjs';

function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), 'mixdog-title-sequence-'));
  const previous = process.env.MIXDOG_DATA_DIR;
  process.env.MIXDOG_DATA_DIR = root;
  t.after(() => {
    if (previous === undefined) delete process.env.MIXDOG_DATA_DIR;
    else process.env.MIXDOG_DATA_DIR = previous;
    rmSync(root, { recursive: true, force: true });
  });
  return { root, path: join(root, 'session-title-sequences.json') };
}

test('numbered prefixes use local YYMMDD and retain at least three sequence digits', () => {
  const previous = process.env.TZ;
  try {
    for (const [timeZone, timestamp, day, prefix] of [
      ['Etc/GMT-9', Date.UTC(2026, 0, 1, 18, 30), '20260102', '260102-000 | '],
      ['Etc/GMT+7', Date.UTC(2026, 0, 2, 3, 30), '20260101', '260101-000 | '],
      ['UTC', Date.UTC(2000, 0, 1), '20000101', '000101-000 | '],
    ]) {
      process.env.TZ = timeZone;
      assert.equal(sessionTitleDateKey(timestamp), day);
      assert.equal(sessionTitleDatePrefix(timestamp, 0), prefix);
    }
  } finally {
    if (previous === undefined) delete process.env.TZ;
    else process.env.TZ = previous;
  }
  assert.equal(sessionTitleDatePrefix(new Date(2026, 9, 12).getTime(), 1000), '261012-1000 | ');
});

test('legacy and numbered prefixes are separated without duplicating either form', () => {
  for (const value of [
    '261012-000 | Work',
    '261012-000 | [260101] Work',
    '261012-000 | 251231-999 | Work',
  ]) {
    assert.deepEqual(splitSessionTitleDatePrefix(value), { prefix: '261012-000 | ', title: 'Work' });
  }
  assert.deepEqual(splitSessionTitleDatePrefix('261012-1000 | Work'), {
    prefix: '261012-1000 | ', title: 'Work',
  });
  assert.deepEqual(splitSessionTitleDatePrefix('261012-000 |'), { prefix: '261012-000 | ', title: '' });
  assert.deepEqual(splitSessionTitleDatePrefix('[260101] 261012-000 | Work'), {
    prefix: '[260101] ', title: 'Work',
  });
});

test('projects share one durable sequence and each local day starts at zero', (t) => {
  const { root, path } = fixture(t);
  const createdAt = new Date(2026, 9, 12, 12).getTime();
  assert.deepEqual(reserveSessionTitle({ createdAt, cwd: join(root, 'project-a') }), {
    createdAt, prefix: '261012-000 | ',
  });
  assert.equal(reserveSessionTitle({ createdAt, cwd: join(root, 'project-b') }).prefix, '261012-001 | ');
  assert.equal(reserveSessionTitle({ createdAt: new Date(2026, 9, 13).getTime() }).prefix, '261013-000 | ');
  assert.equal(reserveSessionTitle({ createdAt }).prefix, '261012-002 | ');
  assert.deepEqual(JSON.parse(readFileSync(path, 'utf8')), { 20261012: 3, 20261013: 1 });
});

test('internal agents do not consume numbers but root Lead sessions do', (t) => {
  const { path } = fixture(t);
  const createdAt = new Date(2026, 9, 12).getTime();
  for (const fields of [
    { id: 'sess_child', owner: 'agent', parentSessionId: 'sess_parent', agent: 'worker' },
    { id: 'sess_hidden', visibility: 'agent-only' },
    { id: 'sess_cycle', owner: 'agent', agent: 'cycle1-agent' },
  ]) {
    assert.equal(reserveSessionTitle({ createdAt, ...fields }), null);
  }
  assert.equal(reserveSessionTitle({
    id: 'sess_lead', agent: 'lead', ownerSessionId: 'sess_lead', visibility: 'agent-only', createdAt,
  }).prefix, '261012-000 | ');
  assert.deepEqual(JSON.parse(readFileSync(path, 'utf8')), { 20261012: 1 });
});

test('first real input numbers the current local day once and preserves the reservation timestamp', (t) => {
  const { path } = fixture(t);
  const createdAt = new Date(2026, 9, 11, 23, 59).getTime();
  const session = { createdAt, title: '[261011] [Bloom] 새 대화' };
  assert.equal(existsSync(path), false);
  assert.equal(assignSessionTitlePrefix(session, new Date(2026, 9, 12, 0, 1).getTime()), true);
  assert.equal(session.createdAt, createdAt);
  assert.equal(session.generatedTitlePrefix, '261012-000 | ');
  assert.equal(session.title, '261012-000 | [Bloom] 새 대화');
  assert.equal(assignSessionTitlePrefix(session, new Date(2026, 9, 13).getTime()), false);
  assert.deepEqual(JSON.parse(readFileSync(path, 'utf8')), { 20261012: 1 });
});

test('existing numbers, closed sessions and internal agents do not allocate another number', (t) => {
  const { path } = fixture(t);
  for (const session of [
    { generatedTitlePrefix: '261011-007 | ', title: 'Existing title' },
    { closed: true },
    { id: 'sess_child', owner: 'agent', parentSessionId: 'sess_parent', agent: 'worker' },
    { id: 'sess_cycle', owner: 'agent', agent: 'cycle1-agent' },
  ]) {
    const before = structuredClone(session);
    assert.equal(assignSessionTitlePrefix(session, new Date(2026, 9, 12).getTime()), false);
    assert.deepEqual(session, before);
  }
  assert.equal(existsSync(path), false);
});

test('manual titles only gain a number when prefix preservation was explicitly requested', (t) => {
  const { path } = fixture(t);
  const numberedAt = new Date(2026, 9, 12).getTime();
  const manual = { title: 'Custom title', titleLocked: true };
  assert.equal(assignSessionTitlePrefix(manual, numberedAt), true);
  assert.equal(manual.title, 'Custom title');
  const pending = { title: 'softon_user | Work', titleLocked: true, titlePrefixPending: true };
  assert.equal(assignSessionTitlePrefix(pending, numberedAt), true);
  assert.equal(pending.title, '261012-001 | softon_user | Work');
  assert.equal(pending.titlePrefixPending, undefined);
  assert.deepEqual(JSON.parse(readFileSync(path, 'utf8')), { 20261012: 2 });
});

test('the thousandth boundary expands the number instead of wrapping it', (t) => {
  const { path } = fixture(t);
  writeFileSync(path, '{"20261012":999}\n');
  const createdAt = new Date(2026, 9, 12).getTime();
  assert.equal(reserveSessionTitle({ createdAt }).prefix, '261012-999 | ');
  assert.equal(reserveSessionTitle({ createdAt }).prefix, '261012-1000 | ');
});

test('corrupt or invalid counters fail without resetting or overwriting the store', (t) => {
  const { path } = fixture(t);
  for (const value of ['{broken', 'null', '[]', '{"20261012":-1}', '{"20261012":"1"}', '{"20261012":null}']) {
    writeFileSync(path, value);
    assert.throws(() => reserveSessionTitle({ createdAt: new Date(2026, 9, 12).getTime() }));
    assert.equal(readFileSync(path, 'utf8'), value);
  }
});

function childReservations(root, createdAt) {
  const moduleUrl = new URL('./title-sequence.mjs', import.meta.url).href;
  const script = `import { reserveSessionTitle } from ${JSON.stringify(moduleUrl)};
    console.log(JSON.stringify(Array.from({ length: 2 }, () => reserveSessionTitle({ createdAt: ${createdAt} }).prefix)));`;
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['--input-type=module', '-e', script], {
      env: { ...process.env, MIXDOG_DATA_DIR: root },
      windowsHide: true,
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (data) => { stdout += data; });
    child.stderr.on('data', (data) => { stderr += data; });
    child.once('error', reject);
    child.once('close', (code) => {
      if (code !== 0) reject(new Error(`Reservation child exited ${code}: ${stderr}`));
      else {
        try { resolve(JSON.parse(stdout)); } catch (error) { reject(error); }
      }
    });
  });
}

test('concurrent processes allocate unique numbers and a fresh process continues the sequence', async (t) => {
  const { root, path } = fixture(t);
  const createdAt = new Date(2026, 9, 12).getTime();
  const prefixes = (await Promise.all(Array.from({ length: 4 }, () => childReservations(root, createdAt)))).flat();
  assert.deepEqual(prefixes.sort(), Array.from({ length: 8 }, (_, n) => `261012-${String(n).padStart(3, '0')} | `));
  assert.deepEqual(await childReservations(root, createdAt), ['261012-008 | ', '261012-009 | ']);
  assert.deepEqual(JSON.parse(readFileSync(path, 'utf8')), { 20261012: 10 });
});
