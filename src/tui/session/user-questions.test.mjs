import assert from 'node:assert/strict';
import test from 'node:test';
import { createUserQuestions } from './user-questions.mjs';
import { createToolApproval } from './tool-approval.mjs';
import { normalizeUserQuestions, normalizeUserQuestionResponse } from '../../runtime/user-questions/contract.mjs';
import { executeUserQuestion, REQUEST_USER_INPUT_TOOL } from '../../runtime/user-questions/tool.mjs';
import { collectStandaloneToolDefs } from '../../runtime/agent/orchestrator/runtime-core/tool-defs.mjs';
import { filterModelToolsForProfile } from '../../runtime/agent/orchestrator/runtime-core/tool-profile.mjs';
import { _sessionForDisk } from '../../runtime/agent/orchestrator/session/store/serialize.mjs';

const questions = [
  { id: 'route', header: 'Approach', question: 'Which route?', options: [
    { label: 'Small', description: 'Keep it focused' }, { label: 'Full', description: 'Cover every path' },
  ] },
  { id: 'note', question: 'Anything else?', options: [] },
];

function harness(sessionId = 'session-a') {
  let state = { sessionId, userQuestion: null, toolApproval: null };
  let disposed = false;
  let seq = 0;
  const deps = {
    getState: () => state,
    set: (patch) => { state = { ...state, ...patch }; },
    getDisposed: () => disposed,
    nextId: () => `question-${++seq}`,
  };
  const api = createUserQuestions(deps);
  return { api, deps, state: () => state, dispose: () => { disposed = true; api.cancelAllUserQuestions('runtime closing'); } };
}

test('questions wait for explicit, complete answers and return selected labels plus custom text', async () => {
  const h = harness();
  let settled = false;
  const pending = h.api.requestUserQuestion({ sessionId: 'session-a', toolCallId: 'call-1', questions });
  pending.then(() => { settled = true; });
  await Promise.resolve();
  assert.equal(settled, false);
  const request = h.state().userQuestion;
  assert.equal(request.sessionId, 'session-a');
  assert.equal(request.toolCallId, 'call-1');
  assert.deepEqual(request.questions, questions);
  assert.equal(h.api.finishUserQuestion('stale', { cancelled: true }), false);
  for (const answers of [
    { route: { option: 0 } },
    { route: { option: 5 }, note: { text: 'note' } },
    { route: { option: 0 }, note: { text: '   ' } },
    { route: { option: 0 }, unknown: { text: 'note' } },
    { route: { option: 0, text: 'both' }, note: { text: 'note' } },
  ]) {
    assert.throws(() => h.api.finishUserQuestion(request.id, { answers }), TypeError);
    assert.equal(h.state().userQuestion.id, request.id);
    assert.equal(settled, false);
  }
  assert.equal(h.api.finishUserQuestion(request.id, { answers: { route: { option: 1 }, note: { text: '  keep logs  ' } } }), true);
  assert.deepEqual(await pending, {
    cancelled: false, answers: { route: { answers: ['Full'] }, note: { answers: ['keep logs'] } },
  });
  assert.equal(h.state().userQuestion, null);
  assert.equal(h.api.finishUserQuestion(request.id, { cancelled: true }), false);
});

test('only the visible FIFO request can be answered; cancellation never picks an option', async () => {
  const h = harness();
  const first = h.api.requestUserQuestion({ sessionId: 'session-a', questions });
  const second = h.api.requestUserQuestion({ sessionId: 'session-a', questions });
  assert.equal(h.api.finishUserQuestion('question-2', { cancelled: true }), false);
  assert.equal(h.api.finishUserQuestion('question-1', { cancelled: true }), true);
  assert.deepEqual(await first, { cancelled: true, answers: {}, reason: 'cancelled by user' });
  assert.equal(h.state().userQuestion.id, 'question-2');
  h.api.cancelAllUserQuestions('turn finished');
  assert.deepEqual(await second, { cancelled: true, answers: {}, reason: 'turn finished' });
});

test('session-local queues cannot accept another session request or answer', async () => {
  const a = harness('session-a');
  const b = harness('session-b');
  await assert.rejects(a.api.requestUserQuestion({ sessionId: 'session-b', questions }), /does not belong/);
  const pending = a.api.requestUserQuestion({ sessionId: 'session-a', questions });
  assert.equal(b.api.finishUserQuestion(a.state().userQuestion.id, { cancelled: true }), false);
  assert.ok(a.state().userQuestion);
  a.dispose();
  assert.equal((await pending).reason, 'runtime closing');
  assert.equal(a.api.finishUserQuestion('question-1', { cancelled: true }), false);
  assert.deepEqual(await a.api.requestUserQuestion({ sessionId: 'session-a', questions }), {
    cancelled: true, answers: {}, reason: 'runtime disposed',
  });
});

