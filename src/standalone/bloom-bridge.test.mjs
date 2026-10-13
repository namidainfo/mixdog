import assert from 'node:assert/strict';
import test from 'node:test';
import { setImmediate as tick } from 'node:timers/promises';
import { createBloomBridge, sanitizeBloomUsage, requireBloomRuntime, serveBloomBridge } from './bloom-bridge.mjs';
import { PassThrough } from 'node:stream';
import { createRecallResourceApi } from '../session-runtime/resource-recall-api.mjs';
import { normalizeToolMode, toolSpecForMode, deferredSurfaceModeForLead } from '../runtime/agent/orchestrator/runtime-core/effort.mjs';
import { applyDeferredToolSurface, refreshInitialDeferredMcpSurface, reconcileDeferredMcpToolCatalog, selectDeferredTools } from '../runtime/agent/orchestrator/runtime-core/tool-catalog.mjs';
import { snapshotProviderRequestTools } from '../runtime/agent/orchestrator/runtime-core/provider-request-snapshot.mjs';
import { prepareDeferredToolCallThrough, isOffReadonlySurface } from '../runtime/agent/orchestrator/session/loop/deferred-call-through.mjs';
import { createSessionProxyFactory } from './session-proxy.mjs';
import { createSessionOps } from '../session-runtime/turn/session-ops.mjs';
import { SESSION_PROTOCOL, SESSION_REVISION } from './session-wire.mjs';
import { createSessionService } from './session-service.mjs';

function harness({ submit, makePrompt, initialQuestion } = {}) {
  const calls = [], created = [], events = [];
  const catalog = [
    { provider: 'openai-oauth', id: 'gpt-test', display: 'Test model', effortOptions: [{ value: 'low' }, { value: 'high' }], config: { apiKey: 'private' } },
    { provider: 'anthropic-oauth', id: 'claude-unavailable', effortOptions: [] },
    { provider: 'off-provider', id: 'disabled', effortOptions: [] },
  ];
  function api(options) {
    let state = {
      sessionId: options.sessionId || `session-${created.length + 1}`,
      provider: options.provider || 'openai-oauth', model: options.model || 'gpt-test',
      cwd: options.cwd, toolMode: options.toolMode, busy: false, items: [], config: { accessToken: 'private' },
      ...(options.sessionId && initialQuestion ? { busy: true, userQuestion: initialQuestion } : {}),
    };
    const listeners = new Set();
    const update = (patch) => { state = { ...state, ...patch }; for (const listener of listeners) listener(); };
    const instance = {
      options, update, getState: () => state,
      subscribe: (listener) => { listeners.add(listener); return () => listeners.delete(listener); },
      async setToolMode(mode) { calls.push(['mode', mode]); update({ toolMode: mode }); return mode; },
      async listProviderModels() { calls.push(['models']); return catalog; },
      async getProviderSetup() {
        calls.push(['setup']);
        return { oauth: [
          { id: 'openai-oauth', authenticated: true, enabled: true },
          { id: 'anthropic-oauth', authenticated: false },
          { id: 'off-provider', authenticated: true, enabled: false },
        ] };
      },
      async getUsageDashboard(options) {
        calls.push(['usage', options]);
        return { checkedAt: 4, rows: [{ id: 'openai-oauth', accounts: [{
          accountId: 'account-a', alias: 'Personal', identity: 'person@example.test', selected: true,
          status: 'partial', stale: false, updatedAt: 3,
          windows: [{ label: '5H', usedPct: 42, resetAt: 100, windowSeconds: 18000, cookie: 'private' }],
          config: { accessToken: 'private' }, password: 'private',
        }], config: { apiKey: 'private' } }], config: { refreshToken: 'private' } };
      },
      async listProjects() { calls.push(['projects']); return [{ path: 'C:/project-a', name: 'A' }, { path: 'C:/project-b', name: 'B' }]; },
      async searchConversations(query, options) { calls.push(['search', query, options]); return 'Project A match\nProject B match'; },
      async listSessions() { calls.push(['sessions']); return [{ id: 'existing-a', title: 'A', cwd: 'C:/project-a', provider: 'openai-oauth', model: 'gpt-test' }]; },
      async readSessionSnapshot(id) { calls.push(['read', id]); return { ...state, sessionId: id }; },
      async submitAsync(prompt, options) {
        calls.push(['submit', options.id, prompt, state.sessionId]);
        update({ busy: true, items: [...state.items, { id: options.id, kind: 'user', text: prompt }] });
        if (submit) return submit(instance, prompt, options);
        return true;
      },
      async abortAsync() {
        calls.push(['abort', state.sessionId]);
        update({ busy: false, items: [...state.items, { id: 'cancelled', kind: 'turndone', status: 'cancelled' }] });
        return { aborted: true };
      },
      async resolveUserQuestion(id, response) { calls.push(['answer', id, response]); return true; },
      async approveAsync(id, decision) { calls.push(['approve', id, decision]); return true; },
      async handoff() { calls.push(['handoff', state.sessionId]); return { sessionId: state.sessionId, cwd: state.cwd }; },
      async dispose() { calls.push(['dispose', state.sessionId]); },
    };
    created.push(instance);
    return instance;
  }
  const bridge = createBloomBridge({
    cwd: 'C:/bloom', createSession: async (options) => api(options), emit: (event) => events.push(event),
    ...(makePrompt ? { makePrompt } : {}),
  });
  const open = (mode = 'chat', sessionId = null) => bridge.call('open', {
    viewId: 'bloom-view', modelKey: 'mixdog:openai-oauth/gpt-test', effort: 'low', mode, sessionId,
  });
  return { bridge, open, calls, created, events, catalog };
}

