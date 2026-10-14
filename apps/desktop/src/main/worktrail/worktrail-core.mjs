// Migrated from Project Workdesk: read-only Worktrail access, search and
// reviewed local drafts. No project manager or service hub is required.
import { randomUUID } from 'node:crypto';

const SESSION_MARKER = /localStorage\.setItem\("cb_token","([A-Za-z0-9_-]{16,128})"\)/;

export function createWorktrailClient(request = fetch, { getOrigin = () => 'http://127.0.0.1:8796' } = {}) {
  let sessionKey = null;
  let sessionOrigin = null;
  let preparing = null;
  async function session(origin) {
    if (preparing?.origin === origin) return preparing.promise;
    const promise = (async () => {
      const response = await request(`${origin}/`, { redirect: 'error', signal: AbortSignal.timeout(3_000) });
      if (!response.ok) throw new Error(`Worktrail 화면 연결 실패 (${response.status})`);
      const found = SESSION_MARKER.exec(await response.text());
      if (!found) throw new Error('Worktrail 세션을 확인할 수 없습니다.');
      if (getOrigin() === origin) { sessionOrigin = origin; sessionKey = found[1]; }
      return found[1];
    })();
    preparing = { origin, promise };
    try { return await promise; } finally { if (preparing?.promise === promise) preparing = null; }
  }
  async function read(path, retry = true, options = {}) {
    const { signal = AbortSignal.timeout(10_000), onProgress = () => {} } = options;
    const origin = getOrigin();
    if (sessionOrigin !== origin) sessionKey = null;
    onProgress('connecting');
    const key = sessionKey || await session(origin);
    signal.throwIfAborted();
    onProgress('loading');
    const response = await request(`${origin}/api/app/${path}`, {
      redirect: 'error', signal, headers: { authorization: `Bearer ${key}`, origin },
    });
    if (response.status === 403 && retry) {
      if (sessionOrigin === origin && sessionKey === key) sessionKey = null;
      return read(path, false, { signal, onProgress });
    }
    if (!response.ok) throw new Error(`Worktrail 기록 조회 실패 (${response.status})`);
    return response.json();
  }
  const id = value => {
    if (!Number.isSafeInteger(value) || value <= 0) throw new Error('작업 번호를 확인해 주세요.');
    return value;
  };
  return {
    status: () => read('status'),
    review: options => read('review', true, options),
    thread: value => read(`thread/${id(value)}`),
    history: value => read(`case/${id(value)}`),
    archive: value => read(value === undefined ? 'prior' : `prior?repo_id=${id(value)}`),
    prior: value => read(`prior/${id(value)}`),
  };
}

