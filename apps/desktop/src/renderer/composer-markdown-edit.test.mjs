import assert from 'node:assert/strict';
import test from 'node:test';
import React, { act, useRef, useState } from 'react';
import { installTestDom } from './test-support/test-dom.mjs';
import { composerListIndentEdit, composerNewlineEdit } from './composer-markdown-edit.ts';

test('explicit newlines continue bullet and numbered markers with their indentation and spacing', () => {
  for (const [input, expected] of [
    ['- one', '- one\n- '],
    ['+ one', '+ one\n+ '],
    ['* one', '* one\n* '],
    ['  9. nine', '  9. nine\n  10. '],
    ['\t2) two', '\t2) two\n\t3) '],
    ['-  wide', '-  wide\n-  '],
  ]) {
    assert.deepEqual(composerNewlineEdit(input, input.length, input.length), {
      value: expected, start: expected.length, end: expected.length,
    });
  }
});

test('newline replaces the selection, splits list content and does not reinterpret plain text or marker carets', () => {
  for (const [input, start, end, expected, caret] of [
    ['- first last', 7, 7, '- first\n-  last', 10],
    ['- first last', 2, 8, '- \n- last', 5],
    ['- first\n- second', 4, 12, '- fi\n- cond', 7],
    ['hello world', 5, 11, 'hello\n', 6],
    ['inline - text', 13, 13, 'inline - text\n', 14],
    ['- text', 0, 0, '\n- text', 1],
    ['  12. text', 3, 3, '  1\n2. text', 4],
    ['first\n- next', 6, 6, 'first\n\n- next', 7],
    ['---', 3, 3, '---\n', 4],
  ]) {
    assert.deepEqual(composerNewlineEdit(input, start, end), { value: expected, start: caret, end: caret });
  }
});

test('empty list items end in place without removing neighboring lines', () => {
  for (const input of ['- ', '+ ', '* ', '1. ', '  2) \t', '\t- ', '-']) {
    assert.deepEqual(composerNewlineEdit(input, input.length, input.length), { value: '', start: 0, end: 0 });
  }
  assert.deepEqual(composerNewlineEdit('before\n  -  \nafter', 11, 11), {
    value: 'before\n\nafter', start: 7, end: 7,
  });
  assert.deepEqual(composerNewlineEdit('  -   ', 3, 5), { value: '', start: 0, end: 0 });
  assert.deepEqual(composerNewlineEdit('  -   ', 1, 1), { value: ' \n -   ', start: 2, end: 2 });
  assert.deepEqual(composerNewlineEdit('- \nnext', 2, 4), { value: '- \n- ext', start: 5, end: 5 });
});

test('Tab and Shift+Tab transform list lines and preserve selected content and caret offsets', () => {
  assert.deepEqual(composerListIndentEdit('- one', 5, 5, false), { value: '  - one', start: 7, end: 7 });
  assert.deepEqual(composerListIndentEdit('  - one', 7, 7, true), { value: '- one', start: 5, end: 5 });
  assert.deepEqual(composerListIndentEdit('\t- one', 6, 6, true), { value: '- one', start: 5, end: 5 });
  assert.deepEqual(composerListIndentEdit(' - one', 1, 1, true), { value: '- one', start: 0, end: 0 });
  assert.deepEqual(composerListIndentEdit('  - one', 1, 1, true), { value: '- one', start: 0, end: 0 });
  assert.deepEqual(composerListIndentEdit('- one', 5, 5, true), { value: '- one', start: 5, end: 5 });
  assert.deepEqual(composerListIndentEdit('- one\n2. two\nplain', 2, 12, false), {
    value: '  - one\n  2. two\nplain', start: 4, end: 16,
  });
  assert.deepEqual(composerListIndentEdit('  - one\n  2. two\nplain', 4, 16, true), {
    value: '- one\n2. two\nplain', start: 2, end: 12,
  });
  assert.deepEqual(composerListIndentEdit('- one\nplain', 0, 6, false), {
    value: '  - one\nplain', start: 2, end: 8,
  });
  for (const [input, start, end] of [['plain', 5, 5], ['- one\nplain', 0, 11], ['first\nplain', 6, 6]]) {
    assert.equal(composerListIndentEdit(input, start, end, false), null);
  }
});

