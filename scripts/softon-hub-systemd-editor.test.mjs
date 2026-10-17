import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { stageHubOverride } from './softon-hub-systemd-editor.mjs';

test('the systemd editor stages only the approved settings and preserves unrelated targets', async (t) => {
  const home = await mkdtemp(path.join(tmpdir(), 'softon-systemd-editor-'));
  t.after(() => rm(home, { recursive: true, force: true }));
  const directory = path.join(home, '.config/systemd/user/codex-slack-bridge.service.d');
  await mkdir(directory, { recursive: true });
  const source = path.join(home, 'source.conf'), target = path.join(directory, '.#95-softon-session-hub.conf123');
  const text = '[Service]\nEnvironment="MIXDOG_HUB_ORIGIN=https://192.168.19.118:8797"\n'
    + 'Environment="MIXDOG_HUB_ADMINS=T1:U1"\nEnvironment="MIXDOG_HUB_TLS_KEY=C:\\\\private\\\\server.key"\n'
    + 'Environment="MIXDOG_HUB_TLS_CERT=C:\\\\private\\\\server.crt"\n';
  await writeFile(source, text); await writeFile(target, '');
  await stageHubOverride(source, [target], home);
  assert.equal(await readFile(target, 'utf8'), text);
  await writeFile(target, '');
  await stageHubOverride(source, ['+4', target], home);
  assert.equal(await readFile(target, 'utf8'), text);
  for (const args of [['+4'], ['+line', target], [target, '+4'], ['+4', target, target]]) {
    await assert.rejects(stageHubOverride(source, args, home), /Exactly one|not the SOFTON/u);
  }
  const other = path.join(directory, 'unrelated.conf');
  await writeFile(other, 'keep');
  await assert.rejects(stageHubOverride(source, [other], home), /not the SOFTON/u);
  assert.equal(await readFile(other, 'utf8'), 'keep');
  await writeFile(source, text + 'ExecStart=/unexpected\n');
  await assert.rejects(stageHubOverride(source, [target], home), /four approved/u);
  assert.equal(await readFile(target, 'utf8'), text);
});
