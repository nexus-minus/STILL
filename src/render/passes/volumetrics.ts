import * as THREE from 'three/webgpu';
import {
  texture,
  textureStore,
  uniform,
  wgslFn,
} from 'three/tsl';
import { ndcToCameraRay, type BVHComputeData } from 'three-mesh-bvh/webgpu';
import type { Node } from 'three/webgpu';
import type { QualitySettings } from '../quality.js';

// ---------------------------------------------------------------------------
// Fog tuning constants — the user tunes these against level art later, so
// every value carries the WHY it has. They are compiled into the kernel
// (changing one rebuilds the shader on next boot), not uniforms: they are
// taste, not per-frame state, and constants let TSL fold them away.
// ---------------------------------------------------------------------------

/** Extinction (and scattering) per metre at the floor line. WHY 0.014:
 *  transmittance across a 15 m corridor ≈ exp(-0.014·15) ≈ 0.81 — a visible
 *  haze veil that still lets the far wall read. Below ~0.008 the fog is
 *  invisible in screenshots; above ~0.03 distant geometry turns to soup at
 *  normal camera heights. */
const FOG_DENSITY = 0.014;
/** Metres over which the haze thins to 37 % (1/e) above the level floor —
 *  anchored at FOG_FLOOR_Y (the shadow-geometry bbox min-y, computed once
 *  in the pass constructor), NOT world y=0: this map's floor sits at
 *  y ≈ −9.2, so a world-0 anchor packed full density into a slab below y=0
 *  with a hard knee at it (the user's "fog is only under height 0").
 *  WHY 3 m: the backrooms haze pools at floor/waist height and clears toward
 *  the ceiling, so rooms keep their silhouettes (vibe.png has clean upper
 *  edges, hazy ground). */
const FOG_FALLOFF = 3.0;
/** Ambient in-scatter tint, linear RGB — the misty teal of reference/vibe.png.
 *  Kept blue-teal rather than grey because grey fog just looks like dirt;
 *  the teal is what makes unlit air read as ATMOSPHERE. */
const FOG_COLOR: [number, number, number] = [0.36, 0.6, 0.66];
/** Strength of that ambient term (radiance added per full opacity unit).
 *  WHY 0.10: at 30 % haze it lifts dark air by ≈ 0.03·FOG_COLOR — a veil
 *  you can just see in a corridor, nowhere near washing contrast (0.30 was
 *  tried first and lifted the spawn view +33 % mean luma — soup, not mist).
 *  Shafts and glow come from the traced light loop, not from here. */
const FOG_AMBIENT = 0.1;
/** Metres marched for MISS/sky pixels and the cap for hits (the sky must
 *  haze too — reference/vibe.png's horizon glow is exactly this). WHY 48:
 *  far enough that open views fade out gradually, short enough that
 *  FOG_STEPS never stretches past ~3 m worst case (banding headroom). */
const FOG_MAX_DIST = 48;
/** March steps per pixel. WHY 16: indoor rays are typically 8–25 m, i.e.
 *  ≤ 1.6 m per step; the per-frame dither below plus the temporal blend
 *  hides the coarser far steps. 32 doubled fog cost with no visible gain
 *  in A/B screenshots; fewer than 12 made shaft edges stair-step. */
const FOG_STEPS = 16;
/** Per-step light range cutoff — this is the queued "light-distance culling"
 *  for the fog loop (backlog §8): a fixture further than this contributes
 *  < ~2 % of near-field radiance through the 1/d² falloff, so its shadow ray
 *  is pure waste. WHY 12 m: shafts on this map reach ~8 m from a ceiling
 *  strip; 12 keeps headroom for large rooms. */
const LIGHT_RANGE = 12;
/** Workgroup edge (same as the lighting kernel — one shared dispatch grid
 *  convention keeps every compute pass in this renderer debuggable together). */
const WORKGROUP = 8;

/** Fog-march counters for scripts/rt-vol-smoke.mjs: `dispatches` must stay
 *  0 while the toggle is off (the "off must cost nothing" proof) and
 *  `width/height` stay 1×1 — no fog-sized texture is ever allocated.
 *  `floorY` is the level-floor anchor the height falloff compiles in
 *  (world Y of the shadow-geometry bbox min-y) — reported so tests/humans
 *  can verify the falloff hangs off the actual floor, not world 0. */
export interface VolStats {
  dispatches: number;
  width: number;
  height: number;
  floorY: number;
}

