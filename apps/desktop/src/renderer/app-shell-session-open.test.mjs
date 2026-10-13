import assert from 'node:assert/strict';
import test from 'node:test';
import React, { act } from 'react';
import { useAppSessionOpen } from './app-shell-session-open.ts';
import { usePushNotificationNavigation } from './use-push-notification-navigation.ts';
import { defaultSessionLaneStore } from './session-lane-store.ts';
import { installTestDom } from './test-support/test-dom.mjs';
import { setImmediate as tick } from 'node:timers/promises';
import { SessionOpenRequests } from '../main/session-open-requests.ts';
import { createSessionService } from '../../../../src/standalone/session-service.mjs';
import { EventEmitter } from 'node:events';
import { createBloomBridge } from '../../../../src/standalone/bloom-bridge.mjs';
import { createSessionProxyFactory } from '../../../../src/standalone/session-proxy.mjs';
import { createAttachmentCalls } from '../../../../src/standalone/session-client/attachment-calls.mjs';
import { createCallRoute } from '../../../../src/standalone/session-transport/call-route.mjs';

const delivery = (requestId, sessionId, cwd = null) => ({ requestId, sessionId, cwd, expiresAt: Date.now() + 30_000 });

async function harness(t, initial = {}, transport = {}) {
  const { window, root } = installTestDom(t, { expose: ['navigator'], rootId: 'root' });
  defaultSessionLaneStore.clear();
  t.after(() => defaultSessionLaneStore.clear());
  const selected = [];
  const reads = [];
  const receipts = [];
  const readiness = [];
  const errors = [];
  const focused = [];
  let requested;
  let notified;
  let subscriptions = 0;
  window.mixdogDesktop = {
    onSessionOpenRequested(listener) {
      subscriptions++;
      requested = listener;
      return () => { requested = undefined; };
    },
    sessionOpenNavigationReady: (ready) => { readiness.push(ready); transport.ready?.(ready); },
    sessionOpenHandled: (result) => { receipts.push(result); transport.receipt?.(result); },
    onNotificationOpenSession(listener) {
      notified = listener;
      return () => { notified = undefined; };
    },
    prefetchSession: (id) => {
      reads.push(id);
      return Promise.resolve(transport.load ? transport.load(id) : true).then((loaded) => {
        if (loaded && transport.publishLane !== false)
          defaultSessionLaneStore.apply({ sessionId: id, snapshot: { sessionId: id, items: [], cwd: '/original-project' } });
        return loaded;
      });
    },
    resyncSessionState() {},
  };
  const navigationEpoch = { current: 0 };
  const tabs = [{ key: 'session:existing', title: 'Pinned title', selection: { kind: 'session', id: 'existing', title: 'Pinned title' } }];
  let props = {
    navigationEpoch,
    closeSidebarForNavigation() {},
    setRequestedSessionId() {},
    sessions: [],
    tabs,
    finishPendingConversationHandoff() {},
    activateSelection: (selection, title) => {
      selected.push({ selection, title });
      if (!tabs.some((tab) => tab.selection.id === selection.id)) {
        tabs.push({ key: `session:${selection.id}`, title, selection });
      }
    },
    existingSessionReady: true,
    onSessionOpenError: (message) => errors.push(message),
    ...initial,
  };
  function Probe(input) {
    const { openSession } = useAppSessionOpen(input);
    usePushNotificationNavigation({
      ready: false,
      desktopReady: true,
      openSession: () => assert.fail('Desktop handoff must not enter phone notification navigation'),
      focusDesktopSession: (id) => focused.push(id),
    });
    assert.equal(typeof openSession, 'function');
    return null;
  }
  const render = async (patch = {}) => {
    props = { ...props, ...patch };
    await act(async () => root.render(React.createElement(Probe, props)));
  };
  await render();
  return {
    selected, reads, receipts, readiness, errors, focused, tabs, navigationEpoch,
    request: (request) => requested(request),
    applyLane: (id) => defaultSessionLaneStore.apply({ sessionId: id, snapshot: { sessionId: id, items: [], cwd: '/original-project' } }),
    subscriptions: () => subscriptions,
    render,
    deliver: async (request) => { await act(async () => requested(request)); },
    notify: async (id) => { await act(async () => notified(id)); },
  };
}

