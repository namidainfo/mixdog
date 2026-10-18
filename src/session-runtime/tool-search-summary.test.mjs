import assert from 'node:assert/strict';
import test from 'node:test';
import { applyDeferredToolSurface, renderToolSearch } from '../runtime/agent/orchestrator/runtime-core/tool-catalog.mjs';
import { parseNativeToolSearchPayload } from '../runtime/agent/orchestrator/session/loop/tool-helpers.mjs';

test('native re-selection retains registration without duplicating schemas in prose', () => {
  const tool = {
    name: 'office',
    description: 'Create a document.',
    inputSchema: { type: 'object', properties: { action: { type: 'string' } } },
  };
  const session = {
    provider: 'openai-oauth',
    tools: [{ name: 'read', inputSchema: { type: 'object', properties: {} } }, tool],
    messages: [],
    toolSpec: 'full',
  };
  applyDeferredToolSurface(session, 'full');
  renderToolSearch({ names: ['office'] }, session);
  const result = JSON.parse(renderToolSearch({ names: ['office'] }, session));
  assert.deepEqual(result.alreadyActive, ['office']);
  assert.deepEqual(result.nativeToolSearch.toolReferences, ['office']);
  assert.deepEqual(result.nativeToolSearch.openaiTools[0].parameters, tool.inputSchema);
  assert.equal(result.nativeToolSearch.summary, 'Already active: office');
  assert.equal(result.alreadyActiveSchemas, undefined);
  const native = parseNativeToolSearchPayload('load_tool', JSON.stringify(result));
  assert.equal(native.summary, 'Already active: office');
  assert.deepEqual(native.toolReferences, ['office']);
  assert.deepEqual(native.openaiTools[0].parameters, tool.inputSchema);
});

const pendingNote = 'Some requested names may belong to an MCP server still connecting — retry next turn.';
const failedNote = 'Some requested names may belong to a failed MCP server; those tools are unavailable.';

for (const [label, servers, expectedDiagnostics] of [
  ['pending', [{ name: 'worktrail', status: 'disconnected' }], [
    'pendingMcpServers: worktrail',
    pendingNote,
  ]],
  ['failed', [{ name: 'worktrail', status: 'failed' }], [
    'failedMcpServers: worktrail',
    failedNote,
  ]],
  ['pending and failed', [
    { name: 'worktrail', status: 'disconnected' },
    { name: 'rea', status: 'failed' },
  ], [
    'pendingMcpServers: worktrail',
    'failedMcpServers: rea',
    `${pendingNote} ${failedNote}`,
  ]],
  ['no connection diagnostic', [], []],
]) {
  test(`native missing-tool summary preserves ${label} status and guidance`, () => {
    const session = {
      provider: 'openai-oauth',
      tools: [{ name: 'read', inputSchema: { type: 'object', properties: {} } }],
      messages: [],
      toolSpec: 'full',
    };
    applyDeferredToolSurface(session, 'full');
    const result = renderToolSearch({ names: ['mcp__worktrail__list_threads'] }, session, 'full', {
      mcpStatus: { servers },
    });
    const native = parseNativeToolSearchPayload('load_tool', result);
    assert.equal(native.provider, 'openai-oauth');
    assert.deepEqual(native.toolReferences, []);
    assert.deepEqual(native.openaiTools, []);
    assert.equal(
      native.summary,
      `Loaded deferred tools: \n${[
        'missing: mcp__worktrail__list_threads',
        ...expectedDiagnostics,
      ].join('; ')}`
    );
  });
}
