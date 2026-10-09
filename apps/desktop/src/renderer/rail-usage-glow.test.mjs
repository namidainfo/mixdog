import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import ts from 'typescript';
import { JSDOM } from 'jsdom';
import { displayUsagePercent, usageToneClass } from './usage-percent.ts';
import * as sidebarUsage from './SidebarUsage.tsx';

// Exercise the production glyph without starting the rail's host cadence.
const source = ts.createSourceFile(
  'ActivityRail.tsx',
  await readFile(new URL('./ActivityRail.tsx', import.meta.url), 'utf8'),
  ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX
);
const glyph = source.statements.find((node) => ts.isFunctionDeclaration(node) && node.name?.text === 'usagePinGlyph');
assert.ok(glyph);
const { outputText } = ts.transpileModule(glyph.getText(source), {
  compilerOptions: { jsx: ts.JsxEmit.React, target: ts.ScriptTarget.ES2022 },
});
const usagePinGlyph = new Function(
  'React', 'ProviderIcon', 'InitialSurface', 'displayUsagePercent', 'usageToneClass', 'loadedSidebarUsageModule', 't',
  `${outputText}; return usagePinGlyph;`
)(
  React, () => React.createElement('svg'), () => React.createElement('span', { 'data-loading': true }),
  displayUsagePercent, usageToneClass, () => sidebarUsage,
  (text, values) => text.replace('{{percent}}', String(values?.percent))
);

function render(rows, dashboard = {}, status = 'ready', loading = false) {
  const dom = new JSDOM(renderToStaticMarkup(usagePinGlyph(rows, loading, { dashboard, status })));
  return { dom, brands: [...dom.window.document.querySelectorAll('.rail-usage-pin-brand')] };
}

const entry = (percent, key = 'codex') => ({ key, provider: 'openai-oauth', percent });

test('mini quota keeps used percent and matching used-based warning/danger thresholds', () => {
  const { dom, brands } = render([0, 20, 69, 70, 89, 90, 100, 0.4].map((percent, i) => entry(percent, String(i))));
  try {
    assert.deepEqual(brands.map((brand) => brand.querySelector('small').textContent),
      ['0%', '20%', '69%', '70%', '89%', '90%', '100%', '0.4%']);
    for (const [index, brand] of brands.entries()) {
      const used = [0, 20, 69, 70, 89, 90, 100, 0.4][index];
      assert.equal(brand.querySelector('i > i').style.width, `${used}%`);
      assert.equal(brand.style.getPropertyValue('--quota-value'), `${used}%`);
      assert.equal(brand.title, `${used}% used`);
      assert.equal(brand.classList.contains('tone-warning'), used >= 70 && used < 90);
      assert.equal(brand.classList.contains('tone-danger'), used >= 90);
      assert.equal(brand.classList.contains('glowing'), used > 0);
      assert.ok(brand.classList.contains('has-quota'));
    }
  } finally { dom.window.close(); }
});

test('unknown is never fabricated as zero, and missing rows keep loading/plain glyph behavior', () => {
  const { dom, brands } = render([entry(null), entry(Number.NaN)]);
  try {
    for (const brand of brands) {
      assert.equal(brand.querySelector('small').textContent, '—');
      assert.equal(brand.querySelector('i > i').style.width, '0%');
      assert.equal(brand.title, 'Usage unavailable');
      assert.ok(!brand.classList.contains('has-quota'));
      assert.ok(!brand.classList.contains('glowing'));
      assert.ok(!brand.classList.contains('tone-danger'));
    }
  } finally { dom.window.close(); }
  assert.match(renderToStaticMarkup(usagePinGlyph([], true, { dashboard: {} })), /data-loading/);
  assert.match(renderToStaticMarkup(usagePinGlyph([], false, { dashboard: {} })), /codicon-pie-chart/);
});

test('stale accounts are individually subdued; stale seeds/failures and legacy providers are safe', () => {
  const dashboard = { rows: [{
    id: 'openai-oauth', group: 'oauth', authenticated: true,
    accounts: [
      { accountId: 'a', authenticated: true, stale: true, windows: [{ usedPct: 20 }] },
      { accountId: 'b', authenticated: true, stale: false, windows: [{ usedPct: 70 }] },
    ],
  }] };
  const { dom, brands } = render(sidebarUsage.usagePinEntries(dashboard), dashboard);
  try {
    assert.deepEqual(brands.map((brand) => brand.classList.contains('is-stale')), [true, false]);
  } finally { dom.window.close(); }
  for (const status of ['idle', 'loading', 'unavailable']) {
    const result = render([entry(20)], {}, status);
    assert.ok(result.brands[0].classList.contains('is-stale'));
    assert.equal(result.brands[0].querySelector('small').textContent, '20%');
    result.dom.window.close();
  }
  const legacy = render([entry(20)], { rows: [{ id: 'openai-oauth', stale: true }] });
  assert.ok(legacy.brands[0].classList.contains('is-stale'));
  legacy.dom.window.close();
});
