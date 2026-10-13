import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { statFile } from '@electron/asar';
import { SESSION_PROTOCOL, SESSION_REVISION } from '../../../src/standalone/session-wire.mjs';
import { optionValue } from './cli-args.mjs';

// Keep the public entry point on disk for Bloom's ordinary filesystem checks.
// Electron loads the real bridge and its dependency graph from the same install's archive.
const entryPoint = `import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const bridge = resolve(import.meta.dirname, '../../../../../runtime.asar/node_modules/mixdog/src/standalone/bloom-bridge.mjs');
process.argv[1] = bridge;
await import(pathToFileURL(bridge).href);
`;

export async function preparePersonalBloomRuntime({ runtimeArchive, destination }) {
  statFile(runtimeArchive, join('node_modules', 'mixdog', 'src', 'standalone', 'bloom-bridge.mjs'));
  const script = join(destination, 'src', 'standalone', 'bloom-bridge.mjs');
  await mkdir(dirname(script), { recursive: true });
  await writeFile(script, entryPoint);
  await writeFile(join(destination, 'bloom-runtime.json'), `${JSON.stringify({
    schemaVersion: 1,
    protocol: SESSION_PROTOCOL,
    revision: SESSION_REVISION,
    profile: 'personal',
    bridgeScript: 'src/standalone/bloom-bridge.mjs',
    nodeExecutable: '../../../../Mixdog Personal.exe',
    runAsNode: true,
  }, null, 2)}\n`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const runtimeArchive = resolve(optionValue('runtime-archive'));
  const destination = resolve(optionValue('destination'));
  await preparePersonalBloomRuntime({ runtimeArchive, destination });
  console.log(JSON.stringify({ runtimeArchive, destination }));
}
