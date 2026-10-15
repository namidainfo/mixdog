import assert from 'node:assert/strict';
import test from 'node:test';
import { installTestDom } from './test-support/test-dom.mjs';
import { transcriptPerformanceContext } from './transcript-performance-context.ts';
import { installGlobalRendererDiagnostics } from './RendererRecovery.tsx';
import { normalizeRendererInputDelayDiagnostic, normalizeRendererLongTaskDiagnostic } from '../main/renderer-recovery.ts';

test('performance context reports visible session identities and disclosure counts, never transcript text', t => {
  const { document } = installTestDom(t, { html: `<div class="transcript" data-session-key="local:sess-a">
    <div class="tool-activity" data-open="false">PRIVATE OUTPUT</div><div class="tool-activity" data-open="true"></div>
    </div><div class="transcript" data-session-key="hidden:sess-b"><div class="tool-activity" data-open="true"></div></div>` });
  document.querySelector('.transcript').getClientRects = () => [{ width: 100, height: 100 }];
  assert.deepEqual(transcriptPerformanceContext(document), {
    sessionKeys: ['local:sess-a'], visibleTranscripts: 1, toolGroups: 2, expandedToolGroups: 1,
  });
});

test('slow-operation records bound counts and identities and discard private text and invalid event names', () => {
  const context = { sessionKeys: ['sess-a', 'sess-a', 'invalid secret value', 'sess-b'], toolGroups: 99_999, expandedToolGroups: -2, text: 'PRIVATE', key: 'PRIVATE' };
  assert.deepEqual(normalizeRendererLongTaskDiagnostic({ kind: 'long-task', durationMs: 736, ...context }), {
    durationMs: 736, sessionKeys: ['sess-a', 'sess-b'], toolGroups: 10_000, expandedToolGroups: 0,
  });
  assert.deepEqual(normalizeRendererLongTaskDiagnostic({ kind: 'long-task', durationMs: 500 }), { durationMs: 500 });
  assert.deepEqual(normalizeRendererInputDelayDiagnostic({ kind: 'input-delay', inputDelayMs: 501.4, eventType: 'keydown', ...context }), {
    inputDelayMs: 501, eventType: 'keydown', sessionKeys: ['sess-a', 'sess-b'], toolGroups: 10_000, expandedToolGroups: 0,
  });
  assert.equal(normalizeRendererInputDelayDiagnostic({ kind: 'input-delay', inputDelayMs: 49, eventType: 'click' }), null);
  assert.equal(normalizeRendererInputDelayDiagnostic({ kind: 'input-delay', inputDelayMs: 500, eventType: 'private typed text' }), null);
});

test('Personal input timing reports queue delay with session context and disconnects observers', t => {
  const observers = [];
  class Observer {
    constructor(callback) { this.callback = callback; observers.push(this); }
    observe(options) { this.options = options; }
    disconnect() { this.disconnected = true; }
  }
  const { window, document } = installTestDom(t, { globals: { PerformanceObserver: Observer }, html: '<div class="transcript" data-session-key="sess-a"><div class="tool-activity" data-open="false"></div></div>' });
  document.querySelector('.transcript').getClientRects = () => [{ width: 100, height: 100 }];
  const reports = [];
  window.mixdogDesktop = { personalWorktrail: true, rendererDiagnostic: report => reports.push(report) };
  const cleanup = installGlobalRendererDiagnostics();
  const input = observers.find(observer => observer.options.type === 'event');
  input.callback({ getEntries: () => [{ name: 'keydown', startTime: 100, processingStart: 600 }] });
  assert.deepEqual(reports[0], {
    kind: 'input-delay', inputDelayMs: 500, eventType: 'keydown', sessionKeys: ['sess-a'],
    visibleTranscripts: 1, toolGroups: 1, expandedToolGroups: 0,
  });
  input.callback({ getEntries: () => [{ name: 'click', startTime: 100, processingStart: 900 }] });
  assert.equal(reports.length, 1);
  cleanup();
  assert.ok(observers.every(observer => observer.disconnected));
});
