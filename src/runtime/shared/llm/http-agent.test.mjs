import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createServer } from 'node:http';
import { createServer as createHttpsServer } from 'node:https';
import { once } from 'node:events';
import test from 'node:test';
import { Agent, Dispatcher1Wrapper, ProxyAgent, fetch as undiciFetch, getGlobalDispatcher, setGlobalDispatcher } from 'undici';
import { getLlmDispatcher, recycleLlmDispatcher } from './http-agent.mjs';
import { certificate, privateKey } from './http-agent-tls-fixture.mjs';

function withoutProxyEnv(t) {
  const proxyKeys = [
    'HTTP_PROXY',
    'HTTPS_PROXY',
    'ALL_PROXY',
    'http_proxy',
    'https_proxy',
    'all_proxy',
    'NODE_USE_ENV_PROXY',
  ];
  const saved = proxyKeys.map((key) => [key, process.env[key]]);
  for (const key of proxyKeys) delete process.env[key];
  t.after(() => {
    for (const [key, value] of saved) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });
}

function withOwnedPool(t, assertions) {
  withoutProxyEnv(t);
  // Static undici imports in this file already installed a foreign default.
  // Only a genuinely uninitialized process may create the app's own pool.
  execFileSync(
    process.execPath,
    [
      '--input-type=module',
      '--eval',
      `
        import assert from 'node:assert/strict';
        const legacy = Symbol.for('undici.globalDispatcher.1');
        const current = Symbol.for('undici.globalDispatcher.2');
        assert.equal(Object.getOwnPropertyDescriptor(globalThis, legacy), undefined);
        assert.equal(Object.getOwnPropertyDescriptor(globalThis, current), undefined);
        const pool = await import(${JSON.stringify(new URL('./http-agent.mjs', import.meta.url).href)});
        assert.equal(pool.getLlmDispatcher(), undefined);
        const { Agent, getGlobalDispatcher, setGlobalDispatcher } = await import('undici');
        const initial = getGlobalDispatcher();
        const initialLegacy = globalThis[legacy];
        assert.ok(initial);
        assert.ok(initialLegacy);
        ${assertions}
      `,
    ],
    { encoding: 'utf8', timeout: 10_000 },
  );
}

test('a preexisting default v1/v2 pool is preserved and keeps connections alive', async (t) => {
  withoutProxyEnv(t);
  const previous = getGlobalDispatcher();
  const legacy = Symbol.for('undici.globalDispatcher.1');
  const previousLegacy = globalThis[legacy];
  // Node/Electron may supply their own v1 bridge rather than the SDK's class.
  assert.ok(previousLegacy);
  let connections = 0;
  const server = createServer((_req, res) => res.end('fresh'));
  server.on('connection', () => connections++);
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    assert.equal(getLlmDispatcher(), undefined);
    assert.equal(recycleLlmDispatcher(), false);
    assert.equal(getGlobalDispatcher(), previous);
    assert.equal(globalThis[legacy], previousLegacy);
    assert.equal(previous.closed, false);
    assert.equal(await (await fetch(`${base}/first`)).text(), 'fresh');
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(await (await fetch(`${base}/again`)).text(), 'fresh');
    assert.equal(connections, 1);
  } finally {
    const active = getGlobalDispatcher();
    if (active !== previous) {
      setGlobalDispatcher(previous);
      globalThis[legacy] = previousLegacy;
      await active.close();
    }
    await new Promise((resolve) => server.close(resolve));
  }
});

test('app-owned SDK recycling drains active requests and recreates closed/destroyed pools', (t) => {
  withOwnedPool(t, `
    const { createServer } = await import('node:http');
    const { once } = await import('node:events');
    let pendingResponse;
    let markPending;
    const pending = new Promise((resolve) => { markPending = resolve; });
    const server = createServer((req, res) => {
      if (req.url === '/pending') {
        pendingResponse = res;
        markPending();
      } else {
        res.end('fresh');
      }
    });
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    const base = 'http://127.0.0.1:' + server.address().port;
    try {
      assert.equal(pool.getLlmDispatcher(), undefined);
      assert.equal(getGlobalDispatcher(), initial);
      assert.equal(globalThis[legacy], initialLegacy);
      const inFlight = fetch(base + '/pending').then((response) => response.text());
      await pending;
      assert.equal(pool.recycleLlmDispatcher(), true);
      assert.notEqual(getGlobalDispatcher(), initial);
      // SDK retries fetch without calling getLlmDispatcher again.
      assert.equal(await (await fetch(base + '/next')).text(), 'fresh');
      pendingResponse.end('preserved');
      assert.equal(await inFlight, 'preserved');
      assert.equal(pool.recycleLlmDispatcher(), true);
      assert.equal(await (await fetch(base + '/again')).text(), 'fresh');

      const closed = getGlobalDispatcher();
      await closed.close();
      assert.equal(pool.getLlmDispatcher(), undefined);
      assert.notEqual(getGlobalDispatcher(), closed);
      assert.equal(await (await fetch(base + '/after-close')).text(), 'fresh');

      const destroyed = getGlobalDispatcher();
      await destroyed.destroy();
      assert.equal(pool.getLlmDispatcher(), undefined);
      assert.notEqual(getGlobalDispatcher(), destroyed);
      assert.equal(await (await fetch(base + '/after-destroy')).text(), 'fresh');
    } finally {
      pendingResponse?.end();
      await getGlobalDispatcher().destroy();
      await new Promise((resolve) => server.close(resolve));
    }
  `);
});

