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
  const source = require('../package.json');
  const desktop = require('../apps/desktop/package.json');
  assert.equal(config.appId, 'io.namidainfo.mixdog.personal');
  assert.equal(config.extraMetadata.name, 'mixdog-personal');
  assert.equal(desktop.version, source.version);
  assert.match(config.extraMetadata.version,
    new RegExp(`^${source.version.replaceAll('.', '\\.')}-personal\\.[1-9]\\d*$`));
  assert.equal(config.publish, null);
  assert.equal(config.productName, 'Mixdog Personal');
  assert.deepEqual(config.protocols, [{ name: 'Mixdog Personal', schemes: ['mixdog-personal'] }]);
  assert.equal(config.artifactName.replace('${version}', config.extraMetadata.version)
    .replace('${os}', 'win').replace('${arch}', 'x64').replace('${ext}', 'exe'),
  `mixdog-personal-${config.extraMetadata.version}-win-x64.exe`);
});
