import assert from 'node:assert/strict';
import test from 'node:test';
import { SessionOpenRequests } from './session-open-requests.ts';

const delivery = (requestId, sessionId = 'same-session', cwd = null) => ({
  requestId, sessionId, cwd, expiresAt: Date.now() + 30_000,
});

function fixture(t) {
  const reports = [], sent = [], receipts = [];
  let activations = 0;
  const queue = new SessionOpenRequests((...args) => reports.push(args), (result) => receipts.push(result));
  t.after(() => queue.failAll('test cleanup'));
  const target = { send: (request) => sent.push(request), activate: () => activations++ };
  const opened = (request) => queue.acknowledge({ ...request, opened: true });
  return { queue, target, sent, reports, receipts, opened, activations: () => activations };
}

test('cold delivery preserves daemon correlation and exact session while awaiting matching receipts in order', (t) => {
  const f = fixture(t);
  const first = delivery('daemon-first', 'existing-session', 'C:/project-a');
  const second = delivery('daemon-second', 'not-in-a-tab', 'C:/project-b');
  f.queue.request(first);
  f.queue.request(second);
  f.queue.setTarget(f.target);
  assert.deepEqual(f.sent, []);
  f.queue.setReady(true);
  assert.deepEqual(f.sent, [first]);
  f.queue.acknowledge({ ...first, sessionId: 'wrong', opened: true });
  f.queue.acknowledge({ ...first, requestId: 'foreign', opened: true });
  assert.equal(f.queue.pendingCount, 2);
  assert.deepEqual(f.receipts, []);
  f.opened(first);
  assert.deepEqual(f.sent, [first, second]);
  f.opened(second);
  f.opened(first);
  assert.equal(f.queue.pendingCount, 0);
  assert.deepEqual(f.receipts.map(({ requestId, sessionId, opened }) => [requestId, sessionId, opened]),
    [['daemon-first', 'existing-session', true], ['daemon-second', 'not-in-a-tab', true]]);
  assert.equal(f.activations(), 2);
});

test('window loss fails and removes requests rather than navigating them in a later renderer', (t) => {
  const f = fixture(t);
  f.queue.setTarget(f.target);
  f.queue.setReady(true);
  const request = delivery('daemon-request');
  f.queue.request(request);
  f.queue.setTarget(null);
  f.queue.setTarget(f.target);
  f.queue.setReady(true);
  assert.equal(f.queue.request(request), false);
  f.opened(request);
  assert.equal(f.queue.pendingCount, 0);
  assert.equal(f.receipts.length, 1);
  assert.equal(f.receipts[0].opened, false);
  assert.match(f.receipts[0].error, /disconnected/);
  assert.equal(f.sent.filter((request) => !request.cancelled).length, 1);
});

test('invalid or already expired deliveries cannot activate or navigate a window', (t) => {
  const f = fixture(t);
  f.queue.setTarget(f.target);
  f.queue.setReady(true);
  for (const value of [null, {}, { sessionId: 'valid', cwd: null },
    { ...delivery('id'), sessionId: '../escape' }, { ...delivery('id'), requestId: 1 },
    { ...delivery('id'), expiresAt: NaN }, { ...delivery('id'), cwd: {} }])
    assert.equal(f.queue.request(value), false);
  assert.equal(f.queue.request({ ...delivery('expired'), expiresAt: Date.now() - 1 }), false);
  assert.equal(f.queue.pendingCount, 0);
  assert.equal(f.activations(), 0);
  assert.deepEqual(f.sent, []);
  assert.equal(f.receipts[0].opened, false);
});

test('cold deadline expiry removes queued requests and rejects stale success receipts', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 100_000 });
  const f = fixture(t);
  const request = delivery('expires');
  f.queue.request(request);
  t.mock.timers.tick(30_000);
  f.queue.setTarget(f.target);
  f.queue.setReady(true);
  f.opened(request);
  assert.equal(f.queue.pendingCount, 0);
  assert.deepEqual(f.sent, []);
  assert.equal(f.receipts.length, 1);
  assert.match(f.receipts[0].error, /expired/);
});

test('delivery failure and negative navigation receipts retire requests without spinning or redelivery', (t) => {
  const f = fixture(t);
  f.queue.setTarget({ ...f.target, send: () => { throw new Error('renderer closed'); } });
  f.queue.setReady(true);
  const failed = delivery('delivery-failure');
  f.queue.request(failed);
  assert.equal(f.queue.pendingCount, 0);
  f.queue.setTarget(f.target);
  f.queue.setReady(true);
  const rejected = delivery('navigation-failure');
  f.queue.request(rejected);
  f.queue.acknowledge({ ...rejected, opened: false, error: 'navigation failed' });
  assert.equal(f.queue.pendingCount, 0);
  f.queue.setReady(true);
  assert.equal(f.queue.request(rejected), false);
  assert.deepEqual(f.receipts.map(({ opened, error }) => [opened, error]), [[false, 'renderer closed'], [false, 'navigation failed']]);
});

test('daemon cancellation removes queued and in-flight work without a false receipt or later navigation', (t) => {
  const f = fixture(t);
  f.queue.setTarget(f.target);
  f.queue.setReady(true);
  const request = delivery('cancelled');
  f.queue.request(request);
  f.queue.request({ ...request, cancelled: true });
  f.opened(request);
  f.queue.setReady(true);
  assert.equal(f.queue.request(request), false);
  assert.equal(f.queue.pendingCount, 0);
  assert.deepEqual(f.receipts, []);
  assert.equal(f.sent.at(-1).cancelled, true);
});

test('cancellation received before original delivery prevents that delivery from navigating later', (t) => {
  const f = fixture(t);
  const request = delivery('cancelled-before-delivery');
  assert.equal(f.queue.request({ ...request, cancelled: true }), false);
  f.queue.setTarget(f.target);
  f.queue.setReady(true);
  assert.equal(f.queue.request(request), false);
  assert.equal(f.queue.pendingCount, 0);
  assert.deepEqual(f.sent, []);
  assert.deepEqual(f.receipts, []);
});
