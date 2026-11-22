#!/usr/bin/env node
/** CPU measurement of the same camera retention function used by controller.ts. */
import { stepViewRetention } from '../src/gameplay/step-view.mjs';

const priorMeasuredStep = 0.54;
const frameSeconds = 1 / 60;
const tauSeconds = 0.05;
const firstFrameLag = priorMeasuredStep * stepViewRetention(frameSeconds, tauSeconds);
const firstFrameCameraMove = priorMeasuredStep - firstFrameLag;
let lagAfter150ms = priorMeasuredStep;
for (let i = 0; i < 9; i++) lagAfter150ms *= stepViewRetention(frameSeconds, tauSeconds);

console.log(`old measured one-frame advance: ${priorMeasuredStep.toFixed(3)} m`);
console.log(`new camera advance on first 60 Hz frame: ${firstFrameCameraMove.toFixed(3)} m`);
console.log(`camera lag after 150 ms (9 frames): ${lagAfter150ms.toFixed(3)} m`);
console.log(`position/physics advance: ${priorMeasuredStep.toFixed(3)} m immediately (unchanged)`);

if (!(firstFrameCameraMove < priorMeasuredStep)) throw new Error('camera advance was not damped');
if (!(lagAfter150ms < 0.03)) throw new Error('camera did not settle within 0.03 m by 150 ms');
console.log('PASS step-view CPU reference');
