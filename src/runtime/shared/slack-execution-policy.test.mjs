import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, symlink, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { normalizeSlackExecutionPolicy, slackWorkspace, slackToolDecision } from './slack-execution-policy.mjs';
import { preDispatchDenyForSession, routeWebFetchCall } from '../agent/orchestrator/session/loop/pre-dispatch-deny.mjs';
import { applyBeforeToolHook } from '../agent/orchestrator/session/loop/tool-exec/before-hook.mjs';
import { executeTool } from '../agent/orchestrator/session/loop/tool-exec.mjs';

async function fixture(t) {
  const root = await mkdtemp(path.join(tmpdir(), 'slack-policy-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const policy = normalizeSlackExecutionPolicy({ version: 1, teamId: 'T1', userId: 'U1',
    active: true, admin: false, root });
  const workspace = slackWorkspace(policy), other = path.join(root, 'slack-users', 'T1', 'U2');
  await mkdir(workspace, { recursive: true }); await mkdir(other, { recursive: true });
  await writeFile(path.join(workspace, 'mine.txt'), 'owned');
  await writeFile(path.join(other, 'private.txt'), 'other owner');
  return { root, workspace, other, session: { id: 'member-session', cwd: root, slackExecutionPolicy: policy } };
}
const call = (name, args = {}) => ({ name, arguments: args });
const hook = (session, tool, extra = {}) => applyBeforeToolHook({
  name: tool.name, args: tool.arguments, cwd: session.slackExecutionPolicy.root,
  callerSessionId: session.id, sessionRef: session, executeOpts: {}, ...extra,
});

test('question APIs retain their hook contracts and live Slack authorization', async (t) => {
  const { session } = await fixture(t);
  const hooked = [];
  for (const name of ['ask_user', 'request_user_input']) {
    const tool = call(name);
    const result = await hook(session, tool, { beforeToolHook: () => { hooked.push(name); return null; } });
    assert.equal(result.denial, undefined);
    assert.equal(preDispatchDenyForSession(session, tool), null);
  }
  assert.deepEqual(hooked, ['request_user_input']);
  session.slackExecutionPolicy = { ...session.slackExecutionPolicy, active: false };
  for (const name of ['ask_user', 'request_user_input']) {
    assert.match((await hook(session, call(name))).denial, /승인.*해제/u);
  }
});

test('members read only literal private paths and generate images only inside their own workspace', async (t) => {
  const { session, workspace, other, root } = await fixture(t);
  for (const tool of [
    call('read', { file_path: [path.join(workspace, 'mine.txt'), { file_path: path.join(workspace, 'mine.txt'), limit: 3 }] }),
    call('list', { path: workspace }),
    call('functions.media', { action: 'generate', kind: 'image', path: path.join(workspace, 'new', 'image.png') }),
    call('media', JSON.stringify({ action: 'generate', kind: 'image', path: path.join(workspace, 'image.png') })),
    call('visualize', { action: 'open', input: { targets: [path.join(workspace, 'image.png')] } }),
  ]) assert.equal(preDispatchDenyForSession(session, tool), null, tool.name);
  for (const tool of [
    call('read', { file_path: path.join(other, 'private.txt') }),
    call('read', { file_path: path.join(workspace, '.env') }),
    call('read', { file_path: path.join(workspace, 'server.key') }),
    call('read', { file_path: path.join(workspace, '**', '*') }),
    call('list', { path: root }),
    call('media', { action: 'generate', kind: 'image', path: path.join(other, 'overwrite.png') }),
    call('media', { action: 'generate', kind: 'image', path: path.join(workspace, 'image.png'), references: [path.join(other, 'private.png')] }),
    call('media', { action: 'status', job: 'another-owner' }),
    call('media', { action: 'generate', kind: 'image', path: path.join(workspace, 'image.png'), wait: false }),
    call('visualize', { action: 'open', input: { content: { kind: 'html', source: '<script>run()</script>' } } }),
    call('visualize', { action: 'export', input: { action: 'open', targets: [path.join(workspace, 'image.png')] } }),
    call('visualize', { action: 'open', input: { targets: [path.join(workspace, 'image.png')], content: { kind: 'html', source: '<script>run()</script>' } } }),
    call('media', { action: 'status', job: 'other-owner', input: { action: 'generate', kind: 'image', path: path.join(workspace, 'image.png') } }),
  ]) assert.match(preDispatchDenyForSession(session, tool), /PC 소유자/u, tool.name);
});

test('symlink and junction traversal, mixed batches and device paths do not gain private-path access', async (t) => {
  const { session, workspace, other } = await fixture(t);
  await symlink(other, path.join(workspace, 'external'), 'junction');
  for (const file of [
    path.join(workspace, 'external', 'private.txt'),
    path.join(workspace, 'external', 'new', 'image.png'),
    path.join(workspace, '..', 'U2', 'private.txt'),
    '\\\\server\\share\\file.txt',
    ...(process.platform === 'win32' ? [path.join(workspace, 'mine.txt:stream')] : []),
  ]) assert.notEqual(slackToolDecision(session, call('read', { file_path: file })), null);
  assert.notEqual(slackToolDecision(session, call('read', { file_path: [
    path.join(workspace, 'mine.txt'), path.join(other, 'private.txt'),
  ] })), null);
});