async function withKeyboard(t, run) {
  const { dom, root } = installTestDom(t, { rootId: 'root', jsdom: { pretendToBeVisual: true } });
  dom.window.HTMLElement.prototype.attachEvent = () => {};
  dom.window.HTMLElement.prototype.detachEvent = () => {};
  const { useComposerKeyboard } = await import('./use-composer-keyboard.ts');
  const { useComposerIme } = await import('./use-composer-ime.ts');
  const ctx = { sends: [], caret: null };
  const noop = () => {};
  ctx.slash = { open: false, commands: [{ usage: '/help' }], index: 0, setIndex: noop, setDismissed: noop };
  ctx.mention = {
    open: false, match: { start: 0, end: 1, query: '' }, signature: '',
    results: ['file.ts'], index: 0, setIndex: noop, setDismissed: noop, setResults: noop,
  };
  ctx.skillMention = {
    open: false, match: null, signature: '', results: [], index: 0,
    setIndex: noop, setDismissed: noop,
  };
  ctx.selector = {
    open: false, index: 0, messages: [{ id: 'm1', text: 'old' }],
    setIndex: noop, setOpen: noop, openSelector: noop,
    rewindToMessage: async (id) => { ctx.rewound = id; },
  };
  function Harness() {
    const [value, set] = useState('');
    const ref = useRef(value);
    ref.current = value;
    const textarea = useRef(null);
    const composing = useRef(false);
    const suppressLineBreak = useRef(false);
    const navigation = useRef({ index: -1, seed: '' });
    const seedAttachments = useRef([]);
    const attachmentsRef = useRef([]);
    const escapeClearAt = useRef(0);
    const setCaretOffset = (caret) => { ctx.caret = caret; };
    useComposerIme({
      textarea, composingRef: composing, suppressImeLineBreakRef: suppressLineBreak,
      draftRef: ref, setDraft: set, setCaretOffset,
    });
    Object.assign(ctx, { value, set, textarea, ref, composing, suppressLineBreak, navigation });
    Object.assign(ctx, useComposerKeyboard({
      draft: { value, set, ref, textarea, setCaretOffset },
      slash: ctx.slash, mention: ctx.mention, skillMention: ctx.skillMention, selector: ctx.selector,
      history: { entries: [], navigation, seedAttachments, attachmentsRef, replaceAttachments: noop },
      queue: { pendingSubmissionId: '', hasRestorableMessages: () => false, restore: noop },
      runtime: { turnBusy: false, attachments: [], escapeClearAt, showNotice: noop },
      ime: { composing, suppressLineBreak },
      actions: { send: async (...args) => ctx.sends.push(args), stop: async () => {}, clearAttachments: noop },
    }));
    return React.createElement('textarea', { ref: textarea, value, onChange: (event) => set(event.target.value) });
  }
  await act(async () => root.render(React.createElement(Harness)));
  ctx.seed = async (value, start = value.length, end = start, direction = 'none') => {
    await act(async () => ctx.set(value));
    ctx.textarea.current.setSelectionRange(start, end, direction);
  };
  ctx.flush = async () => {
    await act(async () => new Promise((resolve) => window.setTimeout(resolve, 0)));
  };
  ctx.key = async (key, options = {}) => {
    const event = {
      key, currentTarget: ctx.textarea.current, nativeEvent: { isComposing: false, keyCode: 0 },
      shiftKey: false, ctrlKey: false, metaKey: false, altKey: false, repeat: false,
      prevented: false, stopped: false,
      preventDefault() { this.prevented = true; }, stopPropagation() { this.stopped = true; },
      ...options,
    };
    await act(async () => ctx.onKeyDown(event));
    await ctx.flush();
    return event;
  };
  await run(ctx, dom);
}

test('keyboard edits list newlines and backward selections but ordinary Enter still sends', async (t) => {
  await withKeyboard(t, async (ctx) => {
    await ctx.seed('- one');
    ctx.navigation.current = { index: 0, seed: 'old' };
    assert.equal((await ctx.key('Enter', { shiftKey: true })).prevented, true);
    assert.equal(ctx.value, '- one\n- ');
    assert.equal(ctx.ref.current, ctx.value);
    assert.equal(ctx.caret, 8);
    assert.equal(ctx.textarea.current.selectionStart, 8);
    assert.equal(ctx.navigation.current.index, -1);
    await ctx.key('Enter', { shiftKey: true });
    assert.equal(ctx.value, '- one\n');
    await ctx.seed('- one\n2. two', 2, 12, 'backward');
    await ctx.key('Tab');
    assert.equal(ctx.value, '  - one\n  2. two');
    assert.equal(ctx.textarea.current.selectionStart, 4);
    assert.equal(ctx.textarea.current.selectionEnd, 16);
    assert.equal(ctx.textarea.current.selectionDirection, 'backward');
    await ctx.key('Tab', { shiftKey: true });
    assert.equal(ctx.value, '- one\n2. two');
    assert.equal(ctx.textarea.current.selectionStart, 2);
    assert.equal(ctx.textarea.current.selectionEnd, 12);
    await ctx.seed('- one');
    await ctx.key('Enter');
    assert.deepEqual(ctx.sends, [['', 'keyboard-enter']]);
    assert.equal(ctx.value, '- one');
    await ctx.key('Enter', { repeat: true, shiftKey: true });
    assert.equal(ctx.value, '- one');
  });
});

