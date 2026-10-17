import assert from 'node:assert/strict';
import test from 'node:test';
import childProcess from 'node:child_process';
import { syncBuiltinESMExports } from 'node:module';
import { EventEmitter } from 'node:events';
import { PassThrough, Writable } from 'node:stream';
import { SlackWorkerTransport } from '../transport.mjs';

test('worker connections restore the Windows hub, relay callbacks, reject unknown capabilities and close with the bridge', async (t) => {
  const children = [], requests = [], callbacks = [];
  t.mock.method(childProcess, 'spawn', () => {
    const child = new EventEmitter();
    child.stdout = new PassThrough(); child.stderr = new PassThrough();
    child.stdin = new Writable({ write(chunk, _encoding, done) {
      const frame = JSON.parse(chunk.toString()); requests.push(frame);
      if (frame.method !== 'hubReply') child.stdout.write(JSON.stringify({
        id: frame.id, ok: true, result: frame.method === 'health' ? { ready: true } : { origin: 'https://192.168.19.10:8797' },
      }) + '\n');
      done();
    } });
    child.stdin.on('finish', () => child.emit('exit', 0));
    child.kill = () => child.emit('exit', 1);
    children.push(child); return child;
  });
  syncBuiltinESMExports();
  t.after(() => { t.mock.restoreAll(); syncBuiltinESMExports(); });
  const hubOptions = { origin: 'https://192.168.19.10:8797', adminUsers: ['T1:UA'] };
  const transport = new SlackWorkerTransport({
    node: 'node', worker: 'worker.mjs', runtimeRoot: 'runtime', hubOptions,
    hubRequest: async (method, params) => { callbacks.push({ method, params }); return false; },
  });
  t.after(() => transport.close());
  await transport.start();
  assert.deepEqual(requests.map((frame) => frame.method), ['health', 'startHub']);
  assert.deepEqual(requests[1].params, hubOptions);
  children[0].stdout.write(JSON.stringify({ event: 'hub', id: 'callback-1', method: 'authorize', params: { user: 'U1' } }) + '\n');
  children[0].stdout.write(JSON.stringify({ event: 'hub', id: 'callback-2', method: 'readFile', params: {} }) + '\n');
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(callbacks, [{ method: 'authorize', params: { user: 'U1' } }]);
  assert.deepEqual(requests.find((frame) => frame.id === 'callback-1').params, { ok: true, result: false });
  assert.deepEqual(requests.find((frame) => frame.id === 'callback-2').params, { ok: false });
  children[0].emit('exit', 1);
  await transport.start();
  assert.equal(children.length, 2);
  assert.equal(requests.filter((frame) => frame.method === 'startHub').length, 2);
  await transport.close();
  assert.equal(transport.child, null);
});

test('a daemon-not-ready logon discards its partial worker so the next connection can start the hub', async (t) => {
  const children = [], methods = [];
  t.mock.method(childProcess, 'spawn', () => {
    const number = children.length, child = new EventEmitter();
    child.stdout = new PassThrough(); child.stderr = new PassThrough();
    child.stdin = new Writable({ write(chunk, _encoding, done) {
      const frame = JSON.parse(chunk.toString()); methods.push(frame.method);
      child.stdout.write(JSON.stringify({ id: frame.id, ok: number !== 0,
        error: number === 0 ? 'daemon not ready' : undefined, result: { ready: true } }) + '\n');
      done();
    } });
    child.stdin.on('finish', () => child.emit('exit', 0));
    child.kill = () => child.emit('exit', 1);
    children.push(child); return child;
  });
  syncBuiltinESMExports();
  t.after(() => { t.mock.restoreAll(); syncBuiltinESMExports(); });
  const transport = new SlackWorkerTransport({ node: 'node', worker: 'worker', runtimeRoot: 'runtime',
    hubOptions: { origin: 'https://192.168.19.118:8797' } });
  t.after(() => transport.close());
  await assert.rejects(transport.start(), /daemon not ready/u);
  assert.equal(transport.child, null);
  assert.equal(children[0].stdin.writableEnded, true);
  await transport.start();
  assert.equal(children.length, 2);
  assert.deepEqual(methods, ['health', 'health', 'startHub']);
});