async function jsonlHarness(t, mode = 'chat', outputFailure = false) {
  const h = harness();
  const input = new PassThrough();
  const output = new PassThrough();
  const queued = [], waiters = [];
  // Observe real serialized writes while deliberately withholding reads from
  // Bloom. The server cannot interpret stdout enqueue as client acceptance.
  const transform = output._transform.bind(output);
  output._transform = (bytes, encoding, done) => {
    const message = JSON.parse(bytes.toString());
    queued.push(message);
    for (const waiter of [...waiters]) if (waiter.predicate(message)) {
      waiters.splice(waiters.indexOf(waiter), 1);
      waiter.resolve(message);
    }
    transform(bytes, encoding, done);
  };
  output.pause();
  const server = serveBloomBridge({ bridge: h.bridge, input, output });
  t.after(async () => {
    if (outputFailure) await assert.rejects(server.close(), /Bloom output disconnected/);
    else await server.close();
  });
  const send = (value) => input.write(`${JSON.stringify(value)}\n`);
  const next = (predicate) => {
    const existing = queued.find(predicate);
    return existing ? Promise.resolve(existing) : new Promise((resolve) => waiters.push({ predicate, resolve }));
  };
  send({ id: 'open', method: 'open', args: {
    viewId: 'view', sessionId: 'existing-a', modelKey: 'mixdog:openai-oauth/gpt-test', mode,
  } });
  await next((message) => message.id === 'open');
  const handoff = (id = 'handoff') => send({ id, method: 'handoff', args: { viewId: 'view', sessionId: 'existing-a' } });
  const accept = (proposal) => send({ method: '$accept', args: {
    id: proposal.id, acceptanceToken: proposal.acceptanceToken, sessionId: proposal.result.sessionId,
  } });
  return { ...h, server, input, output, send, next, queued, handoff, accept };
}

test('actual JSONL cancellation after stdout enqueue rejects late success and restores question-only chat', async (t) => {
  const h = await jsonlHarness(t);
  h.handoff();
  const proposal = await h.next((message) => message.id === 'handoff' && message.acceptanceToken);
  assert.equal(h.created.at(-1).getState().toolMode, 'full');
  assert.equal(h.server.pendingCount, 1, 'queued proposal still owns rollback');
  h.send({ method: '$cancel', args: { id: 'handoff' } });
  await h.next((message) => message.id === 'handoff' && message.error);
  await tick();
  assert.equal(h.created.at(-1).getState().toolMode, 'questions');
  assert.equal(h.server.pendingCount, 0);
  h.accept(proposal);
  h.output.resume();
  await tick();
  assert.equal(h.queued.some((message) => message.accepted), false, 'late read/receipt cannot commit cancelled success');
  assert.equal(h.created.at(-1).getState().sessionId, 'existing-a');
});

