import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { JSDOM } from 'jsdom';
import { mountHub } from './public/app.js';

const tick = () => new Promise((resolve) => setImmediate(resolve));
const me = { userId: 'U1', userName: 'softon_박수한', teamId: 'T1', admin: false, csrf: 'csrf' };
function snapshot(id, userName = me.userName) {
  return { id, userName, userId: id === 'b' ? 'U2' : 'U1', title: `261016-001 | ${userName} | 작업 ${id}`, state: 'running',
    channelId: 'C1', threadTs: '1', updatedAt: '2026-10-16T01:00:00Z',
    messages: [{ id: 'u', by: 'user', text: '정리해 줘.' }, { id: 'a', by: 'assistant', text: '작업 중입니다.' }],
    files: [{ id: 'f'.repeat(64), sha256: 'a'.repeat(64), path: 'deliverables/result.md', size: 20, modifiedAt: '2026-10-16T00:59:00Z' }],
    records: Array.from({ length: 8 }, (_, i) => ({ id: `${id}-${i}`, kind: i % 2 ? 'verified' : 'decision',
      title: `기록 ${id}-${i}`, body: `본문 ${id}-${i}`, conclusion: '판단', at: 1792110000000 + i, next: '검토', owner: 'user' })) };
}
async function harness(t, { admin = false, waitingFor = null, sessionIds = admin ? ['a', 'b'] : ['a'] } = {}) {
  const dom = new JSDOM(await readFile(new URL('public/index.html', import.meta.url), 'utf8'), { url: 'http://127.0.0.1' });
  t.after(() => dom.window.close());
  dom.window.HTMLDialogElement.prototype.showModal = function () { this.open = true; };
  dom.window.HTMLDialogElement.prototype.close = function () { this.open = false; };
  dom.window.HTMLElement.prototype.scrollIntoView = function () {};
  const calls = [], docs = [], data = new Map([['a', snapshot('a')], ['b', snapshot('b', 'softon_김민지')], ['c', snapshot('c')]]);
  data.get('a').waitingFor = waitingFor;
  let failure = false, authenticated = true;
  const request = async (url, options = {}) => {
    calls.push({ url, options });
    if (!authenticated) return Response.json({ error: '로그인해 주세요.' }, { status: 401 });
    if (url === '/api/me') return Response.json({ ...me, admin });
    if (url === '/api/sessions') return Response.json({ sessions: sessionIds.map((id) => ({
      id, userName: data.get(id).userName, userId: data.get(id).userId, title: data.get(id).title,
    })) });
    const match = /^\/api\/sessions\/([^/]+)(.*)$/u.exec(url);
    if (match) {
      const [, id, route] = match;
      if (!route || route === '/snapshot') return failure
        ? Response.json({ error: '연결 실패' }, { status: 502 }) : Response.json(data.get(id));
      if (route.startsWith('/files/')) return new Response('# 실제 텍스트 <script>위험</script>');
      if (route === '/documents' && options.method === 'POST') {
        const doc = { id: 'doc', sessionId: id, title: '초안', content: '검토할 본문', status: 'draft', revision: 1 };
        docs.push(doc); return Response.json(doc);
      }
      if (route === '/documents') return Response.json({ documents: docs });
      if (route === '/documents/doc/save') {
        Object.assign(docs[0], JSON.parse(options.body), { revision: docs[0].revision + 1 }); return Response.json(docs[0]);
      }
      if (route === '/documents/doc/submit') {
        Object.assign(docs[0], { status: 'submitted', remoteDraftId: 10 }); return Response.json(docs[0]);
      }
    }
    if (url === '/api/logout') return Response.json({ loggedOut: true });
    return Response.json({ error: 'not found' }, { status: 404 });
  };
  await mountHub(dom.window.document, request).ready;
  return { dom, $: (selector) => dom.window.document.querySelector(selector), calls, data,
    fail: () => { failure = true; }, expire: () => { authenticated = false; } };
}