test('abort signals remove active and queued requests and reject late answers', async () => {
  const h = harness();
  const active = new AbortController();
  const queued = new AbortController();
  const first = h.api.requestUserQuestion({ sessionId: 'session-a', questions, signal: active.signal });
  const second = h.api.requestUserQuestion({ sessionId: 'session-a', questions, signal: queued.signal });
  queued.abort();
  assert.equal((await second).cancelled, true);
  assert.equal(h.state().userQuestion.id, 'question-1');
  active.abort();
  assert.deepEqual(await first, { cancelled: true, answers: {}, reason: 'turn cancelled' });
  assert.equal(h.state().userQuestion, null);
  assert.equal(h.api.finishUserQuestion('question-1', { answers: { route: { option: 0 }, note: { text: 'late' } } }), false);
  assert.equal((await h.api.requestUserQuestion({ sessionId: 'session-a', questions, signal: active.signal })).cancelled, true);
});

test('question and approval decisions never cross, even with identical ids', async () => {
  const h = harness();
  const approvals = createToolApproval({ ...h.deps, nextId: () => 'question-1', timeoutMs: 60_000 });
  const approval = approvals.requestToolApproval({ name: 'shell' });
  const question = h.api.requestUserQuestion({ sessionId: 'session-a', questions });
  assert.throws(() => h.api.finishUserQuestion('question-1', { approved: true }), TypeError);
  h.api.finishUserQuestion('question-1', { cancelled: true });
  await question;
  assert.equal(h.state().toolApproval.id, 'question-1');
  approvals.finishToolApproval('question-1', false, 'denied');
  assert.deepEqual(await approval, { approved: false, reason: 'denied' });
});

test('request and response contracts reject ambiguity and preserve text-only questions', () => {
  assert.deepEqual(normalizeUserQuestions({ questions: [{ id: 'text', question: '  Tell me  ' }] }), [
    { id: 'text', question: 'Tell me', options: [] },
  ]);
  for (const input of [
    { questions: [] },
    { questions: [questions[0], questions[0]] },
    { questions: [{ ...questions[0], options: [{ label: 'x' }, { label: ' x ' }] }] },
    { questions: [{ ...questions[0], question: ' ' }] },
    { questions: [{ ...questions[0], id: '__proto__' }] },
  ]) assert.throws(() => normalizeUserQuestions(input), TypeError);
  for (const response of [
    {}, { approved: true }, { cancelled: true, answers: {} }, { answers: { route: { option: -1 } } },
    { answers: { route: { option: '1' } } }, { answers: { route: { text: 'x'.repeat(8_193) } } },
  ]) assert.throws(() => normalizeUserQuestionResponse(response), TypeError);
});

test('registered question tool uses only its caller hook; headless profiles cannot advertise it', async () => {
  const tools = collectStandaloneToolDefs({});
  assert.ok(tools.standaloneTools.includes(REQUEST_USER_INPUT_TOOL));
  assert.ok(tools.internalToolDefs.includes(REQUEST_USER_INPUT_TOOL));
  assert.equal(filterModelToolsForProfile(tools.standaloneTools, 'headless').some((tool) => tool.name === 'request_user_input'), false);
  await assert.rejects(executeUserQuestion({ questions }), /interactive user-question surface/);
  const h = harness();
  const signal = new AbortController().signal;
  const answer = executeUserQuestion({ questions }, {
    callerSessionId: 'session-a', toolCallId: 'call-9', signal, userQuestionHook: h.api.requestUserQuestion,
  });
  assert.equal(h.state().userQuestion.toolCallId, 'call-9');
  h.api.finishUserQuestion(h.state().userQuestion.id, { cancelled: true });
  assert.equal((await answer).cancelled, true);
});

test('in-flight question callbacks are never persisted to a cold session', () => {
  const session = { id: 'session-a', messages: [], userQuestionHook: () => {} };
  const stored = _sessionForDisk(session);
  assert.equal(Object.hasOwn(stored, 'userQuestionHook'), false);
  assert.equal(typeof session.userQuestionHook, 'function');
});
