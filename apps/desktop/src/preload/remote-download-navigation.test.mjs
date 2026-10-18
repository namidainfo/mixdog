import assert from 'node:assert/strict';
import test from 'node:test';

import { installTestDom } from '../renderer/test-support/test-dom.mjs';
import { installRemoteDownloadNavigation } from './remote-download-navigation.ts';

const PATH = '/__mixdog-download__/11111111-2222-4333-8444-555555555555';
const URL = `https://mixdog.test${PATH}?size=238013607&name=installer.exe`;

function setup(t) {
  const { window, document } = installTestDom(t);
  const uninstall = installRemoteDownloadNavigation(document);
  t.after(uninstall);
  document.addEventListener('click', (event) => event.preventDefault());
  const link = document.createElement('a');
  link.href = URL;
  link.download = 'installer.exe';
  document.body.append(link);
  return { window, document, link, uninstall };
}

test('an old relay renderer can download through the paired window worker', (t) => {
  const { document, link } = setup(t);
  const label = document.createElement('span');
  label.textContent = 'Download';
  link.append(label);
  label.click();
  assert.equal(link.href, URL, 'the leased URL and its authorization are unchanged');
  assert.equal(link.hasAttribute('download'), false, 'the browser navigates through its worker');
  assert.equal(link.target, '', 'the authenticated paired window remains the consumer');
});

for (const [name, href] of [
  ['another origin', `https://other.test${PATH}`],
  ['another port', `https://mixdog.test:8443${PATH}`],
  ['ordinary HTTP file', 'https://mixdog.test/report.pdf'],
  ['blob', 'blob:https://mixdog.test/report'],
  ['data', 'data:text/plain;base64,eA=='],
  ['invalid lease path', 'https://mixdog.test/__mixdog-download__/not-a-lease'],
]) {
  test(`${name} downloads retain their original browser behavior`, (t) => {
    const { link } = setup(t);
    link.href = href;
    link.click();
    assert.equal(link.download, 'installer.exe');
  });
}

test('a renderer already using ordinary navigation needs no intervention', (t) => {
  const { link } = setup(t);
  link.removeAttribute('download');
  link.click();
  assert.equal(link.href, URL);
  assert.equal(link.hasAttribute('download'), false);
});

test('a cancelled click is not changed by the compatibility handler', (t) => {
  const { window, link } = setup(t);
  window.addEventListener('click', (event) => event.preventDefault(), true);
  link.click();
  assert.equal(link.download, 'installer.exe');
});

test('uninstalling releases the compatibility handler', (t) => {
  const { link, uninstall } = setup(t);
  uninstall();
  link.click();
  assert.equal(link.download, 'installer.exe');
});
