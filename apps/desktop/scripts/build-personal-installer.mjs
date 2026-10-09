// Always allocate a new output directory: never clear an older/live package.
import { mkdtemp } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build, Platform, Arch } from 'electron-builder';

const desktop = dirname(dirname(fileURLToPath(import.meta.url)));
const output = await mkdtemp(join(desktop, 'dist-personal-release-'));
const artifacts = await build({
  targets: Platform.WINDOWS.createTarget('nsis', Arch.x64),
  projectDir: desktop,
  config: {
    extends: join(desktop, 'electron-builder.personal.cjs'),
    directories: { output },
  },
  publish: 'never',
});
console.log(JSON.stringify({ output, artifacts }, null, 2));