test('handoff reuses an existing tab and opens a no-tab session by its original ID, never creating a session', async (t) => {
  const h = await harness(t);
  await h.deliver(delivery('request-1', 'existing', '/original-project'));
  assert.equal(h.tabs.length, 1);
  assert.equal(h.selected[0].selection.id, 'existing');
  assert.equal(h.selected[0].title, 'Pinned title');
  await h.deliver(delivery('request-2', 'no-tab', '/different-project'));
  assert.deepEqual(h.reads, ['existing', 'no-tab']);
  assert.equal(h.tabs.length, 2);
  assert.equal(h.selected[1].selection.id, 'no-tab');
  assert.deepEqual(h.receipts.map(({ sessionId, opened }) => [sessionId, opened]), [['existing', true], ['no-tab', true]]);
  assert.deepEqual(h.focused, []);
  assert.deepEqual(h.errors, []);
});

test('cold readiness holds all requests, uses the latest navigation callback and consumes them once', async (t) => {
  const h = await harness(t, { existingSessionReady: false });
  await h.deliver(delivery('request-1', 'first', '/a'));
  await h.deliver(delivery('request-2', 'second', '/b'));
  assert.deepEqual(h.selected, []);
  assert.deepEqual(h.receipts, []);
  const selected = [];
  await h.render({ existingSessionReady: true, activateSelection: (selection) => selected.push(selection.id) });
  assert.deepEqual(selected, ['first', 'second']);
  assert.equal(h.receipts.length, 2);
  await h.render();
  assert.equal(h.receipts.length, 2);
  assert.equal(h.subscriptions(), 1);
  assert.deepEqual(h.readiness, [false, true]);
});

test('invalid renderer deliveries cannot read or select sessions', async (t) => {
  const h = await harness(t);
  for (const value of [null, {}, { requestId: 1, sessionId: '../bad', cwd: null },
    { requestId: 0, sessionId: 'valid', cwd: null }, { requestId: 1, sessionId: '', cwd: null }]) {
    await h.deliver(value);
  }
  assert.equal(h.errors.length, 5);
  assert.deepEqual(h.reads, []);
  assert.deepEqual(h.selected, []);
  assert.deepEqual(h.receipts, []);
});

test('normal desktop notifications still use only focus, not the existing-session handoff', async (t) => {
  const h = await harness(t);
  await h.notify('no-tab');
  assert.deepEqual(h.focused, ['no-tab']);
  assert.deepEqual(h.selected, []);
  assert.deepEqual(h.receipts, []);
  await h.deliver(delivery('request-1', 'no-tab'));
  assert.equal(h.selected[0].selection.id, 'no-tab');
  assert.deepEqual(h.focused, ['no-tab']);
});

test('navigation failure is surfaced and negatively acknowledged instead of reporting success', async (t) => {
  const h = await harness(t, { activateSelection: () => { throw new Error('navigation unavailable'); } });
  await h.deliver(delivery('request-1', 'existing'));
  assert.deepEqual(h.receipts, [{ requestId: 'request-1', sessionId: 'existing', opened: false, error: 'navigation unavailable' }]);
  assert.match(h.errors[0], /navigation unavailable/);
});

async function handoffHarness(t, options = {}) {
  const frames = [];
  const ctx = { clientToken: 'intended-desktop' };
  let queue;
  const service = createSessionService({
    createSessionRuntime: async () => { throw new Error('handoff must not create or execute a session'); },
    sessionExists: async () => true,
    readStoredSession: async (sessionId) => options.readStored ? options.readStored(sessionId) :
      ({ sessionId, cwd: '/original-project', items: [], busy: false }),
    desktopRuntime: { makeAdapter: () => ({ invoke: async () => null, control: async () => {}, dispose: async () => {} }) },
    onFrame: (frame, recipients) => {
      if (frame.message?.name !== 'session-open-request') return;
      frames.push({ frame, recipients: [...recipients] });
      if (recipients.has(ctx.clientToken)) queue.request(frame.message.value);
    },
  });
  t.after(() => service.stop());
  const reply = (result, client = ctx, desktopId = 'primary') => service.handleCall('desktop.invoke', {
    desktopId, method: 'invokeDesktopOperation', args: ['sessionOpenHandled', [result]],
  }, client);
  queue = new SessionOpenRequests(() => {}, (result) => { void reply(result); });
  t.after(() => queue.failAll('test cleanup'));
  const h = await harness(t, { existingSessionReady: options.ready !== false }, {
    load: options.load, publishLane: options.publishLane,
    ready: (ready) => queue.setReady(ready),
    receipt: (result) => queue.acknowledge(result),
  });
  queue.setTarget({ activate() {}, send: h.request });
  queue.setReady(options.ready !== false);
  const moduleUrl = new URL('../../../../src/standalone/test-fixtures/lifecycle-desktop-service.mjs', import.meta.url).href;
  await service.handleCall('desktop.init', { desktopId: 'primary', moduleUrl }, ctx);
  await service.handleCall('desktop.ready', { desktopId: 'primary' }, ctx);
  const foreign = { clientToken: 'other-desktop' };
  await service.handleCall('desktop.init', { desktopId: 'other', moduleUrl: `${moduleUrl}?other` }, foreign);
  await service.handleCall('desktop.ready', { desktopId: 'other' }, foreign);
  const handoff = () => {
    const result = service.handleCall('session.handoff', { sessionId: 'target-session' });
    result.catch(() => {});
    return result;
  };
  return { ...h, service, queue, frames, reply, ctx, foreign, handoff };
}

