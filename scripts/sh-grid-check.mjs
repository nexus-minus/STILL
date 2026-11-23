#!/usr/bin/env node
/**
 * Headless CPU reference for the direction-dependent SH helpers in src/world/light-grid.ts.
 * Run: node --experimental-strip-types scripts/sh-grid-check.mjs
 *
 * What stayed of the old sh-grid module is the maths that depends on a DIRECTION: the basis at
 * a direction, and the SH series read out in a direction WITHOUT the cosine lobe. The cell
 * size, the neighbour mask and the blend strength are the reference's rules (light-grid.ts)
 * and are not restated or re-measured here. This check does not build a second grid, so the
 * projection rule (4π/N in projectCoefficients) is not implemented here either: the checks
 * work with exact closed forms, which is what lets them tell the two functions apart.
 *
 * Tolerances, declared BEFORE the numbers (the result cannot change them):
 *   - integer rules — term count, which term belongs to which band, the normalisation identity,
 *     a zero direction must throw: tolerance 0 differences
 *   - one constant against its closed form (a single rounding): 1 ulp at the term
 *   - the 9-term sums (9 products rounded once + 9 rounded additions): 9 ulp at the LARGEST
 *     term of the sum
 *   - floor for values near zero: 1e-9
 *   - the ulp measured at the RESULT is reported, never asserted: a cancelling sum has a
 *     meaningless ulp at its result, so the rounding is measured where it happens, at the term
 *   - a number that does not reach its tolerance is reported with its numbers and options; the
 *     tolerance is not moved to fit the number.
 *
 * What this proves, in one line: the direct evaluation gives the directional field, the
 * irradiance function gives the lobe-weighted integral, and the two are different numbers.
 */
import {
  SH_TERMS, BAND, LOBE, shBasis, shBasisAtDirection, shValueAtDirection, shIrradiance,
} from '../src/world/light-grid.ts';
import fs from 'node:fs';

const FLOOR = 1e-9;
const ULP_SINGLE = 1; // one constant against its closed form: one rounding
const ULP_SUM = 9;    // 9 products each rounded once + 9 rounded additions
const SMALLEST_F64 = 5e-324;
const ulp = (v) => {
  const a = Math.abs(v);
  if (a < SMALLEST_F64) return SMALLEST_F64;
  return Math.pow(2, Math.floor(Math.log2(a)) - 52);
};
const tol = (term, bound) => Math.max(bound * ulp(term), FLOOR);
// A term of exactly 0 has no ulp; the absolute tolerance (floor 1e-9) is what carries it.
const ulpRatio = (err, term) => term > 0 ? err / ulp(term) : 0;

/* Closed forms, derived from the definition of the real orthonormal SH — not copied from the
 * module. Comparing a module's numbers against the same numbers written down is not a test. */
const FOUR_PI = 4 * Math.PI;
const C0 = Math.sqrt(1 / FOUR_PI);          // band 0
const C1 = Math.sqrt(3 / FOUR_PI);          // band 1
const C2 = Math.sqrt(15 / FOUR_PI);         // band 2, cross terms
const C20 = Math.sqrt(5 / (4 * FOUR_PI));   // band 2, m = 0
const C22 = Math.sqrt(15 / (4 * FOUR_PI));  // band 2, m = ±2 diagonal
// term order as the definition writes it: l = 0; l = 1 (m = -1, 0, 1); l = 2 (m = -2 .. 2)
const DEF_BANDS = [0, 1, 1, 1, 2, 2, 2, 2, 2];
// Ramamoorthi's diffuse band factors, l = 0..2
const DEF_LOBE = [1, 2 / 3, 1 / 4];
/* Mean of each term's square over the sphere, independent of the module: a direction component
 * averages 1/3, x^2y^2 averages 1/15, (3z^2-1)^2 averages 4/5, (x^2-y^2)^2 averages 4/15.
 * norm^2 = constant^2 x 4π x mean, and an orthonormal basis must give exactly 1. */
const MEAN_SQ = [1, 1 / 3, 1 / 3, 1 / 3, 1 / 15, 1 / 15, 4 / 5, 1 / 15, 4 / 15];

/** The module's constants, read out of shBasis itself (its arguments are not normalised, so a
 *  unit axis or an axis pair exposes exactly one constant). */
