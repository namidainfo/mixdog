import assert from 'node:assert/strict';
import test from 'node:test';
import { setImmediate as tick } from 'node:timers/promises';
import { bloomSessionPurpose, normalizeDesktopSessionMetadata, retainBloomProjectMetadata } from './desktop-session-metadata.mjs';
import { bloomSessionTitle, initializeBloomSessionTitle } from './bloom-session-title.mjs';
import { backfillFallbackSessionTitle } from '../agent/orchestrator/session/manager/session-fallback-title.mjs';
import { createSessionTitleController } from '../agent/orchestrator/runtime-core/session-title.mjs';
import { _sessionSummary } from '../agent/orchestrator/session/store-summary-index.mjs';
import { desktopSession } from '../agent/orchestrator/session/store-summary-fields.mjs';
import { previewBloomSessionChanges } from '../../standalone/bloom-session-preview.mjs';

const metadata = { classification: 'project', projectPath: 'C:/Bloom', source: 'bloom', purpose: 'chat' };
const session = (fields = {}) => ({
  id: 'bloom-test', cwd: 'C:/actual-work', createdAt: new Date(2026, 0, 2).getTime(),
  generatedTitlePrefix: '260102-007 | ', desktopSession: { ...metadata }, messages: [], ...fields,
});

test('Bloom provenance survives every metadata projection without changing cwd', () => {
  const value = session();
  for (const projected of [
    normalizeDesktopSessionMetadata(value.desktopSession, value.cwd),
    desktopSession(value.desktopSession, value.cwd),
    _sessionSummary(value).desktopSession,
  ]) assert.deepEqual(projected, metadata);
  assert.equal(value.cwd, 'C:/actual-work');
  assert.deepEqual(retainBloomProjectMetadata(metadata, { classification: 'project', projectPath: 'C:/new-work' }), metadata);
  assert.deepEqual(retainBloomProjectMetadata(metadata, { classification: 'task', projectPath: null }), metadata);
  const ordinary = { classification: 'project', projectPath: 'C:/other' };
  assert.deepEqual(retainBloomProjectMetadata(ordinary, { classification: 'task', projectPath: null }), {
    classification: 'task', projectPath: null,
  });
});

test('unknown provenance cannot change normal project semantics', () => {
  assert.equal(bloomSessionPurpose({ source: 'bloom', purpose: 'unknown' }), null);
  assert.deepEqual(normalizeDesktopSessionMetadata({ ...metadata, purpose: 'unknown' }), {
    classification: 'project', projectPath: 'C:/Bloom',
  });
  assert.equal(normalizeDesktopSessionMetadata({ classification: 'project', projectPath: '\0' }), null);
  assert.deepEqual(normalizeDesktopSessionMetadata({ classification: 'task', projectPath: 'ignored' }), {
    classification: 'task', projectPath: null,
  });
});

test('a provisional Bloom name is replaced by the first real request without locking the title', () => {
  const value = session();
  assert.equal(initializeBloomSessionTitle(value), true);
  assert.equal(value.title, '260102-007 | [Bloom] 새 대화');
  assert.equal(value.bloomTitlePending, true);
  assert.notEqual(value.titleLocked, true);
  assert.equal(backfillFallbackSessionTitle(value, [{ role: 'user', content: '릴레이 메모리 진단' }]), true);
  assert.equal(value.title, '260102-007 | [Bloom] 릴레이 메모리 진단');
  assert.equal(Object.hasOwn(value, 'bloomTitlePending'), false);
  assert.equal(backfillFallbackSessionTitle(value, [{ role: 'user', content: 'A later request' }]), false);
  assert.equal(value.id, 'bloom-test');
  assert.equal(value.cwd, 'C:/actual-work');
});

test('manual and non-Bloom titles remain untouched', () => {
  const manual = session({ title: 'My manual title', titleLocked: true, bloomTitlePending: true });
  assert.equal(initializeBloomSessionTitle(manual), false);
  assert.equal(backfillFallbackSessionTitle(manual, [{ role: 'user', content: 'Do not rename' }]), false);
  assert.equal(manual.title, 'My manual title');
  const ordinary = session({ desktopSession: null });
  assert.equal(initializeBloomSessionTitle(ordinary), false);
  assert.equal(backfillFallbackSessionTitle(ordinary, [{ role: 'user', content: 'Normal title' }]), true);
  assert.equal(ordinary.title, 'Normal title');
  assert.equal(bloomSessionTitle(ordinary, 'Unchanged'), 'Unchanged');
});

test('structured tasks use the actual input and gateway discovery never becomes a named conversation', async () => {
  const value = session({ desktopSession: { ...metadata, purpose: 'structured-text', titleHint: '실제 요청 요약' } });
  assert.equal(initializeBloomSessionTitle(value), true);
  assert.equal(value.title, '260102-007 | [Bloom·자동] 실제 요청 요약');
  assert.equal(value.bloomTitlePending, undefined);
  const sources = [];
  const titles = createSessionTitleController({
    log: () => {},
    generateSessionTitle: async (source) => { sources.push(source); return '요약한 요청'; },
    promoteGeneratedTitle: async () => true,
  });
  try {
    assert.equal(titles.scheduleFirst(value, 'Return JSON matching this internal schema'), true);
    await tick();
    assert.deepEqual(sources, ['실제 요청 요약']);
    assert.equal(titles.observeThird(value), false);
  } finally { titles.disposeAll(); }
  const gateway = session({ desktopSession: { classification: 'task', projectPath: null, source: 'bloom', purpose: 'gateway' } });
  assert.equal(initializeBloomSessionTitle(gateway), false);
  assert.equal(gateway.title, undefined);
});

test('read-only previews preserve desktop manual names and never infer Bloom from an untitled row', () => {
  const rows = [
    { id: 'manual', title: '', cwd: 'C:/actual-work' },
    { id: 'unknown', title: 'Untitled session', cwd: 'C:/actual-work' },
  ];
  const before = structuredClone(rows);
  const result = previewBloomSessionChanges(rows, {
    projectPath: 'C:/Bloom', links: [{ sessionId: 'manual', firstUserText: 'New suggestion' }],
    manualTitles: { manual: 'My desktop name' },
  });
  assert.equal(result.changes.length, 1);
  assert.equal(result.changes[0].proposedTitle, 'My desktop name');
  assert.equal(result.changes[0].needsTitleChange, false);
  assert.equal(result.unverifiedUntitledCount, 1);
  assert.deepEqual(rows, before);
});
