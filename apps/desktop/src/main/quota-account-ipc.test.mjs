import assert from 'node:assert/strict';
import test from 'node:test';
import { requiredDesktopCapabilityRequest, requiredDesktopCapabilityReadRequests } from './ipc-validation.ts';

test('the bulk quota request is an explicit zero-argument mutation, never a batched read', () => {
  const capability = 'requestConnectedAccountQuotaWindows';
  assert.deepEqual(requiredDesktopCapabilityRequest({ capability }), { capability, args: [] });
  for (const args of [['account'], [{ provider: 'openai-oauth', accountId: 'a' }], [{ content: 'User session text' }]]) {
    assert.throws(() => requiredDesktopCapabilityRequest({ capability, args }), /invalid number of arguments/);
  }
  assert.throws(() => requiredDesktopCapabilityReadRequests([{ capability }]), /not read-only/);
});
