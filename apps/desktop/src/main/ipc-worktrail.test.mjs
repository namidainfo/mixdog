import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { DESKTOP_IPC } from '../shared/contract.ts';
import { personalWorktrailEnabled, registerWorktrailIpc } from './ipc-worktrail.ts';

test('Worktrail is enabled only for the personal local connection', t => {
  const original = process.env.MIXDOG_PERSONAL;
  t.after(() => {
    if (original === undefined) delete process.env.MIXDOG_PERSONAL;
    else process.env.MIXDOG_PERSONAL = original;
  });
  process.env.MIXDOG_PERSONAL = '1';
  assert.equal(personalWorktrailEnabled('local'), true);
  assert.equal(personalWorktrailEnabled('ssh'), false);
  process.env.MIXDOG_PERSONAL = '0';
  assert.equal(personalWorktrailEnabled('local'), false);
  assert.equal(personalWorktrailEnabled('ssh'), false);
});

test('a disabled Worktrail IPC cannot open storage or dispatch a request', () => {
  let handler;
  registerWorktrailIpc((channel, listener) => {
    assert.equal(channel, DESKTOP_IPC.worktrailRequest);
    handler = listener;
  }, () => assert.fail('disabled hosts must not read local drafts'), false);
  assert.throws(() => handler({}, 'documents', {}), /Personal/);
});

test('personal Worktrail IPC reads local drafts and rejects arbitrary actions without network access', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'mixdog-worktrail-ipc-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  let handler;
  registerWorktrailIpc((_channel, listener) => { handler = listener; }, () => directory, true);
  assert.deepEqual(await handler({}, 'documents', {}), []);
  await assert.rejects(handler({}, 'constructor', {}), /작업을 확인/);
});
