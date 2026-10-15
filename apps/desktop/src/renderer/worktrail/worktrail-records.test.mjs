import assert from 'node:assert/strict';
import test from 'node:test';
import React, { act } from 'react';
import { installTestDom } from '../test-support/test-dom.mjs';
import { WorktrailPane } from './WorktrailPane.tsx';
import { recordColor, recordHeading, recordLabel, recordMillis, recordSide, worktrailRecords, worktrailStamp } from './worktrail-records.ts';

test('recent records use source order in normalized time and preserve note kinds and exact timestamps', () => {
  const second = 1_700_000_000;
  const records = worktrailRecords({ topics: [], cases: {
    8: { title: '작업', state: 'open', events: [
      { kind: 'note', note_kind: 'verified', at: (second + 1) * 1000, observed: '# 검사 완료\n\n본문' },
      { kind: 'decision', at: second, text: '배치 승인' },
    ] },
  } });
  assert.deepEqual(records.map(record => recordMillis(record.at)), [second * 1000, (second + 1) * 1000]);
  assert.equal(worktrailStamp(second), worktrailStamp(second * 1000));
  assert.equal(recordHeading(records[1]), '검사 완료');
  assert.equal(recordLabel(records[1]), '확인');
  assert.equal(recordColor(records[1]), '#a6e3a1');
  assert.equal(recordSide(records[0]), 'up');
  assert.equal(recordSide(records[1]), 'down');
  assert.equal(new Set(records.map(record => record.key)).size, 2);
});

test('a flow selection immediately replaces a 200-task list with that task and focuses its real record', async t => {
  const { window, document, root } = installTestDom(t, { rootId: 'root' });
  let recordMoves = 0;
  window.HTMLElement.prototype.scrollIntoView = function () { recordMoves++; };
  const calls = [];
  const review = { topics: [], cases: Object.fromEntries(Array.from({ length: 200 }, (_, index) => {
    const id = index + 1;
    return [id, { title: `작업 ${id}`, state: 'open', updated_at: id, events: [
      { kind: 'note', note_kind: 'verified', at: 1_700_000_000 + id, observed: `확인 ${id}\n\n검증한 내용` },
    ] }];
  })) };
  window.mixdogDesktop = { personalWorktrail: true, worktrailRequest: async (action, input) => {
    calls.push([action, input]);
    if (action === 'review') return review;
    if (action === 'thread') return { title: `작업 ${input.id}`, status: 'open', focus: { statement: '목표' } };
    if (action === 'history') return { conversation: [{ id: 1, role: '확인', created_at: 1_700_000_200, content: '실제 전체 기록' }], turns: [] };
    throw new Error(`unexpected ${action}`);
  } };
  await act(async () => root.render(React.createElement(WorktrailPane, { active: true })));
  assert.equal(document.querySelectorAll('.worktrail-list .worktrail-record').length, 200);
  const marks = [...document.querySelectorAll('.worktrail-flow-mark')];
  assert.equal(marks.length, 6);
  assert.ok(marks.at(-1).getAttribute('aria-label').includes('확인 200'));
  await act(async () => marks.at(-1).click());
  assert.equal(document.querySelectorAll('.worktrail-list .worktrail-record').length, 0);
  assert.equal(document.querySelector('.worktrail-detail h3').textContent, '작업 200');
  assert.equal(document.activeElement, document.querySelector('.worktrail-recent-record[data-current="true"]'));
  assert.ok(document.activeElement.textContent.includes('검증한 내용'));
  assert.ok(document.querySelector('.worktrail-flow-mark[aria-pressed="true"]'));
  assert.equal(recordMoves, 1);
  await act(async () => document.querySelector('.worktrail-flow-mark[aria-pressed="true"]').click());
  assert.equal(recordMoves, 2);
  assert.equal(calls.some(([action]) => action === 'history'), false);
  const button = text => [...document.querySelectorAll('button')].find(node => node.textContent === text);
  await act(async () => button('전체 기록').click());
  assert.ok(document.querySelector('.worktrail-event').textContent.includes('실제 전체 기록'));
  await act(async () => button('목록으로').click());
  assert.equal(document.querySelectorAll('.worktrail-list .worktrail-record').length, 200);
});

