/**
 * Lightmap bake stats: decode a lightmap PNG in pure Node (zlib inflate +
 * scanline unfilter — no deps, no browser) and report mean/max brightness
 * plus a coarse brightness grid, so it's obvious at a glance whether the
 * bake captured lit geometry or wrote black.
 *
 *   node scripts/bake-stats.mjs [path/to/lightmap.png]
 *   (default assets/map/lightmap.png)
 *
 * Exits 1 if the image is essentially black (nothing baked).
 */
import { readFileSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { inflateSync } from 'node:zlib';

const file = process.argv[2] ?? 'assets/map/lightmap.png';
const buf = readFileSync(file);
if (buf.readUInt32BE(0) !== 0x89504e47) {
  console.error(`error: not a PNG: ${file}`);
  process.exit(1);
}

// ---- chunk walk: IHDR + concatenated IDAT --------------------------------
let off = 8;
let ihdr = null;
const idat = [];
while (off < buf.length) {
  const len = buf.readUInt32BE(off);
  const type = buf.toString('ascii', off + 4, off + 8);
  const data = buf.subarray(off + 8, off + 8 + len);
  if (type === 'IHDR') {
    ihdr = {
      w: data.readUInt32BE(0),
      h: data.readUInt32BE(4),
      depth: data[8],
      color: data[9],
      interlace: data[12],
    };
  } else if (type === 'IDAT') {
    idat.push(data);
  } else if (type === 'IEND') {
    break;
  }
  off += 12 + len;
}
if (!ihdr) {
  console.error('error: no IHDR chunk');
  process.exit(1);
}
if (ihdr.interlace !== 0) {
  console.error('error: interlaced PNG not supported');
  process.exit(1);
}
const channels = { 0: 1, 2: 3, 4: 2, 6: 4 }[ihdr.color];
if (!channels || (ihdr.depth !== 8 && ihdr.depth !== 16)) {
  console.error(`error: unsupported PNG (color type ${ihdr.color}, bit depth ${ihdr.depth})`);
  process.exit(1);
}

// ---- inflate + undo per-scanline filters (0..4) --------------------------
const raw = inflateSync(Buffer.concat(idat));
const bpp = (channels * ihdr.depth) / 8; // filter operates on this byte stride
const stride = ihdr.w * bpp;
const out = Buffer.alloc(ihdr.h * stride);
let prev = Buffer.alloc(stride);
let pos = 0;
for (let y = 0; y < ihdr.h; y++) {
  const filter = raw[pos++];
  const line = raw.subarray(pos, pos + stride);
  pos += stride;
  const cur = out.subarray(y * stride, (y + 1) * stride);
  if (filter === 0) {
    line.copy(cur);
  } else if (filter === 1 || filter === 2 || filter === 3 || filter === 4) {
    for (let i = 0; i < stride; i++) {
      const a = i >= bpp ? cur[i - bpp] : 0;      // already-reconstructed left pixel
      const b = prev[i];                          // reconstructed pixel above
      const c = i >= bpp ? prev[i - bpp] : 0;     // diagonal
      let v = line[i];
      if (filter === 1) v = (v + a) & 0xff;
      else if (filter === 2) v = (v + b) & 0xff;
      else if (filter === 3) v = (v + ((a + b) >> 1)) & 0xff;
      else {
        const p = a + b - c;
        const pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c);
        v = (v + (pa <= pb && pa <= pc ? a : pb <= pc ? b : c)) & 0xff;
      }
      cur[i] = v;
    }
  } else {
    console.error(`error: unknown PNG filter type ${filter}`);
    process.exit(1);
  }
  prev = cur;
}

