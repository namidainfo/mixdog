import test from 'node:test';
import assert from 'node:assert/strict';
import { startHubAtLogon } from './softon-hub-autostart.mjs';

test('a cold logon launches the background host once, waits for its daemon, then starts and verifies the hub', async () => {
  const events = []; let time = 0, probes = 0, hub = 0;
  const result = await startHubAtLogon({
    probeDaemon: async () => ++probes >= 3,
    launchApp: async () => events.push('launch'),
    startBridge: async () => events.push('bridge'),
    probeHub: async () => ++hub >= 2,
    record: async (status) => events.push(status),
    now: () => time, sleep: async (ms) => { time += ms; },
  });
  assert.deepEqual(result, { ready: true });
  assert.deepEqual(events, ['starting', 'launch', 'daemon-ready', 'bridge', 'ready']);
  assert.equal(probes, 3); assert.equal(hub, 2);
});

test('an already running host is reused without bringing a window forward', async () => {
  let launches = 0, bridges = 0;
  await startHubAtLogon({ probeDaemon: async () => true, launchApp: async () => launches++,
    startBridge: async () => bridges++, probeHub: async () => true, record: async () => {} });
  assert.equal(launches, 0); assert.equal(bridges, 1);
});

test('startup failure is bounded and cannot be reported as ready or replay a launch', async () => {
  let time = 0, launches = 0, bridges = 0;
  const states = [];
  await assert.rejects(startHubAtLogon({
    probeDaemon: async () => false, launchApp: async () => launches++,
    startBridge: async () => bridges++, probeHub: async () => false,
    record: async (status) => states.push(status),
    now: () => time, sleep: async (ms) => { time += ms; }, timeoutMs: 1000,
  }), /준비/u);
  assert.equal(launches, 1); assert.equal(bridges, 0);
  assert.equal(states.includes('ready'), false);
});

test('a bridge or certificate error propagates without claiming successful startup', async () => {
  for (const failAt of ['bridge', 'https']) {
    const states = [];
    await assert.rejects(startHubAtLogon({
      probeDaemon: async () => true, launchApp: async () => {},
      startBridge: async () => { if (failAt === 'bridge') throw new Error('service failed'); },
      probeHub: async () => { throw new Error('certificate failed'); },
      record: async (status) => states.push(status),
    }), /failed/u);
    assert.equal(states.includes('ready'), false);
  }
});
