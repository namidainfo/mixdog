import assert from 'node:assert/strict';
import test from 'node:test';
import { attachSession, withDaemon } from './_shared.mjs';

test('public HTTP caller abort retires handoff correlation and rejects its late navigation receipt', { timeout: 10_000 }, async () => {
  await withDaemon(async ({ discovery }) => {
    const deliveries = [];
    let opened = Promise.withResolvers();
    const cancelled = Promise.withResolvers();
    const desktop = await attachSession({
      discovery, clientKind: 'desktop',
      onFrame: (frame) => {
        if (frame.message?.name !== 'session-open-request') return;
        deliveries.push(frame.message.value);
        if (frame.message.value.cancelled) cancelled.resolve(frame.message.value);
        else opened.resolve(frame.message.value);
      },
    });
    const caller = await attachSession({ discovery });
    try {
      const moduleUrl = new URL('../../src/standalone/test-fixtures/lifecycle-desktop-service.mjs', import.meta.url).href;
      await desktop.call('desktop.init', { desktopId: 'receiver', moduleUrl });
      await desktop.call('desktop.ready', { desktopId: 'receiver' });
      const created = await caller.call('session.create', { cwd: 'C:/original-project' });
      const controller = new AbortController();
      const pending = caller.call('session.handoff', { sessionId: created.sessionId }, { signal: controller.signal });
      pending.catch(() => {});
      const delivery = await opened.promise;
      assert.equal(delivery.sessionId, created.sessionId);
      controller.abort();
      await assert.rejects(pending, /abort/i);
      const retired = await cancelled.promise;
      assert.equal(retired.requestId, delivery.requestId);
      assert.equal(retired.sessionId, created.sessionId);
      const receipt = {
        requestId: delivery.requestId, sessionId: created.sessionId, opened: true,
      };
      assert.equal(await desktop.call('desktop.invoke', {
        desktopId: 'receiver', method: 'invokeDesktopOperation', args: ['sessionOpenHandled', [receipt]],
      }), false);
      assert.equal(deliveries.filter((request) => !request.cancelled).length, 1, 'abort does not retry navigation');

      // A cancelled call does not poison a following handoff of the same exact
      // session. The new correlation must receive its own successful receipt.
      opened = Promise.withResolvers();
      const next = caller.call('session.handoff', { sessionId: created.sessionId });
      next.catch(() => {});
      const nextDelivery = await opened.promise;
      assert.notEqual(nextDelivery.requestId, delivery.requestId);
      assert.equal(await desktop.call('desktop.invoke', {
        desktopId: 'receiver', method: 'invokeDesktopOperation',
        args: ['sessionOpenHandled', [{ requestId: nextDelivery.requestId, sessionId: created.sessionId, opened: true }]],
      }), true);
      assert.equal((await next).sessionId, created.sessionId);
    } finally {
      await caller.close();
      await desktop.close();
    }
  }, {
    desktopRuntime: { makeAdapter: () => ({ invoke: async () => null, control: async () => {}, dispose: async () => {} }) },
  });
});
