import test from 'node:test';
import assert from 'node:assert/strict';
import tls from 'node:tls';
import { once } from 'node:events';
import { channel } from 'node:diagnostics_channel';
import { createOAuthTlsDiagnostics } from './openai-oauth-tls-diagnostics.mjs';
import { certificate, privateKey } from '../../../shared/llm/http-agent-tls-fixture.mjs';

async function localServer(t) {
  const server = tls.createServer({ cert: certificate, key: privateKey }, socket => socket.end());
  server.on('tlsClientError', () => {});
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => new Promise(resolve => server.close(resolve)));
  return server.address().port;
}

function connect(port, ca) {
  return new Promise((resolve, reject) => {
    const socket = tls.connect({ host: '127.0.0.1', port, servername: '127.0.0.1', ...(ca ? { ca } : {}) });
    socket.once('error', reject);
    socket.once('secureConnect', () => { socket.end(); resolve({ status: 200 }); });
    socket.setTimeout(3000, () => socket.destroy(Object.assign(new Error('timeout'), { code: 'ETIMEDOUT' })));
  });
}

test('captures rejected peer chain without disabling certificate verification', async t => {
  const port = await localServer(t);
  const records = [];
  const observe = createOAuthTlsDiagnostics({ host: '127.0.0.1', write: row => records.push(row) });
  await assert.rejects(observe(() => connect(port)), error => error.code === 'DEPTH_ZERO_SELF_SIGNED_CERT');
  const peer = records.find(row => row.event === 'peer-chain-before-verification');
  assert.equal(peer.chain[0].issuer.CN, 'Mixdog HTTP Agent test');
  assert.equal(peer.chain[0].inDefaultCA, false);
  assert.ok(records.some(row => row.event === 'exchange-failed' && row.codes.includes('DEPTH_ZERO_SELF_SIGNED_CERT')));
  assert.equal(records.some(row => row.event === 'tls-verified'), false);
});

test('trusted connection still succeeds and observer is removed', async t => {
  const port = await localServer(t);
  const records = [];
  const observe = createOAuthTlsDiagnostics({ host: '127.0.0.1', write: row => records.push(row) });
  assert.equal((await observe(() => connect(port, certificate))).status, 200);
  assert.ok(records.some(row => row.event === 'tls-verified' && row.authorized));
  const count = records.length;
  await connect(port, certificate);
  assert.equal(records.length, count);
});

test('never serializes error messages, request secrets, or arbitrary diagnostic payloads', async () => {
  const records = [];
  const observe = createOAuthTlsDiagnostics({ write: row => records.push(row) });
  const cause = Object.assign(new Error('SECRET_TOKEN COOKIE code=secret'), { code: 'CERT_' + 'secret'.repeat(100) });
  const failure = new TypeError('fetch failed SECRET', { cause });
  await assert.rejects(observe(async () => { throw failure; }), error => error === failure);
  assert.doesNotMatch(JSON.stringify(records), /SECRET|COOKIE|code=secret|CERT_secret/);
  assert.deepEqual(records.at(-1).codes, []);
});

test('diagnostic writer failure never changes the operation result', async () => {
  const observe = createOAuthTlsDiagnostics({ write() { throw new Error('disk error'); } });
  const response = { status: 200 };
  assert.equal(await observe(async () => response), response);
});

test('unrelated sockets outside exchange context are ignored', async () => {
  const records = [];
  const observe = createOAuthTlsDiagnostics({ write: row => records.push(row) });
  let finish;
  const pending = observe(() => new Promise(resolve => { finish = resolve; }));
  channel('net.client.socket').publish({ socket: { getPeerCertificate() { assert.fail('unrelated socket'); } } });
  finish({ status: 200 });
  await pending;
  assert.equal(records.at(-1).observedNewSockets, 0);
});