test('actual JSONL matching acceptance commits exactly once; stale and foreign receipts cannot commit', async (t) => {
  const h = await jsonlHarness(t);
  h.handoff();
  const proposal = await h.next((message) => message.id === 'handoff' && message.acceptanceToken);
  h.send({ method: '$accept', args: { id: 'foreign', acceptanceToken: proposal.acceptanceToken, sessionId: 'existing-a' } });
  h.send({ method: '$accept', args: { id: 'handoff', acceptanceToken: 'stale', sessionId: 'existing-a' } });
  h.send({ method: '$accept', args: { id: 'handoff', acceptanceToken: proposal.acceptanceToken, sessionId: 'foreign' } });
  await tick();
  assert.equal(h.server.pendingCount, 1);
  assert.equal(h.queued.some((message) => message.accepted), false);
  h.accept(proposal);
  h.accept(proposal);
  const confirmed = await h.next((message) => message.accepted);
  await tick();
  assert.equal(confirmed.acceptanceToken, proposal.acceptanceToken);
  assert.deepEqual(confirmed.result, proposal.result);
  assert.equal(h.server.pendingCount, 0);
  h.send({ method: '$cancel', args: { id: 'handoff' } });
  h.accept(proposal);
  await tick();
  assert.equal(h.queued.filter((message) => message.accepted).length, 1);
  assert.equal(h.created.at(-1).getState().toolMode, 'full', 'accepted explicit work survives later stale cancellation');
});

test('actual JSONL unacknowledged handoff expires and late acceptance cannot restore full permissions', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 100_000 });
  const h = await jsonlHarness(t);
  h.handoff();
  const proposal = await h.next((message) => message.id === 'handoff' && message.acceptanceToken);
  assert.equal(proposal.acceptanceExpiresAt, 130_000);
  t.mock.timers.tick(30_000);
  await h.next((message) => message.id === 'handoff' && message.error);
  await tick();
  h.accept(proposal);
  await tick();
  assert.equal(h.created.at(-1).getState().toolMode, 'questions');
  assert.equal(h.server.pendingCount, 0);
  assert.equal(h.queued.some((message) => message.accepted), false);
});

test('actual JSONL input shutdown rolls back pending delivery before disposing its session', async (t) => {
  const h = await jsonlHarness(t);
  h.handoff();
  await h.next((message) => message.id === 'handoff' && message.acceptanceToken);
  h.input.end();
  await h.server.closed;
  assert.equal(h.server.pendingCount, 0);
  assert.equal(h.created.at(-1).getState().toolMode, 'questions');
  assert.deepEqual(h.calls.filter(([name]) => name === 'mode').map(([, mode]) => mode), ['questions', 'full', 'questions']);
  const full = h.calls.findIndex(([name, mode]) => name === 'mode' && mode === 'full');
  const rollback = h.calls.findIndex(([name, mode], index) => index > full && name === 'mode' && mode === 'questions');
  assert.ok(rollback > full && rollback < h.calls.findIndex(([name]) => name === 'dispose'));
  assert.equal(h.calls.at(-1)[0], 'dispose');
});

test('actual JSONL output disconnect rolls back unaccepted chat but preserves prior explicit work mode', async (t) => {
  for (const mode of ['chat', 'work']) {
    const h = await jsonlHarness(t, mode, true);
    h.handoff();
    await h.next((message) => message.id === 'handoff' && message.acceptanceToken);
    h.output.destroy(new Error('Bloom output disconnected'));
    await assert.rejects(h.server.closed, /output disconnected/);
    assert.equal(h.server.pendingCount, 0);
    assert.equal(h.created.at(-1).getState().toolMode, mode === 'chat' ? 'questions' : 'full');
  }
});

test('only connected routable model IDs are exposed, and invalid selections never submit or choose another engine', async () => {
  const h = harness();
  try {
    assert.deepEqual(await h.bridge.call('models'), [{
      key: 'mixdog:openai-oauth/gpt-test', provider: 'openai-oauth', model: 'gpt-test',
      name: 'Test model', efforts: ['low', 'high'], defaultEffort: null,
    }]);
    await assert.rejects(h.bridge.call('open', { viewId: 'bad', modelKey: 'mixdog:anthropic-oauth/claude-unavailable', mode: 'chat' }), /not routable/);
    await assert.rejects(h.bridge.call('open', { viewId: 'bad', modelKey: 'mixdog:openai-oauth/gpt-test', effort: 'ultra', mode: 'chat' }), /effort/);
    assert.equal(h.created.length, 1, 'invalid routes do not create conversation runtimes');
    assert.equal(h.calls.some(([name]) => name === 'submit'), false);
    await h.open();
    h.catalog.length = 0;
    await assert.rejects(h.bridge.call('send', { viewId: 'bloom-view', turnId: 't1', text: 'hi', images: [] }), /not routable/);
    assert.equal(h.calls.some(([name]) => name === 'submit'), false);
  } finally { await h.bridge.dispose(); }
});

