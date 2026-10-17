import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import test from 'node:test';
import { SlackMixdogRelay } from './relay.mjs';
import { questionResponse, rotationReason } from './controls.mjs';
import { NativeSlackClient, slackSessionState } from './native-client.mjs';

class MemoryStore {
  constructor() { this.values = new Map(); }
  async load() {}
  getConversation(key) { return this.values.get(key) || null; }
  listConversations() { return [...this.values]; }
  async setConversation(key, value) { this.values.set(key, value); return value; }
}

class FakeTransport extends EventEmitter {
  constructor(backend = new Map()) {
    super();
    this.backend = backend;
    this.calls = [];
    this.next = backend.size;
  }
  async start() {}
  async close() {}
  async request(method, params = {}) {
    this.calls.push({ method, params: structuredClone(params) });
    if (method === 'open') {
      const sessionId = params.sessionId || `native-${++this.next}`;
      if (!this.backend.has(sessionId)) {
        this.backend.set(sessionId, {
          sessionId, provider: 'openai-oauth', model: 'gpt-6.1-sol', effort: 'ultra',
          contextWindow: 500000, busy: false, queued: [], items: [], toolApproval: null, userQuestion: null,
        });
      }
      return { sessionId, state: structuredClone(this.backend.get(sessionId)) };
    }
    const state = this.backend.get(params.sessionId);
    if (method === 'context') {
      return { usedTokens: state.usedTokens || 0, contextWindow: 500000, effectiveContextWindow: 500000,
        compaction: { triggerTokens: state.triggerTokens || 500000 }, nextPromptTokens: 10, usedSource: 'provider' };
    }
    if (method === 'state') return { state: structuredClone(state) };
    if (method === 'submit') {
      state.busy = true;
      state.items.push({ kind: 'user', id: `user-${params.requestId}`, messageId: `msg-${params.requestId}`, text: params.prompt });
      return { accepted: true, state: structuredClone(state) };
    }
    if (method === 'abort') { state.busy = false; return { aborted: true, state: structuredClone(state) }; }
    if (method === 'approve') { state.toolApproval = null; return { accepted: true }; }
    if (method === 'answer') { state.userQuestion = null; return { accepted: true }; }
    if (method === 'release') return { released: true };
    throw new Error(`unexpected method ${method}`);
  }
  publish(sessionId) { this.emit('state', { sessionId, state: structuredClone(this.backend.get(sessionId)) }); }
  complete(sessionId, text, status = 'done') {
    const state = this.backend.get(sessionId);
    const user = state.items.findLast((item) => item.kind === 'user');
    const suffix = user.id;
    state.items.push(
      { kind: 'assistant', id: `answer-${suffix}`, messageId: `answer-msg-${suffix}`, text },
      { kind: 'turndone', id: `done-${suffix}`, checkpointId: user.id, status, finalAssistantId: `answer-${suffix}` },
    );
    state.busy = false;
    this.publish(sessionId);
  }
}

function harness({ store = new MemoryStore(), transport = new FakeTransport(), maxTurns = 12, post, now = Date.now } = {}) {
  let generation = 0;
  const sent = [];
  const api = {
    createConversation: (identity) => ({
      logicalSessionId: `logical-${++generation}`, generation: 1, turnCount: 0,
      actorId: identity.userId, userName: identity.userName, teamId: identity.teamId,
      channelId: identity.channelId, threadTs: identity.threadTs, summary: '', recentTurns: [],
    }),
    rotateConversation: (previous, identity, limits, { clear }) => ({
      ...api.createConversation(identity), generation: previous.generation + 1,
      summary: clear ? '' : `carry:${previous.recentTurns.map((turn) => turn.assistant).join('|')}`,
    }),
    appendConversationTurn: (previous, turn) => ({
      ...structuredClone(previous), turnCount: previous.turnCount + 1, recentTurns: [...previous.recentTurns, turn],
    }),
    parseNewSessionCommand: (text) => /^!restart$/i.test(text) || /^!new clear$/i.test(text)
      ? { clear: true } : /^!new$/i.test(text) ? { clear: false } : null,
  };
  const relay = new SlackMixdogRelay({
    config: {
      cwd: 'C:/test', provider: 'openai-oauth', model: 'gpt-6.1-sol', effort: 'ultra', contextTokens: 500000,
      maxTurns, timeoutMs: 900000, pollIntervalMs: 3600000, maxPromptChars: 30000,
      messageIntervalMs: 0, conversationLimits: { maxSummaryChars: 6000 },
    },
    store, transport, api, now,
    authorize: (message) => message.user === 'approved-user' && message.channel === 'allowed-channel' && !message.bot_id,
    extractPrompt: (message) => message.text,
    resolveIdentity: async () => 'Test user',
    loadAttachments: async () => [],
    chunkText: (text) => [text],
    postMessage: async (payload) => {
      if (post) await post(payload);
      sent.push(structuredClone(payload));
      return { ok: true, ts: `posted-${sent.length}` };
    },
  });
  const message = (text, ts, thread = 'thread-a', extra = {}) => ({
    team: 'test-team', channel: 'allowed-channel', user: 'approved-user', thread_ts: thread, ts, text, ...extra,
  });
  const conversation = (thread = 'thread-a', user = 'approved-user') => store.getConversation(`slack:test-team:allowed-channel:${thread}:${user}`);
  return { relay, store, transport, sent, message, conversation };
}