interface VolDeps {
  /** GPU BVH — shadow rays for the light shafts (occlusion only) */
  bvhData: BVHComputeData;
  /** primary-hit guide from the lighting pass: view normal + view depth,
   *  sentinel −1 = miss/sky (march those to FOG_MAX_DIST) */
  geomTex: THREE.StorageTexture;
  /** CURRENT lights storage node — rt.ts rebuilds it when the list size
   *  changes, so this is a getter and the kernel is rebuilt via invalidate() */
  lightsNode: () => Node;
  /** shared uniform nodes from rt.ts (same matrices/frame/seed the lighting
   *  kernel used, so fog rays line up with the geometry guide exactly) */
  invViewProj: Node;
  viewMat: Node;
  frameIndex: Node;
  lightCount: Node;
  softShadow: Node;
  lightGain: Node;
  workgroupSize: Node;
  workgroupId: Node;
  localId: Node;
}

/**
 * PHASE 1B — VOLUMETRICS (fog + light shafts) — WebGPU only.
 *
 *   1. reconstruct the view ray per fog-resolution pixel (settings.volumetricScale)
 *      and read the primary-hit distance from geomTex (−1 = sky → generous max)
 *   2. march FOG_STEPS dithered steps through homogeneous density with a
 *      height falloff (backrooms haze pooling at the floor)
 *   3. per step: in-scatter from every mesh light within LIGHT_RANGE whose
 *      shadow ray to the fixture surface is unoccluded → light shafts; plus a
 *      tiny teal ambient term (the vibe.png veil)
 *   4. accumulate transmittance T and in-scatter S, temporally blend with the
 *      fog history (still camera converges, motion stays live — same rule as
 *      the lighting pass), then rt.ts composites `beauty·T + S` over the FINAL
 *      image so fixtures get hazed too
 *
 * NOT a `RenderPass` from passes/types.ts, deliberately: that graph only runs
 * when the raytraced path is ABSENT (pipeline.ts returns early when the
 * advanced renderer is active), while this pass needs geomTex, the BVH and
 * the light list that live inside rt.ts, and it must composite inside rt.ts's
 * finalColor graph. rt.ts owns and dispatches it; `enabled()` keeps the
 * "disabled pass is never called" contract from types.ts.
 *
 * The toggle is sacred: rt.ts calls `release()` when settings.volumetrics is
 * false — no dispatch, no fog-sized texture, and render() picks a composite
 * built WITHOUT the fog branch (byte-identical to the pre-1b shader).
 */
export class VolumetricPass {
  readonly name = 'volumetrics';
  readonly stats: VolStats = { dispatches: 0, width: 1, height: 1, floorY: 0 };

  private readonly deps: VolDeps;
  /** storage target the composite samples — rgba16float, linear-filtered so
   *  quarter-res fog upscales smoothly over the full-res beauty */
  readonly fogTexture: THREE.StorageTexture;
  /** temporal history (textureLoad only → Nearest) — separate texture so a
   *  pass never reads and writes the same texture in one usage scope */
  private readonly fogHistory: THREE.StorageTexture;
  /** temporal blend: rt.ts passes its own value (1 while moving, 0.08 still) */
  private readonly blendAlpha = uniform(1);

  private kernel?: KernelNode;
  private copyNode?: KernelNode;
  /** whether a fog-sized allocation exists (drives release()) */
  private allocated = false;
  /** false while the toggle/debug skip held the pass — forces a history
   *  reset on resume so stale fog never smears over a fresh frame */
  private wasActive = false;
  /** World Y the height falloff is anchored at — the LEVEL FLOOR, computed
   *  once at pass init (see constructor). Compiled into the kernel as
   *  FOG_FLOOR_Y; a static level never moves it. */
  readonly floorY: number;

