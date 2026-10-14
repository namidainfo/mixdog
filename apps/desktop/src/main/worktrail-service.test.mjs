import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { createWorktrailService } from './worktrail-service.ts';
function request(url) {
  if (url.endsWith('/')) return Promise.resolve(new Response('localStorage.setItem("cb_token","abcdefghijklmnop")'));
  if (url.endsWith('/review')) return Promise.resolve(Response.json({ topics: [], cases: { 8: { title: '기록', state: 'closed', result: '기능을 구현했습니다.', events: [] } } }));
  return Promise.resolve(Response.json({ title: '기록', status: 'resolved', result: '기능을 구현했습니다.' }));
}
async function directory(t) {
  const path = await mkdtemp(join(tmpdir(), 'mixdog-worktrail-'));
  t.after(() => rm(path, { recursive: true, force: true }));
  return path;
}
test('local drafts survive service restart and never require CloudWiki connectivity', async t => {
  const path = await directory(t);
  const wiki = async () => { throw new Error('offline'); };
  const service = await createWorktrailService({ directory: path, request, wiki });
  const doc = await service.invoke('create', { caseIds: [8] });
  assert.equal(doc.status, 'draft');
  const restarted = await createWorktrailService({ directory: path, request, wiki });
  assert.equal((await restarted.invoke('document', { id: doc.id })).content, doc.content);
  assert.equal((await restarted.invoke('documents')).length, 1);
  assert.equal((await restarted.invoke('documents'))[0].content, undefined);
  await assert.rejects(restarted.invoke('submit', { id: doc.id, revision: 1, confirm: true }), /전송 결과/);
  const recovery = await createWorktrailService({ directory: path, request, wiki });
  assert.equal((await recovery.invoke('document', { id: doc.id })).status, 'uncertain');
});
test('corrupt draft storage is reported, not overwritten or silently reset', async t => {
  const path = await directory(t), file = join(path, 'worktrail-documents.json');
  await writeFile(file, '{"broken":true}');
  await assert.rejects(createWorktrailService({ directory: path, request }), /형식을 확인/);
  assert.equal(await readFile(file, 'utf8'), '{"broken":true}');
});
test('dispatch rejects arbitrary actions, invalid IDs and malformed payloads', async t => {
  const service = await createWorktrailService({ directory: await directory(t), request });
  await assert.rejects(service.invoke('constructor'));
  await assert.rejects(service.invoke('readFile'));
  await assert.rejects(service.invoke('thread', { id: '../private' }));
  await assert.rejects(service.invoke('documents', []));
});
