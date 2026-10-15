import assert from 'node:assert/strict';
import { access, open, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import test from 'node:test';
import { extractFile, listPackage } from '@electron/asar';
import personalConfig from '../../electron-builder.personal.cjs';

const output = process.env.MIXDOG_PACKAGING_OUTPUT_DIR;
if (!output) throw new Error('MIXDOG_PACKAGING_OUTPUT_DIR must identify the personal release output.');
const resources = join(output, 'win-unpacked', 'resources');

test('personal Windows artifact retains its separate identity and numeric calibration code', async () => {
  const appArchive = join(resources, 'app.asar');
  const meta = JSON.parse(extractFile(appArchive, 'package.json').toString());
  assert.equal(meta.name, 'mixdog-personal');
  assert.equal(meta.version, personalConfig.extraMetadata.version);
  await access(join(output, 'win-unpacked', 'Mixdog Personal.exe'));
  await access(join(resources, 'LICENSE.txt'));
  await access(join(resources, 'NOTICE.md'));
  const entries = listPackage(join(resources, 'runtime.asar'), { isPack: false })
    .map((entry) => entry.replaceAll('\\', '/'));
  assert.ok(entries.includes('/node_modules/mixdog/src/runtime/shared/llm/codex-quota-calibration.mjs'));
  assert.ok(entries.includes('/node_modules/mixdog/src/runtime/shared/llm/usage-ledger-worker.mjs'));
  assert.equal(entries.some((entry) => entry.endsWith('.codex-calibration.sqlite')), false);
  assert.equal(entries.some((entry) => /\/(?:openai-oauth\.json|provider-accounts\.json|rollout-.*\.jsonl)$/.test(entry)), false);
});

test('personal installer is a Windows executable and publishing is disabled', async () => {
  const installer = join(output, `mixdog-personal-${personalConfig.extraMetadata.version}-win-x64.exe`);
  const handle = await open(installer, 'r');
  try {
    const bytes = Buffer.alloc(64);
    await handle.read(bytes, 0, bytes.length, 0);
    assert.equal(bytes.toString('ascii', 0, 2), 'MZ');
    const pe = Buffer.alloc(4);
    await handle.read(pe, 0, pe.length, bytes.readUInt32LE(60));
    assert.equal(pe.toString('ascii'), 'PE\0\0');
  } finally { await handle.close(); }
  // The programmatic builder need not emit a debug YAML file. Check the
  // shipped payload instead: there must be no official update feed.
  assert.equal((await readdir(resources)).includes('app-update.yml'), false);
  assert.equal((await readdir(output)).includes('latest.yml'), false);
});