test('sidebar shows six ordered records and selecting a mark opens the actual record, without HTML injection', async (t) => {
  const h = await harness(t);
  const marks = h.dom.window.document.querySelectorAll('.flow-mark');
  assert.equal(marks.length, 6);
  assert.match(marks[0].getAttribute('aria-label'), /기록 a-2/u);
  marks[0].click(); await tick();
  assert.equal(h.$('[data-tab="records"]').getAttribute('aria-pressed'), 'true');
  assert.match(h.$('.record[data-selected="true"]').textContent, /기록 a-2/u);
  h.$('[data-tab="files"]').click(); await tick();
  [...h.dom.window.document.querySelectorAll('.file-row button')][0].click(); await tick();
  assert.match(h.$('#file-content').textContent, /<script>위험<\/script>/u);
  assert.equal(h.$('#file-content script'), null);
});

test('administrator record flow follows only the selected session, including sessions with the same owner', async (t) => {
  const h = await harness(t, { admin: true, sessionIds: ['a', 'c', 'b'] });
  const assertSelected = (id) => {
    const marks = [...h.dom.window.document.querySelectorAll('.flow-mark')];
    assert.equal(marks.length, 6);
    for (const [index, mark] of marks.entries()) {
      assert.equal(mark.getAttribute('aria-label').split(' · ')[1], `기록 ${id}-${index + 2}`);
      assert.equal(mark.dataset.here, 'true');
    }
    assert.equal(h.$('.session-heading').textContent, h.data.get(id).title);
  };
  assertSelected('a');
  h.dom.window.document.querySelectorAll('.session')[1].click(); assertSelected('c');
  h.dom.window.document.querySelectorAll('.session')[2].click(); assertSelected('b');
  h.dom.window.document.querySelectorAll('.session')[0].click(); assertSelected('a');
});

test('administrator empty and filtered selections never fall back to another session record', async (t) => {
  const h = await harness(t, { admin: true });
  h.data.get('b').records = [];
  h.$('#reload-list').click(); await tick(); await tick();
  h.dom.window.document.querySelectorAll('.session')[1].click();
  assert.equal(h.$('.session-heading').textContent, h.data.get('b').title);
  assert.equal(h.dom.window.document.querySelectorAll('.flow-mark').length, 0);
  h.$('#search').value = '작업 a'; h.$('#search').dispatchEvent(new h.dom.window.Event('input'));
  assert.equal(h.$('.session-heading').textContent, h.data.get('a').title);
  assert.equal(h.dom.window.document.querySelectorAll('.flow-mark').length, 6);
  h.$('#search').value = '없는 세션'; h.$('#search').dispatchEvent(new h.dom.window.Event('input'));
  assert.equal(h.dom.window.document.querySelectorAll('.session').length, 0);
  assert.equal(h.dom.window.document.querySelectorAll('.flow-mark').length, 0);
});

test('ordinary users load only accessible session records and discard records removed from the sidebar', async (t) => {
  const sessionIds = ['a', 'c'], h = await harness(t, { sessionIds });
  const marks = [...h.dom.window.document.querySelectorAll('.flow-mark')];
  assert.equal(h.dom.window.document.querySelectorAll('.session').length, 2);
  assert.deepEqual(marks.map((mark) => mark.getAttribute('aria-label').split(' · ')[1]),
    ['기록 a-5', '기록 c-5', '기록 a-6', '기록 c-6', '기록 a-7', '기록 c-7']);
  assert.equal(h.calls.some((call) => call.url.startsWith('/api/sessions/b')), false);
  marks[1].click(); await tick();
  assert.equal(h.$('.session-heading').textContent, h.data.get('c').title);
  assert.match(h.$('.record[data-selected="true"]').textContent, /기록 c-5/u);
  sessionIds.pop();
  h.$('#reload-list').click(); await tick(); await tick();
  assert.equal(h.dom.window.document.querySelectorAll('.session').length, 1);
  assert.equal(h.$('.session-heading').textContent, h.data.get('a').title);
  assert.deepEqual([...h.dom.window.document.querySelectorAll('.flow-mark')]
    .map((mark) => mark.getAttribute('aria-label').split(' · ')[1]),
  ['기록 a-2', '기록 a-3', '기록 a-4', '기록 a-5', '기록 a-6', '기록 a-7']);
  assert.equal(h.calls.some((call) => call.url.startsWith('/api/sessions/b')), false);
});