test('passive usage preserves accounts/windows but removes config and credentials at every boundary', async () => {
  const h = harness();
  try {
    const result = await h.bridge.call('usage');
    assert.deepEqual(result.rows[0].accounts[0], {
      accountId: 'account-a', alias: 'Personal', identity: 'person@example.test', selected: true,
      status: 'partial', stale: false, updatedAt: 3,
      windows: [{ label: '5H', usedPct: 42, resetAt: 100, windowSeconds: 18000 }],
    });
    assert.equal(result.rows[0].id, 'openai-oauth');
    assert.equal(JSON.stringify(result).includes('private'), false);
    assert.deepEqual(h.calls, [['usage', { refresh: false }]]);
    assert.equal(JSON.stringify(sanitizeBloomUsage({ rows: [], config: { token: 'private' } })).includes('config'), false);
    const fourAccounts = sanitizeBloomUsage({ rows: [
      { id: 'openai-oauth', accounts: [{ accountId: 'gpt-a', identity: 'A' }, { accountId: 'gpt-b', identity: 'B' }] },
      { id: 'anthropic-oauth', accounts: [{ accountId: 'claude-a', identity: 'C' }, { accountId: 'claude-b', identity: 'D' }] },
    ] });
    assert.deepEqual(fourAccounts.rows.flatMap((row) => row.accounts.map((account) => [account.accountId, account.identity])),
      [['gpt-a', 'A'], ['gpt-b', 'B'], ['claude-a', 'C'], ['claude-b', 'D']]);
  } finally { await h.bridge.dispose(); }
});

test('existing session attachment is identity stable, emits only chat DTOs and refuses a route identity change', async () => {
  const h = harness();
  try {
    const initial = await h.open('chat', 'existing-a');
    assert.equal(initial.sessionId, 'existing-a');
    assert.equal(h.created.at(-1).options.sessionId, 'existing-a');
    assert.equal(h.created.at(-1).options.toolMode, 'questions');
    const current = h.created.at(-1);
    await h.bridge.call('send', { viewId: 'bloom-view', turnId: 't1', text: 'hi', images: [] });
    current.update({ streamingTail: { id: 'assistant-a', kind: 'assistant', text: 'hel', token: 'private' } });
    assert.equal(h.events.at(-1).snapshot.streamingTail.text, 'hel');
    assert.equal('config' in h.events.at(-1).snapshot, false);
    current.update({ streamingTail: null, busy: false, items: [
      { id: 'assistant-a', kind: 'assistant', text: 'hello' }, { id: 'done-a', kind: 'turndone', status: 'done' },
    ] });
    assert.equal(h.events.at(-1).turnId, 't1');
    current.update({ sessionId: 'another-session' });
    assert.match(h.events.at(-1).error, /identity changed/);
    await assert.rejects(h.bridge.call('send', { viewId: 'bloom-view', turnId: 't2', text: 'again' }), /identity changed/);
    current.update({ sessionId: 'existing-a' });
  } finally { await h.bridge.dispose(); }
});

test('subscribe to a preexisting question preserves request and question IDs through reconnect without answers', async () => {
  const question = { id: 'existing-question', sessionId: 'existing-a', questions: [
    { id: 'destination', header: 'Destination', question: 'Where?', options: [{ label: 'Archive' }, { label: 'Inbox' }] },
  ] };
  const h = harness({ initialQuestion: question });
  try {
    const initial = await h.open('chat', 'existing-a');
    assert.equal(initial.question.id, 'existing-question');
    assert.equal(initial.question.questions[0].id, 'destination');
    const current = h.created.at(-1);
    current.update({ userQuestion: structuredClone(question) });
    assert.equal(h.events.at(-1).snapshot.question.id, initial.question.id);
    assert.equal(h.events.at(-1).snapshot.question.questions[0].id, 'destination');
    assert.equal(h.events.at(-1).turnId, null, 'question is session-owned, not tied to a new local prompt');
    assert.equal(h.calls.some(([name]) => ['submit', 'answer', 'approve'].includes(name)), false);
    assert.equal(await h.bridge.call('answer', {
      viewId: 'bloom-view', questionId: 'existing-question', response: { answers: { destination: { option: 1 } } },
    }), true);
    assert.equal(h.calls.filter(([name]) => name === 'answer').length, 1);
  } finally { await h.bridge.dispose(); }
});

test('pending prompt intake cancellation never becomes a delayed model request', async () => {
  let release;
  const h = harness({ makePrompt: () => new Promise((resolve) => { release = resolve; }) });
  try {
    await h.open();
    const send = h.bridge.call('send', { viewId: 'bloom-view', turnId: 't1', text: 'hi', images: [] });
    send.catch(() => {});
    await tick();
    const cancel = h.bridge.call('cancel', { viewId: 'bloom-view', turnId: 't1' });
    release('hi');
    await assert.rejects(send, /cancelled before prompt submission/);
    await cancel;
    assert.equal(h.calls.some(([name]) => name === 'submit'), false);
    assert.equal(h.calls.some(([name]) => name === 'abort'), false, 'unsubmitted intake does not abort a session turn');
  } finally { await h.bridge.dispose(); }
});

