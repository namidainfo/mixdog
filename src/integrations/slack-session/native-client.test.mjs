import assert from 'node:assert/strict';
import test from 'node:test';
import { NativeSlackClient } from './native-client.mjs';
import { SLACK_PROJECT_CWD } from './project.mjs';

function harness({ renamed = true, admin = false, active = true } = {}) {
  const calls = [];
  const policy = { version: 1, teamId: 'T1', userId: 'U1', active, admin, root: SLACK_PROJECT_CWD };
  const state = { sessionId: 'native-1', provider: 'openai-oauth', model: 'gpt-6.1-sol', cwd: SLACK_PROJECT_CWD, items: [] };
  const view = {
    getState: () => state,
    renameSessionTitle: async (...args) => { calls.push(['rename', ...args]); return renamed; },
    subscribe: () => {},
    resume: async () => {},
    dispose: async () => { calls.push(['dispose']); },
    setSlackExecutionPolicy: async (value) => { calls.push(['policy', value]); return value; },
    approveAsync: async (...args) => { calls.push(['approve', ...args]); return true; },
    submitAsync: async (...args) => { calls.push(['submit', ...args]); return true; },
  };
  const client = new NativeSlackClient({
    cwd: 'C:/must-not-be-used', provider: state.provider, model: state.model,
    effort: 'ultra', contextTokens: 500000, onState: () => {},
    hubBridge: { call: async (method) => {
      calls.push(['access', method]);
      return method === 'conversations'
        ? [['key', { teamId: 'T1', actorId: 'U1', nativeSessionId: 'native-1', requests: {} }]]
        : policy;
    } },
  });
  client.createSession = async (options) => { calls.push(['create', options]); return view; };
  return { client, calls, state, policy, view };
}

test('new Slack sessions use SOFTON and preserve the canonical daily number when naming', async () => {
  const h = harness();
  await h.client.open({ userName: 'softon_박수한', title: '연결 폴더의 최신 프로젝트', cwd: 'C:/another-folder' });
  assert.equal(h.calls.find(([kind]) => kind === 'create')[1].cwd, SLACK_PROJECT_CWD);
  assert.equal(SLACK_PROJECT_CWD, 'C:\\Users\\admin\\Documents\\SOFTON');
  assert.deepEqual(h.calls.find(([kind]) => kind === 'rename'), ['rename', 'native-1', 'softon_박수한 | 연결 폴더의 최신 프로젝트', { preservePrefix: true }]);
  assert.deepEqual(h.calls.find(([kind]) => kind === 'policy')[1], h.policy);
  await h.client.close();
});

test('reattaching an existing session never renames it', async () => {
  const h = harness();
  await h.client.open({ sessionId: 'native-1', userName: 'ignored', title: 'ignored' });
  assert.equal(h.calls.find(([kind]) => kind === 'create')[1].sessionId, 'native-1');
  assert.equal(h.calls.filter(([kind]) => kind === 'rename').length, 0);
  await h.client.close();
});

test('members cannot approve their own tool calls but can deny them', async () => {
  const h = harness();
  await h.client.open({ sessionId: 'native-1' });
  h.state.toolApproval = { id: 'approval-1' };
  await assert.rejects(h.client.approve({ sessionId: 'native-1', approvalId: 'approval-1', approved: true }), /관리자 승인/u);
  assert.equal(h.calls.filter(([kind]) => kind === 'approve').length, 0);
  assert.deepEqual(await h.client.approve({ sessionId: 'native-1', approvalId: 'approval-1', approved: false }), { accepted: true });
  assert.equal(h.calls.find(([kind]) => kind === 'approve')[2].approved, false);
  await h.client.close();
});

test('administrator approval still requires the pending ID and live authorization', async () => {
  const h = harness({ admin: true });
  await h.client.open({ sessionId: 'native-1' });
  h.state.toolApproval = { id: 'approval-1' };
  await assert.rejects(h.client.approve({ sessionId: 'native-1', approvalId: 'other', approved: true }), /현재 세션/u);
  assert.deepEqual(await h.client.approve({ sessionId: 'native-1', approvalId: 'approval-1', approved: true }), { accepted: true });
  h.policy.active = false;
  await assert.rejects(h.client.approve({ sessionId: 'native-1', approvalId: 'approval-1', approved: true }), /관리자 승인/u);
  await h.client.close();
});

