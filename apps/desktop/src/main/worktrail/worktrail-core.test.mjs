import assert from 'node:assert/strict';
import test from 'node:test';
import {
  buildWorktrailIndex, composeFactDocument, createWorktrailClient, createWorktrailDocuments,
  createWorktrailSearch, extractWorktrailFacts, searchWorktrailIndex,
} from './worktrail-core.mjs';
import cloudwikiRunner from './cloudwiki-runner.mjs';

const { createCloudWiki } = await import(`data:text/javascript;base64,${Buffer.from(cloudwikiRunner).toString('base64')}`);

const id = '00000000-0000-4000-8000-000000000001';
const slug = `worktrail-${id.replaceAll('-', '')}`;
function draftSetup(call = async () => ({ slug, draft_id: 7, submitted: true })) {
  let saved = [];
  const calls = [];
  const api = createWorktrailDocuments({
    store: { getSetting: () => structuredClone(saved), setSetting: async (_key, rows) => { saved = structuredClone(rows); } },
    worktrail: {
      review: async () => ({ cases: { 8: { events: [{ kind: 'note', note_kind: 'verified', observed: '파일 비교 테스트가 통과했습니다.' }] } } }),
      thread: async value => ({ title: `작업 ${value}`, status: 'resolved', result: '검색 기능을 구현했습니다.' }),
      history: async () => ({ conversation: [{ content: 'private conversation' }] }),
    },
    bridge: { call: async (...args) => { calls.push(args); return call(...args); } },
    uuid: () => id,
  });
  return { api, calls };
}
function wikiSetup(handler, url = 'https://wiki.example/mcp') {
  const seen = [], token = 'private-token-fixture';
  const api = createCloudWiki({
    home: '/example',
    read: async () => `KNOWLEDGE_PROMOTER_CLOUDWIKI_URL=${url}\nKNOWLEDGE_PROMOTER_CLOUDWIKI_TOKEN=${token}`,
    request: async (_url, options) => {
      const body = JSON.parse(options.body); seen.push(body.params);
      return new Response(JSON.stringify({ result: { content: [{ type: 'text', text: JSON.stringify(await handler(body.params.name, body.params.arguments)) }] } }));
    },
  });
  return { api, seen, token };
}

