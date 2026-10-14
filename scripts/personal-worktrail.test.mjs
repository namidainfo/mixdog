import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { configureWorktrail, WORKTRAIL_SERVER } from './personal-worktrail.mjs';

const defaultWorkflow = (await readFile(new URL('../src/workflows/default/WORKFLOW.md', import.meta.url), 'utf8'))
  .replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n/, '')
  .trim();

test('provisions MCP and the recording Default through setup without model or record calls', async () => {
  const calls = [];
  await configureWorktrail(async (args) => {
    calls.push(args);
    return JSON.stringify(args.action === 'status' ? { servers: [] } : { saved: true });
  }, defaultWorkflow);
  assert.deepEqual(calls.map((item) => item.action), [
    'status', 'add_mcp_server', 'save_definition', 'set_workflow',
  ]);
  assert.deepEqual(calls[1].server, WORKTRAIL_SERVER);
  assert.equal(calls[2].definition.id, 'default');
  assert.equal(calls[2].definition.body, defaultWorkflow);
  assert.equal(calls[3].workflow, 'default');
});

test('Default retains approval rules and records meaningful work without per-record approval', () => {
  assert.match(defaultWorkflow, /until the user approves the latest plan/);
  assert.match(defaultWorkflow, /without asking for approval for each record/);
  assert.match(defaultWorkflow, /list_threads/);
  assert.match(defaultWorkflow, /wslpath in the configured distro and user/);
  assert.match(defaultWorkflow, /note_turn with observed/);
  assert.match(defaultWorkflow, /close_thread\(result=\.\.\.\)/);
  assert.match(defaultWorkflow, /Never record passwords/);
});

test('existing Worktrail configuration is reused without changing its connection', async () => {
  const calls = [];
  await configureWorktrail(async (args) => {
    calls.push(args);
    return args.action === 'status' ? { servers: [{ name: 'worktrail' }] } : { saved: true };
  }, defaultWorkflow);
  assert.deepEqual(calls.map((item) => item.action), ['status', 'save_definition', 'set_workflow']);
  assert.equal(calls[1].definition.id, 'default');
  assert.equal(calls[2].workflow, 'default');
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

test('a failed Default save does not activate it or hide the error', async () => {
  const calls = [];
  await assert.rejects(configureWorktrail(async (args) => {
    calls.push(args.action);
    if (args.action === 'save_definition') return { isError: true, error: 'save failed' };
    return { servers: [{ name: 'worktrail' }] };
  }, defaultWorkflow), /Worktrail setup failed/);
  assert.deepEqual(calls, ['status', 'save_definition']);
});
