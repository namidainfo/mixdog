import assert from 'node:assert/strict';
import test from 'node:test';
import React, { act } from 'react';
import { installTestDom } from '../test-support/test-dom.mjs';
import { WorktrailPane } from './WorktrailPane.tsx';
import { desktopUtilityDockTabEnabled } from '../desktop-feature-config.ts';
import { canSubmitDocument, documentDirty, worktrailRows } from './worktrail-model.ts';

test('only the personal local host exposes the Worktrail side view', t => {
  const { window } = installTestDom(t);
  assert.equal(desktopUtilityDockTabEnabled('worktrail'), false);
  window.mixdogDesktop = { personalWorktrail: true };
  assert.equal(desktopUtilityDockTabEnabled('worktrail'), true);
  window.mixdogDesktop = { personalWorktrail: false };
  assert.equal(desktopUtilityDockTabEnabled('worktrail'), false);
});
test('document submission requires saved text and explicit confirmation, and blocks resending pending approval', () => {
  const doc = { status: 'draft', title: '문서', content: '본문' };
  assert.equal(documentDirty(doc, '문서', '본문'), false);
  assert.equal(documentDirty(doc, '문서', '수정'), true);
  assert.equal(canSubmitDocument(doc, false, false), false);
  assert.equal(canSubmitDocument(doc, true, true), false);
  assert.equal(canSubmitDocument(doc, false, true), true);
  assert.equal(canSubmitDocument({ ...doc, status: 'uncertain' }, false, true), true);
  assert.equal(canSubmitDocument({ ...doc, status: 'submitted' }, false, true), false);
});
test('work records retain topics and latest activity ordering', () => {
  const rows = worktrailRows({ topics: [{ name: '믹스독', case_ids: [8] }], cases: {
    8: { title: '완료', state: 'closed', updated_at: 2, events: [] },
    9: { title: '진행', state: 'open', updated_at: 1, events: [] },
  } });
  assert.deepEqual(rows.map(row => row.id), [8, 9]);
  assert.equal(rows[0].topic, '믹스독');
});
test('inactive side layers do not read; completed selection produces a draft without submitting it', async t => {
  const { window, document, root } = installTestDom(t, { rootId: 'root' });
  const calls = [];
  const review = { topics: [], cases: { 8: { title: '완료 기록', state: 'closed', events: [] }, 9: { title: '진행 기록', state: 'open', events: [] } } };
  window.mixdogDesktop = { personalWorktrail: true, worktrailRequest: async (action, input) => {
    calls.push([action, input]);
    if (action === 'review') return review;
    if (action === 'documents') return [];
    if (action === 'create') return { id: 'draft', title: '문서', content: '본문', revision: 1, status: 'draft', sources: [{ id: 8, title: '완료 기록' }] };
    throw new Error(`unexpected ${action}`);
  } };
  await act(async () => root.render(React.createElement(WorktrailPane, { active: false })));
  assert.equal(calls.length, 0);
  await act(async () => root.render(React.createElement(WorktrailPane, { active: true })));
  const button = text => [...document.querySelectorAll('button')].find(node => node.textContent === text);
  await act(async () => button('문서화').click());
  assert.equal(document.querySelectorAll('.worktrail-picker input[type=checkbox]').length, 1);
  await act(async () => document.querySelector('.worktrail-picker input').click());
  await act(async () => button('초안 만들기').click());
  assert.deepEqual(calls.find(([action]) => action === 'create')[1], { caseIds: [8] });
  assert.equal(button('CloudWiki 승인 요청').disabled, true);
  assert.equal(calls.some(([action]) => action === 'submit'), false);
  const before = calls.length;
  await act(async () => root.render(React.createElement(WorktrailPane, { active: false })));
  await act(async () => new Promise(resolve => setTimeout(resolve, 20)));
  assert.equal(calls.length, before);
  assert.equal(document.querySelector('textarea').value, '본문');
});
test('a 200-record picker preserves selection limits and draft guards', async t => {
  const { window, document, root } = installTestDom(t, { rootId: 'root' });
  const calls = [];
  const review = { topics: [], cases: Object.fromEntries(Array.from({ length: 200 }, (_, index) => {
    const id = index + 1;
    return [id, { title: `완료 기록 ${id}`, state: 'closed', updated_at: id, events: [] }];
  })) };
  window.mixdogDesktop = { personalWorktrail: true, worktrailRequest: async (action, input) => {
    calls.push([action, input]);
    if (action === 'review') return review;
    if (action === 'documents') return [];
    if (action === 'create') return {
      id: 'draft', title: '문서', content: '본문', revision: 1, status: 'draft',
      sources: input.caseIds.map(id => ({ id, title: `완료 기록 ${id}` })),
    };
    throw new Error(`unexpected ${action}`);
  } };
  await act(async () => root.render(React.createElement(WorktrailPane, { active: true })));
  const button = text => [...document.querySelectorAll('button')].find(node => node.textContent === text);
  await act(async () => button('문서화').click());
  const picker = [...document.querySelectorAll('.worktrail-picker input[type=checkbox]')];
  assert.equal(picker.length, 200);
  assert.equal(button('초안 만들기').disabled, true);
  await act(async () => picker.at(-1).click());
  assert.equal(button('초안 만들기').disabled, false);
  for (const input of picker.slice(0, 19)) await act(async () => input.click());
  assert.equal(picker.filter(input => input.checked).length, 20);
  assert.equal(picker[19].disabled, true);
  assert.equal(picker.at(-1).disabled, false);
  await act(async () => button('초안 만들기').click());
  const created = calls.find(([action]) => action === 'create')[1].caseIds;
  assert.equal(created.length, 20);
  assert.ok(created.includes(1));
  assert.equal(button('CloudWiki 승인 요청').disabled, true);
  const textarea = document.querySelector('textarea');
  const setValue = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value').set;
  await act(async () => {
    setValue.call(textarea, '수정한 본문');
    textarea.dispatchEvent(new window.Event('input', { bubbles: true }));
  });
  assert.equal(button('초안 만들기').disabled, true);
  assert.equal(calls.some(([action]) => action === 'submit'), false);
});
