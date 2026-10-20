import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { JSDOM } from 'jsdom';
import { mountHub } from './public/app.js';

const tick = async () => { await new Promise((resolve) => setImmediate(resolve)); await new Promise((resolve) => setImmediate(resolve)); };
async function fixture(t, { admin = false, status = 'pending' } = {}) {
  const dom = new JSDOM(await readFile(new URL('public/index.html', import.meta.url), 'utf8'), { url: 'http://127.0.0.1' });
  t.after(() => dom.window.close());
  dom.window.HTMLDialogElement.prototype.showModal = function () { this.open = true; };
  dom.window.HTMLDialogElement.prototype.close = function () { this.open = false; };
  const calls = [], document = dom.window.document, $ = (selector) => document.querySelector(selector);
  const job = { id: 'job-1', sessionId: 'source', teamId: 'T1', userId: 'U1', userName: '요청자', status, revision: 5,
    goal: 'Python 계산', checks: 'factorial 비교', constraints: '비밀정보 공개 금지',
    notification: { status: 'sent' }, recording: { status: 'local_only' }, files: [],
    ...(admin ? { result: { summary: '<script>관리자 결과</script>', files: [] } } : {}) };
  let authenticated = true, hasJob = true;
  const request = async (url, options = {}) => {
    calls.push({ url, options });
    if (!authenticated) return Response.json({ error: '다시 로그인해 주세요.' }, { status: 401 });
    if (url === '/api/me') return Response.json({ teamId: 'T1', userId: admin ? 'UA' : 'U1', admin, csrf: 'csrf' });
    if (url === '/api/sessions') return Response.json({ sessions: [{ id: 'source', userId: 'U1', userName: '요청자', title: '원본 요청' }] });
    if (url === '/api/sessions/source') return Response.json({ id: 'source', state: 'idle', title: '원본 요청', userId: 'U1',
      userName: '요청자', messages: [{ by: 'user', text: '계산 코드를 작성해 줘' }], records: [], files: [] });
    if (url === '/api/jobs') return Response.json({ jobs: hasJob ? [job] : [] });
    if (url === '/api/sessions/source/jobs') {
      Object.assign(job, JSON.parse(options.body), { status: 'pending', revision: 1 });
      hasJob = true; return Response.json(job, { status: 201 });
    }
    if (url === '/api/jobs/job-1/approve') { job.status = 'running'; job.revision++; return Response.json(job); }
    if (url === '/api/jobs/job-1/complete') {
      Object.assign(job, { status: 'completed', summary: JSON.parse(options.body).summary }); return Response.json(job);
    }
    return Response.json({ error: 'not found' }, { status: 404 });
  };
  await mountHub(document, request).ready;
  $('#open-jobs').click(); await tick();
  return { dom, $, calls, job, expire: () => { authenticated = false; } };
}
test('requester gets an editable handoff but cannot approve or see administrator controls', async (t) => {
  const h = await fixture(t);
  assert.equal(h.$('#jobs-dialog').open, true);
  assert.equal(h.$('#job-project-path'), null);
  h.$('#new-job').click();
  assert.equal(h.$('#job-goal').value, '계산 코드를 작성해 줘');
  h.$('#job-checks').value = 'factorial과 비교';
  h.$('#job-checks').dispatchEvent(new h.dom.window.Event('input'));
  assert.match(h.$('#job-prompt-preview').textContent, /factorial과 비교/);
  h.$('#job-request-form').dispatchEvent(new h.dom.window.Event('submit', { bubbles: true, cancelable: true }));
  await tick();
  const saved = h.calls.find(({ url }) => url === '/api/sessions/source/jobs');
  assert.ok(saved);
  assert.equal(saved.options.headers['x-csrf-token'], 'csrf');
  assert.equal(h.calls.some(({ url }) => url.endsWith('/approve')), false);
  assert.match(h.$('#announcement').textContent, /아직 실행하지 않았습니다/);
});
test('administrator approval is explicit and binds project and current revision', async (t) => {
  const h = await fixture(t, { admin: true });
  const approve = [...h.dom.window.document.querySelectorAll('#job-detail button')].find((node) => node.textContent === '이 버전 승인하고 인수');
  approve.click(); await tick();
  assert.equal(h.calls.some(({ url }) => url.endsWith('/approve')), false);
  h.$('#job-project-path').value = 'C:\\Projects\\internal'; h.$('#job-approve-confirm').checked = true;
  approve.click(); await tick();
  assert.deepEqual(JSON.parse(h.calls.find(({ url }) => url.endsWith('/approve')).options.body),
    { revision: 5, confirm: true, projectPath: 'C:\\Projects\\internal' });
});
test('review result is escaped, requires deliberate public summary and clears on authentication expiry', async (t) => {
  const h = await fixture(t, { admin: true, status: 'review' });
  assert.equal(h.$('#job-private-result').textContent, '<script>관리자 결과</script>');
  assert.equal(h.$('#job-private-result script'), null);
  assert.equal(h.$('#job-public-summary').value, '');
  h.$('#job-public-summary').value = '검증한 공개 결과'; h.$('#job-complete-confirm').checked = true;
  [...h.dom.window.document.querySelectorAll('#job-detail button')].find((node) => node.textContent === '검증 완료 및 선택 결과 공개').click();
  await tick();
  assert.equal(JSON.parse(h.calls.find(({ url }) => url.endsWith('/complete')).options.body).summary, '검증한 공개 결과');
  h.expire(); h.$('#reload-jobs').click(); await tick();
  assert.equal(h.$('#jobs-dialog').open, false);
  assert.equal(h.$('#job-detail').textContent, '');
  assert.equal(h.$('#workspace').hidden, true);
});
