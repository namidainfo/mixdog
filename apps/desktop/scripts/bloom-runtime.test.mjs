import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { access, cp, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { promisify } from 'node:util';
import test from 'node:test';
import { createPackage } from '@electron/asar';
import { preparePersonalBloomRuntime } from './bloom-runtime.mjs';

const execFileAsync = promisify(execFile);

async function fixture(context, withBridge = true) {
  const root = await mkdtemp(join(tmpdir(), 'mixdog-bloom-runtime-'));
  context.after(() => rm(root, { recursive: true, force: true }));
  const input = join(root, 'input');
  await mkdir(input);
  await writeFile(join(input, 'package.json'), '{"name":"synthetic-runtime"}');
  if (withBridge) {
    const script = join(input, 'node_modules', 'mixdog', 'src', 'standalone', 'bloom-bridge.mjs');
    await mkdir(dirname(script), { recursive: true });
    await writeFile(script, "process.stdout.write(JSON.stringify({ entry: process.argv[1], ready: true }));\n");
  }
  const runtimeArchive = join(root, 'fixture.asar');
  await createPackage(input, runtimeArchive);
  const resources = join(root, 'install', 'resources');
  const destination = join(resources, 'runtime.asar.unpacked', 'node_modules', 'mixdog');
  return { root, input, runtimeArchive, resources, destination };
}

test('Personal packaging emits the public descriptor and a readable bridge entry point', async (context) => {
  const fixturePaths = await fixture(context);
  await preparePersonalBloomRuntime(fixturePaths);
  const { destination, root } = fixturePaths;
  const descriptor = JSON.parse(await readFile(join(destination, 'bloom-runtime.json'), 'utf8'));
  assert.equal(Object.keys(descriptor).length, 7);
  assert.equal(descriptor.schemaVersion, 1);
  assert.equal(descriptor.protocol, 1);
  assert.ok(descriptor.revision >= 8);
  assert.equal(descriptor.profile, 'personal');
  assert.equal(descriptor.bridgeScript, 'src/standalone/bloom-bridge.mjs');
  assert.equal(descriptor.nodeExecutable, '../../../../Mixdog Personal.exe');
  assert.equal(descriptor.runAsNode, true);
  assert.equal(resolve(destination, descriptor.nodeExecutable), join(root, 'install', 'Mixdog Personal.exe'));
  await access(resolve(destination, descriptor.bridgeScript));
});

test('the public entry point delegates to the same installation and preserves bridge main dispatch', async (context) => {
  const paths = await fixture(context);
  await preparePersonalBloomRuntime(paths);
  // A directory named runtime.asar models Electron's archive filesystem for ordinary Node.
  await cp(paths.input, join(paths.resources, 'runtime.asar'), { recursive: true });
  const script = join(paths.destination, 'src', 'standalone', 'bloom-bridge.mjs');
  const { stdout } = await execFileAsync(process.execPath, [script], { timeout: 5000 });
  assert.deepEqual(JSON.parse(stdout), {
    entry: join(paths.resources, 'runtime.asar', 'node_modules', 'mixdog', 'src', 'standalone', 'bloom-bridge.mjs'),
    ready: true,
  });
});

test('an archive without the real bridge is rejected before publishing any connection files', async (context) => {
  const paths = await fixture(context, false);
  await assert.rejects(preparePersonalBloomRuntime(paths));
  await assert.rejects(access(paths.destination), { code: 'ENOENT' });
});
