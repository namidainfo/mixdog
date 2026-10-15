import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { pathToFileURL } from 'node:url';
import { extractFile, statFile } from '@electron/asar';
import { optionValue } from './cli-args.mjs';

export function assertPersonalRuntimeVersions({ runtimeArchive, sourceVersion, desktopVersion, personalVersion }) {
  const runtimeVersion = JSON.parse(extractFile(runtimeArchive, join('node_modules', 'mixdog', 'package.json')).toString('utf8')).version;
  const base = /^(\d+\.\d+\.\d+)-personal\.\d+$/.exec(personalVersion)?.[1];
  if (!base || [sourceVersion, desktopVersion, runtimeVersion].some(version => version !== base)) {
    throw new Error(`Personal build version mismatch: source=${sourceVersion}, desktop=${desktopVersion}, runtime=${runtimeVersion}, app=${personalVersion}. Prepare the runtime from this same source before packaging.`);
  }
}

export async function preparePersonalBloomRuntime({ runtimeArchive, destination }) {
  // Read the contract from the archive being shipped, never from another checkout's API version.
  const archived = JSON.parse(extractFile(runtimeArchive, join('node_modules', 'mixdog', 'src', 'standalone', 'bloom-contract.json')).toString('utf8'));
  const { schemaVersion, protocol, revision, profile, bridgeScript, nodeExecutable, runAsNode } = archived;
  if (schemaVersion !== 1 || protocol !== 1 || !Number.isSafeInteger(revision) || revision < 8
      || profile !== 'personal' || runAsNode !== true || typeof bridgeScript !== 'string'
      || typeof nodeExecutable !== 'string' || !nodeExecutable
      || !bridgeScript || isAbsolute(bridgeScript) || bridgeScript.includes(':')) {
    throw new Error('Unsupported archived Bloom public runtime contract.');
  }
  const packageRoot = resolve('runtime.asar.unpacked', 'node_modules', 'mixdog');
  const deployedScript = resolve(packageRoot, bridgeScript);
  if (!deployedScript.startsWith(`${packageRoot}${sep}`)) throw new Error('The Bloom entry point must stay inside its runtime package.');
  statFile(runtimeArchive, join('node_modules', 'mixdog', bridgeScript));
  const archivedScript = resolve('runtime.asar', 'node_modules', 'mixdog', bridgeScript);
  const target = relative(dirname(deployedScript), archivedScript).replaceAll('\\', '/');
  const entryPoint = `import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const bridge = resolve(import.meta.dirname, ${JSON.stringify(target)});
process.argv[1] = bridge;
await import(pathToFileURL(bridge).href);
`;
  // Keep the seven-field public shape readable by existing Bloom releases.
  const descriptor = `${JSON.stringify({ schemaVersion, protocol, revision, profile, bridgeScript, nodeExecutable, runAsNode }, null, 2)}\n`;
  const destinations = new Set([resolve(destination), resolve(`${runtimeArchive}.unpacked`, 'node_modules', 'mixdog')]);
  for (const root of destinations) {
    const script = join(root, bridgeScript);
    await mkdir(dirname(script), { recursive: true });
    await writeFile(script, entryPoint);
    await writeFile(join(root, 'bloom-runtime.json'), descriptor);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const runtimeArchive = resolve(optionValue('runtime-archive'));
  const destination = resolve(optionValue('destination'));
  await preparePersonalBloomRuntime({ runtimeArchive, destination });
  console.log(JSON.stringify({ runtimeArchive, destination }));
}
