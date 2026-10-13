import assert from 'node:assert/strict';
import test from 'node:test';
import { setImmediate as tick } from 'node:timers/promises';
import { createBloomBridge } from './bloom-bridge.mjs';
import { createSessionOps } from '../session-runtime/turn/session-ops.mjs';
import { createInternalToolExecutor } from '../session-runtime/internal-tool-executor.mjs';
import { normalizeToolMode, toolSpecForMode, deferredSurfaceModeForLead } from '../runtime/agent/orchestrator/runtime-core/effort.mjs';
import {
  applyDeferredToolSurface, rebuildDeferredToolSurfaceForProvider, refreshInitialDeferredMcpSurface,
  reconcileDeferredMcpToolCatalog, selectDeferredTools,
} from '../runtime/agent/orchestrator/runtime-core/tool-catalog.mjs';
import { snapshotProviderRequestTools } from '../runtime/agent/orchestrator/runtime-core/provider-request-snapshot.mjs';
import { prepareDeferredToolCallThrough, isOffReadonlySurface } from '../runtime/agent/orchestrator/session/loop/deferred-call-through.mjs';
import { executeTool } from '../runtime/agent/orchestrator/session/loop/tool-exec.mjs';
import { setInternalToolsProvider } from '../runtime/agent/orchestrator/internal-tools.mjs';
import { REQUEST_USER_INPUT_TOOL } from '../runtime/user-questions/tool.mjs';
import { createUserQuestions } from '../tui/session/user-questions.mjs';

const blockedNames = [
  'read', 'find', 'glob', 'grep', 'list', 'shell', 'apply_patch', 'git', 'agent',
  'goal', 'setup', 'memory', 'recall', 'web_search', 'web_fetch', 'code_graph',
  'Skill', 'skills_list', 'skill_view', 'tool_search', 'load_tool', 'computer',
  'browser', 'office', 'media', 'mcp__demo__mutate', 'bash', 'Write',
];
const catalog = [
  REQUEST_USER_INPUT_TOOL,
  ...blockedNames.map((name) => ({ name, description: name, inputSchema: { type: 'object', properties: {} } })),
];
const input = { questions: [
  { id: 'route', question: 'Which route?', options: [{ label: 'Small' }, { label: 'Full' }] },
  { id: 'note', question: 'Anything else?' },
] };

test('questions is an explicit non-native surface across providers, refreshes and stale work schemas', () => {
  assert.equal(normalizeToolMode('questions'), 'questions');
  assert.deepEqual(toolSpecForMode('questions'), []);
  assert.equal(deferredSurfaceModeForLead('questions'), 'questions');
  for (const provider of ['openai-oauth', 'anthropic-oauth', 'gemini']) {
    const session = {
      provider, tools: catalog.slice(), toolSpec: 'full', messages: [],
      deferredLateToolCatalog: catalog.slice(), deferredDiscoveredTools: blockedNames.slice(),
    };
    applyDeferredToolSurface(session, 'questions', catalog);
    assert.deepEqual(session.tools.map((tool) => tool.name), ['request_user_input']);
    assert.deepEqual(session.deferredCallableTools, ['request_user_input']);
    assert.deepEqual(session.deferredDiscoveredTools, []);
    assert.deepEqual(session.deferredLateToolCatalog, []);
    assert.equal(session.deferredNativeTools, false);
    assert.equal(refreshInitialDeferredMcpSurface(session, catalog), false);
    assert.equal(reconcileDeferredMcpToolCatalog(session, catalog), null);
    assert.deepEqual(selectDeferredTools(session, blockedNames, 'full').blocked.map((row) => row.name), blockedNames);
    assert.deepEqual(selectDeferredTools(session, ['request_user_input'], 'full').already, ['request_user_input']);
    const snapshot = snapshotProviderRequestTools({
      session, provider, tools: catalog, nativeTools: catalog,
      messages: [{ nativeToolSearch: { provider, toolReferences: blockedNames } }],
    });
    assert.deepEqual(snapshot.map((tool) => tool.name), ['request_user_input']);
    for (const name of blockedNames) {
      assert.equal(isOffReadonlySurface(session, name), true, name);
      assert.match(prepareDeferredToolCallThrough(session, name).deny, /question-only/, name);
    }
    assert.equal(isOffReadonlySurface(session, 'request_user_input'), false);
    assert.equal(prepareDeferredToolCallThrough(session, 'request_user_input'), null);
    rebuildDeferredToolSurfaceForProvider(session, 'anthropic-oauth');
    assert.deepEqual(session.tools.map((tool) => tool.name), ['request_user_input']);
    applyDeferredToolSurface(session, 'none');
    assert.deepEqual(snapshotProviderRequestTools({ session, tools: catalog, nativeTools: catalog }), []);
    assert.match(prepareDeferredToolCallThrough(session, 'request_user_input').deny, /no-tools/);
    applyDeferredToolSurface(session, 'questions');
    assert.deepEqual(session.tools.map((tool) => tool.name), ['request_user_input']);
    applyDeferredToolSurface(session, 'lead');
    assert.ok(session.deferredToolCatalog.some((tool) => tool.name === 'shell'));
  }
  const denied = { tools: catalog.slice(), disallowedTools: ['request_user_input'] };
  applyDeferredToolSurface(denied, 'questions');
  assert.deepEqual(denied.tools, []);
});

