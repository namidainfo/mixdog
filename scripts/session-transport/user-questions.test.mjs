import assert from 'node:assert/strict';
import test from 'node:test';
import { attachSession, createStubSessionRuntime, withDaemon, RUNTIME_ROOT } from './_shared.mjs';
import { createSessionProtocolClient } from '../../src/standalone/session-protocol.mjs';
import { createUserQuestions } from '../../src/tui/session/user-questions.mjs';
import { createToolApproval } from '../../src/tui/session/tool-approval.mjs';
import { createRemoteActions } from '../../src/standalone/session-proxy/remote-actions.mjs';
import { callLane } from '../../src/standalone/session-transport/call-lanes.mjs';
import { executeTool } from '../../src/runtime/agent/orchestrator/session/loop/tool-exec.mjs';
import { setInternalToolsProvider } from '../../src/runtime/agent/orchestrator/internal-tools.mjs';
import { createInternalToolExecutor } from '../../src/session-runtime/internal-tool-executor.mjs';
import { REQUEST_USER_INPUT_TOOL } from '../../src/runtime/user-questions/tool.mjs';
import { createAskCallbacks } from '../../src/session-runtime/turn/turn-run/ask-callbacks.mjs';

const input = { questions: [{ id: 'route', question: 'Which route?', options: [{ label: 'Small' }, { label: 'Full' }] }] };

function questionRuntime() {
  const stub = createStubSessionRuntime();
  let patch = {};
  let disposed = false;
  let lastQuestion;
  const listeners = new Set();
  const getState = () => ({ ...stub.getState(), ...patch });
  const set = (next) => {
    patch = { ...patch, ...next };
    for (const listener of listeners) listener();
  };
  const questions = createUserQuestions({ getState, set, getDisposed: () => disposed });
  const approvals = createToolApproval({
    getState, set, getDisposed: () => disposed, nextId: () => 'approval-only', timeoutMs: 60_000,
  });
  const request = () => {
    lastQuestion = questions.requestUserQuestion({ ...input, sessionId: getState().sessionId });
    return lastQuestion;
  };
  return {
    ...stub,
    getState,
    subscribe(listener) {
      listeners.add(listener);
      const unsubscribe = stub.subscribe(listener);
      return () => { listeners.delete(listener); unsubscribe(); };
    },
    request,
    pendingQuestion: () => lastQuestion,
    requestApproval: () => approvals.requestToolApproval({ name: 'shell' }),
    resolveUserQuestion: questions.finishUserQuestion,
    resolveToolApproval: (id, decision) => approvals.finishToolApproval(id, decision.approved),
    async submitAsync() {
      set({ busy: true });
      void request().then(async (result) => {
        await stub.submitAsync(JSON.stringify(result));
        set({ busy: false });
      });
      return true;
    },
    async dispose() {
      disposed = true;
      questions.cancelAllUserQuestions('runtime closing');
      approvals.denyAllToolApprovals('runtime closing');
      await stub.dispose();
    },
  };
}

test('daemon question survives client disconnect/reload, routes by session and resumes only after a user answer', async () => {
  const runtimes = [];
  await withDaemon(async ({ discovery }) => {
    let view = await attachSession({ discovery, cwd: process.cwd() });
    const otherView = await attachSession({ discovery, cwd: process.cwd() });
    try {
      let client = createSessionProtocolClient(view);
      const created = await client.create({ cwd: process.cwd() });
      await client.subscribe({ sessionId: created.sessionId });
      await client.submit({ sessionId: created.sessionId, prompt: 'ask first' });
      const runtime = runtimes[0];
      const request = runtime.getState().userQuestion;
      assert.ok(request);
      assert.equal(runtime.getState().items.length, 0, 'no answer is invented on presentation');
      await client.close('renderer reload');
      view = await attachSession({ discovery, cwd: process.cwd() });
      client = createSessionProtocolClient(view);
      await client.subscribe({ sessionId: created.sessionId });
      const restored = await client.read({ sessionId: created.sessionId });
      assert.ok(JSON.stringify(restored).includes(request.id), 'reload replays the same pending request');
      assert.equal(runtime.getState().items.length, 0);

      const other = createSessionProtocolClient(otherView);
      const wrong = await other.create({ cwd: process.cwd() });
      const response = { answers: { route: { option: 1 } } };
      await assert.rejects(client.answer({
        sessionId: created.sessionId, questionId: request.id, response: { approved: true },
      }), /question response/);
      assert.equal((await other.answer({ sessionId: wrong.sessionId, questionId: request.id, response })).accepted, false);
      assert.equal((await client.approve({
        sessionId: created.sessionId, approvalId: request.id, decision: { approved: true },
      })).approved, false);
      assert.equal(runtime.getState().userQuestion.id, request.id);
      const approval = runtime.requestApproval();
      assert.equal((await client.answer({ sessionId: created.sessionId, questionId: request.id, response })).accepted, true);
      await new Promise(setImmediate);
      assert.deepEqual(JSON.parse(runtime.getState().items[0].text), {
        cancelled: false, answers: { route: { answers: ['Full'] } },
      });
      assert.equal(runtime.getState().toolApproval.id, 'approval-only', 'answers do not authorize tools');
      assert.equal((await client.answer({ sessionId: created.sessionId, questionId: request.id, response })).accepted, false);
      await client.approve({ sessionId: created.sessionId, approvalId: 'approval-only', decision: { approved: false } });
      assert.equal((await approval).approved, false);
    } finally {
      await view.close('test end');
      await otherView.close('test end');
    }
  }, { sessionFactory: async () => { const runtime = questionRuntime(); runtimes.push(runtime); return runtime; } });
});