test('Worktrail authenticates in the backend, shares cold session preparation and validates IDs before network access', async () => {
  let preparation = 0, queries = 0;
  const api = createWorktrailClient(async (url, options) => {
    if (url.endsWith('/')) { preparation++; return new Response('localStorage.setItem("cb_token","abcdefghijklmnop")'); }
    queries++; assert.equal(options.headers.authorization, 'Bearer abcdefghijklmnop');
    assert.equal(options.headers.origin, 'http://127.0.0.1:8796');
    return Response.json({ counts: {}, topics: [], cases: {} });
  });
  await Promise.all([api.status(), api.review()]);
  assert.equal(preparation, 1); assert.equal(queries, 2);
  assert.throws(() => api.thread('../secret')); assert.throws(() => api.prior(0));
  assert.equal(queries, 2);
});
test('Worktrail renews an expired session once without exposing it in returned data', async () => {
  let sessions = 0, queries = 0;
  const api = createWorktrailClient(async url => {
    if (url.endsWith('/')) { sessions++; return new Response('localStorage.setItem("cb_token","abcdefghijklmnop")'); }
    queries++; return queries === 1 ? new Response('', { status: 403 }) : Response.json({ title: '작업', status: 'resolved' });
  });
  assert.deepEqual(await api.thread(8), { title: '작업', status: 'resolved' });
  assert.equal(sessions, 2); assert.equal(queries, 2);
});
test('search covers title, topic, body and result with literal all-term matches and pagination', () => {
  const index = buildWorktrailIndex({
    topics: [{ name: '믹스독', case_ids: [8] }],
    cases: { 8: { title: '완료 작업', state: 'closed', result: '검색 검증 완료', events: [{ kind: 'note', text: '본문 [특수] 기록', at: 3 }] } },
  });
  assert.equal(searchWorktrailIndex(index, '믹스독').total, 1);
  assert.equal(searchWorktrailIndex(index, '본문 [특수]').total, 1);
  assert.equal(searchWorktrailIndex(index, '본문 검색').total, 0);
  assert.equal(searchWorktrailIndex(index, '검증').results[0].caseId, 8);
  assert.throws(() => searchWorktrailIndex(index, '본문', { offset: -1 }));
});
test('search shares a read, expires its cache, and explicit refresh cancels stale preparation', async () => {
  let calls = 0, now = 0;
  const api = createWorktrailSearch({ now: () => now, load: async () => {
    calls++; return { topics: [], cases: { 8: { title: '검색', state: 'open', events: [] } } };
  } });
  await Promise.all([api.search({ query: '검색' }), api.search({ query: '검색' })]);
  assert.equal(calls, 1);
  now = 16_000; await api.search({ query: '검색' }); assert.equal(calls, 2);
  let resolveOld;
  const old = new Promise(resolve => { resolveOld = resolve; });
  let reads = 0;
  const refresh = createWorktrailSearch({ load: async () => ++reads === 1 ? old : { cases: { 2: { title: '새 기록', state: 'open', events: [] } } } });
  const pending = refresh.search({ query: '기록' }).catch(error => error);
  await Promise.resolve();
  assert.equal((await refresh.search({ query: '기록', refresh: true })).results[0].caseId, 2);
  resolveOld({ cases: { 1: { title: '옛 기록', state: 'open', events: [] } } });
  assert.ok(await pending instanceof Error);
  assert.equal((await refresh.search({ query: '기록' })).results[0].caseId, 2);
});
test('facts retain implementation, current verification and limitations, not goals or speculation', () => {
  const detail = { result: '검색 기능을 구현했습니다. 다음 배포는 예정입니다.', next: { statement: '추가 설치하겠습니다.' } };
  const events = [
    { kind: 'note', note_kind: 'verified', at: 1, observed: '1000px에서 테스트가 통과했습니다.' },
    { kind: 'note', note_kind: 'verified', at: 2, observed: '840px에서 테스트가 통과했습니다. 원격 게시를 확인하지 않았습니다.' },
    { kind: 'note', note_kind: 'thought', observed: '자동 게시를 구현했습니다.' },
  ];
  const facts = extractWorktrailFacts(detail, events);
  assert.deepEqual(facts.features, ['검색 기능을 구현했습니다.']);
  assert.deepEqual(facts.verification, ['840px에서 테스트가 통과했습니다.']);
  assert.deepEqual(facts.limits, ['원격 게시를 확인하지 않았습니다.']);
  const document = composeFactDocument('문서', [{ id: 8, detail, events }]);
  assert.match(document, /출처: Worktrail 작업 #8/);
  assert.doesNotMatch(document, /1000px|예정|추가 설치|자동 게시/);
  assert.match(composeFactDocument('미확인', [{ id: 1, detail: { result: 'will implement next' }, events: [] }]), /사실을 보완/);
});
test('drafts retain source identity and exclude raw conversation, with confirmation required for outbound writes', async () => {
  const { api, calls } = draftSetup();
  await assert.rejects(api.create({ caseIds: [] }));
  const doc = await api.create({ caseIds: [8, 8] });
  assert.equal(doc.sources.length, 1); assert.equal(doc.slug, slug);
  assert.match(doc.content, /검색 기능|파일 비교 테스트/);
  assert.doesNotMatch(doc.content, /private conversation/);
  assert.equal('content' in api.list()[0], false);
  await assert.rejects(api.submit({ id, revision: 1, confirm: false }));
  assert.equal(calls.length, 0);
});
test('ongoing work cannot become a completed-document source', async () => {
  const api = createWorktrailDocuments({
    store: { getSetting: () => [], setSetting: async () => assert.fail('must not save') },
    worktrail: { review: async () => ({ cases: {} }), thread: async () => ({ status: 'open' }) },
    bridge: { call: async () => assert.fail('must not send') },
  });
  await assert.rejects(api.create({ caseIds: [8] }), /완료 처리/);
});
test('concurrent saves reject stale revisions and retain the first accepted edit', async () => {
  const { api } = draftSetup(); await api.create({ caseIds: [8] });
  const results = await Promise.allSettled([
    api.save({ id, revision: 1, title: '첫 문서', content: '저장한 본문' }),
    api.save({ id, revision: 1, title: '두 번째', content: '오래된 본문' }),
  ]);
  assert.equal(results[0].status, 'fulfilled'); assert.equal(results[1].status, 'rejected');
  assert.equal(api.get(id).content, '저장한 본문');
});
test('uncertain submission freezes edits and recovers with the same remote identity', async () => {
  let attempts = 0;
  const { api, calls } = draftSetup(async () => {
    if (++attempts === 1) throw new Error('connection lost');
    return { slug, draft_id: 7, submitted: true };
  });
  await api.create({ caseIds: [8] });
  await assert.rejects(api.submit({ id, revision: 1, confirm: true }));
  assert.equal(api.get(id).status, 'uncertain');
  await assert.rejects(api.save({ id, revision: 1, title: '변경', content: '다른 본문' }));
  await assert.rejects(api.remove({ id, revision: 1, confirm: true }));
  assert.equal((await api.submit({ id, revision: 1, confirm: true })).status, 'submitted');
  assert.equal(calls[0][1].slug, calls[1][1].slug);
  await api.submit({ id, revision: 1, confirm: true }); assert.equal(calls.length, 2);
});
test('draft deletion requires confirmation and a current revision', async () => {
  const { api } = draftSetup(); await api.create({ caseIds: [8] });
  await assert.rejects(api.remove({ id, revision: 1, confirm: false }));
  await assert.rejects(api.remove({ id, revision: 2, confirm: true }));
  assert.equal(api.list().length, 1);
  await api.remove({ id, revision: 1, confirm: true }); assert.equal(api.list().length, 0);
});
test('CloudWiki configuration and confirmation guards prevent outbound writes', async () => {
  const bad = wikiSetup(() => [], 'http://untrusted.example/mcp');
  await assert.rejects(bad.api.status()); assert.equal(bad.seen.length, 0);
  const valid = wikiSetup(() => []);
  await assert.rejects(valid.api.submit({ slug, title: '제목', content: '본문', confirm: false }));
  assert.equal(valid.seen.length, 0);
});
test('CloudWiki reports an authentication denial without retrying or exposing the credential', async () => {
  let calls = 0;
  const wiki = createCloudWiki({
    home: '/example',
    read: async () => 'KNOWLEDGE_PROMOTER_CLOUDWIKI_URL=https://wiki.example/mcp\nKNOWLEDGE_PROMOTER_CLOUDWIKI_TOKEN=private-token-fixture',
    request: async () => { calls++; return new Response('{}', { status: 401 }); },
  });
  await assert.rejects(wiki.status(), error => /HTTP 401/.test(error.message) && !error.message.includes('private-token-fixture'));
  assert.equal(calls, 1);
});
test('CloudWiki creates only a draft and requests approval with validated identity', async () => {
  const { api, seen } = wikiSetup(name => name === 'list_drafts' ? [] : name === 'create_or_update_page'
    ? { slug, draft_id: 7 } : { slug, draft_id: 7, submitted: true });
  assert.equal((await api.submit({ slug, title: '문서', content: '본문', confirm: true })).submitted, true);
  assert.deepEqual(seen.map(row => row.name), ['list_drafts', 'create_or_update_page', 'commit_edit']);
  assert.equal(seen[1].arguments.create_only, true);
});
test('CloudWiki recovery reuses an existing draft and does not resend an already pending document', async () => {
  const draft = wikiSetup(name => name === 'list_drafts' ? [{ slug, draft_id: 7, status: 'draft' }] : { slug, draft_id: 7, submitted: true });
  await draft.api.submit({ slug, title: '문서', content: '본문', confirm: true });
  assert.deepEqual(draft.seen.map(row => row.name), ['list_drafts', 'commit_edit']);
  const pending = wikiSetup(() => [{ slug, draft_id: 7, status: 'pending_approval' }]);
  await pending.api.submit({ slug, title: '문서', content: '본문', confirm: true });
  assert.deepEqual(pending.seen.map(row => row.name), ['list_drafts']);
});
test('CloudWiki rejects wrong identities and secret echoes without exposing credentials', async () => {
  const wrong = wikiSetup(name => name === 'list_drafts' ? [] : { slug: 'wrong', draft_id: 7 });
  await assert.rejects(wrong.api.submit({ slug, title: '문서', content: '본문', confirm: true }), /번호가 일치/);
  const echo = wikiSetup(() => 'private-token-fixture');
  await assert.rejects(echo.api.status(), error => !error.message.includes(echo.token));
});
