import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { recordHubStartup, startHubAtLogon } from './softon-hub-autostart.mjs';

test('startup receipts expose the latest state without losing earlier failures from the operational log', async (t) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'softon-startup-log-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const receipt = path.join(directory, 'startup.json');
  const entries = [
    { status: 'starting', at: '2026-10-19T00:00:00.000Z', origin: 'https://192.168.19.118:8797' },
    { status: 'failed', at: '2026-10-19T00:02:00.000Z', error: 'service failed' },
    { status: 'ready', at: '2026-10-19T00:03:00.000Z', origin: 'https://192.168.19.118:8797' },
  ];
  for (const entry of entries) await recordHubStartup(receipt, entry);
  assert.deepEqual(JSON.parse(await fs.readFile(receipt, 'utf8')), entries[2]);
  const history = (await fs.readFile(path.join(directory, 'startup.jsonl'), 'utf8')).trim().split('\n').map(JSON.parse);
  assert.deepEqual(history, entries);
});

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
