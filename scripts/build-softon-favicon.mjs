import fs from 'node:fs/promises';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { pathToFileURL } from 'node:url';
import sharp from 'sharp';

// Preserve the supplied CI artwork. Its leftmost connected alpha component is
// the original S, including its curved tips; no font substitution or redraw.
export async function buildSoftonFavicon(source, output) {
  const { data, info } = await sharp(source).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  if (info.width !== 250 || info.height !== 100) throw new Error('Expected the supplied 250x100 solid SOFTON logo.');
  const seen = new Uint8Array(info.width * info.height), components = [];
  for (let start = 0; start < seen.length; start++) {
    if (seen[start] || !data[start * 4 + 3]) continue;
    const queue = [start], pixels = [];
    seen[start] = 1;
    let left = info.width, top = info.height, right = 0, bottom = 0;
    for (let index = 0; index < queue.length; index++) {
      const pixel = queue[index], x = pixel % info.width, y = Math.floor(pixel / info.width);
      pixels.push(pixel);
      left = Math.min(left, x); top = Math.min(top, y); right = Math.max(right, x); bottom = Math.max(bottom, y);
      for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
        const nx = x + dx, ny = y + dy;
        if (nx < 0 || nx >= info.width || ny < 0 || ny >= info.height) continue;
        const next = ny * info.width + nx;
        if (!seen[next] && data[next * 4 + 3]) { seen[next] = 1; queue.push(next); }
      }
    }
    components.push({ left, top, width: right - left + 1, height: bottom - top + 1, pixels });
  }
  components.sort((a, b) => a.left - b.left);
  const glyph = components[0];
  if (!glyph || glyph.left !== 0 || glyph.width >= info.width / 3) throw new Error('The original S could not be isolated.');
  const white = Buffer.alloc(data.length);
  for (const pixel of glyph.pixels) {
    white.fill(255, pixel * 4, pixel * 4 + 3);
    white[pixel * 4 + 3] = data[pixel * 4 + 3];
  }
  const symbol = await sharp(white, { raw: info }).extract({
    left: glyph.left, top: glyph.top, width: glyph.width, height: glyph.height,
  }).png().toBuffer();
  await fs.mkdir(output, { recursive: true });
  const icons = [];
  for (const size of [16, 32, 48, 128]) {
    const foreground = await sharp(symbol).resize(size - 4, size - 4, { fit: 'contain',
      background: { r: 0, g: 0, b: 0, alpha: 0 } }).png().toBuffer();
    const png = await sharp({ create: { width: size, height: size, channels: 4, background: '#DA2032' } })
      .composite([{ input: foreground, gravity: 'centre' }]).png().toBuffer();
    await fs.writeFile(path.join(output, `favicon-${size}.png`), png, { flag: 'wx' });
    if (size <= 48) icons.push({ size, png });
  }
  const header = Buffer.alloc(6 + icons.length * 16);
  header.writeUInt16LE(1, 2); header.writeUInt16LE(icons.length, 4);
  let offset = header.length;
  for (const [index, { size, png }] of icons.entries()) {
    const entry = 6 + index * 16;
    header[entry] = size; header[entry + 1] = size;
    header.writeUInt16LE(1, entry + 4); header.writeUInt16LE(32, entry + 6);
    header.writeUInt32LE(png.length, entry + 8); header.writeUInt32LE(offset, entry + 12);
    offset += png.length;
  }
  await fs.writeFile(path.join(output, 'favicon.ico'), Buffer.concat([header, ...icons.map(({ png }) => png)]), { flag: 'wx' });
  return { source, output, glyph: { left: glyph.left, top: glyph.top, width: glyph.width, height: glyph.height },
    colors: ['#DA2032', '#FFFFFF'], sizes: [16, 32, 48, 128] };
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const { values } = parseArgs({ options: { source: { type: 'string' }, output: { type: 'string' } } });
  if (!values.source || !values.output) throw new Error('--source and --output are required.');
  console.log(JSON.stringify(await buildSoftonFavicon(values.source, values.output), null, 2));
}
