import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { access, cp, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { promisify } from 'node:util';
import test from 'node:test';
import { createPackage } from '@electron/asar';
import { assertPersonalRuntimeVersions, preparePersonalBloomRuntime } from './bloom-runtime.mjs';

const execFileAsync = promisify(execFile);
const publicContract = {
  schemaVersion: 1, protocol: 1, revision: 8, profile: 'personal',
  bridgeScript: 'src/standalone/bloom-bridge.mjs',
  nodeExecutable: '../../../../Mixdog Personal.exe', runAsNode: true,
};

async function fixture(context, { withBridge = true, withContract = true, contract = publicContract } = {}) {
  const root = await mkdtemp(join(tmpdir(), 'mixdog-bloom-runtime-'));
  context.after(() => rm(root, { recursive: true, force: true }));
  const input = join(root, 'input');
  await mkdir(input);
  await writeFile(join(input, 'package.json'), '{"name":"synthetic-runtime"}');
  const packageRoot = join(input, 'node_modules', 'mixdog');
  await mkdir(join(packageRoot, 'src', 'standalone'), { recursive: true });
  await writeFile(join(packageRoot, 'package.json'), '{"name":"mixdog","version":"2.3.4"}');
  if (withContract) {
    await writeFile(join(packageRoot, 'src', 'standalone', 'bloom-contract.json'), JSON.stringify(contract));
  }
  if (withBridge) {
    const script = join(packageRoot, contract.bridgeScript);
    await mkdir(dirname(script), { recursive: true });
    await writeFile(script, "process.stdout.write(JSON.stringify({ entry: process.argv[1], ready: true }));\n");
  }
  const runtimeArchive = join(root, 'fixture.asar');
  await createPackage(input, runtimeArchive);
  const resources = join(root, 'install', 'resources');
  const destination = join(resources, 'runtime.asar.unpacked', 'node_modules', 'mixdog');
  const sidecar = join(`${runtimeArchive}.unpacked`, 'node_modules', 'mixdog');
  return { root, input, runtimeArchive, resources, destination, sidecar };
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
  assert.deepEqual(JSON.parse(await readFile(join(fixturePaths.sidecar, 'bloom-runtime.json'), 'utf8')), publicContract);
  assert.equal(
    await readFile(join(fixturePaths.sidecar, descriptor.bridgeScript), 'utf8'),
    await readFile(resolve(destination, descriptor.bridgeScript), 'utf8'),
    'archive sidecar and installer staging carry the same public bootstrap'
  );
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
  const paths = await fixture(context, { withBridge: false });
  await assert.rejects(preparePersonalBloomRuntime(paths));
  await assert.rejects(access(paths.destination), { code: 'ENOENT' });
  await assert.rejects(access(paths.sidecar), { code: 'ENOENT' });
});

test('an old archive without its own public contract cannot borrow a newer checkout contract', async (context) => {
  const paths = await fixture(context, { withContract: false });
  await assert.rejects(preparePersonalBloomRuntime(paths), /bloom-contract\.json/);
  await assert.rejects(access(paths.destination), { code: 'ENOENT' });
});

test('the shipped archive declares its minimum API and nested entry location independently of the preparing checkout', async (context) => {
  const contract = { ...publicContract, revision: 9, bridgeScript: 'src/standalone/v2/entry.mjs', buildVersion: 'future' };
  const paths = await fixture(context, { contract });
  await preparePersonalBloomRuntime(paths);
  const descriptor = JSON.parse(await readFile(join(paths.destination, 'bloom-runtime.json'), 'utf8'));
  assert.equal(descriptor.revision, 9);
  assert.equal(Object.keys(descriptor).length, 7, 'new packaging preserves the older Bloom descriptor shape');
  await cp(paths.input, join(paths.resources, 'runtime.asar'), { recursive: true });
  const { stdout } = await execFileAsync(process.execPath, [join(paths.destination, descriptor.bridgeScript)], { timeout: 5000 });
  assert.deepEqual(JSON.parse(stdout), {
    entry: join(paths.resources, 'runtime.asar', 'node_modules', 'mixdog', contract.bridgeScript), ready: true,
  });
});

test('a prepared archive, both source manifests and the Personal app label must have the same base version', async (context) => {
  const { runtimeArchive } = await fixture(context);
  const valid = { runtimeArchive, sourceVersion: '2.3.4', desktopVersion: '2.3.4', personalVersion: '2.3.4-personal.2' };
  assertPersonalRuntimeVersions(valid);
  for (const change of [
    { sourceVersion: '1.1.2' }, { desktopVersion: '1.2.0' },
    { personalVersion: '2.3.5-personal.1' }, { personalVersion: '2.3.4' },
  ]) {
    assert.throws(() => assertPersonalRuntimeVersions({ ...valid, ...change }), /version mismatch/);
  }
});

test('an archived entry path outside the runtime is rejected before any public files are written', async (context) => {
  const paths = await fixture(context, { contract: { ...publicContract, bridgeScript: '../outside.mjs' } });
  await assert.rejects(preparePersonalBloomRuntime(paths), /inside its runtime package/);
  await assert.rejects(access(paths.destination), { code: 'ENOENT' });
});