// ---- luminance per pixel (0..1) ------------------------------------------
const step = ihdr.depth / 8;
const sample = (base) => {
  if (ihdr.depth === 8) return out[base] / 255;
  return out.readUInt16BE(base) / 65535;
};
// RGBM lightmaps (encoding:"rgbm" in the sibling manifest) store
// rgb = srgb(linear/m), alpha = srgb(m/range). Decode to linear, then
// re-encode to sRGB so the reported numbers keep their pre-RGBM meaning
// (display brightness — directly comparable to the old plain-sRGB stats).
// Without a manifest range m is unrecoverable: fall back to the raw ratio
// channels and SAY SO (verdict still works, magnitudes don't).
const srgb2lin = (v) => (v <= 0.04045 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4));
const lin2srgb = (v) => (v <= 0.0031308 ? v * 12.92 : 1.055 * Math.pow(v, 1 / 2.4) - 0.055);
let rgbmRange = null;
try {
  const manifest = JSON.parse(readFileSync(join(dirname(file), 'manifest.json'), 'utf8'));
  const lm = manifest?.lightmap;
  // The 8-bit PNG is always the RGBM preview, even when the game file is the 16-bit
  // one, so a present range means the same decode here.
  if (lm && Number.isFinite(lm.range) && (lm.encoding === 'rgbm' || lm.encoding === 'half')) {
    rgbmRange = lm.range;
  }
} catch { /* no manifest next to the PNG → legacy mode */ }
const rgbm = rgbmRange !== null && ihdr.color === 6 && channels >= 4;
console.log(rgbm
  ? `  decode: RGBM (range ${rgbmRange}, from manifest.json)`
  : (ihdr.color === 6 && channels >= 4
    ? '  decode: legacy ratio mode (no manifest range — magnitudes are ratios, not brightness)'
    : '  decode: plain (non-RGBM)'));
const lum = new Float64Array(ihdr.w * ihdr.h);
for (let i = 0; i < lum.length; i++) {
  const base = i * bpp;
  if (ihdr.color === 0 || ihdr.color === 4) {
    lum[i] = sample(base); // grayscale
  } else if (rgbm) {
    const m = srgb2lin(sample(base + 3 * step)) * rgbmRange;
    lum[i] = (lin2srgb(srgb2lin(sample(base)) * m)
      + lin2srgb(srgb2lin(sample(base + step)) * m)
      + lin2srgb(srgb2lin(sample(base + 2 * step)) * m)) / 3;
  } else {
    // RGB(A): average the colour channels, ignore alpha
    lum[i] = (sample(base) + sample(base + step) + sample(base + 2 * step)) / 3;
  }
}

// ---- stats ----------------------------------------------------------------
let sum = 0;
let max = 0;
let min = 1;
let lit = 0; // pixels brighter than 4/255
for (let i = 0; i < lum.length; i++) {
  const v = lum[i];
  sum += v;
  if (v > max) max = v;
  if (v < min) min = v;
  if (v * 255 > 4) lit++;
}
const mean = sum / lum.length;
const depthLabel = `${ihdr.depth}-bit`;
const colorLabel = { 0: 'gray', 2: 'RGB', 4: 'gray+A', 6: 'RGBA' }[ihdr.color];
console.log(`bake stats: ${file} — ${ihdr.w}x${ihdr.h}, ${depthLabel} ${colorLabel}, ` +
  `${(statSync(file).size / 1e6).toFixed(1)} MB`);
console.log(`  mean ${(mean * 255).toFixed(1)}  max ${(max * 255).toFixed(1)}  ` +
  `min ${(min * 255).toFixed(1)}  non-black ${(lit / lum.length * 100).toFixed(1)}% (>4/255)`);

// ---- coarse brightness grid (8x8 cell means, 0..255) ---------------------
const N = 8;
const cw = Math.ceil(ihdr.w / N);
const ch = Math.ceil(ihdr.h / N);
const pad = (n) => String(n).padStart(4);
console.log(`  brightness grid (${N}x${N} cell means, 0-255, row 0 = top):`);
for (let gy = 0; gy < N; gy++) {
  const cells = [];
  for (let gx = 0; gx < N; gx++) {
    let s = 0;
    let n = 0;
    for (let y = gy * ch; y < Math.min((gy + 1) * ch, ihdr.h); y++) {
      for (let x = gx * cw; x < Math.min((gx + 1) * cw, ihdr.w); x++) {
        s += lum[y * ihdr.w + x];
        n++;
      }
    }
    cells.push(pad(n ? Math.round((s / n) * 255) : 0));
  }
  console.log(`  ${pad(gy)} ${cells.join('')}`);
}

// ---- verdict ---------------------------------------------------------------
if (max * 255 < 2) {
  console.log('  verdict: BLACK — the bake captured no light');
  process.exit(1);
}
console.log(`  verdict: LIT — bake captured lit geometry (mean ${(mean * 255).toFixed(1)}, max ${(max * 255).toFixed(1)})`);