test('pending prompt intake owns the turn and blocks overlapping sends and permission handoff', async () => {
  const intake = Promise.withResolvers();
  let prompts = 0;
  const h = harness({ makePrompt: (prompt) => ++prompts === 1 ? intake.promise : prompt });
  try {
    await h.open();
    const first = h.bridge.call('send', { viewId: 'bloom-view', turnId: 't1', text: 'first', images: [] });
    first.catch(() => {});
    await tick();
    await assert.rejects(h.bridge.call('send', { viewId: 'bloom-view', turnId: 't2', text: 'second', images: [] }), /already busy/);
    await assert.rejects(h.bridge.call('handoff', { viewId: 'bloom-view' }), /Stop the active turn/);
    assert.equal(h.calls.some(([name]) => ['submit', 'handoff'].includes(name)), false);
    intake.resolve('first');
    assert.equal(await first, true);
    assert.equal(h.calls.filter(([name]) => name === 'submit').length, 1);
  } finally {
    intake.resolve('first');
    await h.bridge.dispose();
  }
});

test('retired send and cancellation completions cannot publish into or abort a following turn', async (t) => {
  for (const fail of [false, true]) {
    await t.test(fail ? 'late error' : 'late acceptance', async () => {
      const reply = Promise.withResolvers();
      const h = harness({ submit: (_api, _prompt, options) => options.id === 'old' ? reply.promise : true });
      try {
        await h.open();
        const current = h.created.at(-1);
        const old = h.bridge.call('send', { viewId: 'bloom-view', turnId: 'old', text: 'first', images: [] });
        old.catch(() => {});
        await tick();
        const cancel = h.bridge.call('cancel', { viewId: 'bloom-view', turnId: 'old' });
        cancel.catch(() => {});
        current.update({ busy: false, items: [{ id: 'old-done', kind: 'turndone', status: 'done' }] });
        assert.equal(await h.bridge.call('send', { viewId: 'bloom-view', turnId: 'next', text: 'second', images: [] }), true);
        const eventCount = h.events.length;
        if (fail) {
          reply.reject(new Error('late old intake error'));
          await assert.rejects(old, /late old intake error/);
          await assert.rejects(cancel, /late old intake error/);
        } else {
          reply.resolve(true);
          assert.equal(await old, true);
          assert.deepEqual(await cancel, { aborted: false });
        }
        assert.equal(h.events.length, eventCount, 'retired intake emits no projection for the new turn');
        assert.equal(current.getState().busy, true, 'new turn remains active');
        assert.equal(h.calls.some(([name]) => name === 'abort'), false, 'old cancellation sends no abort for the new turn');
        current.update({ busy: false, items: [{ id: 'new-done', kind: 'turndone', status: 'done' }] });
        assert.equal(h.events.at(-1).turnId, 'next', 'new turn retains its identity through completion');
      } finally {
        reply.resolve(true);
        await h.bridge.dispose();
      }
    });
  }
});

test('user input and execution approvals remain different validated lanes', async () => {
  const h = harness();
  try {
    await h.open('work', 'existing-work');
    const current = h.created.at(-1);
    current.update({
      userQuestion: { id: 'question-a', sessionId: 'existing-work', questions: [{ id: 'target', question: 'Which file?', options: [] }] },
      toolApproval: { id: 'approval-a', name: 'shell', args: { command: 'echo ok' } },
    });
    const response = { answers: { target: { text: 'a.txt' } } };
    assert.equal(await h.bridge.call('answer', { viewId: 'bloom-view', questionId: 'question-a', response }), true);
    assert.equal(h.calls.some(([name]) => name === 'approve'), false);
    await assert.rejects(h.bridge.call('approve', { viewId: 'bloom-view', approvalId: 'question-a', allow: true }), /no longer pending/);
    await assert.rejects(h.bridge.call('answer', { viewId: 'bloom-view', questionId: 'question-a', response: { answers: { target: { option: 1, text: 'x' } } } }), /either an option/);
    await h.bridge.call('answer', { viewId: 'bloom-view', questionId: 'question-a', response: { cancelled: true } });
    await h.bridge.call('approve', { viewId: 'bloom-view', approvalId: 'approval-a', allow: false });
    assert.deepEqual(h.calls.filter(([name]) => name === 'approve'), [['approve', 'approval-a', { approved: false }]]);
    current.update({ userQuestion: { ...current.getState().userQuestion, sessionId: 'foreign' } });
    await assert.rejects(h.bridge.call('answer', { viewId: 'bloom-view', questionId: 'question-a', response }), /no longer pending/);
  } finally { await h.bridge.dispose(); }
});

