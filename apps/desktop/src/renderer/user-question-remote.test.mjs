import assert from 'node:assert/strict';
import test from 'node:test';
import { createRemoteApi } from './remote-shim-api.ts';
import { SessionHostLifecycle } from '../main/session-host-lifecycle.ts';

test('paired browser forwards question answers without changing the session or approving a tool', async () => {
  const sent = [];
  let disconnected = false;
  const api = createRemoteApi({
    call: async (...args) => {
      if (disconnected) throw new Error('disconnected');
      sent.push(args);
      return true;
    },
  });
  const response = { answers: { route: { text: 'my own route' } } };
  assert.equal(await api.resolveUserQuestionForSession('sess_question_a', 'question-a', response), true);
  assert.deepEqual(sent, [['resolveUserQuestionForSession', ['sess_question_a', 'question-a', response]]]);
  disconnected = true;
  await assert.rejects(api.resolveUserQuestionForSession('sess_question_a', 'question-a', response), /disconnected/);
  assert.equal(sent.length, 1);
});

test('Desktop host sends answers to the exact session and consumes only an explicit accepted acknowledgment', async () => {
  const sent = [];
  const applied = [];
  let accepted = true;
  const host = new SessionHostLifecycle({
    client: { answer: async (...args) => { sent.push(args); return { accepted }; } },
    publication: { projections: new Map([['sess_question_a', { revision: 9 }]]) },
    openHints: (sessionId) => ({ sessionId }),
    callOptions: () => ({ callId: 'answer-call' }),
    applySessionResult: (...args) => applied.push(args),
  });
  assert.equal(await host.resolveUserQuestionForSession('sess_question_a', 'question-a', { cancelled: true }), true);
  assert.deepEqual(sent, [[{
    sessionId: 'sess_question_a', questionId: 'question-a', response: { cancelled: true },
    open: { sessionId: 'sess_question_a' }, baseRevision: 9,
  }, { callId: 'answer-call' }]]);
  assert.deepEqual(applied, [['sess_question_a', { accepted: true }]]);
  accepted = false;
  assert.equal(await host.resolveUserQuestionForSession('sess_question_a', 'question-a', { cancelled: true }), false);
});
