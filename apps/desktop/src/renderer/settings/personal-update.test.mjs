import assert from 'node:assert/strict';
import test from 'node:test';
import React, { act } from 'react';
import { installTestDom } from '../test-support/test-dom.mjs';
import { CapabilitySettings } from './CapabilitySettings';

test('personal update settings show the installer version and never offer an official release', async (t) => {
  const { root, document } = installTestDom(t, { rootId: 'root' });
  const invoked = [];
  const api = {
    async readCapabilities(requests) {
      return requests.map(({ capability }) => ({
        ok: true,
        value: capability === 'getUpdateSettings' ? {
          manualOnly: true, currentVersion: '1.2.0-personal.1',
          autoUpdate: true, latestVersion: '999.0.0', updateAvailable: true,
        } : null,
      }));
    },
    async invokeCapability({ capability }) {
      invoked.push(capability);
      return { value: null, snapshot: null };
    },
    async listProviderModels() { return []; },
    async getSnapshot() { return null; },
    async getUpdaterState() { return { status: 'ready', version: '999.0.0' }; },
    subscribeState() { return () => {}; },
    subscribeUpdaterState() { return () => {}; },
  };
  await act(async () => root.render(React.createElement(CapabilitySettings, { api, category: 'system' })));
  assert.match(document.body.textContent, /1\.2\.0-personal\.1/);
  assert.match(document.body.textContent, /Manual installation/);
  assert.doesNotMatch(document.body.textContent, /999\.0\.0|Latest version|Check now|Update to v/);
  const row = [...document.querySelectorAll('.mixdog-settings__row')]
    .find((element) => element.querySelector('.mixdog-settings__row-title')?.textContent === 'Auto-update');
  const toggle = row?.querySelector('input[type="checkbox"][aria-label="Auto-update"]');
  assert.ok(toggle);
  assert.equal(toggle.checked, false);
  assert.equal(toggle.disabled, true);
  const beforeToggle = invoked.slice();
  await act(async () => toggle.click());
  assert.deepEqual(invoked, beforeToggle, 'a disabled switch cannot change or run updates');
});