test('refresh failures preserve the exact previous snapshot and authentication expiry clears private content', async (t) => {
  const h = await harness(t), previous = h.$('.session-heading').textContent;
  h.fail(); h.$('#refresh').click(); await tick(); await tick();
  assert.equal(h.$('.session-heading').textContent, previous);
  assert.match(h.$('.notice.error').textContent, /마지막 정상 스냅샷/u);
  h.expire(); h.$('#refresh').click(); await tick(); await tick();
  assert.equal(h.$('#workspace').hidden, true);
  assert.equal(h.$('#detail').textContent, ''); assert.equal(h.$('#flow-marks').textContent, '');
});

test('administrator owner filters also constrain the recent record flow', async (t) => {
  const h = await harness(t, { admin: true });
  assert.equal(h.$('#owner-label').hidden, false);
  h.$('#owner-filter').value = 'U2'; h.$('#owner-filter').dispatchEvent(new h.dom.window.Event('change'));
  assert.equal(h.dom.window.document.querySelectorAll('.session').length, 1);
  assert.equal(h.dom.window.document.querySelectorAll('.flow-mark').length, 6);
  for (const mark of h.dom.window.document.querySelectorAll('.flow-mark')) assert.match(mark.getAttribute('aria-label'), /softon_김민지/u);
});

test('messages identify the Slack owner, AI and errors without trusting author HTML', async (t) => {
  const h = await harness(t, { waitingFor: '도구 승인' });
  assert.equal(h.$('.message[data-speaker="user"] .message-head strong').textContent, me.userName);
  assert.match(h.$('.message[data-speaker="user"] .message-head').textContent, /사용자/u);
  assert.equal(h.$('.message[data-speaker="assistant"] .message-head strong').textContent, 'SOFTON');
  assert.match(h.$('.message[data-speaker="assistant"] .message-head').textContent, /AI/u);
  assert.match(h.$('#login').textContent, /아직 SOFTON 세션이 없어도 로그인할 수 있습니다\./u);
  assert.equal(h.$('#active-panel .notice').textContent, '도구 승인 대기 중입니다. 질문에는 원래 Slack 스레드에서 답변해 주세요. 일반 사용자의 도구 실행은 PC 소유자가 SOFTON 승인 화면에서 확인해야 합니다.');
  assert.equal(h.$('link[rel="icon"][type="image/x-icon"]').getAttribute('href'), '/favicon.ico');
  assert.equal(h.$('.brand-mark').getAttribute('src'), '/favicon-32.png');
});

test('document submission needs preview, a fresh saved revision and explicit confirmation', async (t) => {
  const h = await harness(t);
  h.$('[data-tab="wiki"]').click(); await tick();
  [...h.dom.window.document.querySelectorAll('#active-panel button')].find((node) => node.textContent === '작업 기록으로 새 초안 만들기').click();
  await tick(); await tick();
  [...h.dom.window.document.querySelectorAll('#active-panel button')].find((node) => node.textContent === '저장하고 승인 요청 검토').click();
  await tick(); await tick();
  assert.equal(h.$('#wiki-dialog').open, true); assert.equal(h.$('#submit-wiki').disabled, true);
  assert.equal(h.calls.some((call) => call.url.endsWith('/submit')), false);
  h.$('#confirm-wiki').checked = true; h.$('#confirm-wiki').dispatchEvent(new h.dom.window.Event('change'));
  h.$('#submit-wiki').click(); await tick(); await tick();
  const submitted = h.calls.find((call) => call.url.endsWith('/submit'));
  assert.deepEqual(JSON.parse(submitted.options.body), { revision: 2, confirm: true });
  assert.equal(submitted.options.headers['x-csrf-token'], 'csrf');
  assert.match(h.$('#active-panel').textContent, /승인 대기 제출 완료/u);
});
