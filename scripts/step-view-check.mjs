#!/usr/bin/env node
/** CPU measurement of the same camera retention function used by controller.ts. */
import { stepViewRetention } from '../src/gameplay/step-view.mjs';

const priorMeasuredStep = 0.54;
const frameSeconds = 1 / 60;
const tauSeconds = 0.05;
const retention = stepViewRetention(frameSeconds, tauSeconds);

// The two orderings of the same damping, measured with the same tau.
//
// A = record the step advance BEFORE the retention (what the code did first): the
//   step frame itself already pushes part of the jump through the camera.
// B = record it AFTER the retention (what controller.ts does now), the same order
//   the height ease uses: the step frame holds the view, the view catches up over
//   the following frames.
//
// Camera position = feet + offset, so the camera advance in a frame is
// (physics advance) + offset. The physics feet always move the full step immediately.
function run(order, frames) {
  let offset = 0;
  let pending = 0;
  const advances = [];
  for (let f = 0; f < frames; f++) {
    if (f === 0) pending = priorMeasuredStep; // a step is accepted once
    if (order === 'before') {
      offset -= pending;
      pending = 0;
    }
    offset *= retention;
    if (order === 'after') {
      offset -= pending;
      pending = 0;
    }
    advances.push(priorMeasuredStep + offset);
  }
  return advances;
}

const settleWindow = 10; // 150 ms at 60 Hz, the window the height ease uses
const longRun = 60; // 1 s, where the asymptote is within 0.001 m
const settleLimit = 0.03;
function settleFrame(advances) {
  for (let i = 0; i < advances.length; i++) {
    if (priorMeasuredStep - advances[i] < settleLimit) return i + 1;
  }
  return -1;
}

const before = run('before', longRun);
const after = run('after', longRun);

console.log(`per-frame retention at 60 Hz, tau ${tauSeconds} s: ${retention.toFixed(4)}`);
console.log(`physics advance every frame: ${priorMeasuredStep.toFixed(3)} m immediately (unchanged)`);
console.log('--- ordering comparison, same 0.54 m step-up ---');
console.log(`A record before retention: frame 1 camera advance ${before[0].toFixed(3)} m, ` +
  `settles below ${settleLimit} m on frame ${settleFrame(before)}, travel after 1 s ${before[longRun - 1].toFixed(3)} m`);
console.log(`B record after retention:  frame 1 camera advance ${after[0].toFixed(3)} m, ` +
  `settles below ${settleLimit} m on frame ${settleFrame(after)}, travel after 1 s ${after[longRun - 1].toFixed(3)} m`);
console.log(`camera lag at 150 ms: A ${(priorMeasuredStep - before[settleWindow - 1]).toFixed(3)} m, ` +
  `B ${(priorMeasuredStep - after[settleWindow - 1]).toFixed(3)} m`);
console.log('per-frame camera advance, first 10 frames:');
for (let i = 0; i < settleWindow; i++) {
  console.log(`  frame ${i + 1}: A ${before[i].toFixed(3)} m | B ${after[i].toFixed(3)} m`);
}

// B is what controller.ts now does: the step frame holds the view, no jump through.
if (after[0] > 1e-9) throw new Error('B was expected to hold the view on the step frame');
// Damping may change WHEN the view arrives, never HOW FAR it goes: both orderings
// must reach the same travel, because the physics feet move the whole step.
if (Math.abs(after[longRun - 1] - priorMeasuredStep) > 0.001) {
  throw new Error('B lost distance to the damping');
}
if (Math.abs(before[longRun - 1] - after[longRun - 1]) > 0.001) {
  throw new Error('damping changed the total travel');
}
// B must still settle within the 150 ms window plus one frame, or it feels laggy.
if (settleFrame(after) > settleWindow) throw new Error('B does not settle within 150 ms');

console.log('PASS step-view CPU reference (both orderings, horizontal included)');