test('plain chat cannot grant execution and explicit handoff keeps the same durable session', async () => {
  const h = harness();
  try {
    const state = await h.open('chat', 'existing-chat');
    const current = h.created.at(-1);
    current.update({ toolApproval: { id: 'approval-a', name: 'shell', args: {} } });
    await assert.rejects(h.bridge.call('approve', { viewId: 'bloom-view', approvalId: 'approval-a', allow: true }), /Plain chat/);
    current.update({ toolApproval: null });
    const result = await h.bridge.call('handoff', { viewId: 'bloom-view' });
    assert.equal(result.sessionId, state.sessionId);
    assert.equal(result.mode, 'work');
    assert.equal(current.getState().toolMode, 'full');
    assert.equal(h.calls.some(([name]) => name === 'submit'), false);
  } finally { await h.bridge.dispose(); }
});

test('a failed desktop handoff restores plain-chat permissions and exposes the failure', async () => {
  const h = harness();
  try {
    await h.open();
    const current = h.created.at(-1);
    current.handoff = async () => { throw new Error('Mixdog desktop is not connected'); };
    await assert.rejects(h.bridge.call('handoff', { viewId: 'bloom-view' }), /desktop is not connected/);
    assert.equal(current.getState().toolMode, 'questions');
    assert.equal(h.events.at(-1).snapshot.mode, 'chat');
    assert.equal(h.calls.some(([name]) => name === 'submit'), false);
  } finally { await h.bridge.dispose(); }
});

test('cancellation during permission setup restores chat before a handoff can be submitted', async () => {
  const h = harness();
  const controller = new AbortController();
  const enabled = Promise.withResolvers();
  try {
    await h.open();
    const current = h.created.at(-1);
    const setMode = current.setToolMode;
    current.setToolMode = async (mode) => {
      const result = await setMode(mode);
      if (mode === 'full') await enabled.promise;
      return result;
    };
    const pending = h.bridge.call('handoff', { viewId: 'bloom-view' }, { signal: controller.signal });
    pending.catch(() => {});
    await tick();
    controller.abort(new Error('Caller cancelled during mode setup.'));
    enabled.resolve();
    await assert.rejects(pending, /cancelled during mode setup/);
    assert.equal(current.getState().toolMode, 'questions');
    assert.equal(h.events.at(-1).snapshot.mode, 'chat');
    assert.equal(h.calls.some(([name]) => name === 'handoff'), false);
  } finally { enabled.resolve(); await h.bridge.dispose(); }
});

test('late handoff success after cancellation cannot leave plain chat in work mode', async () => {
  const h = harness();
  const controller = new AbortController();
  const result = Promise.withResolvers();
  try {
    await h.open();
    const current = h.created.at(-1);
    current.handoff = async ({ signal }) => {
      assert.equal(signal, controller.signal);
      return result.promise;
    };
    const pending = h.bridge.call('handoff', { viewId: 'bloom-view' }, { signal: controller.signal });
    pending.catch(() => {});
    await tick();
    await assert.rejects(h.bridge.call('send', { viewId: 'bloom-view', turnId: 'new', text: 'must not execute' }), /already busy/);
    controller.abort(new Error('Caller cancelled while waiting.'));
    result.resolve({ sessionId: current.getState().sessionId, cwd: current.getState().cwd });
    await assert.rejects(pending, /cancelled while waiting/);
    assert.equal(current.getState().toolMode, 'questions');
    assert.equal(h.events.at(-1).snapshot.mode, 'chat');
    assert.equal(h.calls.some(([name]) => name === 'submit'), false);
  } finally { result.resolve(); await h.bridge.dispose(); }
});

test('an older or missing runtime is rejected rather than normalizing no-tools mode to full', () => {
  assert.throws(() => requireBloomRuntime(null), /compatible runtime/);
  assert.throws(() => requireBloomRuntime({ protocol: SESSION_PROTOCOL, revision: SESSION_REVISION - 1 }), /compatible runtime/);
  requireBloomRuntime({ protocol: SESSION_PROTOCOL, revision: SESSION_REVISION });
});

