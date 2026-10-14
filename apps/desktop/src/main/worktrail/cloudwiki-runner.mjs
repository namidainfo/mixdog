// The same source runs in WSL and in isolated protocol tests. It is embedded
// in the desktop bundle, so no extra service, extracted ASAR or raw loader is needed.
const cloudwikiRunner = String.raw`
// Runs inside the existing WSL user. Credentials never cross stdout or IPC.
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { homedir } from 'node:os';

export function createCloudWiki({ home, request = fetch, read = readFile }) {
  async function configuration() {
    const file = join(home, '.local/state/knowledge-promoter/cloudwiki.env');
    const env = {};
    try {
      for (const line of (await read(file, 'utf8')).split(/\r?\n/u)) {
        const match = /^(?:export\s+)?(KNOWLEDGE_PROMOTER_CLOUDWIKI_(?:URL|TOKEN))\s*=\s*(.*?)\s*$/u.exec(line);
        if (match) env[match[1]] = match[2].replace(/^(['"])(.*)\1$/u, '$2');
      }
    } catch { throw new Error('CloudWiki 연결 설정을 찾을 수 없습니다. WSL의 cloudwiki.env를 확인해 주세요.'); }
    const url = env.KNOWLEDGE_PROMOTER_CLOUDWIKI_URL, token = env.KNOWLEDGE_PROMOTER_CLOUDWIKI_TOKEN;
    if (!url || !token) throw new Error('CloudWiki 연결 설정이 비어 있습니다.');
    const parsed = new URL(url);
    if (parsed.username || parsed.password
      || (parsed.protocol !== 'https:' && !(parsed.protocol === 'http:' && ['127.0.0.1', 'localhost', '[::1]'].includes(parsed.hostname))))
      throw new Error('CloudWiki 연결 주소를 확인해 주세요.');
    return { url, token };
  }
  async function call(name, args) {
    const { url, token } = await configuration();
    let failure = 'CloudWiki 연결 또는 요청 결과를 확인하지 못했습니다.';
    try {
      const response = await request(url, {
        method: 'POST', redirect: 'error', signal: AbortSignal.timeout(20_000),
        headers: { authorization: 'Bearer ' + token, 'content-type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } }),
      });
      if (!response.ok) {
        failure = 'CloudWiki 요청 실패 (HTTP ' + response.status + '). 연결 설정과 접근 권한을 확인해 주세요.';
        throw new Error('http');
      }
      const raw = await response.text();
      if (raw.length > 2_000_000 || raw.includes(token)) throw new Error('invalid');
      const outer = JSON.parse(raw), result = outer.result;
      if (outer.error || !result || result.isError) throw new Error('rpc');
      const blocks = result.content?.filter(item => item.type === 'text');
      if (!blocks?.length || blocks.some(item => typeof item.text !== 'string' || item.text.startsWith('Error:')))
        throw new Error('result');
      return JSON.parse(blocks[0].text);
    } catch { throw new Error(failure); }
  }
  function drafts(value) {
    if (!Array.isArray(value) || value.some(row => !Number.isSafeInteger(row.draft_id) || row.draft_id <= 0
      || typeof row.slug !== 'string' || !['draft', 'pending_approval'].includes(row.status)))
      throw new Error('CloudWiki 초안 목록 형식을 확인해 주세요.');
    return value;
  }
  const identity = (value, slug, id) => {
    if (value?.slug !== slug || !Number.isSafeInteger(value.draft_id) || value.draft_id <= 0
      || (id && value.draft_id !== id)) throw new Error('CloudWiki 초안 번호가 일치하지 않습니다.');
    return value;
  };
  return {
    async status() {
      const rows = drafts(await call('list_drafts', {}));
      return { connected: true, pending: rows.filter(row => row.status === 'pending_approval').length };
    },
    async submit(input) {
      if (input?.confirm !== true || !/^worktrail-[0-9a-f]{32}$/u.test(input.slug || '')
        || typeof input.title !== 'string' || !input.title.trim() || input.title.length > 180
        || typeof input.content !== 'string' || !input.content.trim()
        || input.content.length > 200_000 || input.content.includes('\0'))
        throw new Error('CloudWiki 문서 요청을 확인해 주세요.');
      const matches = drafts(await call('list_drafts', {})).filter(row => row.slug === input.slug);
      if (matches.length > 1) throw new Error('같은 문서의 초안이 여러 개입니다. CloudWiki에서 확인해 주세요.');
      let draft = matches[0];
      if (draft?.status === 'pending_approval') return { ...draft, submitted: true };
      if (!draft) draft = identity(await call('create_or_update_page', {
        title: input.slug, display_title: input.title, content: input.content, create_only: true, category: '개발 기록',
      }), input.slug);
      const result = identity(await call('commit_edit', {
        draft_id: draft.draft_id, summary: 'Worktrail 기록을 검토한 개발 문서',
      }), input.slug, draft.draft_id);
      if (result.submitted !== true) throw new Error('CloudWiki 승인 대기 상태를 확인하지 못했습니다.');
      return { slug: input.slug, draft_id: draft.draft_id, submitted: true };
    },
  };
}

if (process.argv.includes('--worktrail-cloudwiki')) {
  try {
    let raw = '';
    for await (const chunk of process.stdin) {
      raw += chunk;
      if (raw.length > 1_000_000) throw new Error('CloudWiki 요청 크기를 확인해 주세요.');
    }
    const { action, input } = JSON.parse(raw);
    const wiki = createCloudWiki({ home: homedir() });
    if (!['status', 'submit'].includes(action)) throw new Error('CloudWiki 작업을 확인해 주세요.');
    const result = action === 'status' ? await wiki.status() : await wiki.submit(input);
    process.stdout.write(JSON.stringify({ result }));
  } catch (error) {
    process.stdout.write(JSON.stringify({ error: error.message }));
    process.exitCode = 1;
  }
}
`;
export default cloudwikiRunner;
