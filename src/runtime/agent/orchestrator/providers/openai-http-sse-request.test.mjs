import assert from 'node:assert/strict';
import { test } from 'node:test';
import zlib from 'node:zlib';

import { openHttpSseResponse } from './openai-http-sse-request.mjs';

test('a zstd 400 on the last attempt still replays uncompressed and surfaces a real response', {
  skip: typeof zlib.zstdCompressSync !== 'function',
}, async () => {
  const seen = [];
  const fetchFn = async (_url, init) => {
    const compressed = init.headers['Content-Encoding'] === 'zstd';
    seen.push(compressed);
    if (compressed && seen.length <= 4) return new Response('boom', { status: 503 });
    if (compressed) return new Response('bad encoding', { status: 400 });
    return new Response('data: {}\n\n', { status: 200 });
  };
  const response = await openHttpSseResponse({
    auth: { type: 'openai-oauth' },
    body: { input: 'x'.repeat(16 * 1024) },
    headers: {},
    poolKey: 'zstd-last-attempt',
    turnId: 'turn',
    useModel: 'test-model',
    fetchFn,
    totalTimeout: new (class {
      signal = new AbortController().signal;
      cleanup() {}
    })(),
    _sleepFn: async () => {},
  });
  assert.equal(response.status, 200);
  assert.deepEqual(seen, [true, true, true, true, true, false]);
});

for (const [label, wrap] of [
  ['direct', (cause) => cause],
  ['fetch', (cause) => new TypeError('fetch failed', { cause })],
  ['SDK', (cause) => Object.assign(new Error('connection error', { cause }), { name: 'APIConnectionError' })],
]) {
  for (const resetFirst of [false, true]) {
    test(`HTTP ${label} certificate failure stops retries${resetFirst ? ' after ECONNRESET' : ''}`, async () => {
      const certificate = Object.assign(new Error('self-signed certificate in certificate chain'), {
        code: 'SELF_SIGNED_CERT_IN_CHAIN',
      });
      const current = wrap(certificate);
      const originalCause = current.cause;
      let fetches = 0;
      let cleanups = 0;
      const sleeps = [];
      const stages = [];
      await assert.rejects(
        openHttpSseResponse({
          auth: { type: 'openai-direct' },
          body: {},
          headers: {},
          poolKey: `certificate-${label}-${resetFirst}`,
          turnId: 'turn',
          useModel: 'test-model',
          fetchFn: async () => {
            fetches += 1;
            if (resetFirst && fetches === 1) throw Object.assign(new Error('reset'), { code: 'ECONNRESET' });
            throw current;
          },
          totalTimeout: {
            signal: new AbortController().signal,
            cleanup: () => { cleanups += 1; },
          },
          onStageChange: (stage, details) => stages.push([stage, details.attempt]),
          _sleepFn: async (ms) => { sleeps.push(ms); },
        }),
        (error) => error === current
      );
      assert.equal(fetches, resetFirst ? 2 : 1);
      assert.equal(sleeps.length, resetFirst ? 1 : 0);
      assert.equal(cleanups, 1);
      assert.equal(current.cause, originalCause);
      assert.deepEqual(stages, resetFirst ? [['requesting', 1], ['requesting', 2]] : [['requesting', 1]]);
    });
  }
}

test('HTTP ordinary reset and TLS record failures still retry and recover', async () => {
  const codes = ['ECONNRESET', 'ERR_SSL_SSLV3_ALERT_BAD_RECORD_MAC'];
  let fetches = 0;
  const sleeps = [];
  const response = await openHttpSseResponse({
    auth: { type: 'openai-direct' },
    body: {},
    headers: {},
    poolKey: 'ordinary-transient-recovery',
    turnId: 'turn',
    useModel: 'test-model',
    fetchFn: async () => {
      const code = codes[fetches++];
      if (code) throw Object.assign(new Error('transport fault'), { code });
      return new Response('data: {}\n\n', { status: 200 });
    },
    totalTimeout: { signal: new AbortController().signal, cleanup() {} },
    _sleepFn: async (ms) => { sleeps.push(ms); },
  });
  assert.equal(response.status, 200);
  assert.equal(fetches, 3);
  assert.equal(sleeps.length, 2);
});
