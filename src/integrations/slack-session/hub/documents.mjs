import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { composeSessionDocument } from './projection.mjs';
function content(value, max, label) {
  if (typeof value !== 'string' || !value.trim() || value.length > max || value.includes('\0')) {
    throw Object.assign(new Error(`${label}을 확인해 주세요.`), { status: 400 });
  }
  return value.trim();
}
export async function createHubDocuments({ file, wiki, now = () => new Date().toISOString() }) {
  let rows = [];
  try {
    rows = JSON.parse(await fs.readFile(file, 'utf8'));
    if (!Array.isArray(rows) || rows.some((row) => !row.id || !row.sessionId
      || !Number.isSafeInteger(row.revision) || !['draft', 'sending', 'uncertain', 'submitted'].includes(row.status))) {
      throw new Error('공유실 문서 저장 형식이 다릅니다. 원본 파일은 보존됩니다.');
    }
  } catch (error) { if (error.code !== 'ENOENT') throw error; }
  let chain = Promise.resolve();
  const locked = (run) => { const result = chain.then(run); chain = result.catch(() => {}); return result; };
  const put = async (doc) => {
    const next = rows.filter((row) => row.id !== doc.id).concat(doc);
    await fs.mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
    const temporary = `${file}.${randomUUID()}.tmp`;
    try {
      await fs.writeFile(temporary, JSON.stringify(next), { mode: 0o600, flag: 'wx' });
      await fs.rename(temporary, file); rows = next;
    } finally { await fs.rm(temporary, { force: true }); }
    return structuredClone(doc);
  };
  const get = (sessionId, id) => {
    const doc = rows.find((row) => row.id === id && row.sessionId === sessionId);
    if (!doc) throw Object.assign(new Error('이 세션의 문서를 찾을 수 없습니다.'), { status: 404 });
    return doc;
  };
  const revision = (sessionId, input) => {
    const doc = get(sessionId, input.id);
    if (input.revision !== doc.revision) throw Object.assign(new Error('다른 창에서 문서가 변경됐습니다. 다시 불러와 주세요.'), { status: 409 });
    return doc;
  };
  return {
    list: (sessionId) => structuredClone(rows.filter((row) => row.sessionId === sessionId)),
    create: (snapshot) => locked(() => {
      const id = randomUUID();
      return put({ id, sessionId: snapshot.id, slug: `worktrail-${id.replaceAll('-', '')}`,
        title: content(snapshot.title, 180, '제목'), content: content(composeSessionDocument(snapshot), 200_000, '본문'),
        revision: 1, status: 'draft', createdAt: now(), updatedAt: now() });
    }),
    save: (sessionId, input) => locked(() => {
      const doc = revision(sessionId, input);
      if (doc.status !== 'draft') throw Object.assign(new Error('전송을 시작한 문서는 수정할 수 없습니다. 새 초안을 만들어 주세요.'), { status: 409 });
      return put({ ...doc, title: content(input.title, 180, '제목'), content: content(input.content, 200_000, '본문'),
        revision: doc.revision + 1, updatedAt: now() });
    }),
    submit: (sessionId, input) => locked(async () => {
      const doc = revision(sessionId, input);
      if (input.confirm !== true) throw Object.assign(new Error('검토한 문서의 승인 요청을 명시적으로 확인해 주세요.'), { status: 400 });
      if (doc.status === 'submitted') return structuredClone(doc);
      const sending = await put({ ...doc, status: 'sending', updatedAt: now() });
      try {
        const result = await wiki('submit', { slug: doc.slug, title: doc.title, content: doc.content, confirm: true });
        if (result?.submitted !== true || result.slug !== doc.slug || !Number.isSafeInteger(result.draft_id) || result.draft_id <= 0) {
          throw new Error('CloudWiki 승인 요청 결과가 일치하지 않습니다.');
        }
        return await put({ ...sending, status: 'submitted', remoteDraftId: result.draft_id, updatedAt: now() });
      } catch {
        await put({ ...sending, status: 'uncertain', updatedAt: now() });
        throw Object.assign(new Error('전송 결과가 불확실합니다. 같은 문서로 상태 확인·재시도하면 기존 초안을 찾아 이어갑니다.'), { status: 502 });
      }
    }),
  };
}