const normalize = value => String(value || '').normalize('NFKC').toLocaleLowerCase('ko-KR');
function terms(query) {
  if (typeof query !== 'string' || query.length > 200 || /[\u0000-\u0008\u007f]/u.test(query))
    throw new Error('검색어는 200자 이내로 입력해 주세요.');
  return [...new Set(normalize(query).trim().split(/\s+/u).filter(Boolean))];
}
export function buildWorktrailIndex(review) {
  const topics = new Map();
  for (const topic of review.topics || []) for (const id of topic.case_ids) topics.set(id, topic.name);
  return Object.entries(review.cases || {}).map(([key, row]) => {
    const id = Number(key), topic = topics.get(id) || '주제 없음';
    const sections = [
      { kind: 'title', text: `${row.title}\n${topic}`, at: row.updated_at || 0 },
      ...(row.result ? [{ kind: 'result', text: row.result, at: row.updated_at || 0 }] : []),
      ...(row.events || []).map(event => ({
        kind: String(event.note_kind || event.kind || 'note'),
        text: [event.observed, event.text, event.reason].filter(Boolean).join('\n'), at: Number(event.at) || 0,
      })),
    ];
    return { id, title: row.title, status: row.state, topic,
      sections: sections.filter(section => section.text).map(section => ({ ...section, hay: normalize(section.text) })) };
  });
}
function excerpt(section, tokens) {
  const flat = section.text.replace(/\s+/gu, ' ').trim(), hay = normalize(flat);
  const found = tokens.map(token => hay.indexOf(token)).filter(index => index >= 0);
  const start = Math.max(0, Math.min(...found) - 45);
  return `${start ? '…' : ''}${flat.slice(start, start + 250)}${flat.length > start + 250 ? '…' : ''}`;
}
export function searchWorktrailIndex(index, query, { offset = 0, limit = 30 } = {}) {
  const tokens = terms(query);
  if (!Number.isSafeInteger(offset) || offset < 0 || !Number.isSafeInteger(limit) || limit < 1 || limit > 100)
    throw new Error('검색 범위를 확인해 주세요.');
  if (!tokens.length) return { query: query.trim(), results: [], total: 0, nextOffset: null };
  const results = [];
  for (const row of index) {
    const matched = row.sections.filter(section => tokens.every(token => section.hay.includes(token)));
    if (!matched.length) continue;
    matched.sort((a, b) => b.at - a.at);
    const unique = [...new Map(matched.map(section => [section.text, section])).values()];
    results.push({ caseId: row.id, title: row.title, status: row.status, topic: row.topic, at: matched[0].at,
      matches: unique.slice(0, 3).map(section => ({ kind: section.kind, at: section.at, snippet: excerpt(section, tokens) })),
      matchCount: unique.length });
  }
  results.sort((a, b) => b.at - a.at || b.caseId - a.caseId);
  return { query: query.trim(), results: results.slice(offset, offset + limit), total: results.length,
    nextOffset: offset + limit < results.length ? offset + limit : null };
}
export function createWorktrailSearch({ load, now = () => Date.now(), ttl = 15_000, timeoutMs = 6_000 }) {
  let cache = null, pending = null, epoch = 0;
  let state = { phase: 'idle', error: null, checkedAt: null };
  function clear() {
    epoch++; pending?.controller.abort(); cache = null; pending = null;
    state = { phase: 'idle', error: null, checkedAt: null };
  }
  return {
    clear, state: () => ({ ...state }),
    async search(input = {}) {
      if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('검색 요청을 확인해 주세요.');
      searchWorktrailIndex([], input.query ?? '', input);
      if (input.refresh === true) clear();
      if (!cache || now() - cache.at >= ttl) {
        if (!pending) {
          const current = epoch, controller = new AbortController();
          const signal = AbortSignal.any([controller.signal, AbortSignal.timeout(timeoutMs)]);
          state = { phase: 'connecting', error: null, checkedAt: null };
          const onProgress = phase => { if (current === epoch) state = { ...state, phase }; };
          const request = Promise.resolve().then(() => load({ signal, onProgress })).then(review => {
            signal.throwIfAborted(); onProgress('indexing');
            const value = { at: now(), index: buildWorktrailIndex(review) };
            if (current === epoch) { cache = value; state = { phase: 'ready', error: null, checkedAt: value.at }; }
            return value;
          }).catch(error => {
            const message = signal.aborted || error.name === 'TimeoutError'
              ? 'Worktrail 응답이 늦습니다. 서비스 상태를 확인하고 다시 조회해 주세요.'
              : `Worktrail 검색 준비 실패: ${error.message}`;
            if (current === epoch) state = { phase: 'failed', error: message, checkedAt: null };
            throw new Error(message);
          }).finally(() => { if (pending?.request === request) pending = null; });
          pending = { request, controller };
        }
        const value = await pending.request;
        return { ...searchWorktrailIndex(value.index, input.query ?? '', input), checkedAt: value.at };
      }
      return { ...searchWorktrailIndex(cache.index, input.query ?? '', input), checkedAt: cache.at };
    },
  };
}

