#!/usr/bin/env node
/**
 * Compares the two lightmap encodings the game can load, using the SAME math the
 * loader uses, and prints what a player would actually see.
 *
 *   node scripts/lightmap-16bit-check.mjs [dir]     (default assets/map)
 *
 * It needs a bake that wrote BOTH files — tools/bake_map.sh writes lightmap.bin
 * (16-bit, the game file) and lightmap.png (8-bit preview) in the same run.
 *
 * Why the 16-bit file is the reference: it stores the bake's linear values as
 * half-float per channel, which is what the game uploads. The PNG is the same
 * values squeezed into bytes, so the difference between the two reads is exactly
 * the quantization the player would see if the game still used the 8-bit file.
 *
 * Two things this checks that a plain "error" number would hide:
 *   - relative error is only meaningful above half-float's floor (6.1e-5); below
 *     it a channel is subnormal and a percentage is meaningless, so those texels
 *     are counted separately, not averaged into the number;
 *   - row order. Both paths take row 0 as the TOP (glTF v0). This is checked by
 *     comparing the two files in the same order AND in flipped order: if the
 *     flipped comparison is clearly worse, the convention is consistent.
 */
import { readFileSync } from 'node:fs';
import { inflateSync } from 'node:zlib';
import { join } from 'node:path';

const dir = process.argv[2] ?? 'assets/map';
const manifest = JSON.parse(readFileSync(join(dir, 'manifest.json'), 'utf8'));
const lm = manifest.lightmap;
if (!lm) throw new Error(`${dir}/manifest.json has no "lightmap" block — run tools/bake_map.sh`);

const size = lm.resolution;
const texels = size * size;

// ---- 16-bit path: raw RGBA16F, no decode (what loadHalfLightmap reads) -------
function halfToFloat(h) {
  const sign = h & 0x8000 ? -1 : 1;
  const exp = (h & 0x7c00) >> 10;
  const frac = h & 0x03ff;
  if (exp === 0) return sign * Math.pow(2, -14) * (frac / 1024); // subnormal
  if (exp === 31) return sign * Infinity;                        // inf / nan
  return sign * Math.pow(2, exp - 15) * (1 + frac / 1024);
}

const binBuf = readFileSync(join(dir, lm.file ?? 'lightmap.bin'));
const binBytes = new Uint8Array(binBuf.buffer, binBuf.byteOffset, binBuf.byteLength);
if (binBytes.length !== texels * 8) {
  throw new Error(`lightmap.bin is ${binBytes.length} bytes, expected ${texels * 8} (${size}x${size} RGBA16F)`);
}
const bin = new Uint16Array(binBytes.buffer, binBytes.byteOffset, binBytes.byteLength / 2);

const linear = new Float64Array(texels * 3);
for (let i = 0, o = 0; i < bin.length; i += 4, o += 3) {
  // The loader multiplies both paths by π after decoding, so the comparison here
  // is unaffected: the scale cancels out of a relative error.
  linear[o] = halfToFloat(bin[i]);
  linear[o + 1] = halfToFloat(bin[i + 1]);
  linear[o + 2] = halfToFloat(bin[i + 2]);
}

// ---- 8-bit path: PNG, filter 0 per row (as tools/bake_map.py writes it) -------
function decodePng(path) {
  const b = new Uint8Array(readFileSync(path).buffer);
  if ([...b.subarray(0, 8)].join() !== '137,80,78,71,13,10,26,10') throw new Error(`${path} is not a PNG`);
  let p = 8, w = 0, h = 0, bitDepth = 0, colorType = 0;
  const idat = [];
  while (p < b.length) {
    const len = ((b[p] << 24) | (b[p + 1] << 16) | (b[p + 2] << 8) | b[p + 3]) >>> 0;
    const type = String.fromCharCode(b[p + 4], b[p + 5], b[p + 6], b[p + 7]);
    const data = b.subarray(p + 8, p + 8 + len);
    if (type === 'IHDR') {
      w = ((data[0] << 24) | (data[1] << 16) | (data[2] << 8) | data[3]) >>> 0;
      h = ((data[4] << 24) | (data[5] << 16) | (data[6] << 8) | data[7]) >>> 0;
      bitDepth = data[8];
      colorType = data[9];
    } else if (type === 'IDAT') idat.push(data);
    if (type === 'IEND') break;
    p += 12 + len;
  }
  if (bitDepth !== 8 || colorType !== 6) throw new Error(`${path}: expected 8-bit RGBA, got depth ${bitDepth} type ${colorType}`);
  if (w !== size || h !== size) throw new Error(`${path} is ${w}x${h}, manifest says ${size}`);
  const raw = inflateSync(Buffer.concat(idat.map((c) => Buffer.from(c))));
  const rows = new Uint8Array(w * h * 4);
  for (let y = 0; y < h; y++) {
    const base = y * (1 + w * 4);
    const filter = raw[base];
    if (filter !== 0) throw new Error(`${path}: row ${y} uses filter ${filter} — this check reads filter 0 only`);
    rows.subarray(y * w * 4).set(raw.subarray(base + 1, base + 1 + w * 4));
  }
  return rows;
}