test('runtime all-project search is read-only and never ingests, forces cycles or changes current project', async () => {
  const calls = [];
  const api = createRecallResourceApi({ deps: {
    getConfig: () => ({}), getSession: () => ({ id: 'active', messages: [{ role: 'user', content: 'private' }] }),
    getCurrentCwd: () => 'C:/project-a', cfgMod: {},
    getMemoryModule: async () => ({ handleToolCall: async (name, args) => {
      calls.push([name, args]); return { content: [{ type: 'text', text: 'Project A\nProject B' }] };
    } }),
  } });
  assert.equal(await api.searchConversations('topic', { limit: 25 }), 'Project A\nProject B');
  assert.deepEqual(calls, [['recall', {
    query: 'topic', limit: 25, projectScope: 'all', currentSession: false,
    forceCycleOnEmpty: false, includeRaw: true, includeArchived: true,
  }]]);
  const h = harness();
  try {
    const result = await h.bridge.call('search', { query: 'topic', limit: 25 });
    assert.equal(result.projects.length, 2);
    assert.match(result.mixdogText, /Project B/);
    assert.equal(h.calls.some(([name]) => ['submit', 'mode', 'handoff'].includes(name)), false);
  } finally { await h.bridge.dispose(); }
});

test('none-tools mode forbids eager, late, native and direct tool execution; explicit work restores the catalog', () => {
  const tools = ['read', 'shell', 'request_user_input', 'mcp__demo__mutate'].map((name) => ({
    name, description: name, parameters: { type: 'object', properties: {} },
  }));
  const session = { provider: 'anthropic-oauth', tools: tools.slice(), toolSpec: 'full', messages: [] };
  assert.equal(normalizeToolMode('none'), 'none');
  assert.deepEqual(toolSpecForMode('none'), []);
  assert.equal(deferredSurfaceModeForLead('none'), 'none');
  applyDeferredToolSurface(session, 'none', tools);
  assert.deepEqual(session.tools, []);
  assert.deepEqual(snapshotProviderRequestTools({ session, provider: 'anthropic-oauth', tools, nativeTools: tools }), []);
  assert.equal(refreshInitialDeferredMcpSurface(session, tools), false);
  assert.equal(reconcileDeferredMcpToolCatalog(session, tools), null);
  assert.equal(selectDeferredTools(session, ['shell'], 'full').blocked.length, 1);
  assert.match(prepareDeferredToolCallThrough(session, 'shell').deny, /no-tools/);
  assert.equal(isOffReadonlySurface(session, 'shell'), true);
  applyDeferredToolSurface(session, 'lead', tools);
  assert.ok(session.deferredToolCatalog.some((tool) => tool.name === 'shell'));
});

test('permission transitions force-refresh the actual conversation and restore its original tool spec, not approvals', async () => {
  const tools = [{ name: 'shell', description: 'shell', parameters: { type: 'object', properties: {} } }];
  const session = { id: 'existing-a', provider: 'openai-oauth', toolSpec: 'full', tools: tools.slice(), messages: [{ role: 'user', content: 'hi' }] };
  let mode = 'full', activeTurns = 0;
  const requests = [];
  const api = createSessionOps({
    getSession: () => session, getActiveTurnCount: () => activeTurns, setMode: (value) => { mode = value; },
    refreshEmptySessionToolPolicy: async (options) => {
      requests.push(options);
      applyDeferredToolSurface(session, deferredSurfaceModeForLead(mode), tools);
    },
  });
  await api.setToolMode('none');
  assert.deepEqual(session.toolSpec, []);
  assert.equal(session.deferredSurfaceMode, 'none');
  assert.deepEqual(requests, [{ force: true }]);
  activeTurns = 1;
  await assert.rejects(api.setToolMode('full'), /Stop the active turn/);
  assert.equal(mode, 'none');
  activeTurns = 0;
  await api.setToolMode('full');
  assert.equal(session.toolSpec, 'full');
  assert.ok(session.deferredToolCatalog.some((tool) => tool.name === 'shell'));
});

test('service handoff validates the exact stored session and fails when no desktop is connected', async () => {
  let runtimeLoads = 0;
  const service = createSessionService({
    createSessionRuntime: async () => { runtimeLoads++; throw new Error('must remain a read-only stored lookup'); },
    sessionExists: async () => true,
    readStoredSession: async () => ({ sessionId: 'existing-a', cwd: 'C:/p', items: [], busy: false }),
  });
  try {
    await assert.rejects(service.handleCall('session.handoff', { sessionId: 'existing-a' }), /desktop is not connected/);
    assert.equal(runtimeLoads, 0);
  } finally { await service.stop(); }
});