const basisAt = (x, y, z) => { const b = new Float64Array(SH_TERMS); shBasis(x, y, z, b); return b; };
const MODULE_C = [
  basisAt(0, 0, 0)[0],      // band 0
  basisAt(0, 1, 0)[1],      // band 1, m = -1
  basisAt(0, 0, 1)[2],      // band 1, m = 0
  basisAt(1, 0, 0)[3],      // band 1, m = 1
  basisAt(1, 1, 0)[4],      // band 2, m = -2
  basisAt(0, 1, 1)[5],      // band 2, m = -1
  basisAt(0, 0, 1)[6] / 2,  // band 2, m = 0 (the term carries 3z^2 - 1 = 2 here)
  basisAt(1, 0, 1)[7],      // band 2, m = 1
  basisAt(1, 0, 0)[8],      // band 2, m = 2
];
const DEF_C = [C0, C1, C1, C1, C2, C2, C20, C2, C22];

function closedFormBasis(x, y, z, out) {
  const len = Math.hypot(x, y, z);
  if (!(len > 0)) throw new RangeError('SH direction must be non-zero');
  x /= len; y /= len; z /= len;
  out[0] = C0;
  out[1] = C1 * y; out[2] = C1 * z; out[3] = C1 * x;
  out[4] = C2 * x * y; out[5] = C2 * y * z; out[6] = C20 * (3 * z * z - 1);
  out[7] = C2 * x * z; out[8] = C22 * (x * x - y * y);
  return out;
}

/** The same order through the Legendre addition theorem: the terms of one band sum to
 *  (2l+1)/(4π) P_l(cos). It does not know the term constants, so order, bands and lobe can be
 *  checked separately. `ratio` measures the sums with the module's own constants instead of the
 *  definition's, which tells a wrong constant apart from a wrong sum. */
function legendreKernel(cos, withLobe, ratio = [1, 1, 1]) {
  const P = [1, cos, (3 * cos * cos - 1) / 2];
  let e = 0;
  for (let l = 0; l <= 2; l++) e += (withLobe ? DEF_LOBE[l] * Math.PI : 1) * ratio[l] * ((2 * l + 1) / FOUR_PI) * P[l];
  return e;
}

/* 24 test directions from the golden spiral, deterministic, and deliberately not unit length:
 *  normalising the input is part of what is checked. */
const DIRS = [];
for (let i = 0; i < 24; i++) {
  const z = 1 - 2 * (i + 0.5) / 24;
  const r = Math.sqrt(1 - z * z);
  const a = i * 2.399963229728653;
  const scale = 0.7 + 0.6 * ((i * 7) % 5);
  DIRS.push([r * Math.cos(a) * scale, r * Math.sin(a) * scale, z * scale]);
}
const unit = (d) => { const l = Math.hypot(d[0], d[1], d[2]); return [d[0] / l, d[1] / l, d[2] / l]; };

let bandDiff = 0, lobeOver = 0, lobeMaxUlp = 0;
let constOver = 0, constMaxUlp = 0, normOver = 0, normMaxErr = 0;
let basisOver = 0, basisMaxUlpAtTerm = 0, normDiff = 0, zeroThrows = false;
let isoFieldOver = 0, isoFieldResultUlp = 0, isoLobeOver = 0, isoLobeResultUlp = 0, sameNumber = 0;
let fieldOver = 0, fieldMaxUlpAtTerm = 0, irrOver = 0, irrMaxUlpAtTerm = 0;
let fieldOverModule = 0, irrOverModule = 0;
const helperBasis = new Float64Array(SH_TERMS);
const closedBasis = new Float64Array(SH_TERMS);

// 1) band map (tolerance 0) and the lobe against its closed form (1 ulp at the term).
// LOBE is indexed by BAND, not by term, so the comparison uses the band the term belongs to.
for (let k = 0; k < SH_TERMS; k++) {
  if (BAND[k] !== DEF_BANDS[k]) bandDiff++;
  const term = DEF_LOBE[BAND[k]] * Math.PI;
  const e = Math.abs(LOBE[BAND[k]] - term);
  if (e > tol(term, ULP_SINGLE)) lobeOver++;
  lobeMaxUlp = Math.max(lobeMaxUlp, ulpRatio(e, term));
}