test('pool replacement preserves a custom global dispatcher', async (t) => {
  withoutProxyEnv(t);
  const previous = getGlobalDispatcher();
  let dispatched = 0;
  class CustomAgent extends Agent {
    dispatch(options, handler) {
      dispatched += 1;
      return super.dispatch(options, handler);
    }
  }
  const custom = new CustomAgent();
  const server = createServer((_req, res) => res.end('custom'));
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  setGlobalDispatcher(custom);
  try {
    assert.equal(getLlmDispatcher(), undefined);
    assert.equal(recycleLlmDispatcher(), false);
    assert.equal(getGlobalDispatcher(), custom);
    assert.equal(custom.closed, false);
    assert.equal(await (await fetch(`http://127.0.0.1:${server.address().port}/`)).text(), 'custom');
    assert.equal(dispatched, 1);
  } finally {
    setGlobalDispatcher(previous);
    await custom.close();
    await new Promise((resolve) => server.close(resolve));
  }
});

test('a plain external Agent with connect.ca installed before initialization is preserved', async (t) => {
  withoutProxyEnv(t);
  const previous = getGlobalDispatcher();
  const custom = new Agent({ connect: { ca: certificate } });
  const untrusted = new Agent();
  const server = createHttpsServer({ cert: certificate, key: privateKey }, (_req, res) => res.end('custom-ca'));
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const url = `https://127.0.0.1:${server.address().port}/`;
  setGlobalDispatcher(custom);
  try {
    const pool = await import('./http-agent.mjs?custom-ca');
    assert.equal(pool.getLlmDispatcher(), undefined);
    assert.equal(getGlobalDispatcher(), custom);
    assert.equal(pool.recycleLlmDispatcher(), false);
    assert.equal(getGlobalDispatcher(), custom);
    assert.equal(custom.closed, false);
    assert.equal(custom.destroyed, false);
    // The fixture is self-signed: a bare Agent must reject it, while global
    // fetch must succeed using the external CA without disabling verification.
    await assert.rejects(
      undiciFetch(url, { dispatcher: untrusted }),
      (error) => error.cause?.code === 'DEPTH_ZERO_SELF_SIGNED_CERT',
    );
    assert.equal(await (await fetch(url)).text(), 'custom-ca');
  } finally {
    const current = getGlobalDispatcher();
    setGlobalDispatcher(previous);
    if (current !== custom) await current.close();
    await custom.close();
    await untrusted.close();
    await new Promise((resolve) => server.close(resolve));
  }
});

test('an external proxy named Agent is preserved before initialization', async (t) => {
  withoutProxyEnv(t);
  const previous = getGlobalDispatcher();
  const proxy = new (class Agent extends ProxyAgent {})('http://127.0.0.1:1');
  setGlobalDispatcher(proxy);
  try {
    const pool = await import('./http-agent.mjs?proxy');
    assert.equal(pool.getLlmDispatcher(), undefined);
    assert.equal(pool.recycleLlmDispatcher(), false);
    assert.equal(getGlobalDispatcher(), proxy);
    assert.equal(proxy.closed, false);
    assert.equal(proxy.destroyed, false);
  } finally {
    const current = getGlobalDispatcher();
    setGlobalDispatcher(previous);
    if (current !== proxy) await current.close();
    await proxy.close();
  }
});