test('restricted permission transitions preserve the work spec and refuse active-turn changes', async () => {
  for (const spec of ['full', ['tools:readonly']]) {
    const session = { tools: catalog.slice(), toolSpec: spec, messages: [{ role: 'user', content: 'hi' }] };
    let mode = 'full', active = 0;
    const refreshes = [];
    const ops = createSessionOps({
      getSession: () => session, getActiveTurnCount: () => active, setMode: (value) => { mode = value; },
      refreshEmptySessionToolPolicy: async (options) => {
        refreshes.push(options);
        applyDeferredToolSurface(session, deferredSurfaceModeForLead(mode), catalog);
      },
    });
    await ops.setToolMode('questions');
    assert.deepEqual(session.toolSpec, []);
    active = 1;
    for (const next of ['full', 'none', 'questions', 'readonly']) {
      await assert.rejects(ops.setToolMode(next), /Stop the active turn/);
      assert.equal(mode, 'questions');
    }
    active = 0;
    await ops.setToolMode('none');
    await ops.setToolMode('questions');
    await ops.setToolMode('full');
    assert.deepEqual(session.toolSpec, spec);
    assert.deepEqual(refreshes, Array(4).fill({ force: true }));
    assert.ok(session.deferredToolCatalog.some((tool) => tool.name === 'agent'));
  }
  const fresh = { tools: [], toolSpec: [], deferredSurfaceMode: 'questions' };
  const ops = createSessionOps({
    getSession: () => fresh, getActiveTurnCount: () => 0, setMode: () => {},
    invalidatePreSessionToolSurface: () => {},
  });
  await ops.setToolMode('full');
  assert.equal(fresh.toolSpec, 'full', 'fresh question-only sessions can explicitly enter work');
});

test('model execution refuses every non-question lane even with a stale active catalog', async (t) => {
  const session = { id: 'questions-only', tools: catalog.slice(), toolSpec: [], deferredSurfaceMode: 'questions' };
  let channelCalls = 0, questionCalls = 0;
  const executor = createInternalToolExecutor({
    rt: { session, currentCwd: process.cwd() },
    channels: { isChannelTool: () => true, execute: () => { channelCalls += 1; } },
  });
  for (const name of blockedNames) {
    await assert.rejects(executor(name, {}, { invocationSource: 'model-tool' }), /Question-only/, name);
    assert.match(await executeTool(name, {}, process.cwd(), session.id, session), /not available/, name);
  }
  const unregister = setInternalToolsProvider({
    scopeId: 'question-only-guard', tools: [REQUEST_USER_INPUT_TOOL], executor,
  });
  t.after(unregister);
  session.mcpScopeId = 'question-only-guard';
  const result = await executeTool('request_user_input', input, process.cwd(), session.id, session, {
    userQuestionHook: () => { questionCalls += 1; return { cancelled: true, answers: {} }; },
  });
  assert.equal(JSON.parse(result).cancelled, true);
  assert.equal(questionCalls, 1);
  session.deferredSurfaceMode = 'none';
  await assert.rejects(executor('request_user_input', input, { invocationSource: 'model-tool' }), /No-tools/);
  assert.match(await executeTool('request_user_input', input, process.cwd(), session.id, session), /not available/);
  assert.equal(questionCalls, 1);
  assert.equal(channelCalls, 0);
});

