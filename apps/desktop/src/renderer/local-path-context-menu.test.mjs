import assert from 'node:assert/strict';
import test from 'node:test';
import { win32 } from 'node:path';
import React, { act } from 'react';
import { installTestDom } from './test-support/test-dom.mjs';
import { LocalPathMention, MarkdownOpenFileContext, MarkdownProjectContext } from './MarkdownLink';

const PROJECT = 'C:/Project/conversation';

for (const path of ['src/app.ts', `${PROJECT}/src/app.ts`, 'docs/']) {
  test(`right-clicking ${path} reveals its validated location without opening a preview`, async (t) => {
    const { dom, root, document } = installTestDom(t, { rootId: 'root' });
    const reveals = [];
    const previews = [];
    dom.window.mixdogDesktop = {
      revealFile: async (...args) => reveals.push(args),
      openFilePath: async (...args) => reveals.push(args),
      searchProjectFiles: async () => [],
      resolveLocalPaths: async (paths) => paths.map((absolutePath) => ({
        absolutePath: win32.normalize(absolutePath).replaceAll('\\', '/').replace(/\/$/, ''),
        dir: path.endsWith('/'),
        projectPath: PROJECT,
        relPath: path.endsWith('/') ? 'docs' : 'src/app.ts',
        size: 10,
      })),
    };
    await act(async () => root.render(
      React.createElement(MarkdownProjectContext.Provider, { value: PROJECT },
        React.createElement(MarkdownOpenFileContext.Provider, { value: (...args) => previews.push(args) },
          React.createElement(LocalPathMention, { path, line: path.endsWith('/') ? undefined : 42 }, path)))
    ));
    const mention = document.querySelector('.tool-path-link');
    assert.ok(mention);
    const event = new dom.window.MouseEvent('contextmenu', {
      bubbles: true, cancelable: true, clientX: 25, clientY: 35, button: 2,
    });
    await act(async () => mention.dispatchEvent(event));
    assert.equal(event.defaultPrevented, true);
    assert.deepEqual(previews, []);
    const reveal = [...document.querySelectorAll('[role="menuitem"]')]
      .find((item) => item.textContent === 'Reveal in Explorer');
    assert.ok(reveal);
    await act(async () => reveal.click());
    assert.equal(reveals.length, 1);
    assert.equal(
      win32.resolve(...reveals[0].slice(0, 2)).replaceAll('\\', '/'),
      `${PROJECT}/${path.endsWith('/') ? 'docs' : 'src/app.ts'}`
    );
    assert.equal(reveals[0][2], undefined);
    assert.deepEqual(previews, []);
    if (!path.endsWith('/')) {
      await act(async () => mention.click());
      assert.deepEqual(previews, [[PROJECT, 'src/app.ts', 42]]);
    }
  });
}

test('a remote chat never offers the host OS Explorer action for a path mention', async (t) => {
  const { dom, root, document } = installTestDom(t, { rootId: 'root' });
  dom.window.mixdogRemoteServer = 'https://relay.test';
  dom.window.mixdogDesktop = { searchProjectFiles: async () => [] };
  await act(async () => root.render(
    React.createElement(MarkdownProjectContext.Provider, { value: PROJECT },
      React.createElement(LocalPathMention, { path: 'src/app.ts' }, 'src/app.ts'))
  ));
  await act(async () => document.querySelector('.tool-path-link').dispatchEvent(
    new dom.window.MouseEvent('contextmenu', { bubbles: true, cancelable: true, button: 2 })
  ));
  assert.equal([...document.querySelectorAll('[role="menuitem"]')]
    .some((item) => item.textContent === 'Reveal in Explorer'), false);
});
