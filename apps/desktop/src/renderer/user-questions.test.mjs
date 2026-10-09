import assert from 'node:assert/strict';
import test from 'node:test';
import React, { act } from 'react';
import { installTestDom } from './test-support/test-dom.mjs';
import { UserQuestionCard } from './UserQuestionCard.tsx';
import { registerSessionIpc } from '../main/ipc-sessions.ts';
import { DESKTOP_IPC } from '../shared/contract.ts';

const request = {
  id: 'question-a', sessionId: 'session-a', toolCallId: 'call-a', requestedAt: 1,
  questions: [
    { id: 'route', header: 'Approach', question: 'Which route?', options: [
      { label: 'Small', description: 'Focused changes' }, { label: 'Full', description: 'All paths' },
    ] },
    { id: 'note', question: 'Anything else?', options: [] },
  ],
};

function mount(t) {
  const env = installTestDom(t, { rootId: 'root', expose: ['HTMLElement', 'HTMLInputElement', 'HTMLTextAreaElement'] });
  const render = async (props) => act(async () => env.root.render(React.createElement(UserQuestionCard, props)));
  const click = async (element) => act(async () => element.click());
  const type = async (element, value) => act(async () => {
    const setter = Object.getOwnPropertyDescriptor(env.window.HTMLTextAreaElement.prototype, 'value').set;
    setter.call(element, value);
    element.dispatchEvent(new env.window.Event('input', { bubbles: true }));
  });
  return { ...env, render, click, type };
}

test('card exposes labeled choices, requires every answer and submits selected/custom answers once', async (t) => {
  const h = mount(t);
  const responses = [];
  const pending = Promise.withResolvers();
  await h.render({ request, resolve: (response) => { responses.push(response); return pending.promise; } });
  const form = h.document.querySelector('form');
  const submit = form.querySelector('button[type=submit]');
  assert.match(form.textContent, /Which route\?.*Small.*Focused changes.*Full.*All paths.*Other.*Anything else\?/s);
  assert.equal(form.querySelector('input:checked'), null);
  assert.equal(submit.disabled, true);
  assert.deepEqual(responses, []);
  await h.click(form.querySelectorAll('input[type=radio]')[1]);
  assert.equal(submit.disabled, true);
  await h.type(form.querySelector('textarea'), 'keep logs');
  assert.equal(submit.disabled, false);
  await act(async () => {
    form.dispatchEvent(new h.window.Event('submit', { bubbles: true, cancelable: true }));
    form.dispatchEvent(new h.window.Event('submit', { bubbles: true, cancelable: true }));
  });
  assert.deepEqual(responses, [{ answers: { route: { option: 1 }, note: { text: 'keep logs' } } }]);
  assert.equal(submit.disabled, true);
  await act(async () => pending.resolve(true));
});

test('Other accepts custom text, transport failure preserves it and cancellation is explicit', async (t) => {
  const h = mount(t);
  const responses = [];
  let fail = true;
  const single = { ...request, questions: [request.questions[0]] };
  await h.render({
    request: single,
    resolve: async (response) => {
      responses.push(response);
      if (fail) throw new Error('disconnected');
      return true;
    },
  });
  const form = h.document.querySelector('form');
  await h.click(form.querySelectorAll('input[type=radio]')[2]);
  const textarea = form.querySelector('textarea');
  await h.type(textarea, '  ');
  assert.equal(form.querySelector('button[type=submit]').disabled, true);
  await h.type(textarea, 'my own route');
  await h.click(form.querySelector('button[type=submit]'));
  assert.match(form.textContent, /disconnected/);
  assert.equal(textarea.value, 'my own route');
  assert.equal(form.querySelector('button[type=submit]').disabled, false);
  fail = false;
  await act(async () => textarea.dispatchEvent(new h.window.KeyboardEvent('keydown', {
    key: 'Escape', bubbles: true, cancelable: true,
  })));
  assert.deepEqual(responses, [{ answers: { route: { text: 'my own route' } } }, { cancelled: true }]);
});

test('reload and session/request replacement never select or submit an answer', async (t) => {
  const h = mount(t);
  const responses = [];
  const resolve = async (response) => { responses.push(response); return true; };
  await h.render({ key: 'session-a:question-a', request, resolve });
  await h.click(h.document.querySelector('input[type=radio]'));
  await h.render({ key: 'session-b:question-b', request: { ...request, id: 'question-b', sessionId: 'session-b' }, resolve });
  assert.equal(h.document.querySelector('input:checked'), null);
  assert.equal(h.document.querySelector('button[type=submit]').disabled, true);
  await act(async () => h.root.render(null));
  await h.render({ key: 'session-a:question-a', request, resolve });
  assert.equal(h.document.querySelector('input:checked'), null);
  assert.deepEqual(responses, []);
  await h.click(h.document.querySelector('button[type=button]'));
  assert.deepEqual(responses, [{ cancelled: true }]);
});

test('question IPC validates its own response and retains the addressed session/id', async () => {
  const routes = new Map();
  const received = [];
  registerSessionIpc({
    handle: (name, fn) => routes.set(name, fn),
    host: { resolveUserQuestionForSession: async (...args) => { received.push(args); return true; } },
    invokeDesktopOperation: async () => null,
  });
  const answer = routes.get(DESKTOP_IPC.resolveUserQuestionForSession);
  const response = { answers: { route: { option: 1 } } };
  assert.equal(await answer(null, 'sess_question_a', 'question-a', response), true);
  assert.deepEqual(received, [['sess_question_a', 'question-a', { cancelled: false, ...response }]]);
  assert.throws(() => answer(null, 'sess_question_a', 'question-a', { approved: true }), TypeError);
  assert.throws(() => answer(null, '', 'question-a', response), TypeError);
  assert.throws(() => answer(null, 'sess_question_a', '', response), TypeError);
  assert.equal(received.length, 1);
});