test('existing sessions receive a durable policy before transport readiness and revoked users cannot submit', async () => {
  const h = harness();
  h.client.discovery = async () => ({});
  assert.deepEqual(await h.client.health(), { ready: true });
  assert.equal(h.calls.filter(([kind]) => kind === 'policy').length, 1);
  assert.equal(h.calls.filter(([kind]) => kind === 'rename').length, 0);
  h.policy.active = false;
  await assert.rejects(h.client.submit({ sessionId: 'native-1', prompt: 'run', requestId: 'r1' }), /승인.*해제/u);
  assert.equal(h.calls.filter(([kind]) => kind === 'submit').length, 0);
  await h.client.close();
});

test('policy persistence errors prevent a session from being attached or submitted', async () => {
  const h = harness();
  h.view.setSlackExecutionPolicy = async () => { throw new Error('policy persistence failed'); };
  await assert.rejects(h.client.open({ sessionId: 'native-1' }), /policy persistence failed/u);
  assert.equal(h.client.views.size, 0);
  assert.equal(h.calls.filter(([kind]) => kind === 'submit').length, 0);
  await h.client.close();
});

test('missing identity fails before creation and failed naming disposes the new attachment', async () => {
  const h = harness({ renamed: false });
  await assert.rejects(h.client.open({ title: 'work' }), /사용자 이름/);
  assert.equal(h.calls.length, 0);
  await assert.rejects(h.client.open({ userName: 'softon_박수한', title: 'work' }), /제목을 저장/);
  assert.equal(h.calls.at(-1)[0], 'dispose');
  assert.equal(h.client.views.size, 0);
});

const upstreamQuestions = () => Array.from({ length: 4 }, (_, index) => ({
  question: `Question ${index + 1}`, header: `Q${index + 1}`, multi_select: index === 0,
  options: [{ label: 'A', description: 'First choice' }, { label: 'B', description: 'Second choice' }],
}));

test('members answer four upstream questions without gaining ordinary tool approval', async () => {
  const h = harness();
  await h.client.open({ sessionId: 'native-1' });
  h.state.toolApproval = { id: 'question-1', name: 'ask_user', kind: 'question', args: { questions: upstreamQuestions() } };
  const snapshot = (await h.client.state({ sessionId: 'native-1' })).state;
  assert.equal(snapshot.toolApproval, null);
  assert.equal(snapshot.userQuestion.source, 'ask_user');
  assert.deepEqual(snapshot.userQuestion.questions.map((question) => question.id), ['q1', 'q2', 'q3', 'q4']);
  const answers = [{ selected: ['A', 'B'] }, { selected: ['B'] }, { selected: [], text: 'Typed answer' }, { selected: ['A'] }];
  await assert.rejects(h.client.answer({ sessionId: 'native-1', questionId: 'stale', response: { answers } }), /현재 세션의 질문/u);
  await assert.rejects(h.client.answer({ sessionId: 'native-1', questionId: 'question-1', response: { answers: [] } }), /질문 응답/u);
  assert.deepEqual(await h.client.answer({ sessionId: 'native-1', questionId: 'question-1', response: { answers } }), { accepted: true });
  assert.deepEqual(h.calls.find(([kind]) => kind === 'approve'), ['approve', 'question-1', {
    approved: true, answers, device: 'Slack',
  }]);
  h.state.toolApproval = { id: 'shell-1', name: 'shell', args: { command: 'must not run' } };
  await assert.rejects(h.client.answer({ sessionId: 'native-1', questionId: 'shell-1', response: { answers } }), /현재 세션의 질문/u);
  assert.equal(h.calls.filter(([kind]) => kind === 'approve').length, 1);
  await h.client.close();
});

test('upstream questions support cancellation and recheck revoked Slack access', async () => {
  const h = harness();
  await h.client.open({ sessionId: 'native-1' });
  h.state.toolApproval = { id: 'question-1', name: 'ask_user', kind: 'question', args: { questions: upstreamQuestions() } };
  await h.client.answer({ sessionId: 'native-1', questionId: 'question-1', response: { cancelled: true } });
  assert.equal(h.calls.find(([kind]) => kind === 'approve')[2].approved, false);
  h.policy.active = false;
  await assert.rejects(h.client.answer({ sessionId: 'native-1', questionId: 'question-1', response: { cancelled: true } }), /승인.*해제/u);
  assert.equal(h.calls.filter(([kind]) => kind === 'approve').length, 1);
  await h.client.close();
});
