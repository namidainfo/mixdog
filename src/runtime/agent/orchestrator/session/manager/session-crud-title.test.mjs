import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { sessionTitleDatePrefix } from '../../../../shared/session-title-format.mjs';

const root = mkdtempSync(join(tmpdir(), 'mixdog-session-title-'));
const previousDataDir = process.env.MIXDOG_DATA_DIR;
process.env.MIXDOG_DATA_DIR = root;
mkdirSync(join(root, 'sessions'));
const { drainSessionStore, saveSessionAsync } = await import('../store.mjs');
const { getSession, updateSessionGeneratedTitle, updateSessionManualTitle } = await import('./session-crud.mjs');
const { settleSessionSummaryIndex } = await import('../store/listing.mjs');

test.after(async () => {
  drainSessionStore();
  await settleSessionSummaryIndex();
  if (previousDataDir === undefined) delete process.env.MIXDOG_DATA_DIR;
  else process.env.MIXDOG_DATA_DIR = previousDataDir;
  rmSync(root, { recursive: true, force: true });
});

async function plantSession(id, fields = {}) {
  const session = {
    id,
    provider: 'openai',
    model: 'gpt-test',
    cwd: root,
    messages: [],
    generation: 0,
    closed: false,
    createdAt: new Date(2026, 0, 2, 0, 30).getTime(),
    ...fields,
  };
  await saveSessionAsync(session, { expectedGeneration: session.generation });
  return session;
}

test('date prefixes use local calendar dates and zero-padded YYMMDD', () => {
  const previousTimeZone = process.env.TZ;
  try {
    for (const [timeZone, timestamp, expected] of [
      ['Etc/GMT-9', Date.UTC(2026, 0, 1, 18, 30), '[260102] '],
      ['Etc/GMT+7', Date.UTC(2026, 0, 2, 3, 30), '[260101] '],
      ['UTC', Date.UTC(2000, 0, 1), '[000101] '],
    ]) {
      process.env.TZ = timeZone;
      assert.equal(sessionTitleDatePrefix(timestamp), expected);
    }
  } finally {
    if (previousTimeZone === undefined) delete process.env.TZ;
    else process.env.TZ = previousTimeZone;
  }
});

test('first automatic titles persist the creation-date prefix and all 32 body characters', async () => {
  const id = 'sess_title_first';
  const body = '가'.repeat(32);
  await plantSession(id);
  assert.equal(await updateSessionGeneratedTitle(id, body, 'first'), true);
  const expected = `[260102] ${body}`;
  assert.equal(getSession(id).title, expected);
  assert.equal(getSession(id).title.length, 41);
  assert.equal(getSession(id).generatedTitleStage, 'first');
  const stored = JSON.parse(readFileSync(join(root, 'sessions', `${id}.json`), 'utf8'));
  assert.equal(stored.title, expected);
});

test('third-turn updates keep the creation date and replace existing date prefixes', async () => {
  const id = 'sess_title_third';
  await plantSession(id);
  assert.equal(await updateSessionGeneratedTitle(id, 'First title', 'first'), true);
  assert.equal(await updateSessionGeneratedTitle(id, '[991231] [000101] Updated title', 'third'), true);
  assert.equal(getSession(id).title, '[260102] Updated title');
  assert.equal(getSession(id).generatedTitleStage, 'third');
  assert.equal(await updateSessionGeneratedTitle(id, 'Another title', 'third'), false);
  assert.equal(getSession(id).title, '[260102] Updated title');
});

test('automatic title bodies retain the existing 32-character limit independently of the prefix', async () => {
  const id = 'sess_title_long';
  await plantSession(id);
  assert.equal(await updateSessionGeneratedTitle(id, '가'.repeat(64), 'first'), true);
  assert.equal(getSession(id).title, `[260102] ${'가'.repeat(31)}…`);
});

test('manual titles remain undated and block subsequent automatic updates', async () => {
  const id = 'sess_title_manual';
  await plantSession(id);
  assert.equal(await updateSessionGeneratedTitle(id, 'Automatic title', 'first'), true);
  assert.equal(await updateSessionManualTitle(id, '  Custom   title  '), true);
  assert.equal(getSession(id).title, 'Custom title');
  assert.equal(getSession(id).titleLocked, true);
  assert.equal(await updateSessionGeneratedTitle(id, 'Updated title', 'third'), false);
  assert.equal(getSession(id).title, 'Custom title');
});

test('existing titles stay unchanged until a future automatic update', async () => {
  const id = 'sess_title_existing';
  await plantSession(id, { title: 'Existing title', generatedTitleStage: 'first' });
  assert.equal(getSession(id).title, 'Existing title');
  assert.equal(await updateSessionGeneratedTitle(id, 'Replacement title', 'first'), false);
  assert.equal(getSession(id).title, 'Existing title');
  assert.equal(await updateSessionGeneratedTitle(id, 'Updated title', 'third'), true);
  assert.equal(getSession(id).title, '[260102] Updated title');
});

test('empty titles, invalid stages, closed sessions and missing sessions are not changed', async () => {
  const id = 'sess_title_invalid';
  await plantSession(id, { title: 'Original title' });
  assert.equal(await updateSessionGeneratedTitle(id, '[260102]', 'first'), false);
  assert.equal(await updateSessionGeneratedTitle(id, 'New title', 'invalid'), false);
  assert.equal(getSession(id).title, 'Original title');
  await plantSession('sess_title_closed', { title: 'Closed title', closed: true });
  assert.equal(await updateSessionGeneratedTitle('sess_title_closed', 'New title', 'first'), false);
  assert.equal(getSession('sess_title_closed').title, 'Closed title');
  assert.equal(await updateSessionGeneratedTitle('sess_title_missing', 'New title', 'first'), false);
});

test('numbered titles keep their reserved prefix and the independent body budget', async () => {
  const id = 'sess_title_numbered';
  await plantSession(id, { generatedTitlePrefix: '260102-007 | ' });
  assert.equal(await updateSessionGeneratedTitle(id, '991231-999 | [000101] ' + '가'.repeat(64), 'first'), true);
  assert.equal(getSession(id).title, `260102-007 | ${'가'.repeat(31)}…`);
  assert.equal(await updateSessionGeneratedTitle(id, '260101-000 | Updated title', 'third'), true);
  assert.equal(getSession(id).title, '260102-007 | Updated title');
  const stored = JSON.parse(readFileSync(join(root, 'sessions', `${id}.json`), 'utf8'));
  assert.equal(stored.generatedTitlePrefix, '260102-007 | ');
  assert.equal(stored.title, '260102-007 | Updated title');
});

test('number-only titles are rejected and a numbered session still protects manual titles', async () => {
  const id = 'sess_title_numbered_manual';
  await plantSession(id, { generatedTitlePrefix: '260102-008 | ' });
  assert.equal(await updateSessionGeneratedTitle(id, '260102-008 |', 'first'), false);
  assert.equal(await updateSessionManualTitle(id, 'Custom numbered task'), true);
  assert.equal(await updateSessionGeneratedTitle(id, 'Automatic replacement', 'first'), false);
  assert.equal(getSession(id).title, 'Custom numbered task');
});