const future = /예정|계획|추정|가설|추측|예상|가능성|진행하겠|하겠습니다|할 수 있|권장|다음 행동|요청했습니다|원하시|해야 합니다|해주세요|해 주세요|우선.{0,25}후보|권고|추천|판단했습니다|판단됩니다|\b(?:will|planned|should|might|may|hypothesis|probably|suspect|proposed|todo)\b/iu;
const limited = /미확인|검증하지|확인하지|수행하지|실행하지|시험하지|남아 있|제약|제한|지원하지|아직|검증 범위|\b(?:not (?:yet )?(?:verified|tested|implemented|executed|confirmed)|unverified|untested|pending|limitation|unsupported)\b/iu;
const implemented = /(?:구현|추가|수정|적용|제거|삭제|설치|저장|등록|비활성화)(?:했|하였|됐|되어|하고|하여|해|을|를)|기능.{0,25}(?:구현|추가|수정|적용)|지원합니다|제공합니다|동작합니다|읽습니다|표시합니다/iu;
const factual = /했습니다|됐습니다|확인했|통과|성공|일치|완료|지원합니다|제공합니다|동작합니다|읽습니다|표시합니다|사용합니다|검증|passed|verified|implemented|supports|installed/iu;
function statements(value) {
  let body = String(value || '');
  const heading = body.match(/^([^\n]+)\n\s*\n/u);
  if (heading && !/[.!?]|했습니다|됐습니다|합니다/iu.test(heading[1])) body = body.slice(heading[0].length);
  return body.split(/\n|(?<=[.!?])\s+/u).map(line => line.trim().replace(/^[-*]\s*/u, '')).filter(Boolean);
}
export function completed(state) { return ['closed', 'resolved', 'completed'].includes(state); }
export function extractWorktrailFacts(detail, events = []) {
  const features = [], verification = [], limits = [];
  const add = (value, kind) => {
    for (const sentence of statements(value)) {
      if (limited.test(sentence)) { if (!future.test(sentence)) limits.push(sentence); continue; }
      if (future.test(sentence) || !factual.test(sentence)) continue;
      (implemented.test(sentence) && kind !== 'verified' ? features : verification).push(sentence);
    }
  };
  add(detail.result, 'result');
  const recent = [...events].sort((a, b) => Number(b.at || 0) - Number(a.at || 0));
  for (const kind of ['verified', 'change']) {
    const event = recent.find(item => item.kind === 'note' && item.note_kind === kind);
    if (event) add(event.observed || event.text, kind);
  }
  for (const item of detail.constraints || []) add(item.statement || item.text, 'constraint');
  const unique = items => [...new Set(items)];
  return { features: unique(features), verification: unique(verification).filter(item => !features.includes(item)),
    limits: unique(limits) };
}
export function composeFactDocument(title, sources) {
  return [`# ${title}`, '', '완료한 작업의 구현 결과와 확인된 사실을 원문 기록에서 추렸습니다.',
    ...sources.flatMap(({ id, detail, events }) => {
      const facts = extractWorktrailFacts(detail, events);
      return [...(sources.length > 1 ? ['', `## ${detail.title || '완료 작업'}`] : []),
        ...(facts.features.length ? ['', '### 구현된 기능', ...facts.features.map(item => `- ${item}`)] : []),
        ...(facts.verification.length ? ['', '### 확인된 사실·검증', ...facts.verification.map(item => `- ${item}`)] : []),
        ...(facts.limits.length ? ['', '### 제약·검증 범위', ...facts.limits.map(item => `- ${item}`)] : []),
        ...(!facts.features.length && !facts.verification.length
          ? ['', '확정된 구현 내용이나 검증 결과가 기록되어 있지 않습니다. 원문을 확인해 사실을 보완해 주세요.'] : []),
        '', `출처: Worktrail 작업 #${id} · http://127.0.0.1:8796/#/threads/${id}`];
    })].join('\n');
}