  constructor(deps: VolDeps) {
    this.deps = deps;
    // Height-falloff anchor = bounding-box min-y of the traced shadow
    // geometry (the level itself), computed ONCE. Round 1 anchored at world
    // y=0: this map's floor is y ≈ −9.2, so every gameplay room sat inside
    // a full-density slab that stopped dead at y=0 — the user-reported
    // "fog is only under the height 0". Anchored at the floor: full density
    // at/below it, smooth exp decay above — correct for any level at any
    // world height, no knee anywhere.
    // bvhData.objects isn't in three-mesh-bvh's d.ts but IS the mesh list
    // its constructor received (BVHComputeData.js: `this.objects = objects`);
    // world matrices are fresh because main.ts runs scene.updateMatrixWorld
    // before createAdvancedRenderer builds the BVH.
    const shadowMeshes = (deps.bvhData as unknown as { objects?: THREE.Object3D[] }).objects ?? [];
    const bounds = new THREE.Box3();
    for (const obj of shadowMeshes) bounds.expandByObject(obj);
    // no meshes / empty bounds → keep the legacy 0 rather than ±Infinity
    this.floorY = Number.isFinite(bounds.min.y) ? bounds.min.y : 0;
    this.stats.floorY = this.floorY;
    this.fogTexture = new THREE.StorageTexture(1, 1);
    this.fogTexture.type = THREE.HalfFloatType;
    this.fogTexture.format = THREE.RGBAFormat;
    this.fogTexture.minFilter = THREE.LinearFilter;
    this.fogTexture.magFilter = THREE.LinearFilter;
    this.fogHistory = new THREE.StorageTexture(1, 1);
    this.fogHistory.type = THREE.HalfFloatType;
    this.fogHistory.format = THREE.RGBAFormat;
    this.fogHistory.minFilter = THREE.NearestFilter;
    this.fogHistory.magFilter = THREE.NearestFilter;
  }

  /** the pipeline skip gate (passes/types.ts contract): off = never called. */
  enabled(settings: QualitySettings): boolean {
    return settings.volumetrics;
  }

  /**
   * One fog frame. rt.ts calls this only while the toggle is on AND the view
   * is not a ?rtdebug buffer diagnostic (those must stay raw — see rt.ts).
   * Lazy-allocates the fog buffers at `logical × scale` and resets temporal
   * history on resize/resume; otherwise hands rt.ts's temporal rule straight
   * to the blend (blendAlpha = 1 while moving, <1 while still).
   */
  dispatch(
    renderer: THREE.WebGPURenderer,
    opts: { logicalW: number; logicalH: number; scale: number; blendAlpha: number },
  ): void {
    const w = Math.max(1, Math.ceil(opts.logicalW * opts.scale));
    const h = Math.max(1, Math.ceil(opts.logicalH * opts.scale));
    // history is garbage after a resize or a skipped run — start live
    let reset = !this.wasActive;
    this.wasActive = true;
    if (w !== this.stats.width || h !== this.stats.height) {
      this.fogTexture.setSize(w, h, 1);
      this.fogHistory.setSize(w, h, 1);
      this.stats.width = w;
      this.stats.height = h;
      this.allocated = true;
      reset = true;
    }
    this.blendAlpha.value = reset ? 1 : opts.blendAlpha;

    this.kernel ??= this.buildKernel();
    this.copyNode ??= this.buildCopyNode();
    const gx = Math.ceil(w / WORKGROUP);
    const gy = Math.ceil(h / WORKGROUP);
    renderer.compute(this.kernel, [gx, gy, 1]);
    renderer.compute(this.copyNode, [gx, gy, 1]);
    this.stats.dispatches++;
  }

  /** Toggle OFF: free the fog-sized textures back to 1×1 (no texture cost)
   *  and mark the pass inactive so the next enable starts a fresh history.
   *  Idempotent and allocation-free while already released. */
  release(): void {
    this.wasActive = false;
    if (!this.allocated) return;
    this.fogTexture.setSize(1, 1, 1);
    this.fogHistory.setSize(1, 1, 1);
    this.stats.width = 1;
    this.stats.height = 1;
    this.allocated = false;
  }

  /** the lights storage buffer changed size (setLights) — the kernel indexes
   *  `rt_lights` at module scope, so it must be rebuilt with the new include */
  invalidate(): void {
    this.kernel = undefined; // copy kernel is lights-independent
  }

  dispose(): void {
    this.fogTexture.dispose();
    this.fogHistory.dispose();
  }

