import assert from 'node:assert/strict';
import test from 'node:test';
import { HubWorkerBridge } from './worker-bridge.mjs';

test('private callback replies are correlated and only explicit hub capabilities are callable', async () => {
  const frames = [], bridge = new HubWorkerBridge((frame) => frames.push(frame));
  const first = bridge.call('authorize', { user: 'U1' }), second = bridge.call('conversations');
  await Promise.resolve(); await Promise.resolve();
  assert.equal(frames.length, 2);
  bridge.receive(frames[1].id, { ok: true, result: [['key', { actorId: 'U1' }]] });
  bridge.receive(frames[0].id, { ok: true, result: false });
  assert.equal(await first, false);
  assert.equal((await second)[0][1].actorId, 'U1');
  assert.equal(bridge.pending.size, 0);
  await assert.rejects(bridge.call('readFile'), /허용되지/u);
  bridge.close();
});
test('failed and disconnected callback requests are never replayed and do not leak code or credentials', async () => {
  const frames = [], bridge = new HubWorkerBridge((frame) => frames.push(frame));
  const rejected = bridge.call('sendCode', { person: { userId: 'U1' }, code: 'private-test-code' });
  await Promise.resolve(); await Promise.resolve();
  bridge.receive(frames[0].id, { ok: false, error: 'private-test-code' });
  await assert.rejects(rejected, (error) => !error.message.includes('private-test-code'));
  const pending = bridge.call('authorize', { user: 'U1' });
  bridge.close(); await assert.rejects(pending, /닫혔습니다/u);
  assert.equal(bridge.pending.size, 0);
});
test('transport write failures reject the one callback attempt', async () => {
  let attempts = 0;
  const bridge = new HubWorkerBridge(() => { attempts++; throw new Error('pipe closed'); });
  await assert.rejects(bridge.call('conversations'), /pipe closed/u);
  assert.equal(attempts, 1); assert.equal(bridge.pending.size, 0);
});