test('rotated native IDs remain in the same owner history', async () => {
  const h = harness();
  await h.relay.start();
  await h.relay.handleMessage(h.message('first', '1'), 'bot');
  const previous = h.conversation().nativeSessionId;
  h.transport.complete(previous, '완료');
  await h.relay.idle();
  await h.relay.handleMessage(h.message('!new', '2'), 'bot');
  assert.ok(h.conversation().nativeSessionHistory.includes(previous));
  assert.notEqual(h.conversation().nativeSessionId, previous);
  assert.equal(h.conversation().actorId, 'approved-user');
  await h.relay.close();
});

test('authorization and bot-loop prevention run before any session or state mutation', async () => {
  const h = harness();
  await h.relay.start();
  assert.equal(await h.relay.handleMessage(h.message('prompt', '1', 'thread-a', { user: 'stranger' }), 'bot'), false);
  assert.equal(await h.relay.handleMessage(h.message('prompt', '2', 'thread-a', { bot_id: 'bot' }), 'bot'), false);
  assert.equal(h.store.listConversations().length, 0);
  assert.equal(h.transport.calls.length, 0);
  await h.relay.close();
});

test('a prompt runs once, its final answer returns only to its thread and only completed requests count as turns', async () => {
  const h = harness();
  await h.relay.start();
  const event = h.message('first prompt', '1');
  await h.relay.handleMessage(event, 'bot');
  await h.relay.handleMessage(event, 'bot');
  const sessionId = h.conversation().nativeSessionId;
  assert.equal(h.transport.calls.filter((call) => call.method === 'submit').length, 1);
  assert.equal(h.conversation().turnCount, 0);
  h.transport.complete(sessionId, 'actual final answer');
  await h.relay.idle();
  h.transport.publish(sessionId);
  await h.relay.idle();
  assert.equal(h.conversation().turnCount, 1);
  assert.equal(h.sent.filter((message) => message.text === 'actual final answer').length, 1);
  assert.ok(h.sent.every((message) => message.channel === 'allowed-channel' && message.thread_ts === 'thread-a'));
  assert.ok(h.sent.some((message) => message.text.includes('턴: 1/12')));
  await h.relay.close();
});

test('threads stay isolated and a queued prompt cannot overtake the active prompt', async () => {
  const h = harness();
  await h.relay.start();
  await h.relay.handleMessage(h.message('first', '1'), 'bot');
  await h.relay.handleMessage(h.message('second', '2'), 'bot');
  await h.relay.handleMessage(h.message('other thread', '3', 'thread-b'), 'bot');
  assert.notEqual(h.conversation().nativeSessionId, h.conversation('thread-b').nativeSessionId);
  assert.equal(h.transport.calls.filter((call) => call.method === 'submit').length, 2);
  h.transport.complete(h.conversation().nativeSessionId, 'first answer');
  await h.relay.idle();
  const submits = h.transport.calls.filter((call) => call.method === 'submit');
  assert.equal(submits.length, 3);
  assert.match(submits.at(-1).params.prompt, /second/);
  await h.relay.close();
});

