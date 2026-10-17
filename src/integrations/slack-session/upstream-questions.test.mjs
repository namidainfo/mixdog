import assert from 'node:assert/strict';
import test from 'node:test';
import { questionResponse, questionText } from './controls.mjs';
import { slackSessionState } from './native-client.mjs';

const question = { question: 'Choose a route.', header: 'Route', options: [
  { label: 'Small', description: 'Smaller change' }, { label: 'Full', description: 'Complete change' },
] };
const state = (questions) => slackSessionState({
  sessionId: 'session-1', toolApproval: { id: 'ask-1', kind: 'question', name: 'ask_user', args: { questions } },
});

test('upstream Slack questions keep their native answer schema and never appear as tool approvals', () => {
  const snapshot = state([question]);
  assert.equal(snapshot.toolApproval, null);
  const request = snapshot.userQuestion;
  assert.deepEqual(questionResponse(request, '2'), { answers: [{ selected: ['Full'] }] });
  assert.deepEqual(questionResponse(request, 'custom route'), { answers: [{ selected: [], text: 'custom route' }] });
  assert.deepEqual(questionResponse(request, '--cancel'), { cancelled: true });
  assert.throws(() => questionResponse(request, '3'), /보기 번호/u);
  assert.match(questionText(request), /!answer ask-1/u);
});

test('multiple upstream questions accept ordered JSON including multi-select answers', () => {
  const request = state([{ ...question, multi_select: true }, { ...question, question: 'Choose another route.' }]).userQuestion;
  const response = { answers: [{ selected: ['Small', 'Full'] }, { selected: [], text: 'Custom' }] };
  assert.deepEqual(questionResponse(request, JSON.stringify(response)), response);
  assert.throws(() => questionResponse(request, '1'), /순서대로 JSON/u);
  assert.match(questionText(request), /"answers":\[/u);
});