  // ---- WGSL ------------------------------------------------------------------
  private buildKernel(): KernelNode {
    const { deps } = this;
    // Constants interpolated from the tuning block above — one place to edit.
    // They live INSIDE compute(): three's wgslFn parser strips leading
    // comments then demands a function declaration, so module-scope consts
    // before `fn` throw "not a WGSL code".
    const source = /* wgsl */ `
      // compute MUST be the first function: three parses the first fn for the
      // entry signature (and Tint rejects '-> void' — return vec4f, discard it)
      fn compute(
        fogTex: texture_storage_2d<rgba16float, write>,
        fogHistory: texture_2d<f32>,
        geomTex: texture_2d<f32>,
        blendAlpha: f32,
        invViewProj: mat4x4f,
        viewMat: mat4x4f,
        frameIndex: f32,
        lightCount: f32,
        softShadow: f32,
        lightGain: f32,
        workgroupSize: vec3u,
        workgroupId: vec3u,
        localId: vec3u,
      ) -> vec4f {
        const FOG_DENSITY = ${FOG_DENSITY};
        const FOG_FALLOFF = ${FOG_FALLOFF};
        // level-floor anchor (bbox min-y of the shadow geometry, computed
        // once at pass init) — falloff measures height ABOVE this, so the
        // fog is full-density at/below the floor and decays smoothly up,
        // with no world-0 knee (the round-1 "fog only under height 0" bug)
        const FOG_FLOOR_Y = ${this.floorY};
        const FOG_COLOR = vec3f(${FOG_COLOR[0]}, ${FOG_COLOR[1]}, ${FOG_COLOR[2]});
        const FOG_AMBIENT = ${FOG_AMBIENT};
        const FOG_MAX_DIST = ${FOG_MAX_DIST};
        const FOG_STEPS = ${FOG_STEPS};
        const LIGHT_RANGE_SQ = ${(LIGHT_RANGE * LIGHT_RANGE).toFixed(1)};

        let dimensions = textureDimensions(fogTex);
        let indexUV = workgroupSize.xy * workgroupId.xy + localId.xy;
        if (indexUV.x >= dimensions.x || indexUV.y >= dimensions.y) { return vec4f(0.0); }
        let uv = (vec2f(indexUV) + vec2f(0.5)) / vec2f(dimensions);

        // geomTex lives at the LIGHTING resolution — equal to the fog
        // resolution on every tier today, but map through uv so a future
        // mismatch still stops the march at the right primary hit. The
        // sentinel (view depth −1) means miss/sky: march the full distance
        // so the sky hazes too (vibe.png horizon glow).
        let geomDims = textureDimensions(geomTex);
        let gUV = min(vec2u(uv * vec2f(geomDims)), geomDims - 1u);
        let g = textureLoad(geomTex, gUV, 0);

        let ndc = uv * 2.0 - 1.0;
        let ray = ndcToCameraRay(ndc, invViewProj);

        // view depth → distance ALONG THE RAY: in view space the hit sits at
        // t·dirView.z = −viewDepth, so t = viewDepth / (−dirView.z). (View
        // depth is planar, not ray length — dividing by the z component is
        // what keeps the march ending exactly on the primary surface.)
        // f32() cast: the constant interpolates as an integer literal, and an
        // integer-typed var would reject the f32 assignment below.
        var marchDist = f32(FOG_MAX_DIST);
        if (g.w >= 0.0) {
          let dirView = (viewMat * vec4f(ray.direction, 0.0)).xyz;
          marchDist = min(g.w / max(0.0 - dirView.z, 1e-3), FOG_MAX_DIST);
        }

        let nLights = u32(lightCount + 0.5);
        let stepLen = marchDist / f32(FOG_STEPS);
        // per-frame dithered step offset (hash, not a texture — no asset
        // dependency): every sample slides by a random fraction of a step
        // each frame, so the discrete step positions never sit still long
        // enough to draw fixed stripes across a receding wall. The temporal
        // blend (alpha < 1 while the camera is still) averages the shifted
        // patterns into a smooth gradient — that is the anti-banding pair.
        let dither = hash12(uv * 719.3 + vec2f(frameIndex * 1.37, frameIndex * 2.11));
        var t = dither * stepLen;
        var T = 1.0;
        var S = vec3f(0.0);

        for (var i = 0; i < FOG_STEPS; i++) {
          if (t >= marchDist) { break; }
          let P = ray.origin + ray.direction * t;
          // homogeneous density + height falloff: backrooms haze pooling on
          // the LEVEL FLOOR (FOG_FLOOR_Y) and thinning upward — anchored at
          // the floor, not world 0, so it works at any level height and
          // never draws a horizontal knee across the view. No noise texture:
          // uniform air reads as atmosphere, textured air reads as clouds
          let rho = FOG_DENSITY * exp(-max(P.y - FOG_FLOOR_Y, 0.0) / FOG_FALLOFF);
          if (rho > 1e-5) {
            // ambient teal veil — tiny on purpose (see FOG_AMBIENT WHY)
            var L = FOG_COLOR * FOG_AMBIENT;
            for (var li = 0u; li < nLights; li++) {
              let b = li * 5u;
              let lp = rt_lights.value[b];
              let lc = rt_lights.value[b + 1u];
              let le = rt_lights.value[b + 2u];
              let ld = rt_lights.value[b + 3u];
              let lq = rt_lights.value[b + 4u];
              if (lp.w <= 0.0) { continue; }
              // one-way cone: fog outside the cone must not glow (same rule
              // as surface lighting, or shafts leak past the fixture's aim)
              if (ld.w > -0.5) {
                let toP = normalize(P - lp.xyz);
                if (dot(toP, ld.xyz) < ld.w) { continue; }
              }
              // PER-STEP RANGE CULL — the queued light-distance culling for
              // the fog loop: beyond LIGHT_RANGE the 1/d² term is <2 %, so
              // neither the surface sample nor its shadow ray is worth paying
              // for (backlog §8 "far lights cost nothing per pixel")
              let dCenter2 = dot(lp.xyz - P, lp.xyz - P);
              if (dCenter2 > LIGHT_RANGE_SQ) { continue; }
              let seed = uv * 91.7 + vec2f(frameIndex * 0.37, frameIndex * 0.73)
                + vec2f(f32(li) * 17.31, f32(li) * 9.17);
              let lightPt = fogLightPoint(lp, le, lq, P, seed, softShadow);
              let toL = lightPt - P;
              let d2 = dot(toL, toL);
              if (d2 > LIGHT_RANGE_SQ) { continue; }
              let d = sqrt(d2);
              // occlusion = the shafts: anything between this air sample and
              // the fixture blackholes it. Any-hit (not first-hit) — we only
              // need yes/no, and it exits traversal at the first blocker.
              var sray: Ray;
              sray.origin = P;
              sray.direction = toL / max(d, 1e-4);
              // 0.08 stop-short matches surface shadow rays: a wall flush
              // with the sample face must not occlude its own fixture
              sray.maxDist = max(d - 0.08, 0.001);
              if (bvh_RaycastAnyHit(sray)) { continue; }
              // isotropic point-ish radiance — no surface N·L (fog has no
              // receiver surface), same 0.25 floor as directLight()
              L += lc.rgb * (lp.w * lightGain / max(d2, 0.25));
            }
            // analytic integration across the step: in-scatter grows with the
            // light reaching the step, transmittance decays exponentially.
            // (rho·stepLen ≈ 0.02 here, so the explicit form is stable.)
            S += T * (L * rho) * stepLen;
            T *= exp(-rho * stepLen);
          }
          t += stepLen;
        }

        // temporal accumulation — history is written by the copy pass below,
        // never read+write in one usage scope (same rule as rt.ts's lighting)
        let prev = textureLoad(fogHistory, indexUV, 0);
        textureStore(fogTex, indexUV, mix(prev, vec4f(S, T), blendAlpha));
        return vec4f(0.0);
      }

      // ---- helpers AFTER compute (Tint accepts module-scope forward refs;
      // three needs compute first for the entry signature) ----------------
      fn hash12(coordinate: vec2f) -> f32 {
        var h3 = fract(vec3f(coordinate.xyx) * 0.1031);
        h3 += dot(h3, h3.yzx + 33.33);
        return fract((h3.x + h3.y) * h3.z);
      }

      // rotate v by quaternion q (xyzw)
      fn qrot(q: vec4f, v: vec3f) -> vec3f {
        return v + 2.0 * cross(q.xyz, cross(q.xyz, v) + q.w * v);
      }

      // Point on the fixture's emitting surface for a FOG shadow ray.
      // Mirrors rt.ts's shadowVis() sample selection on purpose (separate
      // kernel string — keep the two in sync) but WITHOUT the receiver N·L
      // test: a fog volume has no surface to turn away from the light.
      //   soft (?rtsoft default) = area-weighted face + uniform point, so
      //     temporal accumulation converges a fixture-shaped shaft penumbra;
      //   hard (?rtsoft=0)       = deterministic centre of the face turned
      //     toward the step (the crisp A/B look);
      //   point lights (no extents — test room) = the centre.
      fn fogLightPoint(lp: vec4f, le: vec4f, lq: vec4f, P: vec3f, seed: vec2f, soft: f32) -> vec3f {
        if (max(le.x, max(le.y, le.z)) <= 1e-4) { return lp.xyz; }
        let e = le.xyz;
        if (soft > 0.5) {
          let wsum = e.y * e.z + e.x * e.z + e.x * e.y;
          let rF = hash12(seed);
          let rS = hash12(seed + vec2f(3.71, 11.13));
          let rU = hash12(seed + vec2f(7.77, 21.7));
          let rV = hash12(seed + vec2f(13.3, 5.9));
          var baseN = vec3f(1.0, 0.0, 0.0);
          if (rF >= (e.y * e.z) / wsum) { baseN = vec3f(0.0, 1.0, 0.0); }
          if (rF >= (e.y * e.z + e.x * e.z) / wsum) { baseN = vec3f(0.0, 0.0, 1.0); }
          let faceN = baseN * select(-1.0, 1.0, rS < 0.5);
          let refUp = select(vec3f(0.0, 1.0, 0.0), vec3f(1.0, 0.0, 0.0), abs(faceN.y) > 0.9);
          let t1 = normalize(cross(refUp, faceN));
          let t2 = cross(faceN, t1);
          let u = 2.0 * rU - 1.0;
          let v = 2.0 * rV - 1.0;
          let local = faceN * dot(abs(faceN), e)
            + t1 * (u * dot(abs(t1), e))
            + t2 * (v * dot(abs(t2), e));
          return lp.xyz + qrot(lq, local);
        }
        // hard A/B: centre of the box face the air sample sits on the side of
        let toP = qrot(vec4f(-lq.x, -lq.y, -lq.z, lq.w), P - lp.xyz);
        let a = abs(toP);
        var baseN = vec3f(1.0, 0.0, 0.0);
        if (a.y > max(a.x, a.z)) { baseN = vec3f(0.0, 1.0, 0.0); }
        else if (a.z > a.x) { baseN = vec3f(0.0, 0.0, 1.0); }
        let sgn = select(-1.0, 1.0, dot(toP, baseN) >= 0.0);
        return lp.xyz + qrot(lq, baseN * (sgn * dot(abs(baseN), e)));
      }
    `;
    const computeFn = wgslFn(source, [
      ndcToCameraRay,
      this.deps.bvhData.fns.raycastAnyHit,
      deps.lightsNode(),
      // storage node rides in the includes; raw WGSL indexes rt_lights.value[]
    ] as never);
    const params = {
      fogTex: textureStore(this.fogTexture),
      fogHistory: texture(this.fogHistory),
      geomTex: texture(this.deps.geomTex),
      blendAlpha: this.blendAlpha,
      invViewProj: deps.invViewProj,
      viewMat: deps.viewMat,
      frameIndex: deps.frameIndex,
      lightCount: deps.lightCount,
      softShadow: deps.softShadow,
      lightGain: deps.lightGain,
      workgroupSize: deps.workgroupSize,
      workgroupId: deps.workgroupId,
      localId: deps.localId,
    };
    return computeFn(params as never).computeKernel([WORKGROUP, WORKGROUP, 1]) as KernelNode;
  }