test('approved users in the same thread have separate sessions, histories and controls', async () => {
  const h = harness();
  h.relay.authorize = (message) => ['approved-user', 'second-user'].includes(message.user);
  h.relay.resolveIdentity = async (user) => user === 'approved-user' ? 'softon_박수한' : 'softon_김민지';
  await h.relay.start();
  await h.relay.handleMessage(h.message('연결 폴더의 최신 프로젝트', '1'), 'bot');
  await h.relay.handleMessage(h.message('내 문서 정리', '2', 'thread-a', { user: 'second-user' }), 'bot');
  const first = h.conversation();
  const second = h.conversation('thread-a', 'second-user');
  assert.notEqual(first.nativeSessionId, second.nativeSessionId);
  assert.deepEqual(h.transport.calls.filter((call) => call.method === 'open' && !call.params.sessionId).map((call) => call.params), [
    { userName: 'softon_박수한', title: '연결 폴더의 최신 프로젝트', principal: { teamId: 'test-team', userId: 'approved-user' } },
    { userName: 'softon_김민지', title: '내 문서 정리', principal: { teamId: 'test-team', userId: 'second-user' } },
  ]);
  const secondPrompt = h.transport.calls.filter((call) => call.method === 'submit').at(-1).params.prompt;
  assert.ok(!secondPrompt.includes('연결 폴더의 최신 프로젝트'));
  h.transport.backend.get(first.nativeSessionId).toolApproval = { id: 'first-only' };
  await h.relay.handleMessage(h.message('!approve first-only', '3', 'thread-a', { user: 'second-user' }), 'bot');
  assert.equal(h.transport.calls.filter((call) => call.method === 'approve').length, 0);
  await h.relay.handleMessage(h.message('!stop', '4', 'thread-a', { user: 'second-user' }), 'bot');
  assert.deepEqual(h.transport.calls.filter((call) => call.method === 'abort').map((call) => call.params.sessionId), [second.nativeSessionId]);
  assert.ok(h.conversation().activeRequestId);
  await h.relay.close();
});

test('legacy thread records remain intact and cannot become a new user session', async () => {
  const h = harness();
  const key = 'slack:test-team:allowed-channel:thread-a';
  const legacy = h.relay.fresh({
    userId: 'legacy-user', userName: 'Legacy user', teamId: 'test-team',
    channelId: 'allowed-channel', threadTs: 'thread-a',
  });
  legacy.summary = 'legacy private history';
  await h.store.setConversation(key, legacy);
  const original = structuredClone(legacy);
  await h.relay.start();
  await h.relay.handleMessage(h.message('new private work', '1'), 'bot');
  assert.deepEqual(h.store.getConversation(key), original);
  assert.equal(h.conversation().summary, '');
  assert.ok(!h.transport.calls.find((call) => call.method === 'submit').params.prompt.includes('legacy private history'));
  await h.relay.close();
});

test('!new carries a bounded summary, !restart does not, and stale completion cannot enter the replacement session', async () => {
  const h = harness();
  await h.relay.start();
  await h.relay.handleMessage(h.message('first', '1'), 'bot');
  const old = h.conversation().nativeSessionId;
  h.transport.complete(old, 'first answer');
  await h.relay.idle();
  await h.relay.handleMessage(h.message('!new', '2'), 'bot');
  assert.match(h.conversation().summary, /first answer/);
  assert.equal(h.conversation().turnCount, 0);
  assert.ok(h.conversation().nativeSessionId);
  assert.notEqual(h.conversation().nativeSessionId, old);
  await h.relay.handleMessage(h.message('continued', '3'), 'bot');
  const current = h.conversation().nativeSessionId;
  assert.notEqual(current, old);
  assert.match(h.transport.calls.filter((call) => call.method === 'submit').at(-1).params.prompt, /carry:first answer/);
  await h.relay.handleMessage(h.message('!restart', '4'), 'bot');
  assert.equal(h.conversation().summary, '');
  h.transport.complete(current, 'must not be forwarded');
  await h.relay.idle();
  assert.ok(!h.sent.some((message) => message.text === 'must not be forwarded'));
  assert.equal(h.conversation().turnCount, 0);
  await h.relay.close();
});

test('turn cap rotates before the following request, without replaying whole history', async () => {
  const h = harness({ maxTurns: 1 });
  await h.relay.start();
  await h.relay.handleMessage(h.message('first', '1'), 'bot');
  const old = h.conversation().nativeSessionId;
  h.transport.complete(old, 'first answer');
  await h.relay.idle();
  await h.relay.handleMessage(h.message('second', '2'), 'bot');
  assert.notEqual(h.conversation().nativeSessionId, old);
  assert.equal(h.conversation().generation, 2);
  assert.equal(h.conversation().turnCount, 0);
  assert.ok(h.sent.some((message) => message.text.includes('턴 제한')));
  await h.relay.close();
});

test('rotation uses the current native input budget, not the old character-limit or model display value', () => {
  const conversation = { turnCount: 2 };
  const context = { usedTokens: 190, nextPromptTokens: 11, contextWindow: 500000, effectiveContextWindow: 300000, compaction: { triggerTokens: 200 } };
  assert.equal(rotationReason(conversation, context, 12), 'context-budget');
  assert.equal(rotationReason(conversation, { ...context, usedTokens: 180 }, 12), '');
  assert.equal(rotationReason({ turnCount: 12 }, { ...context, usedTokens: 0 }, 12), 'turn-limit');
});

