import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import test from 'node:test';
import { personalRepositorySettings } from './personal-repository.mjs';

test('personal clone guard refuses an original-repository push target', () => {
  assert.throws(() => personalRepositorySettings('https://github.com/tribgames/mixdog.git',
    'https://github.com/tribgames/mixdog.git'), /personal Fork/);
  assert.throws(() => personalRepositorySettings('https://github.com/namidainfo/mixdog.git',
    'https://github.com/other/mixdog.git'), /personal Fork/);
  assert.deepEqual(personalRepositorySettings('https://github.com/namidainfo/mixdog.git',
    'https://github.com/tribgames/mixdog.git'), [
    ['remote.upstream.pushurl', 'DISABLED'], ['remote.pushDefault', 'origin'], ['branch.personal.pushRemote', 'origin'],
  ]);
});

test('personal installer has separate identity, version, artifact and no publisher', () => {
  const require = createRequire(import.meta.url);
  const config = require('../apps/desktop/electron-builder.personal.cjs');
  assert.equal(config.appId, 'io.namidainfo.mixdog.personal');
  assert.equal(config.extraMetadata.name, 'mixdog-personal');
  assert.equal(config.extraMetadata.version, '1.0.11-personal.1');
  assert.equal(config.publish, null);
  assert.equal(config.productName, 'Mixdog Personal');
  assert.deepEqual(config.protocols, [{ name: 'Mixdog Personal', schemes: ['mixdog-personal'] }]);
  assert.equal(config.artifactName.replace('${version}', config.extraMetadata.version)
    .replace('${os}', 'win').replace('${arch}', 'x64').replace('${ext}', 'exe'),
  'mixdog-personal-1.0.11-personal.1-win-x64.exe');
});