  /** fogHistory := fogTex — its own pass with its own bindings (a pass may
   *  not read the texture it writes; same pattern as rt.ts's copy kernel) */
  private buildCopyNode(): KernelNode {
    const source = /* wgsl */ `
      fn copyFog(
        src: texture_2d<f32>,
        dst: texture_storage_2d<rgba16float, write>,
        workgroupSize: vec3u,
        workgroupId: vec3u,
        localId: vec3u,
      ) -> vec4f {
        let dimensions = textureDimensions(src);
        let indexUV = workgroupSize.xy * workgroupId.xy + localId.xy;
        if (indexUV.x >= dimensions.x || indexUV.y >= dimensions.y) { return vec4f(0.0); }
        textureStore(dst, indexUV, textureLoad(src, indexUV, 0));
        return vec4f(0.0);
      }
    `;
    const copyFn = wgslFn(source, [] as never);
    return copyFn({
      src: texture(this.fogTexture),
      dst: textureStore(this.fogHistory),
      workgroupSize: this.deps.workgroupSize,
      workgroupId: this.deps.workgroupId,
      localId: this.deps.localId,
    } as never).computeKernel([WORKGROUP, WORKGROUP, 1]) as KernelNode;
  }
}

type KernelNode = Parameters<THREE.WebGPURenderer['compute']>[0];