test('!stop cancels this thread and its local queue without cancelling another thread', async () => {
  const h = harness();
  await h.relay.start();
  await h.relay.handleMessage(h.message('running', '1'), 'bot');
  await h.relay.handleMessage(h.message('queued', '2'), 'bot');
  await h.relay.handleMessage(h.message('other', '3', 'thread-b'), 'bot');
  const sessionId = h.conversation().nativeSessionId;
  await h.relay.handleMessage(h.message('!stop', '4'), 'bot');
  assert.equal(h.conversation().queue.length, 0);
  assert.equal(h.conversation().activeRequestId, null);
  assert.deepEqual(h.transport.calls.filter((call) => call.method === 'abort').map((call) => call.params.sessionId), [sessionId]);
  h.transport.complete(sessionId, 'late answer');
  await h.relay.idle();
  assert.ok(!h.sent.some((message) => message.text === 'late answer'));
  assert.ok(h.conversation('thread-b').activeRequestId);
  await h.relay.close();
});

test('pending approvals require the exact thread-bound ID and are never automatically approved', async () => {
  const h = harness();
  await h.relay.start();
  await h.relay.handleMessage(h.message('prompt', '1'), 'bot');
  const session = h.transport.backend.get(h.conversation().nativeSessionId);
  session.toolApproval = { id: 'approval-a', name: 'shell', args: { command: 'test' }, reason: 'confirm', cwd: 'C:/test' };
  h.transport.publish(session.sessionId);
  await h.relay.idle();
  assert.equal(h.transport.calls.filter((call) => call.method === 'approve').length, 0);
  await h.relay.handleMessage(h.message('!approve wrong-id', '2'), 'bot');
  assert.equal(h.transport.calls.filter((call) => call.method === 'approve').length, 0);
  await h.relay.handleMessage(h.message('!deny approval-a', '3'), 'bot');
  assert.equal(h.transport.calls.find((call) => call.method === 'approve').params.approved, false);
  await h.relay.close();
});

test('plain replies answer a single pending question instead of starting another model turn', async () => {
  const h = harness();
  await h.relay.start();
  await h.relay.handleMessage(h.message('prompt', '1'), 'bot');
  const state = h.transport.backend.get(h.conversation().nativeSessionId);
  state.userQuestion = { id: 'question-a', questions: [{ id: 'choice', question: 'Choose', options: [{ label: 'A' }, { label: 'B' }] }] };
  h.transport.publish(state.sessionId);
  await h.relay.idle();
  await h.relay.handleMessage(h.message('2', '2'), 'bot');
  assert.deepEqual(h.transport.calls.find((call) => call.method === 'answer').params.response, {
    cancelled: false, answers: { choice: { option: 1 } },
  });
  assert.equal(h.transport.calls.filter((call) => call.method === 'submit').length, 1);
  assert.throws(() => questionResponse({ questions: [{ id: 'a' }, { id: 'b' }] }, 'ambiguous'), /JSON/);
  await h.relay.close();
});

test('a service restart reattaches an accepted request and delivers its answer without submitting it again', async () => {
  const first = harness();
  await first.relay.start();
  await first.relay.handleMessage(first.message('prompt', '1'), 'bot');
  const sessionId = first.conversation().nativeSessionId;
  await first.relay.close();
  const transport = new FakeTransport(first.transport.backend);
  const second = harness({ store: first.store, transport });
  transport.complete(sessionId, 'answer after restart');
  await second.relay.start();
  await second.relay.idle();
  assert.equal(transport.calls.filter((call) => call.method === 'submit').length, 0);
  assert.equal(second.sent.filter((message) => message.text === 'answer after restart').length, 1);
  assert.equal(second.conversation().turnCount, 1);
  await second.relay.close();
});