// 2) the module's constants against the closed form, and the orthonormality via the exact means
for (let k = 0; k < SH_TERMS; k++) {
  const e = Math.abs(MODULE_C[k] - DEF_C[k]);
  if (e > tol(DEF_C[k], ULP_SINGLE)) constOver++;
  constMaxUlp = Math.max(constMaxUlp, ulpRatio(e, DEF_C[k]));
  const norm2 = MODULE_C[k] * MODULE_C[k] * FOUR_PI * MEAN_SQ[k];
  const exact = DEF_C[k] * DEF_C[k] * FOUR_PI * MEAN_SQ[k];
  const e2 = Math.abs(norm2 - exact);
  if (e2 > tol(exact, ULP_SINGLE)) normOver++;
  normMaxErr = Math.max(normMaxErr, e2);
}

// 3) the basis at a direction against the closed form, and the normalisation identity (0)
for (const d of DIRS) {
  shBasisAtDirection(d, helperBasis);
  closedFormBasis(d[0], d[1], d[2], closedBasis);
  for (let k = 0; k < SH_TERMS; k++) {
    const e = Math.abs(helperBasis[k] - closedBasis[k]);
    if (e > tol(Math.abs(closedBasis[k]), ULP_SINGLE)) basisOver++;
    basisMaxUlpAtTerm = Math.max(basisMaxUlpAtTerm, ulpRatio(e, Math.abs(closedBasis[k])));
  }
  const u = unit(d);
  shBasis(u[0], u[1], u[2], closedBasis);
  for (let k = 0; k < SH_TERMS; k++) if (helperBasis[k] !== closedBasis[k]) normDiff++;
}
try { shBasisAtDirection([0, 0, 0], helperBasis); } catch (e) { zeroThrows = e instanceof RangeError; }

// 4) the two functions on the SAME coefficients. A constant field is the honest test: the direct
//    sum must give the field itself, the lobe sum pi x the field. The coefficients come from the
//    exact integral of a constant field, so no projection rule is repeated here.
const V = [0.25, 0.5, 0.75];
const isoCoefs = new Float64Array(SH_TERMS * 3);
for (let c = 0; c < 3; c++) for (let k = 0; k < SH_TERMS; k++) {
  isoCoefs[c * SH_TERMS + k] = k === 0 ? V[c] * FOUR_PI * C0 : 0;
}
const isoTerm = Math.max(...isoCoefs.map((v) => Math.abs(v * C0)));

// a directional field: coefficients = the basis at +X, so both sums are the addition theorem
const dirCoefs = new Float64Array(SH_TERMS * 3);
for (let c = 0; c < 3; c++) for (let k = 0; k < SH_TERMS; k++) dirCoefs[c * SH_TERMS + k] = basisAt(1, 0, 0)[k];
// the module's own band factors against the definition's: the sums carry the constant twice
const RATIO = [1, 1, 1];
for (let l = 0; l <= 2; l++) {
  const first = DEF_BANDS.indexOf(l);
  RATIO[l] = (MODULE_C[first] / DEF_C[first]) ** 2;
}

for (const d of DIRS) {
  const u = unit(d);
  const direct = new Float64Array(3), lobeOut = new Float64Array(3);
  shValueAtDirection(isoCoefs, u, direct);
  shIrradiance(isoCoefs, u[0], u[1], u[2], lobeOut);
  for (let c = 0; c < 3; c++) {
    const e = Math.abs(direct[c] - V[c]);
    if (e > tol(isoTerm, ULP_SUM)) isoFieldOver++;
    isoFieldResultUlp = Math.max(isoFieldResultUlp, ulpRatio(e, V[c]));
    const e2 = Math.abs(lobeOut[c] - V[c] * Math.PI);
    if (e2 > tol(isoTerm, ULP_SUM)) isoLobeOver++;
    isoLobeResultUlp = Math.max(isoLobeResultUlp, ulpRatio(e2, V[c] * Math.PI));
  }
  if (direct.every((v, c) => Math.abs(v - lobeOut[c]) <= tol(isoTerm, ULP_SUM))) sameNumber++;

  shBasisAtDirection(d, helperBasis);
  let largestTerm = 0;
  for (let k = 0; k < SH_TERMS; k++) largestTerm = Math.max(largestTerm, Math.abs(dirCoefs[k] * helperBasis[k]));
  shValueAtDirection(dirCoefs, u, direct);
  shIrradiance(dirCoefs, u[0], u[1], u[2], lobeOut);
  // against the definition's constants, and against the same theorem with the module's own
  // constants: the difference between the two counts is the constant, not the sum
  const kdDef = legendreKernel(u[0], false), kiDef = legendreKernel(u[0], true);
  const kdMod = legendreKernel(u[0], false, RATIO), kiMod = legendreKernel(u[0], true, RATIO);
  for (let c = 0; c < 3; c++) {
    const e = Math.abs(direct[c] - kdDef);
    if (e > tol(largestTerm, ULP_SUM)) fieldOver++;
    fieldMaxUlpAtTerm = Math.max(fieldMaxUlpAtTerm, ulpRatio(e, largestTerm));
    if (Math.abs(direct[c] - kdMod) > tol(largestTerm, ULP_SUM)) fieldOverModule++;
    const e2 = Math.abs(lobeOut[c] - kiDef);
    if (e2 > tol(largestTerm, ULP_SUM)) irrOver++;
    irrMaxUlpAtTerm = Math.max(irrMaxUlpAtTerm, ulpRatio(e2, largestTerm));
    if (e2 > tol(largestTerm, ULP_SUM) && Math.abs(lobeOut[c] - kiMod) > tol(largestTerm, ULP_SUM)) irrOverModule++;
  }
}

