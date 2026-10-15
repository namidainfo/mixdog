// Always allocate a new output directory: never clear an older/live package.
import { mkdtemp, readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build, Platform, Arch } from 'electron-builder';
import { assertPersonalRuntimeVersions, preparePersonalBloomRuntime } from './bloom-runtime.mjs';
import personalConfig from '../electron-builder.personal.cjs';

const desktop = dirname(dirname(fileURLToPath(import.meta.url)));
const electronPackage = createRequire(import.meta.url).resolve('electron/package.json');
const electronManifest = JSON.parse(await readFile(electronPackage, 'utf8'));
const electronDist = join(dirname(electronPackage), 'dist');
// Reuse npm's installed distribution instead of extracting it again on Windows.
const distributionVersion = (await readFile(join(electronDist, 'version'), 'utf8')).trim();
if (distributionVersion !== electronManifest.version) {
  throw new Error(`Installed Electron version mismatch: ${distributionVersion} != ${electronManifest.version}`);
}
const runtimeArchive = join(desktop, '.runtime', 'runtime.asar');
const [sourceManifest, desktopManifest] = await Promise.all([
  readFile(join(desktop, '..', '..', 'package.json'), 'utf8').then(JSON.parse),
  readFile(join(desktop, 'package.json'), 'utf8').then(JSON.parse),
]);
assertPersonalRuntimeVersions({
  runtimeArchive, sourceVersion: sourceManifest.version, desktopVersion: desktopManifest.version,
  personalVersion: personalConfig.extraMetadata.version,
});
await preparePersonalBloomRuntime({
  runtimeArchive,
  destination: join(desktop, '.runtime', 'native-modules', 'mixdog'),
});
const output = await mkdtemp(join(desktop, 'dist-personal-release-'));
const artifacts = await build({
  targets: Platform.WINDOWS.createTarget('nsis', Arch.x64),
  projectDir: desktop,
  config: {
    extends: join(desktop, 'electron-builder.personal.cjs'),
    electronDist,
    electronVersion: electronManifest.version,
    directories: { output },
  },
  publish: 'never',
});
console.log(JSON.stringify({ output, artifacts }, null, 2));
