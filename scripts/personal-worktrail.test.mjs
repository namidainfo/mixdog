import assert from 'node:assert/strict';
import test from 'node:test';
import { configureWorktrail, WORKTRAIL_SERVER } from './personal-worktrail.mjs';

test('provisions MCP and recording workflow through setup without model or record calls', async () => {
  const calls = [];
  await configureWorktrail(async (args) => {
    calls.push(args);
    return JSON.stringify(args.action === 'status' ? { servers: [] } : { saved: true });
  }, 'Ask for approval before changing files.');
  assert.deepEqual(calls.map((item) => item.action), [
    'status', 'add_mcp_server', 'create_definition', 'set_workflow',
  ]);
  assert.deepEqual(calls[1].server, WORKTRAIL_SERVER);
  assert.match(calls[2].definition.body, /^Ask for approval before changing files\./);
  assert.match(calls[2].definition.body, /list_threads/);
  assert.match(calls[2].definition.body, /close_thread/);
  assert.match(calls[2].definition.body, /Never record passwords/);
  assert.equal(calls[3].workflow, 'personal-worktrail');
});

test('existing Worktrail configuration is not overwritten', async () => {
  let calls = 0;
  await assert.rejects(configureWorktrail(async () => {
    calls++;
    return { servers: [{ name: 'worktrail' }] };
  }, 'Default rules'), /already exists/);
  assert.equal(calls, 1);
});

test('setup failures stop activation and are not hidden', async () => {
  const calls = [];
  await assert.rejects(configureWorktrail(async (args) => {
    calls.push(args.action);
    if (args.action === 'add_mcp_server') throw new Error('connection failed');
    return { servers: [] };
  }, 'Default rules'), /connection failed/);
  assert.deepEqual(calls, ['status', 'add_mcp_server']);
});