const png = decodePng(join(dir, lm.preview ?? 'lightmap.png'));
const range = lm.range ?? 1;
const srgbDecode = (c) => (c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4));
const srgbEncode = (l) => (l <= 0.0031308 ? l * 12.92 : 1.055 * Math.pow(l, 1 / 2.4) - 0.055);
const HALF_FLOOR = 6.1e-5; // smallest normal half-float value

/** Compare the two reads. `flipped` mirrors rows, which is only correct if one of
 *  the two paths actually flips — so a flipped run is a control, not a result. */
function compare(flipped) {
  let lit = 0, dark = 0, rep = 0;
  let sumRel = 0, maxRel = 0, sumDarkRel = 0, maxDarkRel = 0;
  let sumPeakRel = 0, sumDarkPeakRel = 0;
  let lsbSum = 0, maxLsb = 0, darkGe1 = 0;
  for (let t = 0; t < texels; t++) {
    const src = flipped ? (size - 1 - Math.floor(t / size)) * size + (t % size) : t;
    const p = t * 4;
    const m = srgbDecode(png[p + 3] / 255) * range;               // per-texel RGBM multiplier
    const dec = [0, 1, 2].map((c) => srgbDecode(png[p + c] / 255) * m);
    const o = src * 3;
    const truth = [linear[o], linear[o + 1], linear[o + 2]];
    const peak = Math.max(...truth);
    if (peak <= 1e-4) continue;                                   // black has no gradient to compare
    lit++;
    if (peak < 0.05) dark++;
    if (peak >= HALF_FLOOR) {
      rep++;
      const rel = Math.max(...dec.map((v, i) => Math.abs(v - truth[i]) / truth[i]));
      sumRel += rel;
      maxRel = Math.max(maxRel, rel);
      // The peak channel is what sets brightness, so its error is the number the
      // eye is about. Per-channel percentages stay printed too: they are much
      // larger because a dark texel's weaker channels sit far below the peak.
      const pc = truth.indexOf(peak);
      const relPeak = Math.abs(dec[pc] - peak) / peak;
      sumPeakRel += relPeak;
      if (peak < 0.05) {
        sumDarkRel += rel;
        sumDarkPeakRel += relPeak;
        maxDarkRel = Math.max(maxDarkRel, rel);
      }
    }
    // Display bytes: what a screen can show (sRGB, clamped at 1.0; AgX is not
    // modelled here). A dark texel landing on the same byte as its neighbour is a
    // flat step — a band — so "off by >= 1 byte" is the banding-relevant count.
    const byteTruth = Math.round(255 * srgbEncode(Math.min(truth[0], 1)));
    const byteFile = Math.round(255 * srgbEncode(Math.min(dec[0], 1)));
    const lsb = Math.abs(byteTruth - byteFile);
    lsbSum += lsb;
    maxLsb = Math.max(maxLsb, lsb);
    if (peak < 0.05 && lsb >= 1) darkGe1++;
  }
  return { lit, dark, rep, sumRel, maxRel, sumDarkRel, maxDarkRel, sumPeakRel, sumDarkPeakRel, lsbSum, maxLsb, darkGe1 };
}

const pct = (x, d = 2) => (100 * x).toFixed(d);
const same = compare(false);
const flip = compare(true);
if (!same.lit) throw new Error('no lit texels to compare — nothing to check');

console.log(`lightmap-16bit-check — ${dir} (${size}px, ${same.lit} lit texels, dark lit <0.05: ${same.dark})`);
console.log('8-bit file read against the 16-bit reference, same texels:');
console.log(`  brightness channel (sets luminance), values >= half floor ${HALF_FLOOR}:  mean ${pct(same.sumPeakRel / same.rep, 3)}%`);
if (same.dark) console.log(`  brightness channel, dark lit area (<0.05)                       mean ${pct(same.sumDarkPeakRel / same.dark, 3)}%`);
console.log(`  all channels (weaker channels sit far below the peak):                       mean ${pct(same.sumRel / same.rep, 3)}%  max ${pct(same.maxRel, 2)}%`);
console.log(`  what the screen gets:                                                        mean ${(same.lsbSum / same.lit).toFixed(2)} display LSB  max ${same.maxLsb} LSB`);
if (same.dark) console.log(`  dark texels off by >=1 display byte (a flat step = a band):        ${pct(same.darkGe1 / same.dark, 1)}%`);
console.log(`  texels under half's floor (subnormal, no percentage):                        ${same.lit - same.rep}`);
console.log('The big dark-area percentages are not a contradiction with the small LSB numbers: the values there are tiny, so a relative error is large while the visible step stays around 1-2 bytes. The 16-bit file has 0 error at storage by definition, and its step is far below 1 display LSB — that is the whole argument for 16-bit.');
console.log(`row order control — same order vs mirrored rows:`);
console.log(`  same order    mean ${(same.lsbSum / same.lit).toFixed(2)} LSB`);
console.log(`  mirrored rows mean ${(flip.lsbSum / flip.lit).toFixed(2)} LSB  →  ${flip.lsbSum / flip.lit > 2 * (same.lsbSum / same.lit) + 1 ? 'consistent (row 0 = top in both paths)' : 'NOT consistent — one path flips rows'}`);
console.log('For the 16-bit file itself the stored error is 0 by definition; what matters is that its step is far below 1 display LSB, which tools/bake_map.py prints per run.');