test('fake transport handoff awaits the resolved lane and exact selection; foreign and stale receipts cannot confirm', async (t) => {
  const h = await handoffHarness(t, { publishLane: false });
  let pending;
  await act(async () => { pending = h.handoff(); await tick(); });
  assert.deepEqual(h.reads, ['target-session']);
  assert.deepEqual(h.selected, []);
  assert.deepEqual(h.receipts, []);
  const request = h.frames[0].frame.message.value;
  assert.equal(typeof request.requestId, 'string');
  assert.deepEqual(h.frames[0].recipients, ['intended-desktop']);
  assert.equal(h.frames[0].frame.desktopId, 'primary');
  const receipt = { requestId: request.requestId, sessionId: 'target-session', opened: true };
  assert.equal(await h.reply(receipt, h.foreign), false);
  assert.equal(await h.reply(receipt, h.foreign, 'other'), false);
  assert.equal(await h.reply({ ...receipt, sessionId: 'foreign-session' }), false);
  assert.equal(await h.reply({ ...receipt, requestId: 'stale-request' }), false);
  await act(async () => { h.applyLane('target-session'); await pending; });
  assert.deepEqual(await pending, { sessionId: 'target-session', cwd: '/original-project' });
  assert.equal(h.selected[0].selection.id, 'target-session');
  assert.deepEqual(h.receipts, [receipt]);
  assert.equal(await h.reply(receipt), false, 'completed correlation cannot be reused');
  assert.equal(h.queue.pendingCount, 0);
});

test('fake transport propagates a failed session read without selecting or retaining the request', async (t) => {
  const h = await handoffHarness(t, { load: () => false });
  await act(async () => { await assert.rejects(h.handoff(), /could not be loaded/); });
  assert.deepEqual(h.selected, []);
  assert.equal(h.receipts[0].opened, false);
  assert.equal(h.queue.pendingCount, 0);
  await h.render({ existingSessionReady: false });
  await h.render({ existingSessionReady: true });
  assert.deepEqual(h.selected, []);
});

test('fake transport rejects superseded navigation rather than acknowledging an unselected session', async (t) => {
  const loading = Promise.withResolvers();
  const h = await handoffHarness(t, { load: () => loading.promise });
  let pending;
  await act(async () => { pending = h.handoff(); await tick(); });
  h.navigationEpoch.current++;
  await act(async () => {
    loading.resolve(true);
    await assert.rejects(pending, /superseded/);
  });
  assert.deepEqual(h.selected, []);
  assert.equal(h.receipts[0].opened, false);
  assert.equal(h.queue.pendingCount, 0);
});

test('fake transport timeout retires cold requests before a later readiness cycle can navigate', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 100_000 });
  const h = await handoffHarness(t, { ready: false });
  let pending;
  await act(async () => { pending = h.handoff(); await tick(); });
  const request = h.frames[0].frame.message.value;
  await act(async () => {
    t.mock.timers.tick(30_000);
    await assert.rejects(pending, /timed out/);
  });
  await h.render({ existingSessionReady: true });
  assert.deepEqual(h.reads, []);
  assert.deepEqual(h.selected, []);
  assert.equal(h.queue.pendingCount, 0);
  assert.equal(await h.reply({ requestId: request.requestId, sessionId: 'target-session', opened: true }), false);
});

test('fake transport disconnect aborts an in-flight load; its late result cannot navigate', async (t) => {
  const loading = Promise.withResolvers();
  const h = await handoffHarness(t, { load: () => loading.promise });
  let pending;
  await act(async () => { pending = h.handoff(); await tick(); });
  await act(async () => {
    await h.service.handleCall('desktop.unsubscribe', { desktopId: 'primary' }, h.ctx);
    await assert.rejects(pending, /disconnected/);
    loading.resolve(true);
    await tick();
  });
  assert.deepEqual(h.selected, []);
  assert.equal(h.queue.pendingCount, 0);
});

