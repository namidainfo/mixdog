import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import puppeteer from 'puppeteer-core';

function luminance(color) {
  const rgb = color.match(/\d+/g).map(Number).map((value) => {
    const channel = value / 255;
    return channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4;
  });
  return rgb[0] * .2126 + rgb[1] * .7152 + rgb[2] * .0722;
}

test('mini quota glow uses production theme, remains readable on the rail and never expands layout', async (t) => {
  const browser = await puppeteer.launch({
    ...(process.env.CHROME_PATH ? { executablePath: process.env.CHROME_PATH } : { channel: 'chrome' }),
    headless: true,
  });
  t.after(() => browser.close());
  const page = await browser.newPage();
  await page.setContent('<aside id="fixture" class="activity-rail" style="height:100px"></aside>');
  for (const file of ['./ui/tokens.css', './desktop/01-tokens.css', './desktop/06-activity-rail.css', './desktop/09-sidebar-chrome.css']) {
    await page.addStyleTag({ content: await readFile(new URL(file, import.meta.url), 'utf8') });
  }
  for (const theme of ['dark', 'light']) {
    const samples = await page.evaluate((theme) => {
      document.documentElement.dataset.mixdogTheme = theme;
      const fixture = document.getElementById('fixture');
      return ['', ' tone-warning', ' tone-danger'].map((tone) => {
        fixture.innerHTML = `
          <button class="sidebar-usage-toggle is-pinned">
            <span class="rail-usage-pin-stack">
              <span class="rail-usage-pin-brand has-quota glowing${tone}" style="--quota-value:20%">
                <svg style="width:16px;height:16px"></svg><i><i style="width:20%"></i></i><small>20%</small>
              </span>
            </span>
          </button>`;
        const brand = fixture.querySelector('.rail-usage-pin-brand');
        const meter = brand.querySelector('i');
        const text = brand.querySelector('small');
        const bounds = () => [brand.offsetWidth, brand.offsetHeight, meter.offsetWidth, meter.offsetHeight];
        const fresh = {
          bounds: bounds(),
          color: getComputedStyle(text).color,
          background: getComputedStyle(fixture).backgroundColor,
          gradient: getComputedStyle(meter.firstElementChild).backgroundImage,
          shadow: getComputedStyle(meter, '::before').boxShadow,
          textShadow: getComputedStyle(text).textShadow,
          opacity: getComputedStyle(meter, '::before').opacity,
        };
        brand.classList.add('is-stale');
        const stale = {
          bounds: bounds(),
          opacity: getComputedStyle(meter, '::before').opacity,
          textShadow: getComputedStyle(text).textShadow,
        };
        brand.classList.remove('glowing');
        const zero = { bounds: bounds(), content: getComputedStyle(meter, '::before').content };
        return { fresh, stale, zero };
      });
    }, theme);
    const expectedColors = theme === 'light'
      ? ['rgb(8, 121, 102)', 'rgb(152, 96, 0)', 'rgb(186, 48, 70)']
      : ['rgb(101, 220, 197)', 'rgb(255, 201, 119)', 'rgb(255, 139, 159)'];
    for (const [index, { fresh, stale, zero }] of samples.entries()) {
      assert.equal(fresh.color, expectedColors[index], `${theme}: good/warning/danger quota palette`);
      assert.match(fresh.background, /^rgb\(/, `${theme}: rail background must be opaque`);
      const foreground = luminance(fresh.color);
      const background = luminance(fresh.background);
      const contrast = (Math.max(foreground, background) + .05) / (Math.min(foreground, background) + .05);
      assert.ok(contrast >= 4.5, `${theme}: quota text contrast ${contrast}`);
      assert.match(fresh.gradient, /linear-gradient/);
      assert.notEqual(fresh.shadow, 'none');
      assert.notEqual(fresh.textShadow, 'none');
      assert.equal(fresh.opacity, theme === 'light' ? '0.55' : '1');
      assert.equal(stale.opacity, theme === 'light' ? '0.25' : '0.35');
      assert.equal(stale.textShadow, 'none');
      assert.equal(fresh.bounds[2], 26);
      assert.equal(fresh.bounds[3], 3);
      assert.deepEqual(stale.bounds, fresh.bounds);
      assert.deepEqual(zero.bounds, fresh.bounds);
      assert.equal(zero.content, 'none');
    }
  }
});
