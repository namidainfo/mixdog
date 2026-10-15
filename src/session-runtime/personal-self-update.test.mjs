import assert from 'node:assert/strict';
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { checkLatestVersion, localPackageVersion } from '../runtime/shared/update-checker.mjs';
import { performPendingSwap, runStagedInstall, spawnStagedInstall } from '../runtime/shared/staged-update.mjs';
import { createSelfUpdateController } from './self-update.mjs';
import { createSystemSettings } from './settings-system-api.mjs';

function personalProfile(t) {
  const directory = mkdtempSync(join(tmpdir(), 'mixdog-personal-update-test-'));
  const environment = {
    MIXDOG_PERSONAL: '1',
    MIXDOG_PERSONAL_VERSION: '1.2.0-personal.1',
    MIXDOG_DATA_DIR: directory,
  };
  const previous = Object.fromEntries(Object.keys(environment).map((key) => [key, process.env[key]]));
  Object.assign(process.env, environment);
  t.after(() => {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    rmSync(directory, { recursive: true, force: true });
  });
  t.mock.method(globalThis, 'fetch', () => {
    assert.fail('a personal build must not query the official registry');
  });
  return directory;
}

test('personal builds ignore cached official releases without network or cache writes', async (t) => {
  const directory = personalProfile(t);
  const cache = join(directory, 'update-check-cache.json');
  const cached = JSON.stringify({ latestVersion: '999.0.0', lastCheckedAt: Date.now() });
  writeFileSync(cache, cached);
  for (const force of [false, true]) {
    assert.deepEqual(await checkLatestVersion({ force, dataDir: directory }), {
      currentVersion: '1.2.0-personal.1',
      latestVersion: null,
      updateAvailable: false,
      lastCheckedAt: 0,
    });
  }
  assert.equal(readFileSync(cache, 'utf8'), cached);
  assert.deepEqual(readdirSync(directory), ['update-check-cache.json']);
});

test('personal builds refuse staging and pending swaps before touching the profile', async (t) => {
  const directory = personalProfile(t);
  assert.equal(spawnStagedInstall('999.0.0'), false);
  assert.equal(performPendingSwap(), false);
  const result = await runStagedInstall('999.0.0');
  assert.equal(result.ok, false);
  assert.match(result.error, /disabled in Mixdog Personal/);
  assert.deepEqual(readdirSync(directory), []);
});

test('personal runtime cannot enable, schedule or manually run official updates', async (t) => {
  const directory = personalProfile(t);
  let config = { update: { auto: true } };
  const controller = createSelfUpdateController({
    getConfig: () => config,
    getDataDir: () => directory,
    emitNotification: () => assert.fail('a personal build must not announce an official update'),
  });
  assert.equal(controller.autoUpdateEnabled(), false);
  assert.equal(controller.startBootCheck(), null);
  await controller.checkForUpdate({ force: true });
  const settings = createSystemSettings({
    getConfig: () => config,
    saveConfigAndAdopt: (next) => { config = next; },
    localPackageVersion,
    autoUpdateEnabled: controller.autoUpdateEnabled,
    getUpdateCheckState: () => ({ currentVersion: '1.2.0', latestVersion: '999.0.0', updateAvailable: true, lastCheckedAt: 123 }),
    getUpdateProcessState: controller.getProcessState,
    checkForUpdateInternal: controller.checkForUpdate,
    runUpdateNowInternal: controller.runUpdateNow,
  });
  const expected = {
    autoUpdate: false,
    currentVersion: '1.2.0-personal.1',
    latestVersion: null,
    updateAvailable: false,
    lastCheckedAt: 0,
    manualOnly: true,
  };
  assert.deepEqual(settings.getUpdateSettings(), expected);
  assert.deepEqual(settings.setAutoUpdate(true), expected);
  assert.equal(config.update.auto, false);
  assert.deepEqual(await settings.checkForUpdate({ force: true }), expected);
  const result = await settings.runUpdateNow();
  assert.equal(result.ok, false);
  assert.equal(result.phase, 'failed');
  assert.match(result.error, /disabled in Mixdog Personal/);
  assert.deepEqual(readdirSync(directory), []);
});