test('structured text uses the selected authenticated route with no tools, validates output and propagates model failure', async () => {
  const h = harness({ submit: async (api) => {
    api.update({ busy: false, items: [
      { id: 'answer', kind: 'assistant', text: '{"intent":"reminder"}' },
      { id: 'done', kind: 'turndone', status: 'done' },
    ] });
    return true;
  } });
  const request = {
    modelKey: 'mixdog:openai-oauth/gpt-test', effort: 'low', system: 'Extract intent', text: 'Tomorrow',
    schema: { type: 'object', properties: { intent: { type: 'string' } }, required: ['intent'], additionalProperties: false },
  };
  try {
    assert.deepEqual(await h.bridge.call('structuredText', request), { intent: 'reminder' });
    assert.equal(h.created.at(-1).options.toolMode, 'none');
    assert.equal(h.created.at(-1).options.provider, 'openai-oauth');
  } finally { await h.bridge.dispose(); }
  const fail = harness({ submit: async (api) => {
    api.update({ busy: false, items: [{ id: 'error', kind: 'turndone', status: 'failed', detail: 'account quota reached' }] });
    return true;
  } });
  try {
    await assert.rejects(fail.bridge.call('structuredText', request), /account quota/);
    assert.equal(fail.calls.filter(([name]) => name === 'submit').length, 1);
  } finally { await fail.bridge.dispose(); }
  const invalid = harness({ submit: async (api) => {
    api.update({ busy: false, items: [{ id: 'answer', kind: 'assistant', text: '{"unexpected":true}' }, { id: 'done', kind: 'turndone', status: 'done' }] });
    return true;
  } });
  try { await assert.rejects(invalid.bridge.call('structuredText', request), /requires field/); }
  finally { await invalid.bridge.dispose(); }
});

test('structured text cancellation aborts the owned request without a retry or another provider', async () => {
  const h = harness();
  const controller = new AbortController();
  const request = h.bridge.call('structuredText', {
    modelKey: 'mixdog:openai-oauth/gpt-test', system: 'intent', text: 'tomorrow', schema: { type: 'object' },
  }, { signal: controller.signal });
  request.catch(() => {});
  await tick();
  controller.abort();
  try {
    await assert.rejects(request, /cancelled/);
    assert.equal(h.calls.filter(([name]) => name === 'submit').length, 1);
    assert.equal(h.calls.filter(([name]) => name === 'abort').length, 1);
  } finally { await h.bridge.dispose(); }
});

test('synthetic authenticated transport resumes the existing address and reconnects streaming and question/cancel lanes', async () => {
  const calls = [], attachments = [];
  const state = { sessionId: 'existing-a', provider: 'openai-oauth', model: 'gpt-test', busy: false, items: [], toolMode: 'none' };
  let revision = 1, failNext = false;
  const create = createSessionProxyFactory({
    ensureDaemon: async () => ({ port: 1, token: 'synthetic-token' }),
    attachSession: async ({ onFrame }) => {
      const transport = {
        async call(name, args) {
          calls.push([name, args]);
          if (failNext) { failNext = false; throw Object.assign(new Error('transport lost'), { daemonTransportError: true }); }
          if (name === 'session.create') throw new Error('must not reserve another session');
          if (name === 'session.unsubscribe') return {};
          if (name === 'session.answer') return { sessionId: state.sessionId, accepted: true, revision };
          if (name === 'session.abort') return { sessionId: state.sessionId, aborted: true, revision };
          return { sessionId: state.sessionId, revision, full: { ...state } };
        },
        close: async () => {}, push: onFrame,
      };
      attachments.push(transport);
      return transport;
    },
  });
  const view = await create({ sessionId: 'existing-a', cwd: 'C:/project-a', toolMode: 'none' });
  try {
    assert.equal(calls[0][0], 'session.subscribe');
    revision++;
    state.streamingTail = { id: 'answer', text: 'stream' };
    attachments[0].push({ type: 'session-state', sessionId: 'existing-a', revision, full: { ...state } });
    assert.equal(view.getState().streamingTail.text, 'stream');
    attachments[0].push({ type: 'session-state', sessionId: 'foreign', revision: revision + 10, full: { ...state, streamingTail: { text: 'wrong' } } });
    assert.equal(view.getState().streamingTail.text, 'stream');
    failNext = true;
    assert.equal(await view.resolveUserQuestion('q1', { cancelled: true }), true);
    assert.equal(attachments.length, 2);
    assert.equal(view.getState().sessionId, 'existing-a');
    assert.equal((await view.abortAsync()).aborted, true);
    assert.ok(calls.filter(([name]) => name === 'session.subscribe').every(([, args]) => args.sessionId === 'existing-a'));
  } finally { await view.dispose(); }
});
