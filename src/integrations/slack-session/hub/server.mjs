import http from 'node:http';
import https from 'node:https';
import fs from 'node:fs/promises';
import { HubAccess, allowedAddress } from './access.mjs';
import { slackSessionOwners } from '../identity.mjs';
import { createHubDocuments } from './documents.mjs';
import { redactToolCallArgumentsValue } from '../../../runtime/agent/orchestrator/session/compact/text-utils.mjs';
const assets = new Map([
  ['/', ['public/index.html', 'text/html; charset=utf-8']],
  ['/app.js', ['public/app.js', 'text/javascript; charset=utf-8']],
  ['/boot.js', ['public/boot.js', 'text/javascript; charset=utf-8']],
  ['/style.css', ['public/style.css', 'text/css; charset=utf-8']],
  ['/records.mjs', ['records.mjs', 'text/javascript; charset=utf-8']],
  ['/favicon.ico', ['public/favicon.ico', 'image/x-icon']],
  ['/favicon-32.png', ['public/favicon-32.png', 'image/png']],
]);
const fail = (status, message) => { throw Object.assign(new Error(message), { status }); };
function subject(value) {
  if (!/^T[A-Z0-9]+$/u.test(value.teamId || '') || !/^[UW][A-Z0-9]+$/u.test(value.userId || '')) fail(400, 'Slack 워크스페이스 ID와 멤버 ID를 확인해 주세요.');
  return { teamId: value.teamId, userId: value.userId };
}
async function body(request) {
  if (!/^application\/json(?:;|$)/iu.test(request.headers['content-type'] || '')) fail(415, 'JSON 요청만 허용됩니다.');
  let size = 0; const chunks = [];
  for await (const chunk of request) {
    size += chunk.length; if (size > 900_000) fail(413, '요청 크기를 줄여 주세요.'); chunks.push(chunk);
  }
  try {
    const value = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    if (!value || typeof value !== 'object' || Array.isArray(value)) fail(400, '요청 형식을 확인해 주세요.');
    return value;
  } catch { fail(400, '요청 형식을 확인해 주세요.'); }
}
export async function createSessionHub({
  origin: address, tls, adminUsers, store, transport, authorize, sendCode, documentsFile, wiki,
  now = Date.now, log = () => {},
}) {
  let origin = new URL(address);
  if (origin.pathname !== '/' || origin.search || origin.hash || origin.username || origin.password
    || !['http:', 'https:'].includes(origin.protocol)) throw new Error('공유실 origin은 경로 없는 HTTP(S) 주소여야 합니다.');
  if (!allowedAddress(origin.hostname) || (origin.protocol !== 'https:' && !['127.0.0.1', '[::1]'].includes(origin.hostname))) {
    throw new Error('사내망 공유실은 192.168.19.x의 HTTPS 주소와 TLS 인증서가 필요합니다. HTTP는 로컬 테스트에만 허용됩니다.');
  }
  if (origin.protocol === 'https:' && (!tls?.key || !tls?.cert)) throw new Error('공유실 TLS 개인키와 인증서를 설정해 주세요.');
  if (!Array.isArray(adminUsers) || !adminUsers.length || adminUsers.some((id) => !/^T[A-Z0-9]+:[UW][A-Z0-9]+$/u.test(id))) {
    throw new Error('MIXDOG_HUB_ADMINS에 관리자 T워크스페이스ID:U멤버ID를 지정해 주세요.');
  }
  const identity = (person) => `${person.teamId}:${person.userId}`;
  const admin = (person) => adminUsers.includes(identity(person));
  const conversations = async () => (await store.listConversations()).map(([, conversation]) => conversation);
  const isApproved = (person) => authorize({ team: person.teamId, user: person.userId });
  const access = new HubAccess({ authorize: isApproved, sendCode, now });
  const documents = await createHubDocuments({ file: documentsFile, wiki });
  const snapshots = new Map();
  const index = async () => slackSessionOwners(await conversations()).map((row) =>
    ({ ...row, title: redactToolCallArgumentsValue(row.title) }));
  const owned = async (person, id) => {
    const row = (await index()).find((entry) => entry.id === id
      && entry.teamId === person.teamId && (admin(person) || entry.userId === person.userId));
    if (!row || !await isApproved({ teamId: row.teamId, userId: row.userId })) fail(404, '조회할 수 있는 세션이 아닙니다.');
    return row;
  };
  const snapshot = async (person, id) => {
    const row = await owned(person, id), value = await transport.request('hubSnapshot', { sessionId: id });
    if (value.id !== id) fail(502, '세션 응답이 일치하지 않습니다.');
    const result = { ...value, userName: row.userName, userId: row.userId, channelId: row.channelId,
      threadTs: row.threadTs, title: value.title || `${row.userName} | ${row.title}`, updatedAt: new Date(now()).toISOString() };
    snapshots.set(id, result);
    return result;
  };
  const cookie = (value, expire = false) => `softon_hub=${value}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${expire ? 0 : 28800}${origin.protocol === 'https:' ? '; Secure' : ''}`;
  const json = (response, status, value) => {
    response.writeHead(status, { 'content-type': 'application/json; charset=utf-8' }); response.end(JSON.stringify(value));
  };
  const handler = async (request, response) => {
    response.setHeader('cache-control', 'no-store');
    response.setHeader('content-security-policy', "default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'");
    response.setHeader('x-content-type-options', 'nosniff'); response.setHeader('referrer-policy', 'no-referrer');
    response.setHeader('permissions-policy', 'camera=(), microphone=(), geolocation=()');
    if (origin.protocol === 'https:') response.setHeader('strict-transport-security', 'max-age=31536000');
    try {
      const remote = request.socket.remoteAddress;
      if (!allowedAddress(remote)) fail(403, '192.168.19.0/24 사내망 또는 호스트 PC에서만 접근할 수 있습니다.');
      if (request.headers.host !== origin.host || request.headers['sec-fetch-site'] === 'cross-site') fail(403, '허용되지 않은 접속 주소입니다.');
      const url = new URL(request.url, origin);
      if (url.origin !== origin.origin) fail(403, '허용되지 않은 주소입니다.');
      if (!['GET', 'POST'].includes(request.method)) fail(405, '허용되지 않은 요청입니다.');
      if (request.method === 'POST' && request.headers.origin !== origin.origin) fail(403, '요청 출처를 확인해 주세요.');
      if (request.method === 'GET' && assets.has(url.pathname)) {
        const [file, mime] = assets.get(url.pathname), data = await fs.readFile(new URL(file, import.meta.url));
        response.writeHead(200, { 'content-type': mime }); response.end(data); return;
      }
      if (request.method === 'POST' && url.pathname === '/api/auth/challenge') {
        json(response, 200, await access.challenge(subject(await body(request)), remote)); return;
      }
      if (request.method === 'POST' && url.pathname === '/api/auth/verify') {
        const verified = await access.verify(await body(request), remote);
        response.setHeader('set-cookie', cookie(verified.token)); json(response, 200, { authenticated: true }); return;
      }
      const value = /(?:^|;\s*)softon_hub=([A-Za-z0-9_-]+)/u.exec(request.headers.cookie || '')?.[1];
      const person = await access.current(value, remote);
      if (request.method === 'POST' && request.headers['x-csrf-token'] !== person.csrf) fail(403, '요청 검증 값이 다릅니다. 새로고침해 주세요.');
      if (request.method === 'GET' && url.pathname === '/api/me') {
        json(response, 200, { teamId: person.teamId, userId: person.userId, admin: admin(person), csrf: person.csrf,
          userName: (await conversations()).find((row) => row.teamId === person.teamId && row.actorId === person.userId)?.userName,
          network: '192.168.19.0/24', expiresAt: new Date(person.expires).toISOString() }); return;
      }
      if (request.method === 'POST' && url.pathname === '/api/logout') {
        access.logout(value); response.setHeader('set-cookie', cookie('', true)); json(response, 200, { loggedOut: true }); return;
      }
      if (request.method === 'GET' && url.pathname === '/api/sessions') {
        const rows = [];
        for (const row of (await index()).filter((entry) => entry.teamId === person.teamId && (admin(person) || entry.userId === person.userId))) {
          if (await isApproved({ teamId: row.teamId, userId: row.userId })) rows.push(row);
        }
        json(response, 200, { sessions: rows }); return;
      }
      const match = /^\/api\/sessions\/([A-Za-z0-9_-]+)(?:\/(snapshot|files|documents)(?:\/([A-Za-z0-9_-]+))?(?:\/(save|submit))?)?$/u.exec(url.pathname);
      if (!match) fail(404, '페이지를 찾을 수 없습니다.');
      const [, id, section, itemId, operation] = match;
      await owned(person, id);
      if (request.method === 'GET' && !section) { json(response, 200, await snapshot(person, id)); return; }
      if (request.method === 'POST' && section === 'snapshot' && !itemId) { await body(request); json(response, 200, await snapshot(person, id)); return; }
      if (request.method === 'GET' && section === 'files' && /^[a-f0-9]{64}$/u.test(itemId || '')) {
        const file = snapshots.get(id)?.files.find((entry) => entry.id === itemId);
        if (!file) fail(404, '이 세션의 산출물이 아닙니다. 스냅샷을 먼저 확인해 주세요.');
        if (url.searchParams.get('version') !== file.sha256) fail(409, '스냅샷 이후 파일 버전이 달라졌습니다. 다시 갱신해 주세요.');
        const result = await transport.request('hubFile', { sessionId: id, fileId: itemId, sha256: file.sha256 }), data = Buffer.from(result.data, 'base64');
        response.writeHead(200, { 'content-type': 'application/octet-stream', 'content-length': data.length,
          'content-disposition': `attachment; filename*=UTF-8''${encodeURIComponent(file.path.split('/').pop())}` });
        response.end(data); return;
      }
      if (section === 'documents') {
        if (request.method === 'GET' && !itemId) { json(response, 200, { documents: documents.list(id) }); return; }
        if (request.method === 'POST') {
          const input = await body(request);
          if (!itemId) { json(response, 201, await documents.create(await snapshot(person, id))); return; }
          if (operation === 'save') { json(response, 200, await documents.save(id, { ...input, id: itemId })); return; }
          if (operation === 'submit') { json(response, 200, await documents.submit(id, { ...input, id: itemId })); return; }
        }
      }
      fail(404, '요청을 찾을 수 없습니다.');
    } catch (error) {
      if (response.headersSent) { response.destroy(); return; }
      if (!error.status) log(`공유실 요청 실패: ${error.message}`);
      json(response, error.status || 502, { error: error.status ? error.message : '연결 상태를 확인하지 못했습니다. 기존 화면은 유지됩니다. 잠시 후 다시 갱신해 주세요.' });
    }
  };
  const server = origin.protocol === 'https:' ? https.createServer(tls, handler) : http.createServer(handler);
  server.requestTimeout = 30_000; server.headersTimeout = 15_000; server.maxConnections = 100;
  return { handler,
    async start() {
      await new Promise((resolve, reject) => {
        server.once('error', reject);
        server.listen(Number(origin.port || (origin.protocol === 'https:' ? 443 : 80)),
          origin.hostname.replace(/^\[|\]$/gu, ''), () => { server.off('error', reject); resolve(); });
      });
      if (origin.port === '0') origin.port = String(server.address().port);
      log(`SOFTON 공유실: ${origin.origin} (사내망 + Slack 본인 인증)`); return origin.origin;
    },
    async close() {
      server.closeAllConnections();
      if (server.listening) await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    },
  };
}