test('ambiguous Slack delivery is not retried; operator status remains available and a bot receipt reconciles it', async () => {
  let fail = true;
  const h = harness({ post: async (payload) => {
    if (payload.text === 'final answer' && fail) { fail = false; throw new Error('connection lost after posting'); }
  } });
  await h.relay.start();
  await h.relay.handleMessage(h.message('prompt', '1'), 'bot');
  const id = h.conversation().nativeSessionId;
  h.transport.complete(id, 'final answer');
  await h.relay.idle();
  const uncertain = h.conversation().outbox.find((item) => item.text === 'final answer');
  assert.equal(uncertain.status, 'uncertain');
  await h.relay.tick();
  assert.equal(uncertain.status, 'uncertain');
  await h.relay.handleMessage(h.message('!status', '2'), 'bot');
  assert.ok(h.sent.some((message) => message.text.includes('전송 실패·확인 불가')));
  await h.relay.observeDelivery(h.message('final answer', 'bot-ts', 'thread-a', {
    user: 'bot', metadata: { event_type: 'mixdog_slack_bridge', event_payload: { delivery_id: uncertain.id } },
  }), 'bot');
  await h.relay.idle();
  assert.equal(h.conversation().outbox.find((item) => item.id === uncertain.id).status, 'sent');
  assert.equal(h.conversation().turnCount, 1);
  await h.relay.close();
});

test('bot receipts reconcile the owner session and cannot cross a Slack thread', async () => {
  const h = harness({ post: async (payload) => {
    if (payload.text === 'answer') throw new Error('uncertain delivery');
  } });
  await h.relay.start();
  await h.relay.handleMessage(h.message('work', '1'), 'bot');
  h.transport.complete(h.conversation().nativeSessionId, 'answer');
  await h.relay.idle();
  const item = h.conversation().outbox.find((entry) => entry.text === 'answer');
  const receipt = h.message('answer', 'receipt', 'thread-b', {
    user: 'bot', metadata: { event_type: 'mixdog_slack_bridge', event_payload: { delivery_id: item.id } },
  });
  assert.equal(await h.relay.observeDelivery(receipt, 'bot'), false);
  assert.equal(item.status, 'uncertain');
  assert.equal(await h.relay.observeDelivery({ ...receipt, thread_ts: 'thread-a' }, 'bot'), true);
  assert.equal(h.conversation().outbox.find((entry) => entry.id === item.id).status, 'sent');
  await h.relay.close();
});

test('native failures and empty successes are reported as errors and do not consume a completed turn', async () => {
  const h = harness();
  await h.relay.start();
  await h.relay.handleMessage(h.message('prompt', '1'), 'bot');
  h.transport.complete(h.conversation().nativeSessionId, '', 'error');
  await h.relay.idle();
  assert.equal(h.conversation().turnCount, 0);
  assert.ok(h.sent.some((message) => message.text.includes('error 상태')));
  await h.relay.close();
});

test('public projections exclude reasoning and streaming content and redact approval secrets', () => {
  const state = slackSessionState({
    sessionId: 'session', items: [
      { kind: 'thinking', text: 'private reasoning' },
      { kind: 'assistant', text: 'partial', streaming: true },
      { kind: 'assistant', text: 'analysis', channel: 'analysis' },
      { kind: 'assistant', id: 'final', messageId: 'm-final', text: 'public answer' },
    ],
    toolApproval: { id: 'approval', name: 'tool', args: { api_key: 'private-key', normal: 'visible' } },
  });
  assert.deepEqual(state.items.map((item) => item.text), ['public answer']);
  assert.equal(state.toolApproval.args.api_key, '[redacted]');
  assert.equal(state.toolApproval.args.normal, 'visible');
  const secretReply = slackSessionState({
    sessionId: 'session', items: [{ kind: 'assistant', text: '{"api_key":"not-for-slack"}' }],
  });
  assert.equal(secretReply.items[0].text, '{"api_key":"[redacted]"}');
});

test('attachments are staged in the owner workspace and oversized input fails before writing', async (t) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'slack-attachment-policy-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const client = new NativeSlackClient({
    cwd: 'C:/test', provider: 'openai-oauth', model: 'gpt-6.1-sol', effort: 'ultra',
    contextTokens: 500000, maxAttachmentBytes: 5, onState: () => {},
    hubBridge: { call: async () => ({ version: 1, teamId: 'T1', userId: 'U1',
      active: true, admin: false, root: directory }) },
  });
  const result = await client.stageFiles({
    files: [{ name: '../../outside?.txt', data: Buffer.from('hello').toString('base64'), mimetype: 'text/plain' }],
  });
  assert.equal(result.files.length, 1);
  const file = result.files[0].path;
  assert.ok(file.startsWith(path.join(directory, 'slack-users', 'T1', 'U1', 'attachments') + path.sep));
  assert.ok(path.basename(path.dirname(file)).startsWith('mixdog-slack-'));
  assert.ok(!path.basename(file).includes('?'));
  assert.equal(await fs.readFile(file, 'utf8'), 'hello');
  await assert.rejects(client.stageFiles({
    files: [{ name: 'too-large.txt', data: Buffer.from('123456').toString('base64') }],
  }), /용량 제한/);
  await client.close();
});
