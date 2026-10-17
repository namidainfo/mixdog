import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import sharp from 'sharp';
import { buildSoftonFavicon } from './build-softon-favicon.mjs';

test('the CI-derived icons retain their declared dimensions, colors and valid multi-size ICO entries', async (t) => {
  const directory = await mkdtemp(path.join(tmpdir(), 'softon-favicon-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const source = fileURLToPath(new URL('../src/integrations/slack-session/hub/public/softon-wordmark.png', import.meta.url));
  const result = await buildSoftonFavicon(source, directory);
  assert.equal(result.glyph.left, 0);
  assert.ok(result.glyph.width < 250 / 3);
  const pngs = new Map();
  for (const size of [16, 32, 48, 128]) {
    const png = await readFile(path.join(directory, `favicon-${size}.png`)); pngs.set(size, png);
    const { data, info } = await sharp(png).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
    assert.deepEqual([info.width, info.height], [size, size]);
    assert.deepEqual([...data.subarray(0, 4)], [218, 32, 50, 255]);
    let hasForeground = false;
    for (let pixel = 0; pixel < data.length; pixel += 4) {
      const coverage = (data[pixel + 1] - 32) / (255 - 32);
      assert.equal(data[pixel + 3], 255);
      // Small icons legitimately have no fully covered white pixel: verify
      // the white-over-CI-red compositing invariant, including antialiasing.
      assert.ok(Math.abs(data[pixel] - (218 + (255 - 218) * coverage)) <= 2);
      assert.ok(Math.abs(data[pixel + 2] - (50 + (255 - 50) * coverage)) <= 2);
      hasForeground ||= coverage > 0;
    }
    assert.equal(hasForeground, true);
  }
  const ico = await readFile(path.join(directory, 'favicon.ico'));
  assert.equal(ico.readUInt16LE(0), 0); assert.equal(ico.readUInt16LE(2), 1); assert.equal(ico.readUInt16LE(4), 3);
  for (const [index, size] of [16, 32, 48].entries()) {
    const entry = 6 + index * 16, length = ico.readUInt32LE(entry + 8), offset = ico.readUInt32LE(entry + 12);
    assert.equal(ico[entry], size); assert.equal(ico[entry + 1], size);
    assert.deepEqual(ico.subarray(offset, offset + length), pngs.get(size));
  }
});