test('plain input, modifier newlines and palette ownership are preserved', async (t) => {
  await withKeyboard(t, async (ctx) => {
    await ctx.seed('plain', 1, 4);
    assert.equal((await ctx.key('Tab')).prevented, false);
    assert.equal((await ctx.key('Tab', { shiftKey: true })).prevented, false);
    await ctx.key('Enter', { shiftKey: true });
    assert.equal(ctx.value, 'p\nn');
    for (const options of [{ ctrlKey: true }, { metaKey: true }, { altKey: true }]) {
      await ctx.seed('2. two');
      await ctx.key('Enter', options);
      assert.equal(ctx.value, '2. two\n3. ');
    }
    await ctx.seed('* one');
    await ctx.key('j', { ctrlKey: true });
    assert.equal(ctx.value, '* one\n* ');
    await ctx.seed('- one');
    assert.equal((await ctx.key('Tab', { ctrlKey: true })).prevented, false);
    await ctx.key('A', { shiftKey: true });
    await ctx.key('Enter', { shiftKey: true });
    assert.equal(ctx.value, '- one\n- ');
    assert.equal(ctx.sends.length, 0);
    ctx.slash.open = true;
    await ctx.seed('/h');
    await ctx.key('Tab');
    assert.equal(ctx.value, '/help ');
    await ctx.key('Enter');
    assert.deepEqual(ctx.sends.at(-1), ['/help', 'keyboard-enter']);
    ctx.slash.open = false;
    ctx.mention.open = true;
    await ctx.seed('@');
    await ctx.key('Tab');
    assert.equal(ctx.value, '@file.ts ');
    ctx.mention.open = false;
    ctx.selector.open = true;
    await ctx.seed('- one');
    await ctx.key('Enter');
    assert.equal(ctx.rewound, 'm1');
    assert.equal(ctx.value, '- one');
  });
});

test('Korean composition commits without send or indent and explicit newline uses the committed text once', async (t) => {
  await withKeyboard(t, async (ctx, dom) => {
    await ctx.seed('- 하');
    const element = ctx.textarea.current;
    element.dispatchEvent(new dom.window.CompositionEvent('compositionstart'));
    const enter = await ctx.key('Enter', { nativeEvent: { isComposing: true, keyCode: 229 } });
    assert.equal(enter.prevented, false);
    assert.equal(enter.stopped, true);
    assert.equal(ctx.sends.length, 0);
    assert.equal(ctx.value, '- 하');
    assert.equal((await ctx.key('Tab', { shiftKey: true })).stopped, true);
    await ctx.key('j', { ctrlKey: true });
    assert.equal(ctx.value, '- 하');
    await act(async () => {
      element.value = '- 한';
      element.setSelectionRange(3, 3);
      element.dispatchEvent(new dom.window.CompositionEvent('compositionend'));
    });
    const stray = new dom.window.InputEvent('beforeinput', { inputType: 'insertLineBreak', cancelable: true });
    element.dispatchEvent(stray);
    assert.equal(stray.defaultPrevented, true);
    await ctx.key('Enter');
    assert.equal(ctx.sends.length, 1);
    await ctx.seed('- 하');
    element.dispatchEvent(new dom.window.CompositionEvent('compositionstart'));
    await act(async () => {
      ctx.onKeyDown({
        key: 'Enter', currentTarget: element, nativeEvent: { isComposing: true, keyCode: 229 },
        shiftKey: true, ctrlKey: false, metaKey: false, altKey: false, repeat: false,
        preventDefault() { assert.fail('Do not cancel IME commit'); }, stopPropagation() {},
      });
      element.value = '- 한';
      element.setSelectionRange(3, 3);
      element.dispatchEvent(new dom.window.CompositionEvent('compositionend'));
    });
    await ctx.flush();
    await ctx.flush();
    assert.equal(ctx.value, '- 한\n- ');
    assert.equal(element.selectionStart, 6);
    assert.equal(ctx.sends.length, 1);
    await ctx.seed('한\n');
    await ctx.key('Enter', { shiftKey: true, nativeEvent: { isComposing: true, keyCode: 229 } });
    assert.equal(ctx.value, '한\n');
    await ctx.seed('- 한');
    assert.equal((await ctx.key('Tab', { nativeEvent: { isComposing: false, keyCode: 229 } })).stopped, true);
    assert.equal(ctx.value, '- 한');
  });
});
