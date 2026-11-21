/**
 * Control edge-case probe harness — QA pass over the movement overhaul
 * (companion to scripts/steptest.mjs: probe, don't guess).
 *
 * Every scenario drives the real controller in headless Firefox with a
 * per-frame trace. Columns: [t, feetX, feetY, feetZ, camY, grounded, vy,
 * hSpeed, freecam, coyoteMs, jumpBufMs]. Jump presses (conditional or
 * scheduled) are recorded separately with the PRE-jump state.
 *
 *   node scripts/controlprobe.mjs [url] [section]
 *   section: lips | ledgejump | spam | slopejump | corner | pillar |
 *            freecam | respawn | platform | rampjump | ceiling | all
 */
import puppeteer from 'puppeteer-core';

const rawUrl = process.argv[2] ?? 'http://localhost:4173';
const section = process.argv[3] ?? 'all';
const url = rawUrl.includes('?') ? rawUrl : `${rawUrl.replace(/\/$/, '')}/?testroom`;

const browser = await puppeteer.launch({
  browser: 'firefox',
  executablePath: process.env.FIREFOX ?? '/usr/bin/firefox',
  headless: true,
});
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let failed = false;
const check = (label, ok, detail = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? ' — ' + detail : ''}`);
  if (!ok) failed = true;
};
const note = (label, detail = '') => console.log(`NOTE  ${label}${detail ? ' — ' + detail : ''}`);

try {
  const page = await browser.newPage();
  await page.setViewport({ width: 1000, height: 600 });
  const logs = [];
  page.on('console', (m) => logs.push(m.text()));
  page.on('pageerror', (e) => logs.push('PAGEERROR ' + e.message));

  await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 20000 });
  for (let i = 0; i < 60 && !logs.some((l) => l.includes('[liminal] up')); i++) await sleep(200);
  await sleep(800);
  await page.evaluate(() => {
    window.__liminal.controller.forceActiveForTest = true;
  });

  /**
   * Per-frame scripted run. opts:
   *   spawn [x,y,z], yaw, keys[], ms, releaseAt?, jumpWhen?
   *     {x?[lo,hi], y?[lo,hi], z?[lo,hi], grounded?0|1} — first matching
   *     frame after i>5 presses Space (records PRE-jump state),
   *   actions [{at, type: jump|keydown|keyup|freecam|respawn|setpos, ...}]
   * Returns {frames, jumps} where jumps = [frameIdx, t, feetY, preJumpVy].
   */
  const run = (opts) =>
    page.evaluate(
      (opts) =>
        new Promise((resolve) => {
          const g = window.__liminal;
          const c = g.controller;
          for (const k of ['KeyW', 'KeyA', 'KeyS', 'KeyD', 'ShiftLeft', 'Space'])
            document.dispatchEvent(new KeyboardEvent('keyup', { code: k }));
          if (c.freecam) c.toggleFreecam();
          c.respawnAt(new g.THREE.Vector3(opts.spawn[0], opts.spawn[1], opts.spawn[2]));
          c.yaw = opts.yaw;
          const keys = opts.keys ?? [];
          for (const k of keys) document.dispatchEvent(new KeyboardEvent('keydown', { code: k }));
          const press = () => {
            document.dispatchEvent(new KeyboardEvent('keydown', { code: 'Space' }));
            document.dispatchEvent(new KeyboardEvent('keyup', { code: 'Space' }));
          };
          const frames = [];
          const jumps = [];
          const actions = [...(opts.actions ?? [])].sort((a, b) => a.at - b.at);
          let ai = 0;
          let jumpDone = false;
          const t0 = performance.now();
          const tick = () => {
            const t = performance.now() - t0;
            const vel = c.velocity;
            frames.push([
              +t.toFixed(1),
              +c.feet.x.toFixed(4), +c.feet.y.toFixed(4), +c.feet.z.toFixed(4),
              +g.camera.position.y.toFixed(4),
              c.grounded ? 1 : 0,
              +vel.y.toFixed(3),
              +Math.hypot(vel.x, vel.z).toFixed(3),
              c.freecam ? 1 : 0,
              +c.coyote.toFixed(0),
              +c.jumpBuffer.toFixed(0),
              // appended diagnostics (indices 11+ — consumers use 0..10)
              +vel.x.toFixed(3), +vel.z.toFixed(3),
              +c.wallSleep.toFixed(2), +c.wallLikeHold.toFixed(2),
            ]);
            while (ai < actions.length && t >= actions[ai].at) {
              const a = actions[ai++];
              if (a.type === 'jump') {
                jumps.push([frames.length - 1, +t.toFixed(1), +c.feet.y.toFixed(4), +vel.y.toFixed(3)]);
                press();
              } else if (a.type === 'keydown') {
                document.dispatchEvent(new KeyboardEvent('keydown', { code: a.key }));
              } else if (a.type === 'keyup') {
                document.dispatchEvent(new KeyboardEvent('keyup', { code: a.key }));
              } else if (a.type === 'freecam') {
                c.toggleFreecam();
              } else if (a.type === 'respawn') {
                c.respawnAt(new g.THREE.Vector3(a.pos[0], a.pos[1], a.pos[2]));
              } else if (a.type === 'setpos') {
                c.position.set(a.pos[0], a.pos[1], a.pos[2]);
                c.syncFeet?.();
              }
            }
            if (!jumpDone && opts.jumpWhen) {
              const w = opts.jumpWhen;
              const i = frames.length - 1;
              const okX = !w.x || (c.feet.x >= w.x[0] && c.feet.x <= w.x[1]);
              const okY = !w.y || (c.feet.y >= w.y[0] && c.feet.y <= w.y[1]);
              const okZ = !w.z || (c.feet.z >= w.z[0] && c.feet.z <= w.z[1]);
              const okG = w.grounded == null || (c.grounded ? 1 : 0) === w.grounded;
              if (i > 5 && okX && okY && okZ && okG) {
                jumpDone = true;
                jumps.push([i, +t.toFixed(1), +c.feet.y.toFixed(4), +vel.y.toFixed(3)]);
                press();
              }
            }
            if (opts.releaseAt != null && t >= opts.releaseAt && !frames._rel) {
              frames._rel = true;
              for (const k of keys) document.dispatchEvent(new KeyboardEvent('keyup', { code: k }));
            }
            if (t < opts.ms) requestAnimationFrame(tick);
            else {
              for (const k of [...keys, 'Space'])
                document.dispatchEvent(new KeyboardEvent('keyup', { code: k }));
              resolve({ frames, jumps });
            }
          };
          requestAnimationFrame(tick);
        }),
      opts,
    );

  // ---- helpers ------------------------------------------------------------
  const nanIn = (frames) =>
    frames.some((f) => f.slice(1, 4).some((v) => !Number.isFinite(v)) || !Number.isFinite(f[6]));
  /** jump impulses: vy gains ≥3 m/s in one frame AND ends >2 (a jump adds
   * jumpSpeed≈4; landings reset to ≤0, ramp entries grow vy by <3) */
  const impulses = (frames) => {
    const out = [];
    for (let i = 1; i < frames.length; i++) {
      if (frames[i][6] - frames[i - 1][6] > 3.0 && frames[i][6] > 2) {
        out.push({ i, t: frames[i][0], y: frames[i][2] });
      }
    }
    return out;
  };
  /** contiguous airborne spans [[startIdx, endIdx], ...] */
  const airSpans = (frames) => {
    const spans = [];
    let s = -1;
    for (let i = 0; i < frames.length; i++) {
      if (frames[i][5] === 0 && s < 0) s = i;
      if (frames[i][5] === 1 && s >= 0) { spans.push([s, i]); s = -1; }
    }
    if (s >= 0) spans.push([s, frames.length - 1]);
    return spans;
  };
  const boundsOk = (frames, b = { x: 8.6, z: 33, yLo: -1, yHi: 4.5 }) =>
    frames.every(
      (f) => Math.abs(f[1]) <= b.x && f[3] >= -8.6 && f[3] <= b.z && f[2] >= b.yLo && f[2] <= b.yHi,
    );

  const runSection = async (name) => {
    console.log(`\n=== ${name} ===`);
    logs.length = 0;

    // ---------------------------------------------------------------
    if (name === 'lips') {
      // Statistical lip-runway reproduction: the nub's climb window can
      // catch the mid-fall sample inherited from the 0.25 lip's descent.
      const RUNS = Number(process.env.LIPRUNS ?? 14);
      // mirrors scripts/steptest.mjs: real box x-spans (nub face 5.55) and
      // the window derived from the raycast height + live stepUp
      const lipDefs = [
        { face: 1.8, h: 0.05, depth: 0.4 }, { face: 3.0, h: 0.1, depth: 0.4 },
        { face: 4.2, h: 0.25, depth: 0.4 }, { face: 5.55, h: 0.05, depth: 0.1 },
      ].map((l) => ({
        ...l,
        touch: Math.sqrt(0.35 * 0.35 - (0.35 - l.h) * (0.35 - l.h)),
      }));
      const worst = [];
      let oldWindowFails = 0;
      const nubReadings = [];
      // the derived acceptance window (mirrors steptest): h from the BVH,
      // pop height from the live controller's stepUp
      const geom = await page.evaluate(() => {
        const g = window.__liminal;
        const down = new g.THREE.Vector3(0, -1, 0);
        return {
          heights: [2.0, 3.2, 4.4, 5.6].map((x) => {
            const hit = g.collision.raycast(new g.THREE.Vector3(x, 0.6, 5), down, 1.2);
            return hit ? +hit.point.y.toFixed(4) : NaN;
          }),
          stepUp: g.controller.opts?.stepUp ?? NaN,
        };
      });
      const win = geom.heights.map((h, i) => [
        h / 2,
        h + (geom.stepUp - h) / 2,
        i > 0 && geom.heights[i - 1] > h ? 0 : h / 2, // minOnTop bound (mirrors steptest)
      ]);
      console.log('derived windows:', JSON.stringify(win), 'heights:', JSON.stringify(geom.heights));
      for (let r = 0; r < RUNS; r++) {
        const logMark = logs.length;
        const { frames } = await run({
          spawn: [0.6, 0, 5], yaw: -Math.PI / 2, keys: ['ShiftLeft', 'KeyW'], ms: 2600,
        });
        const stepup = logs.slice(logMark).filter((l) => l.includes('[stepup] attempt'));
        const lipTouchI = (li) => {
          const l = lipDefs[li];
          for (let i = 1; i < frames.length; i++) if (frames[i][1] >= l.face - l.touch) return i;
          return frames.length;
        };
        const res = lipDefs.map((lip, li) => {
          const ci = lipTouchI(li);
          let ki = -1;
          if (ci < frames.length) {
            for (let i = ci; i < frames.length; i++) {
              if (frames[i][2] >= lip.h - 0.015) { ki = i; break; }
            }
          }
          const nextCi = li < lipDefs.length - 1 ? lipTouchI(li + 1) : frames.length;
          let peak = -1;
          if (ci < frames.length) for (let i = ci; i < nextCi; i++) peak = Math.max(peak, frames[i][2]);
          let minOnTop = Infinity;
          if (ki >= 0) {
            for (let i = ki; i < frames.length && frames[i][1] <= lip.face + lip.depth; i++) {
              minOnTop = Math.min(minOnTop, frames[i][2]);
            }
          }
          return {
            lip: lip.h, ki, kiGrounded: ki >= 0 ? frames[ki][5] : -1,
            climbY: ki >= 0 ? +frames[ki][2].toFixed(3) : null,
            peak: +peak.toFixed(3),
            minOnTop: Number.isFinite(minOnTop) ? +minOnTop.toFixed(3) : null,
          };
        });
        const nub = res[3];
        nubReadings.push({ climb: nub.climbY, peak: nub.peak, min: nub.minOnTop, g: nub.kiGrounded });
        // derived window (what steptest now asserts): climb/peak within
        // [h/2, midpoint(h, stepUp)], minOnTop ≥ h/2
        const oldFail = res.some((r, i) =>
          r.climbY == null ||
          r.climbY < win[i][0] || r.climbY > win[i][1] ||
          r.peak > win[i][1] ||
          (r.minOnTop != null && r.minOnTop < win[i][2]),
        );
        if (oldFail) {
          oldWindowFails++;
          // dump nub-region frames for the failing run
          worst.push({
            run: r, res,
            frames: frames
              .filter((f) => f[1] >= 5.2 && f[1] <= 5.8)
              .map((f) => [f[0], f[1], f[2], f[5], f[6]]),
            stepup: stepup.filter((l) => l.includes('trial=(5') || l.includes('trial=(4')),
          });
        }
      }
      console.log('nub readings:', JSON.stringify(nubReadings));
      console.log(`old-window failures: ${oldWindowFails}/${RUNS}`);
      for (const w of worst) {
        console.log(`FAILRUN ${w.run}: ${JSON.stringify(w.res)}`);
        console.log('  frames[t,x,y,g,vy]:', JSON.stringify(w.frames));
        for (const l of w.stepup) console.log('  ' + l);
      }
      check(
        `lips: derived window holds across ${RUNS} runs (the old fixed h+0.05 window failed 3/14)`,
        oldWindowFails === 0,
        `derivedWindowFails=${oldWindowFails}`,
      );
    }

    // ---------------------------------------------------------------
    if (name === 'ledgejump') {
      // jump with takeoff at/around the 0.3 ledge's far lip (z = -2.7),
      // walking -z off the north edge — windows ~2 frames wide at walk speed
      const variants = [
        ['before-lip', { z: [-2.68, -2.62] }],
        ['at-lip', { z: [-2.74, -2.68] }],
        ['just-past-lip', { z: [-2.80, -2.74] }],
        ['2fr-past-lip', { z: [-2.88, -2.81] }],
      ];
      for (const [label, zw] of variants) {
        const { frames, jumps } = await run({
          spawn: [0, 0.3, -1.0], yaw: 0, keys: ['KeyW'], ms: 3000,
          jumpWhen: { ...zw, y: [0.2, 0.45] },
        });
        const imp = impulses(frames);
        const spans = airSpans(frames);
        const j = jumps[0];
        let apex = -1;
        if (j) for (let i = j[0]; i < frames.length; i++) apex = Math.max(apex, frames[i][2]);
        const end = frames[frames.length - 1];
        const landed = end[5] === 1;
        const rise = j ? apex - j[2] : NaN;
        console.log(
          `ledgejump ${label}: jumps=${jumps.length} fired=${j != null} ` +
            `press@${j ? j[1] : '-'}ms y=${j ? j[2] : '-'} vyPre=${j ? j[3] : '-'} ` +
            `rise=${Number.isFinite(rise) ? rise.toFixed(3) : '-'} ` +
            `impulses=${imp.length} spans=${spans.length} end=(${end[1]},${end[2]},${end[3]}) landed=${landed}`,
        );
        check(
          `ledgejump (${label}): jump at the lip fires once, lands, no NaN`,
          j != null && imp.length <= 1 && landed && !nanIn(frames) && boundsOk(frames),
          `fired=${j != null} impulses=${imp.length} landed=${landed} nan=${nanIn(frames)} bounded=${boundsOk(frames)}`,
        );
        // rise must be a sane hop (0.4..0.6 on flat; on-lip takeoff similar)
        check(
          `ledgejump (${label}): sane hop height (0.35..0.75)`,
          Number.isFinite(rise) && rise >= 0.35 && rise <= 0.75,
          `rise=${Number.isFinite(rise) ? rise.toFixed(3) : 'n/a'}`,
        );
      }
    }

    // ---------------------------------------------------------------
    if (name === 'spam') {
      // mash jump while walking off the ledge and landing — every airtime
      // gets exactly one impulse; presses must not double-fire
      const { frames } = await run({
        spawn: [0, 0.3, -2.4], yaw: 0, keys: ['KeyW'], ms: 4800,
        actions: Array.from({ length: 40 }, (_, i) => ({ at: 400 + i * 90, type: 'jump' })),
      });
      const imp = impulses(frames);
      const spans = airSpans(frames);
      const perSpan = spans.map(([s, e]) =>
        imp.filter((x) => x.i >= s && x.i <= e).length);
      console.log(
        `spam: impulses=${imp.length} airtimeSpans=${spans.length} perSpan=${JSON.stringify(perSpan)} ` +
          `end=(${frames.at(-1)[1]},${frames.at(-1)[2]},${frames.at(-1)[3]})`,
      );
      check(
        'spam: mash jump = at most 1 impulse per airtime, lands, no NaN',
        perSpan.every((n) => n <= 1) && frames.at(-1)[5] === 1 && !nanIn(frames) && boundsOk(frames),
        `perSpan=${JSON.stringify(perSpan)} nan=${nanIn(frames)}`,
      );
      check(
        'spam: mashing actually jumps (>=2 impulses total — input not swallowed)',
        imp.length >= 2,
        `impulses=${imp.length}`,
      );
    }

    // ---------------------------------------------------------------
    if (name === 'slopejump') {
      // jump exactly at walkable<->steep transitions
      const variants = [
        ['50 toe (flat->ramp)', { spawn: [1.7, 0, -4], yaw: -Math.PI / 2, keys: ['KeyW'],
          jumpWhen: { x: [2.2, 2.45] }, ms: 3500 }],
        ['50 top (ramp->platform)', { spawn: [1.7, 0, -4], yaw: -Math.PI / 2, keys: ['KeyW'],
          // the junction step-up advances ≥0.43 m in ONE frame (3.52 → 4.07),
          // skipping any narrow window — press on the LAST ramp frames, the
          // transition itself (the jump then suppresses the step-up gate for
          // that frame and takes off from the ramp edge instead)
          jumpWhen: { x: [3.4, 3.58] }, ms: 4500 }],
        ['50 descent (ramp->flat)', { spawn: [4.9, 1.85, -4], yaw: Math.PI / 2, keys: ['KeyW'],
          jumpWhen: { x: [2.6, 3.4] }, ms: 4000 }],
        ['30 toe (flat->ramp)', { spawn: [-4.8, 0, 4], yaw: Math.PI / 2, keys: ['KeyW'],
          jumpWhen: { x: [-5.65, -5.45] }, ms: 3500 }],
        ['30 top (ramp->wall)', { spawn: [-4.8, 0, 4], yaw: Math.PI / 2, keys: ['KeyW'],
          jumpWhen: { x: [-7.3, -7.1] }, ms: 5000 }],
      ];
      for (const [label, opts] of variants) {
        const { frames, jumps } = await run(opts);
        const j = jumps[0];
        // apex bounded to the AIRTIME (W stays held — an unbounded max would
        // read the continued ramp climb, not the jump)
        let apex = -1;
        if (j) {
          for (let i = j[0]; i < frames.length; i++) {
            apex = Math.max(apex, frames[i][2]);
            if (i > j[0] && frames[i][5] === 1) break;
          }
        }
        const imp = impulses(frames);
        const end = frames.at(-1);
        const rise = j ? apex - j[2] : NaN;
        console.log(
          `slopejump ${label}: fired=${j != null} press@${j ? j[1] : '-'}ms y=${j ? j[2] : '-'} ` +
            `vyPre=${j ? j[3] : '-'} rise=${Number.isFinite(rise) ? rise.toFixed(3) : '-'} ` +
            `impulses=${imp.length} end=(${end[1]},${end[2]},${end[3]}) g=${end[5]}`,
        );
        check(
          `slopejump (${label}): fires once, lands, bounded, no NaN`,
          j != null && imp.length <= 1 && !nanIn(frames) && boundsOk(frames) && end[5] === 1,
          `fired=${j != null} impulses=${imp.length} bounded=${boundsOk(frames)} nan=${nanIn(frames)} endG=${end[5]}`,
        );
      }
    }

    // ---------------------------------------------------------------
    if (name === 'corner') {
      // full sprint into a step + wall corner from a new angle, recoverable
      const c1 = await run({
        spawn: [7.0, 0, -5.6], yaw: 0, keys: ['ShiftLeft', 'KeyW'], ms: 4000,
        actions: [
          { at: 1800, type: 'keyup', key: 'KeyW' },
          { at: 1900, type: 'keyup', key: 'ShiftLeft' },
          { at: 2400, type: 'keydown', key: 'KeyD' }, // walk away: must escape
        ],
      });
      const f1 = c1.frames;
      const hitI = f1.findIndex((f) => f[3] <= -6.35);
      let maxJump = 0;
      for (let i = 1; i < f1.length; i++) {
        if (f1[i][0] < (hitI > 0 ? f1[hitI][0] : 0) + 300) continue;
        maxJump = Math.max(maxJump,
          Math.hypot(f1[i][1] - f1[i - 1][1], f1[i][3] - f1[i - 1][3]));
      }
      const endX = f1.at(-1)[1];
      const accepted = logs.some((l) => l.includes('accepted=true') && l.includes('gained=0.3'));
      console.log(
        `corner S: hit@${hitI > 0 ? f1[hitI][0] : '-'}ms maxFrameDelta=${maxJump.toFixed(4)} ` +
          `endX=${endX.toFixed(2)} stepAcceptedAny=${accepted} minY=${Math.min(...f1.map((f) => f[2])).toFixed(3)}`,
      );
      check(
        'corner: sprint into step+wall corner stays bounded, no pop, recoverable',
        hitI > 0 && maxJump < 0.16 && endX > 7.1 && !nanIn(f1) &&
          Math.min(...f1.map((f) => f[2])) > -0.05,
        `maxFrameDelta=${maxJump.toFixed(4)} endX=${endX.toFixed(2)} nan=${nanIn(f1)}`,
      );
      // plain NW corner (no step) — bounds + jitter + escape
      const c2 = await run({
        spawn: [-7, 0, -7], yaw: Math.PI / 4, keys: ['ShiftLeft', 'KeyW'], ms: 4000,
        actions: [
          { at: 1800, type: 'keyup', key: 'KeyW' },
          { at: 1900, type: 'keyup', key: 'ShiftLeft' },
          { at: 2400, type: 'keydown', key: 'KeyS' }, // walk away +z
        ],
      });
      const f2 = c2.frames;
      const hit2 = f2.findIndex((f) => f[1] <= -7.4 && f[3] <= -7.4);
      let jitter = 0;
      for (let i = 1; i < f2.length; i++) {
        if (f2[i][0] < (hit2 > 0 ? f2[hit2][0] : 0) + 300 || f2[i][0] > 1800) continue;
        jitter = Math.max(jitter,
          Math.hypot(f2[i][1] - f2[i - 1][1], f2[i][3] - f2[i - 1][3]));
      }
      const endZ2 = f2.at(-1)[3];
      console.log(
        `corner NW: hit@${hit2 > 0 ? f2[hit2][0] : '-'}ms jitter=${jitter.toFixed(4)} ` +
          `endZ=${endZ2.toFixed(2)} nan=${nanIn(f2)}`,
      );
      check(
        'corner: NW corner press steady (no stutter), bounded, recoverable',
        hit2 > 0 && jitter < 0.1 && endZ2 > -7.0 && !nanIn(f2),
        `jitter=${jitter.toFixed(4)} endZ=${endZ2.toFixed(2)}`,
      );
    }

    // ---------------------------------------------------------------
    if (name === 'pillar') {
      // wall-slide into an obstacle: shallow-angle sprint onto the pillar
      const p = await run({
        spawn: [3.6, 0, 0.55], yaw: -1.27, keys: ['ShiftLeft', 'KeyW'], ms: 3200,
      });
      const f = p.frames;
      const xs = f.map((x) => x[1]);
      const maxX = Math.max(...xs);
      let jitter = 0;
      let contactI = -1;
      for (let i = 1; i < f.length; i++) {
        // near the pillar box (x 4.65..5.35, z -0.35..0.35) — the slide
        // pins x at 4.3 (sphere touching the west face at 4.65), so the
        // window starts before the box itself
        const near = f[i][1] > 4.0 && f[i][1] < 5.6 && Math.abs(f[i][3]) < 0.6;
        if (near && contactI < 0) contactI = i;
        if (near && contactI > 0 && i > contactI + 5) {
          jitter = Math.max(jitter,
            Math.hypot(f[i][1] - f[i - 1][1], f[i][3] - f[i - 1][3]));
        }
      }
      const speeds = [];
      for (let i = 1; i < f.length; i++) {
        const dt = (f[i][0] - f[i - 1][0]) / 1000;
        if (dt > 0.008) speeds.push(Math.hypot(f[i][1] - f[i - 1][1], f[i][3] - f[i - 1][3]) / dt);
        else speeds.push(null);
      }
      // 3-sample moving average — single-frame position artifacts (depenetration
      // ticks) are not speed; steptest smooths the same way
      const sm = speeds.map((v, i) => {
        if (v == null) return null;
        const w = speeds.slice(Math.max(0, i - 1), i + 2).filter((x) => x != null);
        return w.reduce((a, b) => a + b, 0) / w.length;
      });
      const maxSpd = Math.max(...sm.filter((v) => v != null));
      const maxSpdAt = f[sm.indexOf(maxSpd)]?.[0];
      console.log(
        `pillar: contactI=${contactI} maxX=${maxX.toFixed(2)} jitter=${jitter.toFixed(4)} ` +
          `maxSpd=${maxSpd.toFixed(2)}@${maxSpdAt}ms end=(${f.at(-1)[1].toFixed(2)},${f.at(-1)[3].toFixed(2)})`,
      );
      check(
        'pillar: slide past the pillar AND the ramp toe — no stuck, no oscillation, no NaN',
        contactI > 0 && maxX > 7.0 && jitter < 0.12 && !nanIn(f) && boundsOk(f),
        `maxX=${maxX.toFixed(2)} (must reach the east wall past the toe) jitter=${jitter.toFixed(4)} nan=${nanIn(f)}`,
      );
      check(
        'pillar: slide speed never exceeds sprint cap + margin',
        maxSpd <= 6.0,
        `maxSpd=${maxSpd.toFixed(2)}@${maxSpdAt}ms (position-derived noise band; the suite's sustained-window check is the strict one)`,
      );
    }

    // ---------------------------------------------------------------
    if (name === 'freecam') {
      // enter mid-sprint, exit mid-air in open space
      const f1 = await run({
        spawn: [0, 0, 4], yaw: 0, keys: ['ShiftLeft', 'KeyW'], ms: 4000,
        actions: [
          { at: 700, type: 'freecam' },
          { at: 1500, type: 'freecam' }, // exit mid-air (camera flies at 14 m/s)
        ],
      });
      const fr = f1.frames;
      const exitI = fr.findIndex((x) => x[8] === 0 && x[0] > 1500);
      const postExit = fr.slice(exitI);
      const hspdAfter = postExit.slice(0, 5).map((x) => x[7]);
      const end = fr.at(-1);
      console.log('freecam open frames (exit ±10):');
      for (const f of fr.slice(Math.max(0, exitI - 6), exitI + 12)) console.log(' ', JSON.stringify(f));
      console.log(
        `freecam open: exitI=${exitI} exitPos=(${fr[exitI]?.[1]},${fr[exitI]?.[2]},${fr[exitI]?.[3]}) ` +
          `hspdAfter=${JSON.stringify(hspdAfter)} ` +
          `end=(${end[1].toFixed(2)},${end[2].toFixed(2)},${end[3].toFixed(2)}) g=${end[5]} ` +
          `impulses=${impulses(fr).length}`,
      );
      // velocity must START at ~0 after the exit (one frame of input accel
      // ≈ 1.1 m/s; an inherited freecam velocity would read ≈14)
      check(
        'freecam: exit mid-air drops the capsule with zeroed velocity (no fly-through)',
        exitI > 0 && hspdAfter[0] < 3 && !nanIn(fr),
        `first hspd after exit=${hspdAfter[0]} (14 = inherited fly speed) nan=${nanIn(fr)}`,
      );
      // exit while the camera is OUTSIDE the room (inside/behind a wall)
      const f2 = await run({
        spawn: [0, 0, 4], yaw: 0, keys: ['ShiftLeft', 'KeyW'], ms: 6000,
        actions: [
          { at: 300, type: 'freecam' },
          { at: 1800, type: 'freecam' }, // camera ~18 m north: inside/behind wall
        ],
      });
      const fr2 = f2.frames;
      const ex2 = fr2.findIndex((x) => x[8] === 0 && x[0] > 1800);
      const phys2 = fr2.slice(ex2); // freecam phase flies wherever it likes
      // (no collision by design) — bounds apply only to the physics phase,
      // and the void fall outside the room ends in the y<-60 respawn
      const tail2 = phys2.filter((f) => f[0] >= 5000); // after the recovery
      const end2 = phys2.at(-1);
      const min2 = Math.min(...phys2.map((x) => x[2]));
      console.log(
        `freecam outside: exit=(${fr2[ex2]?.[1]},${fr2[ex2]?.[2]},${fr2[ex2]?.[3]}) ` +
          `end=(${end2[1].toFixed(2)},${end2[2].toFixed(2)},${end2[3].toFixed(2)}) ` +
          `g=${end2[5]} minY=${min2.toFixed(2)} nan=${nanIn(fr2)}`,
      );
      check(
        'freecam: exit outside the room recovers (void fall → respawn), no NaN',
        ex2 > 0 && !nanIn(fr2) && min2 < -50 && end2[5] === 1 &&
          tail2.length > 0 && boundsOk(tail2),
        `end=(${end2[1].toFixed(2)},${end2[2].toFixed(2)},${end2[3].toFixed(2)}) minY=${min2.toFixed(2)}`,
      );
      // space held in freecam (fly up) must not buffer a jump for normal mode
      const f3 = await run({
        spawn: [0, 0, 4], yaw: 0, keys: ['KeyW'], ms: 5000,
        actions: [
          { at: 400, type: 'freecam' },
          { at: 500, type: 'keydown', key: 'Space' }, // fly up
          { at: 1400, type: 'keyup', key: 'Space' },
          { at: 1500, type: 'freecam' }, // exit high in the air
        ],
      });
      const fr3 = f3.frames;
      const imp3 = impulses(fr3);
      const end3 = fr3.at(-1);
      console.log(
        `freecam space: impulses=${imp3.length} at=${JSON.stringify(imp3.map((x) => x.t))} ` +
          `end=(${end3[1].toFixed(2)},${end3[2].toFixed(2)},${end3[3].toFixed(2)}) g=${end3[5]}`,
      );
      check(
        'freecam: Space held to fly does NOT buffer a jump for normal mode',
        imp3.length === 0 && end3[5] === 1 && !nanIn(fr3),
        `impulses=${imp3.length} endG=${end3[5]}`,
      );
    }

    // ---------------------------------------------------------------
    if (name === 'respawn') {
      // mid-air respawn zeroes velocity; a jump press carried INTO the
      // respawn must not fire on the (fresh) landing — buffer belongs to
      // the old spot, same as coyote (see respawnAt).
      const r1 = await run({
        spawn: [0, 8, 0], yaw: 0, keys: [], ms: 4000,
        actions: [
          { at: 600, type: 'jump' },        // press mid-fall (buffer set)
          { at: 640, type: 'respawn', pos: [0, 0, 2] }, // fresh grounded spawn
        ],
      });
      const fr = r1.frames;
      const imp = impulses(fr);
      const respawnI = fr.findIndex((x) => x[0] >= 640);
      console.log(
        `respawn buffered-press: impulses=${imp.length} at=${JSON.stringify(imp.map((x) => x.t))} ` +
          `respawnI=${respawnI} endG=${fr.at(-1)[5]} nan=${nanIn(fr)}`,
      );
      check(
        'respawn: jump press carried into a respawn does not fire after teleport',
        imp.length === 0 && !nanIn(fr),
        `impulses=${imp.length} at=${JSON.stringify(imp.map((x) => x.t))}`,
      );
      // mid-air respawn: velocity zeroed, coyote cleared (press 50 ms later
      // must NOT jump — no stale grace from the old spot)
      const r2 = await run({
        spawn: [0, 8, 0], yaw: 0, keys: [], ms: 4000,
        actions: [
          { at: 700, type: 'respawn', pos: [0, 5, 0] }, // mid-fall restart
          { at: 760, type: 'jump' },                    // inside old coyote? no
        ],
      });
      const fr2 = r2.frames;
      const imp2 = impulses(fr2);
      const respawnI2 = fr2.findIndex((x) => x[0] >= 700);
      // frames[respawnI] is sampled BEFORE the action runs in the same tick
      const velAfter = fr2.slice(respawnI2 + 1, respawnI2 + 4).map((x) => x[6]);
      console.log(
        `respawn mid-air: vyAfter=${JSON.stringify(velAfter)} impulses=${imp2.length} ` +
          `at=${JSON.stringify(imp2.map((x) => x.t))} endG=${fr2.at(-1)[5]}`,
      );
      check(
        'respawn mid-air: velocity zeroed, no stale coyote jump, lands, no NaN',
        velAfter.length > 0 && Math.abs(velAfter[0]) < 0.5 && imp2.length === 0 &&
          fr2.at(-1)[5] === 1 && !nanIn(fr2),
        `vyAfter=${JSON.stringify(velAfter)} (first frame = one gravity step) ` +
          `impulses=${imp2.length} nan=${nanIn(fr2)}`,
      );
      // fall-out-of-world respawn (y < -60): recover to spawn and settle.
      // (The −61 state itself lives between samples — the respawn runs in
      // the same update — so assert the RECOVERY, not a sampled −61.)
      const r3 = await run({
        spawn: [0, 0, 2], yaw: 0, keys: [], ms: 4000,
        actions: [{ at: 500, type: 'setpos', pos: [0, -61, 0] }],
      });
      const fr3 = r3.frames;
      const end3 = fr3.at(-1);
      console.log(
        `respawn fallout: end=(${end3[1].toFixed(2)},${end3[2].toFixed(2)},${end3[3].toFixed(2)}) g=${end3[5]} nan=${nanIn(fr3)}`,
      );
      check(
        'respawn: falling out of the world respawns at spawn and settles',
        end3[5] === 1 && Math.abs(end3[1]) < 0.1 && Math.abs(end3[3] - 2) < 0.1 &&
          !nanIn(fr3),
        `end=(${end3[1].toFixed(2)},${end3[2].toFixed(2)},${end3[3].toFixed(2)})`,
      );
    }

    // ---------------------------------------------------------------
    if (name === 'platform') {
      // walking off height transitions of the test-room geometry
      const variants = [
        ['0.3 ledge NE corner', { spawn: [0.9, 0.3, -2.3], yaw: -Math.PI / 4, keys: ['KeyW'], ms: 3000 }],
        ['1.85 platform SE corner', { spawn: [5.7, 1.85, -2.8], yaw: -3 * Math.PI / 4, keys: ['KeyW'], ms: 4000 }],
        ['1.85 platform -> ramp top', { spawn: [4.4, 1.85, -4], yaw: Math.PI / 2, keys: ['KeyW'], ms: 5000 }],
        ['0.3 ledge -> floor (straight off)', { spawn: [0, 0.3, -1.0], yaw: 0, keys: ['KeyW'], ms: 3000 }],
      ];
      for (const [label, opts] of variants) {
        const { frames } = await run(opts);
        const spans = airSpans(frames);
        const airborne = spans.reduce((n, [s, e]) => n + (e - s), 0);
        const maxY = Math.max(...frames.map((f) => f[2]));
        const end = frames.at(-1);
        const start = frames[0];
        // a real LAUNCH (physics bug) throws the player well above the
        // departure height; ≤0.15 m here is the capsule riding the convex
        // edge it steps off (edge-catch pop — same family as the lip perch,
        // bounded and lands cleanly; observed ≤0.09 m on the 0.3 ledge)
        const launched = maxY > start[2] + 0.15;
        console.log(
          `platform ${label}: spans=${spans.length} airborneFrames=${airborne} ` +
            `maxY=${maxY.toFixed(3)} (start ${start[2].toFixed(3)}) ` +
            `end=(${end[1].toFixed(2)},${end[2].toFixed(2)},${end[3].toFixed(2)}) g=${end[5]}`,
        );
        check(
          `platform (${label}): leaves cleanly — falls, no launch, lands, no NaN`,
          !launched && end[5] === 1 && !nanIn(frames) && boundsOk(frames),
          `launched=${launched} endG=${end[5]} maxY=${maxY.toFixed(3)} nan=${nanIn(frames)}`,
        );
      }
      // platform -> ramp top: grounded nearly throughout (sticks, no pop)
      const tr = await run({
        spawn: [4.4, 1.85, -4], yaw: Math.PI / 2, keys: ['KeyW'], ms: 5000,
      });
      const g = tr.frames.filter((f) => f[5] === 1).length;
      const drops = [];
      let prev = null;
      for (const f of tr.frames) {
        if (prev != null && f[0] - prev[0] < 4 && f[2] - prev[2] > 0.05) drops.push(f[2] - prev[2]);
        prev = f;
      }
      console.log(
        `platform->ramp: groundedFrames=${g}/${tr.frames.length} upwardJumps=${JSON.stringify(drops.map((d) => +d.toFixed(3)))}`,
      );
      check(
        'platform: walking platform -> ramp top sticks (grounded, no upward pop)',
        g / tr.frames.length > 0.9 && drops.length === 0,
        `grounded=${g}/${tr.frames.length} pops=${JSON.stringify(drops)}`,
      );
    }

    // ---------------------------------------------------------------
    if (name === 'rampjump') {
      // MEASUREMENT (no assert on rise): additive impulse on a 50° climb
      const flat = [];
      const climb = [];
      for (let k = 0; k < 3; k++) {
        const a = await run({
          spawn: [0, 0, 2], yaw: 0, keys: [], ms: 2500,
          actions: [{ at: 500, type: 'jump' }],
        });
        const j = a.jumps[0];
        let apex = -1;
        if (j) {
          for (let i = j[0]; i < a.frames.length; i++) {
            apex = Math.max(apex, a.frames[i][2]);
            if (i > j[0] && a.frames[i][5] === 1) break;
          }
        }
        flat.push({ rise: +(apex - j[2]).toFixed(3), vyPre: j[3], y: j[2] });
        const b = await run({
          spawn: [1.7, 0, -4], yaw: -Math.PI / 2, keys: ['KeyW'], ms: 4500,
          jumpWhen: { x: [2.7, 3.3] },
        });
        const jb = b.jumps[0];
        // airtime-bounded: the climb CONTINUES after landing (W held), which
        // would otherwise read as jump height
        let apexB = -1;
        if (jb) {
          for (let i = jb[0]; i < b.frames.length; i++) {
            apexB = Math.max(apexB, b.frames[i][2]);
            if (i > jb[0] && b.frames[i][5] === 1) break;
          }
        }
        climb.push({
          rise: +(apexB - jb[2]).toFixed(3), vyPre: jb[3], y: jb[2],
          x: b.frames[jb[0]][1],
        });
      }
      // run-speed climb: faster ascent carries more vy (the backlog's
      // ~1.12 m reading predates the jump-height retune: old jumpSpeed 5.0
      // → flat 5²/2g = 0.781 m, which is where its "0.78 flat" came from)
      const b2 = await run({
        spawn: [1.7, 0, -4], yaw: -Math.PI / 2, keys: ['ShiftLeft', 'KeyW'], ms: 4000,
        jumpWhen: { x: [2.7, 3.3] },
      });
      const jb2 = b2.jumps[0];
      let apexR = -1;
      if (jb2) {
        for (let i = jb2[0]; i < b2.frames.length; i++) {
          apexR = Math.max(apexR, b2.frames[i][2]);
          if (i > jb2[0] && b2.frames[i][5] === 1) break;
        }
      }
      const climbRun = jb2
        ? { rise: +(apexR - jb2[2]).toFixed(3), vyPre: jb2[3], x: b2.frames[jb2[0]][1] }
        : null;
      console.log('rampjump flat:', JSON.stringify(flat));
      console.log('rampjump 50°-climb walk:', JSON.stringify(climb));
      console.log('rampjump 50°-climb run:', JSON.stringify(climbRun));
      const flatRise = flat.map((f) => f.rise);
      const climbRise = climb.map((c) => c.rise);
      note(
        'jump-while-climbing measurement (documented additive impulse — NOT changed)',
        `flat rise=${JSON.stringify(flatRise)} m; 50°-climb walk rise=${JSON.stringify(climbRise)} m ` +
          `(pre-jump vy=${JSON.stringify(climb.map((c) => c.vyPre))} m/s); ` +
          `50°-climb run rise=${climbRun?.rise ?? 'n/a'} m (pre-jump vy=${climbRun?.vyPre ?? 'n/a'} m/s); ` +
          `model (vy+4.0)²/32: walk=${(((climb[0].vyPre + 4) ** 2) / 32).toFixed(3)} m`,
      );
      check('rampjump: measurement ran (3 flat + 3 walk-climb + 1 run-climb jump fired)',
        flat.every((f) => Number.isFinite(f.rise)) && climb.every((c) => Number.isFinite(c.rise)) &&
          climbRun != null && Number.isFinite(climbRun.rise),
        '');
    }

    // ---------------------------------------------------------------
    if (name === 'ceiling') {
      // ceilings are excluded from the collision BVH by design (test-room
      // `collide=false`) — verify and NOTE (crouch-less ceiling = N/A)
      const res = await page.evaluate(() => {
        const g = window.__liminal;
        const THREE = g.THREE;
        const up = new THREE.Vector3(0, 1, 0);
        const from = (x, y, z) => {
          const h = g.collision.raycast(new THREE.Vector3(x, y, z), up, 10);
          return h ? +h.point.y.toFixed(2) : null;
        };
        return {
          spawnRoomA: from(0, 1, 0),
          corridor: from(0, 1, 12),
          roomB: from(0, 1, 24),
          // and a downward ray DOES hit the floor (control)
          floor: (() => {
            const h = g.collision.raycast(new THREE.Vector3(0, 1, 0), new THREE.Vector3(0, -1, 0), 5);
            return h ? +h.point.y.toFixed(2) : null;
          })(),
        };
      });
      console.log('ceiling rays (up from mid-room):', JSON.stringify(res));
      check(
        'ceiling: excluded from the collision BVH by design (up-ray passes through)',
        res.spawnRoomA == null && res.corridor == null && res.roomB == null && res.floor === 0,
        JSON.stringify(res),
      );
      note(
        'crouch-less ceiling: N/A in the test room — ceilings are non-colliding by design',
        'headroom only matters for step-up fit(2), which raycasts UP against BVH geometry',
      );
    }

    // ---------------------------------------------------------------
    if (name === 'debug') {
      const a = await run({
        spawn: [1.7, 0, -4], yaw: -Math.PI / 2, keys: ['KeyW'], ms: 4500,
        jumpWhen: { x: [3.6, 3.95], y: [1.2, 1.9] },
      });
      console.log('50top frames near window:');
      for (const f of a.frames) {
        if (f[1] > 3.3 && f[1] < 4.3) console.log(' ', JSON.stringify(f));
      }
      console.log('50top jumps:', JSON.stringify(a.jumps));
      const b = await run({
        spawn: [3.6, 0, 0.55], yaw: -1.27, keys: ['ShiftLeft', 'KeyW'], ms: 3200,
        actions: [
          { at: 2400, type: 'keyup', key: 'KeyW' },
          { at: 2450, type: 'keyup', key: 'ShiftLeft' },
          { at: 2700, type: 'keydown', key: 'KeyS' }, // back away: recoverable?
        ],
      });
      console.log('pillar frames x 4.0..6.2 (t,x,y,z,g,vy,hspd,fc,coy,buf,vx,vz,slp,hld):');
      for (const f of b.frames) {
        if (f[1] > 4.0 && f[1] < 6.3) console.log(' ', JSON.stringify(f));
      }
      console.log('pillar stepup logs:');
      for (const l of logs.filter((l) => l.includes('[stepup]')).slice(-14)) console.log(' ', l);

      // instrument: record every resolveCapsule push + wallNormal near the toe
      await page.evaluate(() => {
        const g = window.__liminal;
        const c = g.controller;
        const orig = g.collision.resolveCapsule.bind(g.collision);
        window.__pushLog = [];
        g.collision.resolveCapsule = (...args) => {
          const r = orig(...args);
          if (r.push.length() > 1e-4) {
            window.__pushLog.push([
              +performance.now().toFixed(0),
              +r.push.x.toFixed(4), +r.push.y.toFixed(4), +r.push.z.toFixed(4),
              +r.minNy.toFixed(3),
              +c.wallNormal.x.toFixed(3), +c.wallNormal.z.toFixed(3),
              +c.slopeN.x.toFixed(3), +c.slopeN.z.toFixed(3),
            ]);
          }
          return r;
        };
        window.__restore = () => { g.collision.resolveCapsule = orig; };
      });
      const c = await run({
        spawn: [5.6, 0, -1.0], yaw: -1.27, keys: ['ShiftLeft', 'KeyW'], ms: 2500,
        actions: [
          { at: 1600, type: 'keyup', key: 'KeyW' },
          { at: 1650, type: 'keyup', key: 'ShiftLeft' },
          { at: 1900, type: 'keydown', key: 'KeyS' }, // back away: recoverable?
        ],
      });
      await page.evaluate(() => window.__restore?.());
      const pushes = await page.evaluate(() => window.__pushLog);
      console.log('toe pushes [t,px,py,pz,minNy,wallNx,wallNz,slopeNx,slopeNz]:');
      for (const p of pushes.slice(-45)) console.log(' ', JSON.stringify(p));
      console.log('toe frames after 1400ms:');
      for (const f of c.frames.filter((f) => f[0] > 1400)) console.log(' ', JSON.stringify(f));

      // stage-by-stage velocity: enable the controller TEMP-DEBUG hooks
      await page.evaluate(() => { window.__ctrlDbg = []; });
      const d = await run({
        spawn: [5.6, 0, -1.0], yaw: -1.27, keys: ['ShiftLeft', 'KeyW'], ms: 1400,
      });
      const dbg = await page.evaluate(() => {
        const out = window.__ctrlDbg;
        window.__ctrlDbg = null;
        return out;
      });
      console.log('ctrl dbg (in→out pairs, last 24):');
      for (let i = Math.max(0, dbg.length - 48); i < dbg.length; i++) {
        console.log(' ', JSON.stringify(dbg[i]));
      }
      console.log('toe-d frames (last 14):');
      for (const f of d.frames.slice(-14)) console.log(' ', JSON.stringify(f));
    }
  };

  const sections = section === 'all'
    ? ['lips', 'ledgejump', 'spam', 'slopejump', 'corner', 'pillar', 'freecam', 'respawn', 'platform', 'rampjump', 'ceiling']
    : [section];  for (const s of sections) await runSection(s);

  if (failed) {
    console.log('\n--- console tail ---');
    for (const l of logs.slice(-10)) console.log(l);
    process.exitCode = 1;
  }
} finally {
  await browser.close();
}