test('a later external Agent is preserved and only an exact owned-pair restoration may recycle', (t) => {
  withOwnedPool(t, `
    const external = new Agent();
    try {
      setGlobalDispatcher(external);
      const externalLegacy = globalThis[legacy];
      assert.equal(pool.getLlmDispatcher(), undefined);
      assert.equal(pool.recycleLlmDispatcher(), false);
      assert.equal(getGlobalDispatcher(), external);
      assert.equal(globalThis[legacy], externalLegacy);
      assert.equal(external.closed, false);
      assert.equal(external.destroyed, false);
      assert.equal(initial.closed, false);

      // A setter called externally creates an unrecorded bridge, even to our Agent.
      setGlobalDispatcher(initial);
      const unrecordedLegacy = globalThis[legacy];
      assert.notEqual(unrecordedLegacy, initialLegacy);
      assert.equal(pool.getLlmDispatcher(), undefined);
      assert.equal(pool.recycleLlmDispatcher(), false);
      assert.equal(globalThis[current], initial);
      assert.equal(globalThis[legacy], unrecordedLegacy);
      assert.equal(initial.closed, false);

      globalThis[legacy] = initialLegacy;
      assert.equal(pool.getLlmDispatcher(), undefined);
      assert.equal(globalThis[current], initial);
      assert.equal(globalThis[legacy], initialLegacy);
      assert.equal(pool.recycleLlmDispatcher(), true);
      assert.notEqual(getGlobalDispatcher(), initial);
      assert.equal(initial.closed, true);
      assert.equal(external.closed, false);
    } finally {
      await getGlobalDispatcher().destroy();
      await initial.destroy();
      await external.destroy();
    }
  `);
});

for (const wrapped of [false, true]) {
  test(`a pre-first-use mismatched pair preserves a foreign ${wrapped ? 'native bridge target' : 'plain dispatcher'}`, async (t) => {
    withoutProxyEnv(t);
    const legacy = Symbol.for('undici.globalDispatcher.1');
    const current = Symbol.for('undici.globalDispatcher.2');
    const previous = getGlobalDispatcher();
    const previousLegacy = globalThis[legacy];
    const originalDispatch = Object.getOwnPropertyDescriptor(previous, 'dispatch');
    const foreign = new Agent({ connect: { ca: certificate } });
    const dispatch = t.mock.method(foreign, 'dispatch');
    const close = t.mock.method(foreign, 'close');
    const destroy = t.mock.method(foreign, 'destroy');
    const foreignLegacy = wrapped ? new Dispatcher1Wrapper(foreign) : foreign;
    globalThis[legacy] = foreignLegacy;
    try {
      const pool = await import(`./http-agent.mjs?pre-use-mismatch-${wrapped}`);
      assert.equal(pool.getLlmDispatcher(), undefined);
      assert.equal(globalThis[legacy], foreignLegacy);
      assert.equal(globalThis[current], previous);
      assert.equal(pool.recycleLlmDispatcher(), false);
      assert.equal(globalThis[legacy], foreignLegacy);
      assert.equal(globalThis[current], previous);
      assert.deepEqual(Object.getOwnPropertyDescriptor(previous, 'dispatch'), originalDispatch);
      assert.equal(previous.closed, false);
      assert.equal(foreign.closed, false);
      assert.equal(foreign.destroyed, false);
      assert.equal(dispatch.mock.callCount(), 0);
      assert.equal(close.mock.callCount(), 0);
      assert.equal(destroy.mock.callCount(), 0);
    } finally {
      const active = getGlobalDispatcher();
      setGlobalDispatcher(previous);
      globalThis[legacy] = previousLegacy;
      if (active !== previous && active !== foreign) await active.close();
      await foreign.close();
    }
  });
}

