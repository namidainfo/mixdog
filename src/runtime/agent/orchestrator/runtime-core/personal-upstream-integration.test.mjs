import assert from 'node:assert/strict';
import test from 'node:test';
import { applyDeferredToolSurface, selectDeferredTools, snapshotProviderRequestTools } from './tool-catalog.mjs';
import { ASK_USER_TOOL_DEFS } from './ask-user-tool-defs.mjs';
import { TOOL_BRIDGE_TOOLS } from './tool-defs.mjs';
import { REQUEST_USER_INPUT_TOOL } from '../../../user-questions/tool.mjs';
import { preDispatchDenyForSession } from '../session/loop/pre-dispatch-deny.mjs';
import { prepareDeferredToolCallThrough } from '../session/loop/deferred-call-through.mjs';
import { isToolBridgeEnabled } from './tool-bridge.mjs';
import { sessionTitleDatePrefix } from '../../../shared/session-title-format.mjs';

test('legacy generated titles do not invent a date when their creation timestamp is missing or invalid', () => {
  for (const createdAt of [undefined, null, NaN, 'invalid']) {
    assert.equal(sessionTitleDatePrefix(createdAt), '');
  }
});

for (const provider of ['anthropic', 'openai-oauth', 'openrouter']) {
  test(`${provider}: restricted Personal modes retain both question APIs without leaking the work catalog`, () => {
    const session = {
      provider, messages: [], tools: [
        ...ASK_USER_TOOL_DEFS, REQUEST_USER_INPUT_TOOL, ...TOOL_BRIDGE_TOOLS,
        { name: 'shell', description: 'Run a command.', inputSchema: { type: 'object', properties: {} } },
      ],
    };
    applyDeferredToolSurface(session, 'full');
    applyDeferredToolSurface(session, 'questions');
    const snapshot = () => snapshotProviderRequestTools({
      provider, tools: session.tools, session,
      nativeTools: [{ name: 'stale_native' }],
      messages: [{ role: 'assistant', content: [{ type: 'tool_use', name: 'shell', input: {} }] }],
    });
    assert.deepEqual(snapshot().map((tool) => tool.name).sort(), ['ask_user', 'request_user_input']);
    assert.equal(isToolBridgeEnabled(session), false);
    for (const name of ['ask_user', 'request_user_input']) {
      assert.equal(preDispatchDenyForSession(session, { name, arguments: {} }), null);
      assert.equal(prepareDeferredToolCallThrough(session, name), null);
    }
    assert.match(preDispatchDenyForSession(session, { name: 'shell', arguments: {} }), /read-only/u);
    assert.match(prepareDeferredToolCallThrough(session, 'shell').deny, /question-only/u);
    assert.deepEqual(selectDeferredTools(session, ['ask_user', 'request_user_input', 'shell'], 'questions'), {
      added: [], already: ['ask_user', 'request_user_input'], missing: [],
      blocked: [{ name: 'shell', reason: 'question-only mode' }], native: false,
    });
    applyDeferredToolSurface(session, 'none');
    assert.deepEqual(snapshot(), []);
    for (const name of ['ask_user', 'request_user_input', 'shell']) {
      assert.notEqual(preDispatchDenyForSession(session, { name, arguments: {} }), null);
    }
    applyDeferredToolSurface(session, 'full');
    assert.equal(preDispatchDenyForSession(session, { name: 'shell', arguments: {} }), null);
  });
}
