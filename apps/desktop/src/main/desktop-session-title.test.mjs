import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { generatedSessionTitle, promptTitle, sessionSummaryTitle } from '../shared/session-title.mjs';
import { DesktopSessionMetadata } from './desktop-session-metadata.ts';
import { desktopSessionSummaries } from './desktop-state.ts';

test('desktop automatic titles preserve the date prefix and all 32 body characters', () => {
  const title = `[260102] ${'가'.repeat(32)}`;
  assert.equal(generatedSessionTitle(title), title);
  assert.equal(sessionSummaryTitle({ title }), title);
  const [summary] = desktopSessionSummaries([{ id: 'sess_title_dated', title }]);
  assert.equal(summary.title, title);
});

test('desktop title clipping budgets the date prefix separately from the body', () => {
  assert.equal(generatedSessionTitle(`[260102] ${'가'.repeat(64)}`), `[260102] ${'가'.repeat(31)}…`);
  assert.equal(generatedSessionTitle(`[260102] ${'가'.repeat(32)}`, '', 20), `[260102] ${'가'.repeat(19)}…`);
  assert.equal(generatedSessionTitle('[260102] [251231] Repeated title'), '[260102] Repeated title');
});

test('date-only and prefixed synthetic text do not become session titles', () => {
  assert.equal(generatedSessionTitle('[260102]', 'Fallback'), 'Fallback');
  assert.equal(generatedSessionTitle('[260102] [mixdog-runtime] internal row', ''), '');
});

test('legacy automatic titles and manual names are not assigned date prefixes', () => {
  assert.equal(generatedSessionTitle('Existing title'), 'Existing title');
  assert.equal(promptTitle('Initial prompt'), 'Initial prompt');
  const rows = desktopSessionSummaries(
    [
      { id: 'sess_title_legacy', title: 'Existing title' },
      { id: 'sess_title_manual', title: '[260102] Automatic title' },
    ],
    {},
    { sess_title_manual: 'Custom title' }
  );
  assert.deepEqual(
    rows.map((row) => row.title),
    ['Existing title', 'Custom title']
  );
});

test('desktop metadata reload preserves dated bodies without changing manual titles', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'mixdog-desktop-titles-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const metadata = new DesktopSessionMetadata(() => root);
  await metadata.load();
  const title = `[260102] ${'가'.repeat(32)}`;
  assert.equal(metadata.rememberGeneratedTitle('sess_title_dated', title), true);
  await metadata.setName('sess_title_manual', 'Custom title');
  assert.equal(metadata.rememberGeneratedTitle('sess_title_manual', '[260102] Automatic title'), false);
  await metadata.flush();
  const reloaded = new DesktopSessionMetadata(() => root);
  await reloaded.load();
  assert.equal(reloaded.titles.sess_title_dated, title);
  assert.equal(reloaded.names.sess_title_manual, 'Custom title');
});

test('desktop numbered titles preserve their prefix and all 32 body characters', () => {
  const title = `261012-000 | ${'가'.repeat(32)}`;
  assert.equal(generatedSessionTitle(title), title);
  assert.equal(sessionSummaryTitle({ title }), title);
  const [summary] = desktopSessionSummaries([{ id: 'sess_title_numbered', title }]);
  assert.equal(summary.title, title);
  assert.equal(summary.title.length, 45);
  assert.equal(generatedSessionTitle(`261012-000 | ${'가'.repeat(64)}`), `261012-000 | ${'가'.repeat(31)}…`);
  assert.equal(generatedSessionTitle('261012-1000 | [260101] Work'), '261012-1000 | Work');
  assert.equal(generatedSessionTitle('261012-000 |', 'Fallback'), 'Fallback');
  assert.equal(generatedSessionTitle('261012-000 | [mixdog-runtime] internal row', ''), '');
});

test('desktop metadata persists numbered titles while keeping manual names unchanged', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'mixdog-desktop-numbered-titles-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const metadata = new DesktopSessionMetadata(() => root);
  await metadata.load();
  const title = '261012-001 | Work';
  assert.equal(metadata.rememberGeneratedTitle('sess_numbered', title), true);
  await metadata.setName('sess_manual_numbered', 'Custom title');
  assert.equal(metadata.rememberGeneratedTitle('sess_manual_numbered', title), false);
  await metadata.flush();
  const reloaded = new DesktopSessionMetadata(() => root);
  await reloaded.load();
  assert.equal(reloaded.titles.sess_numbered, title);
  assert.equal(reloaded.names.sess_manual_numbered, 'Custom title');
});