test('search flow uses matching tasks, an empty review has no artificial markers, and an inactive pane does not poll', async t => {
  const { window, document, root } = installTestDom(t, { rootId: 'root' });
  const calls = [];
  const review = { topics: [], cases: {
    1: { title: '배포', state: 'open', events: [{ kind: 'decision', at: 1_700_000_001, text: '배포 승인' }] },
    2: { title: '조회', state: 'open', events: [{ kind: 'note', note_kind: 'finding', at: 1_700_000_002, observed: '조회 점검' }] },
  } };
  window.mixdogDesktop = { worktrailRequest: async (action, input) => {
    calls.push([action, input]);
    if (action === 'review') return review;
    if (action === 'search') return { query: input.query, total: 1, nextOffset: null, checkedAt: 1_700_000_003, results: [
      { caseId: 1, title: '배포', topic: '주제', status: 'open', matches: [] },
    ] };
    throw new Error(`unexpected ${action}`);
  } };
  await act(async () => root.render(React.createElement(WorktrailPane, { active: true })));
  const button = text => [...document.querySelectorAll('button')].find(node => node.textContent === text);
  await act(async () => button('작업 검색').click());
  assert.equal(document.querySelectorAll('.worktrail-flow-mark').length, 0);
  const input = document.querySelector('input');
  const setValue = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
  await act(async () => { setValue.call(input, '배포'); input.dispatchEvent(new window.Event('input', { bubbles: true })); });
  await act(async () => document.querySelector('form').dispatchEvent(new window.Event('submit', { bubbles: true, cancelable: true })));
  const labels = [...document.querySelectorAll('.worktrail-flow-mark')].map(node => node.getAttribute('aria-label'));
  assert.equal(labels.length, 1);
  assert.ok(labels[0].includes('배포 승인'));
  assert.ok(!labels[0].includes('조회 점검'));
  await act(async () => root.render(React.createElement(WorktrailPane, { active: false })));
  const before = calls.length;
  await act(async () => new Promise(resolve => setTimeout(resolve, 20)));
  assert.equal(calls.length, before);
});

test('review recovery clears only its own failure and polling never refocuses a selected record', async t => {
  const { window, document, root } = installTestDom(t, { rootId: 'root' });
  let poll;
  window.setInterval = callback => { poll = callback; return 1; };
  window.clearInterval = () => {};
  let moves = 0;
  window.HTMLElement.prototype.scrollIntoView = function () { moves++; };
  let failed = false;
  const review = { topics: [], cases: { 1: { title: '작업', state: 'open', events: [
    { kind: 'note', note_kind: 'verified', at: 1_700_000_001, observed: '확인한 기록' },
  ] } } };
  window.mixdogDesktop = { worktrailRequest: async action => {
    if (action === 'review') {
      if (failed) throw new Error('조회 연결 실패');
      return structuredClone(review);
    }
    if (action === 'thread') return { title: '작업', status: 'open' };
    throw new Error(`unexpected ${action}`);
  } };
  await act(async () => root.render(React.createElement(WorktrailPane, { active: true })));
  await act(async () => document.querySelector('.worktrail-flow-mark').click());
  assert.equal(moves, 1);
  failed = true;
  await act(async () => poll());
  assert.equal(document.querySelector('.worktrail-error').textContent, '조회 연결 실패');
  assert.ok(document.body.textContent.includes('마지막 조회 내용'));
  assert.ok(document.body.textContent.includes('확인한 기록'));
  failed = false;
  await act(async () => poll());
  assert.equal(document.querySelector('.worktrail-error'), null);
  assert.ok(!document.body.textContent.includes('현재 상태는 확인하지 못했습니다.'));
  assert.equal(moves, 1);
});

test('a failed detail read stops the loading notice and preserves the available recent record', async t => {
  const { window, document, root } = installTestDom(t, { rootId: 'root' });
  window.mixdogDesktop = { worktrailRequest: async action => {
    if (action === 'review') return { topics: [], cases: { 1: { title: '작업', state: 'open', events: [
      { kind: 'note', note_kind: 'finding', at: 1_700_000_001, observed: '남아 있는 기록' },
    ] } } };
    throw new Error('상세 조회 실패');
  } };
  await act(async () => root.render(React.createElement(WorktrailPane, { active: true })));
  await act(async () => document.querySelector('.worktrail-list .worktrail-record').click());
  assert.equal(document.querySelector('.worktrail-error').textContent, '상세 조회 실패');
  assert.ok(!document.body.textContent.includes('선택한 작업을 조회하고 있습니다…'));
  assert.ok(document.querySelector('.worktrail-recent-record').textContent.includes('남아 있는 기록'));
});