test('fake transport in-flight expiry aborts a load before late acceptance can select the session', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 100_000 });
  const loading = Promise.withResolvers();
  const h = await handoffHarness(t, { load: () => loading.promise });
  let pending;
  await act(async () => { pending = h.handoff(); await tick(); });
  await act(async () => {
    t.mock.timers.tick(30_000);
    await assert.rejects(pending, /timed out/);
    loading.resolve(true);
    await tick();
  });
  assert.deepEqual(h.selected, []);
  assert.equal(h.queue.pendingCount, 0);
});

// Exercise the actual Bloom facade, proxy, attachment and /call cancellation
// boundary. Only HTTP bytes and model catalog/state are synthetic; navigation
// still goes through daemon service -> main queue -> real renderer hook.
async function bloomHandoffHarness(t, options = {}) {
  const h = await handoffHarness(t, options);
  const state = {
    sessionId: 'target-session', provider: 'openai-oauth', model: 'gpt-test',
    cwd: '/original-project', toolMode: 'none', busy: false, items: [],
  };
  const modes = [], calls = [];
  let revision = 1;
  const route = createCallRoute({
    clients: new Map([['bloom-client', { leadPid: 12, revision: 8 }]]),
    lanes: { dispatch: (_owner, run) => Promise.resolve().then(run) },
    callCache: { get: () => null, track() {} },
    nowMs: Date.now,
    handleCall: async (name, args, ctx) => {
      calls.push(name);
      if (name === 'session.handoff') return h.service.handleCall(name, args, ctx);
      if (name === 'session.unsubscribe') return {};
      if (name === 'session.configure' && args.action === 'setToolMode') {
        state.toolMode = args.args[0];
        modes.push(state.toolMode);
        revision++;
        return { sessionId: state.sessionId, revision, full: { ...state }, value: state.toolMode };
      }
      if (name === 'session.subscribe') return { sessionId: state.sessionId, revision, full: { ...state } };
      throw new Error(`Unexpected fake daemon route ${name}`);
    },
  });
  const attachment = createAttachmentCalls({
    port: 1, serverToken: 'fake', clientToken: 'bloom-client', stopStream() {}, log() {},
    request: ({ body, path, signal }) => {
      if (path === '/client/deregister') return Promise.resolve({});
      return new Promise((resolve, reject) => {
        const response = new EventEmitter();
        response.destroyed = false;
        response.writableEnded = false;
        const abort = () => {
          response.destroyed = true;
          response.emit('close');
          signal.removeEventListener('abort', abort);
          reject(signal.reason);
        };
        response.writeHead = () => {};
        response.end = (bytes) => {
          response.writableEnded = true;
          const deliver = () => {
            signal?.removeEventListener('abort', abort);
            resolve(JSON.parse(bytes));
          };
          if (body.name === 'session.handoff' && options.responseGate) {
            options.responseQueued.resolve();
            void options.responseGate.promise.then(deliver);
          } else deliver();
        };
        signal?.addEventListener('abort', abort, { once: true });
        if (signal?.aborted) { abort(); return; }
        void route(body, response).catch(reject);
      });
    },
  });
  const create = createSessionProxyFactory({
    ensureDaemon: async () => ({ port: 1, token: 'fake' }),
    attachSession: async () => attachment,
  });
  const bridge = createBloomBridge({
    cwd: '/bloom',
    createSession: async (options) => options.sessionId ? create(options) : {
      listProviderModels: async () => [{ provider: state.provider, id: state.model, effortOptions: [] }],
      getProviderSetup: async () => ({ oauth: [{ id: state.provider, authenticated: true }] }),
      dispose: async () => {},
    },
  });
  t.after(() => bridge.dispose());
  await bridge.call('open', {
    viewId: 'bloom-view', sessionId: state.sessionId,
    modelKey: 'mixdog:openai-oauth/gpt-test', mode: 'chat',
  });
  const handoff = (signal) => {
    const result = bridge.call('handoff', { viewId: 'bloom-view' }, { signal });
    result.catch(() => {});
    return result;
  };
  return { ...h, bridge, state, modes, calls, handoff };
}