test('unknown and destructive tools require admin approval; permission-changing and delegation tools stay denied', async (t) => {
  const { session } = await fixture(t);
  for (const name of ['shell', 'apply_patch', 'git', 'office', 'browser', 'computer', 'mcp__worktrail__note_turn', 'future_tool']) {
    assert.equal(slackToolDecision(session, call(name)).action, 'ask', name);
    assert.match(preDispatchDenyForSession(session, call(name)), /denied/u);
  }
  for (const name of ['functions.setup', 'agent', 'cwd', 'goal']) {
    const result = await hook(session, call(name), { toolApprovalHook: () => { throw new Error('must not ask'); } });
    assert.match(result.denial, /변경하거나 실행을 위임/u);
  }
  assert.equal(preDispatchDenyForSession({}, call('shell')), null);
  assert.equal(preDispatchDenyForSession({ slackExecutionPolicy: { ...session.slackExecutionPolicy, admin: true } }, call('shell')), null);
  assert.match(preDispatchDenyForSession({ slackExecutionPolicy: { ...session.slackExecutionPolicy, active: false, admin: true } }, call('shell')), /승인.*해제/u);
  assert.match(preDispatchDenyForSession({ slackExecutionPolicy: {} }, call('shell')), /손상/u);
  assert.match(preDispatchDenyForSession({ ...session, cwd: path.dirname(session.cwd) }, call('Skill')), /작업 폴더/u);
});

test('the PC approval binds once to the exact call and cannot be forged, replayed or used by another session', async (t) => {
  const { session } = await fixture(t), tool = call('shell', { command: 'approved exact command' });
  let asked = 0;
  const approved = await hook(session, tool, { toolApprovalHook: async (request) => {
    asked++; assert.match(request.reason, /T1:U1/u); return { approved: true };
  } });
  assert.equal(asked, 1); assert.equal(approved.denial, undefined);
  assert.match(preDispatchDenyForSession(session, tool, { approved: true, slackApproved: true }), /denied/u);
  assert.match(preDispatchDenyForSession({ ...session, id: 'other-session' }, tool, approved), /denied/u);
  assert.match(preDispatchDenyForSession(session, call('shell', { command: 'different' }), approved), /denied/u);
  assert.equal(preDispatchDenyForSession(session, tool, approved), null);
  assert.match(preDispatchDenyForSession(session, tool, approved), /denied/u);
  assert.match(preDispatchDenyForSession(session, tool), /denied/u, 'eager dispatch has no approval handle');
});

test('missing approval UI, refusal, hook rewriting and a policy change all fail closed', async (t) => {
  const { session } = await fixture(t), tool = call('shell', { command: 'never execute' });
  assert.match((await hook(session, tool)).denial, /no approval UI/u);
  assert.match((await hook(session, tool, { toolApprovalHook: async () => false })).denial, /denied/u);
  const renamed = await hook(session, call('Skill', { name: 'image' }), {
    beforeToolHook: async () => ({ action: 'rewrite', name: 'shell', args: tool.arguments }),
  });
  assert.match(renamed.denial, /no approval UI/u);
  const changed = await hook(session, tool, { toolApprovalHook: async () => {
    session.slackExecutionPolicy = { ...session.slackExecutionPolicy, active: false };
    return true;
  } });
  assert.match(changed.denial, /정책이 변경/u);
});

test('cancelling a pending administrator approval never grants execution', async (t) => {
  const { session } = await fixture(t), controller = new AbortController();
  const pending = hook(session, call('shell'), { executeOpts: { signal: controller.signal },
    toolApprovalHook: () => new Promise(() => {}) });
  controller.abort(new Error('cancelled by owner'));
  await assert.rejects(pending, /cancelled by owner/u);
  assert.match(preDispatchDenyForSession(session, call('shell')), /denied/u);
});

test('the real serial executor gates a shell before dispatch and still reads an owned file', async (t) => {
  const { session, root, workspace } = await fixture(t);
  const denied = await executeTool('shell', { command: 'echo UNEXPECTED_EXECUTION' }, root, session.id, session);
  assert.match(String(denied), /no approval UI/u);
  const result = await executeTool('read', { file_path: path.join(workspace, 'mine.txt') }, root, session.id, session);
  assert.match(JSON.stringify(result), /owned/u);
});

test('approved public fetches retain their identity through the built-in transport routing', async (t) => {
  const { session } = await fixture(t);
  const tool = call('web_fetch', { url: 'http://127.0.0.1:8123/' });
  const approved = await hook(session, tool, { toolApprovalHook: async () => true });
  routeWebFetchCall(tool);
  assert.equal(tool.name, 'local_fetch');
  assert.equal(preDispatchDenyForSession(session, tool, approved), null);
  assert.match(preDispatchDenyForSession(session, tool, approved), /denied/u);
});