// 5) no duplicated rules: the cell size, the mask and the blend stay the reference's
const lgSrc = fs.readFileSync(new URL('../src/world/light-grid.ts', import.meta.url), 'utf8');
const RULES = {
  'cell size from the bake density': /Math\.sqrt\(o\.texelsPerCell \/ densityPerM2\)/.test(lgSrc),
  'cell size clamp 0.25 .. 4 m': /minCellSize: 0\.25/.test(lgSrc) && /maxCellSize: 4/.test(lgSrc),
  'density warning below 32 texels/m': /minDensity: 32/.test(lgSrc),
  'blend strength 0.25': /export const DEFAULT_BLEND = 0\.25/.test(lgSrc),
  'neighbour mask (neighbourBit + buildNeighbourVisibility)': /export function neighbourBit/.test(lgSrc) && /export function buildNeighbourVisibility/.test(lgSrc),
  'no second cell-size rule (storage budget / cbrt)': !/Math\.cbrt/.test(lgSrc),
  'the old module files are gone': !fs.existsSync(new URL('../src/world/sh-grid.mjs', import.meta.url)) &&
    !fs.existsSync(new URL('../src/world/sh-grid.d.mts', import.meta.url)),
};

console.log(`SH helpers in src/world/light-grid.ts (no second grid): band map ${bandDiff} differ ` +
  `(tolerance 0), lobe vs its closed form (pi x [1, 2/3, 1/4]) ${lobeOver} over ${ULP_SINGLE} ulp ` +
  `at the term, worst ${lobeMaxUlp.toFixed(1)} ulp`);
console.log(`constants, the module's numbers against the closed form (tolerance ${ULP_SINGLE} ulp at ` +
  `the term): ${constOver} of ${SH_TERMS} over, worst ${constMaxUlp.toExponential(3)} ulp`);
for (let k = 0; k < SH_TERMS; k++) {
  const e = Math.abs(MODULE_C[k] - DEF_C[k]);
  if (e > tol(DEF_C[k], ULP_SINGLE)) {
    console.log(`  term ${k} (band ${DEF_BANDS[k]}): module ${MODULE_C[k]}, closed form ${DEF_C[k]}, ` +
      `error ${e.toExponential(3)} = ${ulpRatio(e, DEF_C[k]).toExponential(3)} ulp at the term`);
  }
}
console.log(`  the same the other way, through the exact mean of each term's square over the sphere ` +
  `(norm^2 must be 1, tolerance ${ULP_SINGLE} ulp): ${normOver} of ${SH_TERMS} over, worst absolute ` +
  `${normMaxErr.toExponential(1)}`);
for (let k = 0; k < SH_TERMS; k++) {
  const norm2 = MODULE_C[k] * MODULE_C[k] * FOUR_PI * MEAN_SQ[k];
  if (Math.abs(norm2 - 1) > tol(1, ULP_SINGLE)) console.log(`  term ${k} (band ${DEF_BANDS[k]}): norm^2 ${norm2.toFixed(10)} instead of 1`);
}
console.log(`basis at a direction vs the closed form, ${DIRS.length} deliberately non-unit directions: ` +
  `${basisOver} of ${DIRS.length * SH_TERMS} over ${ULP_SINGLE} ulp at the term (worst ` +
  `${basisMaxUlpAtTerm.toExponential(3)}); normalisation identity ${normDiff} differ (tolerance 0), ` +
  `zero direction throws RangeError: ${zeroThrows}`);