test('unwatched pending questions are retained; explicit cancellation and daemon shutdown settle waiters', async () => {
  let runtime;
  let closing;
  await withDaemon(async ({ discovery, service }) => {
    const view = await attachSession({ discovery, cwd: process.cwd() });
    const client = createSessionProtocolClient(view);
    try {
      const created = await client.create({ cwd: process.cwd() });
      await client.submit({ sessionId: created.sessionId, prompt: 'ask first' });
      const pending = runtime.pendingQuestion();
      const id = runtime.getState().userQuestion.id;
      await client.close('disconnect');
      await new Promise((resolve) => setTimeout(resolve, 80));
      assert.equal(service.size, 1, 'pending input is not an idle-eviction candidate');
      assert.equal(runtime.getState().userQuestion.id, id);
      assert.equal((await service.handleCall('session.answer', {
        sessionId: created.sessionId, questionId: id, response: { cancelled: true },
      })).accepted, true);
      assert.deepEqual(await pending, { cancelled: true, answers: {}, reason: 'cancelled by user' });
      closing = runtime.request();
    } finally {
      await view.close('test end');
    }
  }, {
    sessionFactory: async () => { runtime = questionRuntime(); return runtime; },
    idleEvictMs: 30,
    evictSweepMs: 10,
  });
  assert.deepEqual(await closing, { cancelled: true, answers: {}, reason: 'runtime closing' });
  assert.equal(callLane('session.answer'), 'critical');
});

test('proxy answer replies cannot overwrite a newly bound session and transport errors propagate', async () => {
  const binding = { disposed: false, sessionId: 'session-a', attachment: {} };
  const sent = [];
  const applied = [];
  const reply = Promise.withResolvers();
  let fail = false;
  const actions = createRemoteActions({
    binding,
    projection: { baseRevisionFor: () => 7 },
    openParams: {},
    sendCall: (...args) => {
      sent.push(args);
      return fail ? Promise.reject(new Error('disconnected')) : reply.promise;
    },
    applyResult: (result) => applied.push(result),
    afterPendingTransition: async () => {},
    log: () => {},
  });
  const pending = actions.resolveUserQuestion('question-a', { cancelled: true });
  await Promise.resolve();
  assert.equal(sent[0][0], 'session.answer');
  assert.equal(sent[0][1].sessionId, 'session-a');
  binding.sessionId = 'session-b';
  reply.resolve({ accepted: true });
  assert.equal(await pending, true);
  assert.deepEqual(applied, []);
  fail = true;
  await assert.rejects(actions.resolveUserQuestion('question-b', { cancelled: true }), /disconnected/);
  binding.disposed = true;
  await assert.rejects(actions.resolveUserQuestion('question-a', { cancelled: true }), /disposed/);
});

test('askSession bridge and policy-cleared execution carry the question hook, calling session and turn signal', async (t) => {
  const runtime = questionRuntime();
  runtime.reserveSession('sess_question_exec');
  const session = {
    id: 'sess_question_exec', owner: 'cli', agent: 'lead', cwd: RUNTIME_ROOT,
    mcpScopeId: 'question-execution-scope', tools: [REQUEST_USER_INPUT_TOOL],
  };
  const executor = createInternalToolExecutor({
    rt: { currentCwd: RUNTIME_ROOT },
    channels: { isChannelTool: () => false },
  });
  const unregister = setInternalToolsProvider({
    scopeId: session.mcpScopeId, tools: [REQUEST_USER_INPUT_TOOL], executor,
  });
  t.after(unregister);
  t.after(() => runtime.dispose());

  const denied = await executeTool('request_user_input', input, RUNTIME_ROOT, session.id, session, {
    beforeToolHook: async () => ({ action: 'ask' }),
    toolApprovalHook: async () => ({ approved: false, reason: 'denied' }),
  });
  assert.match(denied, /denied by hook/);
  assert.equal(runtime.getState().userQuestion, undefined, 'a question cannot bypass tool policy');

  for (const fallback of [false, true]) {
    const controller = new AbortController();
    const started = Promise.withResolvers();
    const hook = (request) => {
      assert.equal(request.sessionId, session.id);
      assert.equal(request.toolCallId, 'question-call');
      assert.equal(request.signal, controller.signal);
      const queue = createUserQuestions({
        getState: runtime.getState,
        set: (patch) => { question = patch.userQuestion; },
        getDisposed: () => false,
      });
      const waiting = queue.requestUserQuestion(request);
      started.resolve(queue);
      return waiting;
    };
    let question;
    const { askCallbacks } = createAskCallbacks({ notifyFnForSession: () => null });
    const callbacks = askCallbacks({ timing: {}, signal: controller.signal }, session, { onUserQuestion: hook });
    if (fallback) session.userQuestionHook = callbacks.onUserQuestion;
    const pending = executeTool('request_user_input', input, RUNTIME_ROOT, session.id, session, {
      signal: callbacks.signal,
      toolCallId: 'question-call',
      ...(fallback ? {} : { userQuestionHook: callbacks.onUserQuestion }),
    });
    const queue = await Promise.race([
      started.promise,
      pending.then((result) => { throw new Error(`question completed before user input: ${result}`); }),
    ]);
    assert.equal(question.sessionId, session.id);
    assert.equal(queue.finishUserQuestion(question.id, { answers: { route: { option: 0 } } }), true);
    assert.deepEqual(JSON.parse(await pending), { cancelled: false, answers: { route: { answers: ['Small'] } } });
  }
});
