/**
 * Banding check for the baked lightmap.
 *
 * Decodes the lightmap PNG in pure Node (zlib + scanline unfilter, no deps),
 * then measures what causes visible banding:
 *   - how many distinct levels the 8-bit storage actually uses
 *   - how wide the flat "plateaus" are (a plateau + a 1-LSB jump = a band)
 *   - how coarse the RGBM multiplier (alpha) is in dark texels, which is where
 *     the eye sees banding most
 *
 *   node scripts/banding-check.mjs [path/to/lightmap.png]
 */
import { readFileSync } from 'node:fs';
import { inflateSync } from 'node:zlib';

const file = process.argv[2] ?? 'assets/map/lightmap.png';
const buf = readFileSync(file);

// ---- PNG decode -----------------------------------------------------------
let off = 8;
let ihdr = null;
const idat = [];
while (off < buf.length) {
  const len = buf.readUInt32BE(off);
  const type = buf.toString('ascii', off + 4, off + 8);
  const data = buf.subarray(off + 8, off + 8 + len);
  if (type === 'IHDR') ihdr = { w: data.readUInt32BE(0), h: data.readUInt32BE(4), depth: data[8], color: data[9] };
  if (type === 'IDAT') idat.push(data);
  // metadata chunks that should not be in a public-repo image
  if (type === 'tEXt' || type === 'iTXt' || type === 'zTXt') {
    console.log(`metadata chunk ${type}: ${data.subarray(0, Math.min(data.length, 40)).toString('latin1')}`);
  }
  off += 12 + len;
}
if (!ihdr) { console.error('error: no IHDR'); process.exit(1); }
const raw = inflateSync(Buffer.concat(idat));
const bpp = ihdr.color === 6 ? 4 : 3;
const stride = ihdr.w * bpp;
const px = Buffer.alloc(ihdr.h * stride);
let r = 0;
for (let y = 0; y < ihdr.h; y++) {
  const filter = raw[r++];
  const cur = raw.subarray(r, r + stride); r += stride;
  const prev = y ? px.subarray((y - 1) * stride, y * stride) : Buffer.alloc(stride);
  for (let x = 0; x < stride; x++) {
    const a = x >= bpp ? cur[x - bpp] : 0, b = prev[x], c = x >= bpp ? prev[x - bpp] : 0;
    let v;
    if (filter === 0) v = cur[x];
    else if (filter === 1) v = cur[x] + a;
    else if (filter === 2) v = cur[x] + b;
    else if (filter === 3) v = cur[x] + ((a + b) >> 1);
    else {
      const p = a + b - c, pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c);
      v = cur[x] + (pa <= pb && pa <= pc ? a : pb <= pc ? b : c);
    }
    px[y * stride + x] = v & 0xff;
  }
}

// ---- banding measure ----------------------------------------------------
const lum = i => Math.round(px[i] * 0.2126 + px[i + 1] * 0.7152 + px[i + 2] * 0.0722); // Rec.709 luma
const levels = new Map();      // level -> pixel count
let maxPlateau = 0, plateauPixels = 0, jumps = 0;
for (let y = 0; y < ihdr.h; y++) {
  let run = 1;
  for (let x = 1; x < ihdr.w; x++) {
    const i = y * stride + x * bpp, p = y * stride + (x - 1) * bpp;
    if (lum(i) === lum(p)) run++;
    else {
      jumps++;
      if (run >= 8) plateauPixels += run;
      if (run > maxPlateau) maxPlateau = run;
      run = 1;
    }
  }
}
for (let y = 0; y < ihdr.h; y++) for (let x = 0; x < ihdr.w; x++) {
  const L = lum(y * stride + x * bpp);
  levels.set(L, (levels.get(L) || 0) + 1);
}

// dark-region detail: in the darkest 5% of lit texels, how far apart are the
// distinct levels? A 1-LSB step there is what the eye reads as a band.
const dark = [...levels.entries()].filter(([L]) => L > 4 && L <= 32).sort((a, b) => a[0] - b[0]);
const darkPixels = dark.reduce((s, [, n]) => s + n, 0);
let biggestDarkGap = 0;
for (let i = 1; i < dark.length; i++) biggestDarkGap = Math.max(biggestDarkGap, dark[i][0] - dark[i - 1][0]);

console.log(`banding check: ${file} — ${ihdr.w}x${ihdr.h}, ${ihdr.depth}-bit, ${bpp} channels`);
console.log(`  distinct luma levels used: ${levels.size} of 256`);
console.log(`  largest flat plateau in a row: ${maxPlateau} px (a plateau + 1 LSB jump = one visible band)`);
console.log(`  pixels inside plateaus >= 8 px: ${plateauPixels} (${(plateauPixels / (ihdr.w * ihdr.h) * 100).toFixed(1)} % of the atlas)`);
console.log(`  dark range (luma 5-32): ${dark.length} distinct levels over ${darkPixels} px, biggest gap between levels ${biggestDarkGap}`);
if (bpp === 4) {
  const am = new Map();
  for (let y = 0; y < ihdr.h; y++) for (let x = 0; x < ihdr.w; x++) {
    const a = px[y * stride + x * bpp + 3];
    am.set(a, (am.get(a) || 0) + 1);
  }
  const low = [...am.entries()].filter(([a]) => a <= 40).sort((a, b) => a[0] - b[0]);
  console.log(`  RGBM multiplier channel: ${am.size} distinct values, ${low.length} values <= 40 (the dark areas)`);
  const top = [...am.entries()].sort((a, b) => b[1] - a[1]).slice(0, 6);
  console.log(`  most used multiplier values: ${top.map(([a, n]) => `${a} -> ${(n / (ihdr.w * ihdr.h) * 100).toFixed(1)} %`).join(', ')}`);
}