test('Bloom caller cancellation retires cold navigation and restores question-only mode before later readiness', { timeout: 5_000 }, async (t) => {
  const h = await bloomHandoffHarness(t, { ready: false });
  const controller = new AbortController();
  let pending;
  await act(async () => { pending = h.handoff(controller.signal); await tick(); });
  assert.equal(h.state.toolMode, 'full');
  assert.equal(h.queue.pendingCount, 1);
  await act(async () => {
    controller.abort(new Error('Bloom caller cancelled.'));
    await assert.rejects(pending, /cancelled/);
  });
  assert.equal(h.state.toolMode, 'questions');
  assert.deepEqual(h.modes, ['questions', 'full', 'questions']);
  assert.equal(h.queue.pendingCount, 0);
  assert.equal(h.frames.at(-1).frame.message.value.cancelled, true);
  await h.render({ existingSessionReady: true });
  assert.deepEqual(h.reads, []);
  assert.deepEqual(h.selected, []);
  assert.equal(h.calls.filter((name) => name === 'session.handoff').length, 1, 'caller abort is not a reconnect or retry');
});

test('Bloom cancellation wins a late receipt/load race without selecting or retaining work permissions', { timeout: 5_000 }, async (t) => {
  const loading = Promise.withResolvers();
  const h = await bloomHandoffHarness(t, { load: () => loading.promise });
  const controller = new AbortController();
  let pending;
  await act(async () => { pending = h.handoff(controller.signal); await tick(); });
  const request = h.frames[0].frame.message.value;
  await act(async () => {
    controller.abort(new Error('Bloom caller cancelled.'));
    assert.equal(await h.reply({ requestId: request.requestId, sessionId: 'target-session', opened: true }), false);
    loading.resolve(true);
    await assert.rejects(pending, /cancelled/);
    await tick();
  });
  assert.deepEqual(h.selected, []);
  assert.equal(h.queue.pendingCount, 0);
  assert.equal(h.state.toolMode, 'questions');
  assert.equal(h.state.sessionId, 'target-session');
  assert.equal(h.receipts.some((result) => result.opened), false);
});

test('a navigation receipt followed by caller cancellation cannot commit a delayed Bloom success or full permissions', { timeout: 5_000 }, async (t) => {
  const responseGate = Promise.withResolvers(), responseQueued = Promise.withResolvers();
  t.after(() => responseGate.resolve());
  const h = await bloomHandoffHarness(t, { responseGate, responseQueued });
  const controller = new AbortController();
  let pending;
  await act(async () => { pending = h.handoff(controller.signal); await responseQueued.promise; });
  assert.equal(h.selected[0].selection.id, 'target-session', 'navigation already completed before cancellation');
  assert.equal(h.receipts[0].opened, true);
  await act(async () => {
    controller.abort(new Error('Bloom caller cancelled after receipt.'));
    await assert.rejects(pending, /cancelled after receipt/);
    responseGate.resolve();
    await tick();
  });
  assert.equal(h.state.toolMode, 'questions');
  assert.equal(h.state.sessionId, 'target-session');
  assert.equal(h.queue.pendingCount, 0);
  assert.equal(h.selected.length, 1, 'late result causes no additional navigation');
  assert.deepEqual(h.modes, ['questions', 'full', 'questions']);
});

test('cancellation during stored identity lookup prevents a later desktop navigation publication', { timeout: 5_000 }, async (t) => {
  const entered = Promise.withResolvers(), stored = Promise.withResolvers();
  const h = await bloomHandoffHarness(t, { readStored: async (sessionId) => {
    entered.resolve();
    await stored.promise;
    return { sessionId, cwd: '/original-project', items: [], busy: false };
  } });
  const controller = new AbortController();
  let pending;
  await act(async () => { pending = h.handoff(controller.signal); await entered.promise; });
  await act(async () => {
    controller.abort(new Error('Bloom caller cancelled during read.'));
    await assert.rejects(pending, /cancelled during read/);
    stored.resolve();
    await tick();
  });
  assert.deepEqual(h.frames, []);
  assert.deepEqual(h.selected, []);
  assert.equal(h.state.toolMode, 'questions');
  assert.equal(h.queue.pendingCount, 0);
});

test('already-cancelled Bloom handoff never enables work permissions or requests navigation', { timeout: 5_000 }, async (t) => {
  const h = await bloomHandoffHarness(t);
  const controller = new AbortController();
  controller.abort(new Error('Bloom caller cancelled before handoff.'));
  await assert.rejects(h.handoff(controller.signal), /cancelled before handoff/);
  assert.deepEqual(h.modes, ['questions']);
  assert.deepEqual(h.frames, []);
  assert.deepEqual(h.selected, []);
});