console.log(`constant field — the direct sum must give the field itself, the lobe sum pi x it ` +
  `(tolerance ${ULP_SUM} ulp at the largest term, floor ${FLOOR}): direct ${isoFieldOver} over ` +
  `(worst ${isoFieldResultUlp.toFixed(1)} ulp at the result, reported only), lobe ${isoLobeOver} over ` +
  `(worst ${isoLobeResultUlp.toFixed(1)} ulp at the result); directions where both functions give the ` +
  `same number: ${sameNumber} of ${DIRS.length} — they must not, the lobe is the difference`);
console.log(`directional field (coefficients = the basis at +X), compared with the Legendre addition ` +
  `theorem: direct sum ${fieldOver} of ${DIRS.length * 3} over ${ULP_SUM} ulp at the largest term ` +
  `(worst ${fieldMaxUlpAtTerm.toExponential(2)} ulp), lobe sum ${irrOver} over (worst ` +
  `${irrMaxUlpAtTerm.toExponential(2)} ulp). Measured against the theorem with the module's own band ` +
  `factors (1, ${RATIO[1].toFixed(10)}, 1) instead of the definition's, the same sums come back inside ` +
  `the tolerance: ${fieldOverModule} and ${irrOverModule} over — so the sums and the term order are ` +
  `right. The band-1 constant used to be 1.7 ppm too large; the owner chose option 1 on 2026-11-23, so ` +
  `the module now holds the closed form sqrt(3/(4pi)) in BOTH sides (src/world/light-grid.ts and the ` +
  `same literal in src/render/rt.ts, which light-grid-check compares as values against the module). ` +
  `Option 2 (declare a looser tolerance) would have been a weakening and was not done; option 3 (report ` +
  `only) would have kept the maths wrong on purpose. On the picture this is about 1.7 ppm, far below the ` +
  `representation tolerance, so it is a maths-correctness decision, not a visible one.`);
console.log(`rules: ${Object.entries(RULES).map(([k, v]) => `${k} ${v ? 'ok' : 'MISSING'}`).join(', ')}`);

// asserts, in the order the tolerances were declared
if (bandDiff) throw new Error(`the band map differs from the definition on ${bandDiff} terms (tolerance 0)`);
if (lobeOver) throw new Error(`LOBE differs from pi x the band factors on ${lobeOver} terms, above 1 ulp at the term`);
if (constOver) throw new Error(`the basis constants differ from the closed form on ${constOver} terms, above 1 ulp at the term`);
if (normOver) throw new Error(`the basis is not orthonormal on ${normOver} terms (norm^2 must be 1, tolerance 1 ulp)`);
if (basisOver) throw new Error(`the basis at a direction differs from the closed form on ${basisOver} terms, above 1 ulp at the term`);
if (normDiff) throw new Error(`the direction helper is not bit-identical with shBasis on a unit direction (${normDiff}, tolerance 0)`);
if (!zeroThrows) throw new Error('a zero direction did not throw — a zero vector is not a direction');
if (isoFieldOver) throw new Error(`the direct evaluation did not reproduce a constant field within ${ULP_SUM} ulp (${isoFieldOver})`);
if (isoLobeOver) throw new Error(`the lobe evaluation of a constant field is not pi x the field within ${ULP_SUM} ulp (${isoLobeOver})`);
if (sameNumber) throw new Error(`the direct evaluation and the irradiance function gave the same number on ${sameNumber} directions — the lobe is applied in the wrong place`);
if (fieldOverModule) throw new Error(`the 9-term sum differs from the addition theorem on ${fieldOverModule} channels, above ${ULP_SUM} ulp at the largest term, even with the module's own band factors`);
if (irrOverModule) throw new Error(`the lobe-weighted sum differs from the addition theorem on ${irrOverModule} channels, above ${ULP_SUM} ulp at the largest term, even with the module's own band factors`);
for (const [rule, ok] of Object.entries(RULES)) if (!ok) throw new Error(`rule missing or duplicated: ${rule}`);

console.log('PASS SH helpers (basis at a direction, series read without the lobe, lobe only in the irradiance path)');