test('Bloom chat invokes actual questions, projects reconnects and routes choices, custom text and cancellation', async (t) => {
  const session = {
    id: 'bloom-question-session', provider: 'openai-oauth', model: 'gpt-question-test',
    cwd: process.cwd(), toolSpec: [], tools: catalog.slice(), mcpScopeId: 'bloom-question-chat',
  };
  let mode = 'questions', busy = false, items = [], pendingQuestion = null, controller, completion;
  let result, approvalCalls = 0, attachmentCount = 0;
  const listeners = new Set();
  const getState = () => ({
    sessionId: session.id, provider: session.provider, model: session.model, cwd: session.cwd,
    toolMode: mode, busy, items, userQuestion: pendingQuestion,
  });
  const publish = () => { for (const listener of listeners) listener(); };
  const queue = createUserQuestions({
    getState, getDisposed: () => false,
    set: ({ userQuestion }) => { pendingQuestion = userQuestion; publish(); },
  });
  const executor = createInternalToolExecutor({
    rt: { session, currentCwd: session.cwd }, channels: { isChannelTool: () => false },
  });
  const unregister = setInternalToolsProvider({
    scopeId: session.mcpScopeId, tools: [REQUEST_USER_INPUT_TOOL], executor,
  });
  t.after(unregister);
  const ops = createSessionOps({
    getSession: () => session, getActiveTurnCount: () => Number(busy),
    setMode: (next) => { mode = next; },
    refreshEmptySessionToolPolicy: async () => applyDeferredToolSurface(session, deferredSurfaceModeForLead(mode), catalog),
  });
  const events = [];
  const bridge = createBloomBridge({
    emit: (event) => events.push(event),
    createSession: async (options) => {
      attachmentCount += 1;
      if (!options.sessionId) {
        assert.equal(options.toolMode, 'none', 'discovery gateway remains no-tools');
        return {
          listProviderModels: async () => [{ provider: session.provider, id: session.model }],
          getProviderSetup: async () => ({ oauth: [{ id: session.provider, authenticated: true }] }),
          readSessionSnapshot: async () => getState(),
          dispose: async () => {},
        };
      }
      assert.equal(options.toolMode, 'questions');
      return {
        getState, setToolMode: ops.setToolMode,
        subscribe: (listener) => { listeners.add(listener); return () => listeners.delete(listener); },
        resolveUserQuestion: queue.finishUserQuestion,
        approveAsync: async () => { approvalCalls += 1; },
        submitAsync: async (_prompt, { id }) => {
          controller = new AbortController();
          busy = true;
          publish();
          completion = executeTool('request_user_input', input, session.cwd, session.id, session, {
            signal: controller.signal, toolCallId: id, userQuestionHook: queue.requestUserQuestion,
          }).then((answerText) => {
            result = JSON.parse(answerText);
            busy = false;
            items = [...items, { id: `done-${id}`, kind: 'turndone', status: result.cancelled ? 'cancelled' : 'done' }];
            publish();
          });
          return true;
        },
        abortAsync: async () => { controller.abort(); await completion; return { aborted: true }; },
        dispose: async () => {},
      };
    },
  });
  t.after(async () => { queue.cancelAllUserQuestions(); await completion; await bridge.dispose(); });
  const open = (viewId) => bridge.call('open', {
    viewId, sessionId: session.id, mode: 'chat', modelKey: `mixdog:${session.provider}/${session.model}`,
  });
  await open('chat');
  for (const [response, expected] of [
    [{ answers: { route: { option: 1 }, note: { text: '  keep logs  ' } } },
      { cancelled: false, answers: { route: { answers: ['Full'] }, note: { answers: ['keep logs'] } } }],
    [{ answers: { route: { text: 'custom route' }, note: { text: 'notes' } } },
      { cancelled: false, answers: { route: { answers: ['custom route'] }, note: { answers: ['notes'] } } }],
    [{ cancelled: true }, { cancelled: true, answers: {}, reason: 'cancelled by user' }],
  ]) {
    const turnId = `turn-${items.length}`;
    await bridge.call('send', { viewId: 'chat', turnId, text: 'ask me' });
    await tick();
    const question = events.at(-1).snapshot.question;
    assert.deepEqual(question.questions[0].options.map((option) => option.label), ['Small', 'Full']);
    assert.equal(question.sessionId, session.id);
    await assert.rejects(bridge.call('handoff', { viewId: 'chat' }), /Stop the active turn/);
    const before = attachmentCount;
    const reconnected = await open('reconnected');
    assert.deepEqual(reconnected.question, question);
    assert.equal(attachmentCount, before + 1, 'reattachment does not create a discovery or model request');
    assert.equal((await bridge.call('session', { sessionId: session.id })).mode, 'chat');
    await assert.rejects(bridge.call('answer', { viewId: 'reconnected', questionId: 'stale', response }), /no longer pending/);
    await assert.rejects(bridge.call('answer', { viewId: 'reconnected', questionId: question.id, response: { approved: true } }), /does not accept field/);
    await assert.rejects(bridge.call('approve', { viewId: 'reconnected', approvalId: question.id, allow: true }), /Plain chat/);
    assert.equal(await bridge.call('answer', { viewId: 'reconnected', questionId: question.id, response }), true);
    await completion;
    assert.deepEqual(result, expected);
    assert.equal(pendingQuestion, null);
    assert.equal(mode, 'questions');
    await bridge.call('close', { viewId: 'reconnected' });
  }
  await bridge.call('send', { viewId: 'chat', turnId: 'abort-turn', text: 'ask again' });
  await tick();
  const cancelledId = pendingQuestion.id;
  assert.deepEqual(await bridge.call('cancel', { viewId: 'chat', turnId: 'abort-turn' }), { aborted: true });
  assert.deepEqual(result, { cancelled: true, answers: {}, reason: 'turn cancelled' });
  assert.equal(pendingQuestion, null);
  await assert.rejects(bridge.call('answer', { viewId: 'chat', questionId: cancelledId, response: { cancelled: true } }), /no longer pending/);
  assert.equal(approvalCalls, 0);
  assert.equal(mode, 'questions');
});