const validId = value => typeof value === 'string' && /^[0-9a-f-]{36}$/u.test(value);
function text(value, label, max) {
  if (typeof value !== 'string' || !value.trim() || value.length > max || value.includes('\0'))
    throw new Error(`${label}을 확인해 주세요.`);
  return value.trim();
}
export function createWorktrailDocuments({ store, worktrail, bridge, uuid = randomUUID, now = () => new Date().toISOString() }) {
  let queue = Promise.resolve();
  const locked = operation => { const result = queue.then(operation); queue = result.catch(() => {}); return result; };
  const all = () => store.getSetting('worktrailDocuments') || [];
  const get = id => {
    if (!validId(id)) throw new Error('문서 번호를 확인해 주세요.');
    const doc = all().find(item => item.id === id);
    if (!doc) throw new Error('문서를 찾을 수 없습니다.');
    return doc;
  };
  const put = async doc => {
    const rows = all(), index = rows.findIndex(item => item.id === doc.id);
    if (index < 0) rows.unshift(doc); else rows[index] = doc;
    await store.setSetting('worktrailDocuments', rows);
    return doc;
  };
  const revision = input => {
    const doc = get(input?.id);
    if (input.revision !== doc.revision) throw new Error('문서가 다른 창에서 변경됐습니다. 다시 불러와 주세요.');
    return doc;
  };
  return {
    list: () => all().map(({ content, ...metadata }) => metadata), get,
    create: input => locked(async () => {
      if (!input || !Array.isArray(input.caseIds) || input.caseIds.length < 1 || input.caseIds.length > 20
        || input.caseIds.some(id => !Number.isSafeInteger(id) || id <= 0)) throw new Error('작업을 1~20개 선택해 주세요.');
      const ids = [...new Set(input.caseIds)];
      const review = await worktrail.review();
      const sources = await Promise.all(ids.map(async id => {
        const detail = await worktrail.thread(id);
        if (!completed(detail.status)) throw new Error('완료 처리한 작업만 문서로 만들 수 있습니다.');
        return { id, detail, events: review.cases[String(id)]?.events || [] };
      }));
      const title = text(input.title || sources[0].detail.title || 'Worktrail 작업 문서', '제목', 180);
      const content = text(composeFactDocument(title, sources), '본문', 200_000);
      const id = uuid();
      return put({ id, slug: `worktrail-${id.replaceAll('-', '')}`, title, content, revision: 1,
        status: 'draft', createdAt: now(), updatedAt: now(), templateVersion: 2,
        sources: sources.map(({ id, detail }) => ({ id, title: detail.title || '작업' })) });
    }),
    remove: input => locked(async () => {
      const doc = revision(input);
      if (input.confirm !== true) throw new Error('초안 삭제를 확인해 주세요.');
      if (doc.status !== 'draft') throw new Error('전송 중이거나 승인 요청한 문서는 삭제할 수 없습니다.');
      await store.setSetting('worktrailDocuments', all().filter(item => item.id !== doc.id));
      return { deleted: true, id: doc.id };
    }),
    save: input => locked(async () => {
      const doc = revision(input);
      if (doc.status !== 'draft') throw new Error('전송한 문서는 수정할 수 없습니다. 선택 기록으로 새 문서를 만들어 주세요.');
      return put({ ...doc, title: text(input.title, '제목', 180), content: text(input.content, '본문', 200_000),
        revision: doc.revision + 1, updatedAt: now() });
    }),
    submit: input => locked(async () => {
      const doc = revision(input);
      if (input.confirm !== true) throw new Error('CloudWiki 승인 요청을 확인해 주세요.');
      if (doc.status === 'submitted') return doc;
      const sending = { ...doc, status: 'sending', updatedAt: now(), error: null };
      await put(sending);
      try {
        const result = await bridge.call('wiki.submit', { slug: doc.slug, title: doc.title, content: doc.content, confirm: true });
        if (result?.submitted !== true || result.slug !== doc.slug
          || !Number.isSafeInteger(result.draft_id) || result.draft_id <= 0)
          throw new Error('CloudWiki의 승인 요청 결과를 확인하지 못했습니다.');
        return await put({ ...sending, status: 'submitted', remoteDraftId: result.draft_id,
          submittedAt: now(), updatedAt: now() });
      } catch {
        await put({ ...sending, status: 'uncertain',
          error: '전송 결과를 확인하지 못했습니다. 같은 문서로 다시 확인하면 기존 초안을 찾아 이어서 처리합니다.',
          updatedAt: now() });
        throw new Error('CloudWiki 전송 결과를 확인하지 못했습니다. 문서를 다시 선택해 상태 확인·재시도해 주세요.');
      }
    }),
  };
}