test('a wrong-target foreign getter cannot run or seal the candidate dispatcher', async (t) => {
  withoutProxyEnv(t);
  const legacy = Symbol.for('undici.globalDispatcher.1');
  const current = Symbol.for('undici.globalDispatcher.2');
  const previous = getGlobalDispatcher();
  const previousLegacy = globalThis[legacy];
  const candidate = new Agent();
  setGlobalDispatcher(candidate);
  let getterCalls = 0;
  let closeCalls = 0;
  let destroyCalls = 0;
  const foreign = {
    dispatch() {
      throw new Error('must not dispatch');
    },
    close() {
      closeCalls++;
    },
    destroy() {
      destroyCalls++;
    },
  };
  const foreignBridge = new Dispatcher1Wrapper(foreign);
  // Install the accessor only AFTER the bridge constructor validated dispatch.
  Object.defineProperty(foreign, 'dispatch', {
    configurable: true,
    get() {
      getterCalls++;
      Object.seal(candidate);
      return () => { throw new Error('must not dispatch'); };
    },
  });
  globalThis[legacy] = foreignBridge;
  const descriptors = Object.getOwnPropertyDescriptors(candidate);
  const currentSlot = Object.getOwnPropertyDescriptor(globalThis, current);
  const legacySlot = Object.getOwnPropertyDescriptor(globalThis, legacy);
  try {
    const pool = await import('./http-agent.mjs?getter-seal');
    assert.equal(pool.getLlmDispatcher(), undefined);
    assert.equal(pool.recycleLlmDispatcher(), false);
    assert.equal(getterCalls, 0);
    assert.equal(closeCalls, 0);
    assert.equal(destroyCalls, 0);
    assert.equal(Object.isExtensible(candidate), true);
    assert.deepEqual(Object.getOwnPropertyDescriptors(candidate), descriptors);
    assert.deepEqual(Object.getOwnPropertyDescriptor(globalThis, current), currentSlot);
    assert.deepEqual(Object.getOwnPropertyDescriptor(globalThis, legacy), legacySlot);
  } finally {
    setGlobalDispatcher(previous);
    globalThis[legacy] = previousLegacy;
    await candidate.close();
  }
});

test('a later v1-only foreign replacement preserves both identities and is never closed', (t) => {
  withOwnedPool(t, `
    let closeCalls = 0;
    let destroyCalls = 0;
    const foreign = {
      dispatch() { throw new Error('get/recycle must not dispatch'); },
      close() { closeCalls++; },
      destroy() { destroyCalls++; },
    };
    try {
      globalThis[legacy] = foreign;
      assert.equal(pool.getLlmDispatcher(), undefined);
      assert.equal(globalThis[legacy], foreign);
      assert.equal(globalThis[current], initial);
      assert.equal(pool.recycleLlmDispatcher(), false);
      assert.equal(globalThis[legacy], foreign);
      assert.equal(globalThis[current], initial);
      assert.equal(initial.closed, false);
      assert.equal(initial.destroyed, false);
      assert.equal(closeCalls, 0);
      assert.equal(destroyCalls, 0);

      // Restore the EXACT bridge captured after the app's own setter call.
      globalThis[legacy] = initialLegacy;
      assert.equal(pool.getLlmDispatcher(), undefined);
      assert.equal(globalThis[current], initial);
      assert.equal(globalThis[legacy], initialLegacy);
      assert.equal(pool.recycleLlmDispatcher(), true);
      assert.notEqual(globalThis[current], initial);
      assert.equal(initial.closed, true);
      assert.equal(closeCalls, 0);
      assert.equal(destroyCalls, 0);
    } finally {
      await getGlobalDispatcher().destroy();
      await initial.destroy();
    }
  `);
});

test('an older-global foreign dispatcher survives first use without loading undici 8 over it', (t) => {
  withoutProxyEnv(t);
  // A fresh process is necessary: this file's undici import has already
  // initialized v2. Install only the v1 dispatcher used by Node / undici 6–7.
  execFileSync(
    process.execPath,
    [
      '--input-type=module',
      '--eval',
      `
        import assert from 'node:assert/strict';
        const legacy = Symbol.for('undici.globalDispatcher.1');
        const current = Symbol.for('undici.globalDispatcher.2');
        let dispatched = 0;
        let closed = 0;
        let destroyed = 0;
        const foreign = {
          dispatch(_options, handler) {
            dispatched++;
            handler.onConnect(() => {});
            handler.onHeaders(200, ['content-type', 'text/plain'], () => {}, 'OK');
            handler.onData(Buffer.from('older-global'));
            handler.onComplete([]);
            return true;
          },
          close() { closed++; },
          destroy() { destroyed++; },
        };
        Object.defineProperty(globalThis, legacy, { value: foreign, writable: true });
        assert.equal(globalThis[current], undefined);
        const pool = await import(${JSON.stringify(new URL('./http-agent.mjs', import.meta.url).href)});
        assert.equal(pool.getLlmDispatcher(), undefined);
        assert.equal(globalThis[legacy], foreign);
        assert.equal(globalThis[current], undefined);
        assert.equal(pool.recycleLlmDispatcher(), false);
        assert.equal(globalThis[legacy], foreign);
        // The foreign dispatcher completes the response without any network.
        assert.equal(await (await fetch('http://older-global.invalid/')).text(), 'older-global');
        assert.equal(dispatched, 1);
        assert.deepEqual([closed, destroyed], [0, 0]);
        assert.equal(globalThis[legacy], foreign);
      `,
    ],
    { encoding: 'utf8', timeout: 10_000 },
  );
});
