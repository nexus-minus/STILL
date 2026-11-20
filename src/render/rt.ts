import * as THREE from 'three/webgpu';
import {
  uniform,
  wgslFn,
  textureStore,
  texture,
  storage,
  workgroupId,
  localId,
  screenUV,
  vec2,
  vec4,
  mix,
  step,
  mrt,
  pass,
  output,
  diffuseColor,
  emissive,
  Fn,
} from 'three/tsl';
import { bloom } from 'three/addons/tsl/display/BloomNode.js';
import { BVHComputeData, ndcToCameraRay } from 'three-mesh-bvh/webgpu';
import type { QualitySettings } from './quality.js';

// vec4 slots per light in the storage buffer:
// [0] pos.xyz + power · [1] color.rgb + halfSize · [2] local half-extents
// [3] cone dir.xyz + coneCos · [4] orientation quaternion (xyzw)
const LIGHT_STRIDE = 5;
const WORKGROUP = 8;
/** WebGPU default maxStorageBufferBindingSize — used when limits are unreadable */
const FALLBACK_MAX_STORAGE = 134217728;

export interface RtLight {
  /** world position (center of the emissive surface) */
  position: [number, number, number];
  /** linear RGB color */
  color: [number, number, number];
  /** radiometric power — feeds 1/d² falloff */
  power: number;
  /**
   * Scalar half-size = MEDIAN of the world-AABB half extents. Consumers probe
   * outward from the centre by this distance (map-loader nudge step, main's
   * embed probes) — median matches the legacy per-sample value on this map's
   * fixtures (cubes exact, strips ±0.03 m), so those probes behave as before.
   * The renderer itself uses `extents`, not this.
   */
  halfSize: number;
  /**
   * World-space HALF-extents of the emitting box in the fixture's LOCAL axes
   * (geometry bbox ⊙ |world scale|). Present = the mesh itself is sampled as
   * an area light (surface NEE); absent = analytic point light (test-room
   * fallback lights keep their legacy behaviour).
   */
  extents?: [number, number, number];
  /** world orientation of the fixture box (quaternion xyzw); absent = axis-aligned */
  orientation?: [number, number, number, number];
  /**
   * Optional one-way cone (Blender prop `cone_deg` on the fixture):
   * world-space emitting direction (the object's +Z after export) and
   * cos(half-angle). Absent = omni light.
   */
  direction?: [number, number, number];
  coneCos?: number;
}

export interface AdvancedRenderer {
  /** false until the GPU BVH upload finished — dispatch() no-ops until then */
  readonly ready: boolean;
  /** lighting compute pass (no-ops when raytracing is off this frame) */
  dispatch(camera: THREE.PerspectiveCamera, settings: QualitySettings, pixelRatio: number): void;
  /** raster MRT + composite + bloom */
  render(): void;
  /** logical canvas size in CSS pixels */
  setLogicalSize(width: number, height: number): void;
  /** 0 = normal, 1 = uv-gradient (pipeline alive?), 2 = red=miss / green=hit */
  setDebugMode(mode: number): void;
  /** runtime intensity multiplier for all lights (settings slider) */
  setLightGain(value: number): void;
  /** replace the light list (future chunk-streaming) — rebuilds the storage buffer, never truncates */
  setLights(lights: RtLight[]): void;
  dispose(): void;
}

/**
 * PHASE 1 — ADVANCED (RAYTRACED) RENDER PATH — WebGPU only.
 *
 *   1. compute pass at settings.lightingScale resolution:
 *        primary camera ray   -> ndcToCameraRay + bvh_RaycastFirstHit
 *        direct lighting      -> next-event estimation over the emissive light
 *                                list, occlusion via bvh_RaycastAnyHit shadow rays
 *        one bounce           -> cosine-hemisphere ray, shaded at the hit point
 *        + hemisphere ambient                               -> storage texture
 *   2. raster pass -> MRT { output(beauty), diffuse(albedo), emissive }
 *   3. composite: diffuse * lighting + emissive (selected vs beauty by flag)
 *      -> bloom -> tone mapping (outputColorTransform)
 *
 * Safety rules (this machine cannot run WebGPU locally):
 *  - mirrors the official three-mesh-bvh webgpu example APIs exactly — every
 *    call exists in the installed sources;
 *  - lights live in a `storage()` buffer referenced from the raw WGSL by name
 *    (`rt_lights.value[...]`) — mechanism verified by scripts/rt-storage-
 *    probe.mjs; no fixed cap, no uniform-array slot games;
 *  - construction failures degrade to the standard path with a player-visible
 *    message (main() catches). The ONE intentional throw is an oversized
 *    light list: failing loudly beats silently dropping a light.
 */
export function createAdvancedRenderer(
  renderer: THREE.WebGPURenderer,
  scene: THREE.Scene,
  camera: THREE.PerspectiveCamera,
  /** SHADOW/tracing geometry — must EXCLUDE emissive fixtures (see WorldDef) */
  bvhMeshes: THREE.Mesh[],
  lights: RtLight[],
): AdvancedRenderer {
  // ---- BVH first: kernel deps reference its fns ------------------------------
  const bvhData = new BVHComputeData(bvhMeshes, {
    attributes: { position: 'vec4f', normal: 'vec4f' },
  });
  let ready = false;
  void bvhData.updateAsync().then(() => {
    ready = true;
    console.info('[rt] BVH uploaded to GPU');
  });

  // ---- G-buffer: scene pass with MRT -----------------------------------------
  const scenePass = pass(scene, camera, {
    minFilter: THREE.NearestFilter,
    magFilter: THREE.NearestFilter,
  });
  scenePass.setMRT(
    mrt({
      output,
      diffuse: diffuseColor,
      emissive,
    }),
  );

  // HDR storage: rgba8unorm clips all radiance above1.0 BEFORE AgX tone mapping,
  // which turns emissive rooms into broad featureless white slabs. Half-float
  // preserves the HDR range through the composite.
  const lightingTex = new THREE.StorageTexture(1, 1);
  lightingTex.type = THREE.HalfFloatType;
  lightingTex.format = THREE.RGBAFormat;
  lightingTex.minFilter = THREE.LinearFilter;
  lightingTex.magFilter = THREE.LinearFilter;
  // temporal accumulation history: static camera converges to a clean image,
  // any movement resets to live (no smear — reset instead of reproject)
  const historyTex = new THREE.StorageTexture(1, 1);
  historyTex.type = THREE.HalfFloatType;
  historyTex.format = THREE.RGBAFormat;
  historyTex.minFilter = THREE.LinearFilter;
  historyTex.magFilter = THREE.LinearFilter;

  // ---- uniforms -----------------------------------------------------------------
  const invViewProj = uniform(new THREE.Matrix4());
  const frameIndex = uniform(0);
  const lightCount = uniform(lights.length);
  const bounceCount = uniform(0);
  const debugMode = uniform(0);
  /** area-jittered surface samples on / legacy single-tap off — ?rtsoft=0 = A/B */
  const softShadow = uniform(new URLSearchParams(location.search).get('rtsoft') === '0' ? 0 : 1);
  /** temporal blend: 1 = live frame (moving), <1 = accumulate */
  const blendAlpha = uniform(1);
  /** runtime intensity multiplier (settings slider) — multiplied in-shader */
  const lightGain = uniform(1);
  // Precomputed4-tap offsets: TSL miscompiles unary minus on swizzle
  // components inside vec2(...) (it emitted literal NaN.0 into WGSL and broke
  // every fragment pipeline) — no node arithmetic, just four uniforms.
  const tapNE = uniform(new THREE.Vector2(1, 1));
  const tapSW = uniform(new THREE.Vector2(-1, -1));
  const tapSE = uniform(new THREE.Vector2(1, -1));
  const tapNW = uniform(new THREE.Vector2(-1, 1));
  const workgroupSize = uniform(new THREE.Vector3(WORKGROUP, WORKGROUP, 1));

  // ---- UNCAPPED LIGHT LIST ------------------------------------------------
  // Storage buffer of vec4 slots (LIGHT_STRIDE per light) referenced BY NAME
  // from the raw WGSL (`rt_lights.value[...]`) — three declares storage as
  // `struct rt_lightsStruct { value: array<vec4f> }` +
  // `var<storage, read> rt_lights : rt_lightsStruct` when the node sits in the
  // wgslFn includes (mechanism verified by scripts/rt-storage-probe.mjs).
  // No fixed cap, no nearest-N truncation: the only bound is the GPU's
  // maxStorageBufferBindingSize, and exceeding it FAILS LOUDLY (console.error
  // + construction throw -> main's on-screen notice + standard path) instead
  // of ever silently dropping a light.
  const fillLightArray = (list: RtLight[], arr: Float32Array): void => {
    for (let i = 0; i < list.length; i++) {
      const l = list[i];
      const o = i * LIGHT_STRIDE * 4;
      arr[o + 0] = l.position[0];
      arr[o + 1] = l.position[1];
      arr[o + 2] = l.position[2];
      arr[o + 3] = l.power;
      arr[o + 4] = l.color[0];
      arr[o + 5] = l.color[1];
      arr[o + 6] = l.color[2];
      arr[o + 7] = l.halfSize;
      arr[o + 8] = l.extents?.[0] ?? 0;
      arr[o + 9] = l.extents?.[1] ?? 0;
      arr[o + 10] = l.extents?.[2] ?? 0;
      arr[o + 11] = 0;
      arr[o + 12] = l.direction?.[0] ?? 0;
      arr[o + 13] = l.direction?.[1] ?? 0;
      arr[o + 14] = l.direction?.[2] ?? 0;
      arr[o + 15] = l.coneCos ?? -1;
      arr[o + 16] = l.orientation?.[0] ?? 0;
      arr[o + 17] = l.orientation?.[1] ?? 0;
      arr[o + 18] = l.orientation?.[2] ?? 0;
      arr[o + 19] = l.orientation?.[3] ?? 1;
    }
  };
  let lightsAttr: THREE.StorageBufferAttribute | undefined;
  const makeLightsNode = (list: RtLight[]) => {
    const arr = new Float32Array(Math.max(list.length, 1) * LIGHT_STRIDE * 4);
    fillLightArray(list, arr);
    const bytes = arr.byteLength;
    const limits = (renderer as unknown as {
      backend?: { device?: { limits?: { maxStorageBufferBindingSize?: number } } };
    }).backend?.device?.limits;
    // test hook: ?rtlightlimit=N fakes a tiny GPU limit so the loud-failure
    // path (console + construction throw -> on-screen notice) is testable
    // without a giant map — scripts/rt-softshadow-smoke.mjs uses it
    const forced = Number(new URLSearchParams(location.search).get('rtlightlimit'));
    const maxBinding =
      Number.isFinite(forced) && forced > 0
        ? forced
        : (limits?.maxStorageBufferBindingSize ?? FALLBACK_MAX_STORAGE);
    if (bytes > maxBinding) {
      const msg =
        `[rt] light list too large: ${list.length} fixtures need ${bytes} bytes of ` +
        `storage > maxStorageBufferBindingSize ${maxBinding} — refusing to drop lights ` +
        `(split the scene or raise the GPU limit)`;
      console.error(msg);
      throw new Error(msg);
    }
    // three's TS signature wants all3 args; count is unused for storage
    // (only uniform 'buffer' decls embed it) — BVH passes it the same way
    lightsAttr = new THREE.StorageBufferAttribute(arr, 4);
    return storage(lightsAttr, 'vec4', 0).toReadOnly().setName('rt_lights');
  };
  let lightsNode = makeLightsNode(lights);

  // ---- WGSL ------------------------------------------------------------------------
  // Light iteration is a RUNTIME loop over lightCount reading the storage
  // buffer — no unrolled chain, no cap (a map with N fixtures costs exactly
  // N iterations and one shadow ray each).
  const kernelSource = /* wgsl */ `
    // compute MUST be the first function: three parses the FIRST fn for the
    // signature it binds and calls THAT name from its generated main. It also
    // requires a return identifier (regex) — but Tint rejects '-> void', so we
    // return vec4f and let the caller discard it (Tint-verified accepted).
    fn compute(
      lightingTex: texture_storage_2d<rgba16float, write>,
      historyTex: texture_2d<f32>,
      blendAlpha: f32,
      invViewProj: mat4x4f,
      frameIndex: f32,
      lightCount: f32,
      bounceCount: f32,
      debugMode: f32,
      softShadow: f32,
      lightGain: f32,
      workgroupSize: vec3u,
      workgroupId: vec3u,
      localId: vec3u,
    ) -> vec4f {
      let dimensions = textureDimensions(lightingTex);
      let indexUV = workgroupSize.xy * workgroupId.xy + localId.xy;
      if (indexUV.x >= dimensions.x || indexUV.y >= dimensions.y) { return vec4f(0.0); }

      let uv = (vec2f(indexUV) + vec2f(0.5)) / vec2f(dimensions);

      // per-pixel + per-frame jitter seed — AO, soft-shadow taps and the
      // debug visibility chain all consume it, so it must be declared before
      // the first of them (the debug2 branch runs before the AO block)
      let jseed = uv * 91.7 + vec2f(frameIndex * 0.37, frameIndex * 0.73);

      // debug modes (?rtdebug=1|2) — written before any ray math so each
      // stage of the pipeline can be isolated with one screenshot
      if (debugMode > 0.5 && debugMode < 1.5) {
        textureStore(lightingTex, indexUV, vec4f(uv, 0.3, 1.0));
        return vec4f(0.0);
      }

      let ndc = uv * 2.0 - 1.0;
      var ray = ndcToCameraRay(ndc, invViewProj);

      var hit: IntersectionResult;
      bvh_RaycastFirstHit(ray, &hit);

      if (!hit.didHit) {
        // debug2 promises "red = miss" (HUD + comment below) — paint it so
        // void/seam pixels are unmistakable instead of blending to black
        if (debugMode > 1.5 && debugMode < 2.5) {
          textureStore(lightingTex, indexUV, vec4f(1.0, 0.0, 0.0, 1.0));
          return vec4f(0.0);
        }
        let prevM = textureLoad(historyTex, indexUV, 0).rgb;
        let blendedM = mix(prevM, vec3f(0.0), blendAlpha);
        textureStore(lightingTex, indexUV, vec4f(blendedM, 1.0));
        return vec4f(0.0);
      }

      var N = hit.normal;
      if (dot(N, -ray.direction) < 0.0) { N = -N; }
      // smooth shading: prefer INTERPOLATED vertex normals (Blender smooth
      // shading) when they agree with the face — flat triangle normals are
      // what makes lighting look stepped "per face"
      let vN3 = bvh_sampleTrianglePoint(hit.barycoord, hit.indices.xyz).normal.xyz;
      if (dot(vN3, vN3) > 1e-6) {
        var sn = normalize(vN3);
        if (dot(sn, -ray.direction) < 0.0) { sn = -sn; }
        if (dot(sn, N) > 0.5) { N = sn; }
      }
      let P = ray.origin + ray.direction * hit.dist + N * 0.04; // clears thin overlaps

      var acc = vec3f(0.0);
      let nLights = u32(lightCount + 0.5);

      if (debugMode > 1.5 && debugMode < 2.5) {
        // debug2: hit/miss colour SHADED by real shadow-ray visibility —
        // bright green = hit & lit · dark green = hit & IN SHADOW · red = miss.
        // max() (not sum) is INTENTIONAL — a binary "lit by ANY light" squeezed
        // into one green channel. Falls through to the temporal blend below:
        // one jittered sample per frame is noisy alone, a static camera
        // converges it (the old early-return skipped history, so the promised
        // accumulation never actually happened).
        var vis = 0.0;
        for (var li = 0u; li < nLights; li++) {
          let lseed = jseed + vec2f(f32(li) * 17.31, f32(li) * 9.17);
          vis = max(vis, shadowFactor(li, P, N, lseed, softShadow));
        }
        acc = vec3f(0.0, 1.0, 0.0) * (0.25 + 0.75 * vis);
      } else {
        // hemisphere ambient so nothing is pitch black — modulated by RAYTRACED
        // AO (one short jittered ray up the normal): without this the ambient
        // ignores geometry and every corner reads flat/wrong
        var aor: Ray;
        aor.origin = P;
        let j1 = hash12(jseed) - 0.5;
        let j2 = hash12(jseed + vec2f(7.31, 2.17)) - 0.5;
        aor.direction = normalize(N + vec3f(j1, j2, j1 * j2) * 0.7);
        aor.maxDist = 0.6;
        var aoh: IntersectionResult;
        var ao = 1.0;
        if (bvh_RaycastFirstHit(aor, &aoh)) { ao = clamp(aoh.dist / 0.6, 0.0, 1.0); }
        acc = mix(vec3f(0.012, 0.011, 0.010), vec3f(0.028, 0.027, 0.024), N.y * 0.5 + 0.5) * ao;

        // direct lighting: next-event estimation — ONE surface sample per light
        // per frame (jseed + light index decorrelate the jitter; temporal
        // accumulation converges it into a continuous penumbra)
        for (var li = 0u; li < nLights; li++) {
          let lseed = jseed + vec2f(f32(li) * 17.31, f32(li) * 9.17);
          acc += directLight(li, P, N, 1.0, lseed, softShadow, lightGain);
        }

        // one bounce: cosine hemisphere ray, shade at the hit point
        if (bounceCount > 0.5) {
          let seed = uv * vec2f(311.7, 271.9) + vec2f(frameIndex * 0.618, frameIndex * 0.271);
          let r1 = hash12(seed);
          let r2 = hash12(seed + vec2f(17.13, 3.71));
          var T = normalize(cross(select(vec3f(1.0, 0.0, 0.0), vec3f(0.0, 1.0, 0.0), abs(N.y) < 0.9), N));
          var B = cross(N, T);
          let phi = 6.2831853 * r1;
          let rr = sqrt(r2);
          let dir = normalize(T * (cos(phi) * rr) + B * (sin(phi) * rr) + N * sqrt(max(0.0, 1.0 - r2)));

          var bray: Ray;
          bray.origin = P;
          bray.direction = dir;
          bray.maxDist = 0.0;
          var bhit: IntersectionResult;
          if (bvh_RaycastFirstHit(bray, &bhit)) {
            var BN = bhit.normal;
            if (dot(BN, -dir) < 0.0) { BN = -BN; }
            let BP = bray.origin + dir * bhit.dist + BN * 0.04;
            var bacc = vec3f(0.0);
            for (var li = 0u; li < nLights; li++) {
              let lseed = seed + vec2f(f32(li) * 17.31, f32(li) * 9.17);
              bacc += directLight(li, BP, BN, 0.72, lseed, softShadow, lightGain);
            }
            // FIREFLY CLAMP: a bounce landing next to a light spikes 1/d² into
            // single white pixels — the "particles" in screenshots. Cap the
            // indirect term; direct pools stay bright (storage clamps at 1).
            acc += min(bacc / 3.14159265, vec3f(0.6));
          }
        }
      }

      // temporal accumulation: blend with the PREVIOUS frame's result, which
      // historyTex holds as a sampled texture (written by the copy kernel
      // after this pass — one usage per pass, never read+write together)
      let prev = textureLoad(historyTex, indexUV, 0).rgb;
      let blended = mix(prev, acc, blendAlpha);
      textureStore(lightingTex, indexUV, vec4f(blended, 1.0));
      return vec4f(0.0);
    }

    // helpers AFTER compute — Tint accepts module-scope forward references
    // (verified by probe), and compute must stay first for three's parser.
    fn hash12(coordinate: vec2f) -> f32 {
      var h3 = fract(vec3f(coordinate.xyx) * 0.1031);
      h3 += dot(h3, h3.yzx + 33.33);
      return fract((h3.x + h3.y) * h3.z);
    }

    // rotate v by quaternion q (xyzw) — box sampling must land on the
    // fixture's ACTUAL world surface (light001/light002 are rotated ~60° in
    // the map; a world-AABB box would fatten them into the wrong emitter)
    fn qrot(q: vec4f, v: vec3f) -> vec3f {
      return v + 2.0 * cross(q.xyz, cross(q.xyz, v) + q.w * v);
    }

    // Light-side weight of a box-surface sample: emission only leaves the
    // FRONT of a face (cos <= 0 -> 0), plus the area factor K = A_total /
    // A_maxface. With uniform surface sampling the expected light-side cosine
    // is A_proj/A_total (Cauchy), so K·E[cos] = A_proj/A_ref — exactly 1 when
    // the receiver faces the dominant face, i.e. face-on brightness matches
    // the legacy centre-point estimate; edge/end views get the physically
    // correct lower value instead of the old omni point's flat one.
    fn faceWeight(lp: vec4f, le: vec4f, lq: vec4f, lightPt: vec3f, P: vec3f, dist: f32) -> f32 {
      let local = qrot(vec4f(-lq.x, -lq.y, -lq.z, lq.w), lightPt - lp.xyz);
      // the sample lies ON a face: its dominant extent-normalised axis IS the face
      let q = abs(local) / max(le.xyz, vec3f(1e-4));
      var ax = 0u;
      var best = q.x;
      if (q.y > best) { ax = 1u; best = q.y; }
      if (q.z > best) { ax = 2u; }
      let comp = select(select(local.z, local.y, ax == 1u), local.x, ax == 0u);
      let s = select(-1.0, 1.0, comp >= 0.0);
      let nLocal = vec3f(select(0.0, s, ax == 0u), select(0.0, s, ax == 1u), select(0.0, s, ax == 2u));
      let toR = P - lightPt;
      let cosL = dot(qrot(lq, nLocal), toR) / max(dist, 1e-4);
      if (cosL <= 0.0) { return 0.0; }
      let sum = le.y * le.z + le.x * le.z + le.x * le.y;
      let aRef = 4.0 * max(le.y * le.z, max(le.x * le.z, le.x * le.y));
      return cosL * (8.0 * sum) / max(aRef, 1e-6);
    }

    // ONE shadow-ray sample per light per frame (replaces the legacy 3-tap
    // disc loop — ~9x fewer shadow rays on this map). Box lights pick a point
    // on the fixture's actual SURFACE: area-weighted face, uniform on the face
    // (hash by pixel uv + frame + light index); temporal accumulation
    // converges the jitter into a continuous penumbra shaped like the fixture,
    // and a fixture clipped into the floor lights through its EXPOSED faces
    // (the buried analytic centre point could not — it emitted nothing).
    // ?rtsoft=0 = deterministic receiver-facing face centre: crisp hard
    // shadows, still a surface point. Point lights (no extents — test-room)
    // keep one legacy disc-jittered tap. Returns xyz = shadow-ray target,
    // w = visibility.
    fn shadowVis(lp: vec4f, lc: vec4f, le: vec4f, lq: vec4f, P: vec3f, N: vec3f, seed: vec2f, soft: f32) -> vec4f {
      let hasBox = max(le.x, max(le.y, le.z)) > 1e-4;
      // NB: never name a local 'target' — WGSL reserves it (Tint parse error)
      var lightPt = lp.xyz;
      if (hasBox) {
        let e = le.xyz;
        if (soft > 0.5) {
          // area-weighted face pick: P(±X face pair) ∝ 2*(2hy*2hz)
          let wsum = e.y * e.z + e.x * e.z + e.x * e.y;
          let rF = hash12(seed);
          let rS = hash12(seed + vec2f(3.71, 11.13));
          let rU = hash12(seed + vec2f(7.77, 21.7));
          let rV = hash12(seed + vec2f(13.3, 5.9));
          var baseN = vec3f(1.0, 0.0, 0.0);
          if (rF >= (e.y * e.z) / wsum) { baseN = vec3f(0.0, 1.0, 0.0); }
          if (rF >= (e.y * e.z + e.x * e.z) / wsum) { baseN = vec3f(0.0, 0.0, 1.0); }
          let faceN = baseN * select(-1.0, 1.0, rS < 0.5);
          // uniform on that face via a tangent basis (same ref-up construction
          // as the legacy disc jitter)
          let refUp = select(vec3f(0.0, 1.0, 0.0), vec3f(1.0, 0.0, 0.0), abs(faceN.y) > 0.9);
          let t1 = normalize(cross(refUp, faceN));
          let t2 = cross(faceN, t1);
          let u = 2.0 * rU - 1.0;
          let v = 2.0 * rV - 1.0;
          let local = faceN * dot(abs(faceN), e)
            + t1 * (u * dot(abs(t1), e))
            + t2 * (v * dot(abs(t2), e));
          lightPt = lp.xyz + qrot(lq, local);
        } else {
          // hard A/B: centre of the box face the receiver sits on the side of
          let toP = qrot(vec4f(-lq.x, -lq.y, -lq.z, lq.w), P - lp.xyz);
          let a = abs(toP);
          var baseN = vec3f(1.0, 0.0, 0.0);
          if (a.y > max(a.x, a.z)) { baseN = vec3f(0.0, 1.0, 0.0); }
          else if (a.z > a.x) { baseN = vec3f(0.0, 0.0, 1.0); }
          let sgn = select(-1.0, 1.0, dot(toP, baseN) >= 0.0);
          lightPt = lp.xyz + qrot(lq, baseN * (sgn * dot(abs(baseN), e)));
        }
      } else if (soft > 0.5 && lc.w > 0.015) {
        // point light: one disc-jittered target (legacy disc radius = lc.w;
        // single tap now — the temporal average converges it)
        let toL = lp.xyz - P;
        let L0 = toL / max(sqrt(dot(toL, toL)), 1e-4);
        let refUp = select(vec3f(0.0, 1.0, 0.0), vec3f(1.0, 0.0, 0.0), abs(L0.y) > 0.9);
        let tan1 = normalize(cross(refUp, L0));
        let tan2 = cross(L0, tan1);
        let ang = 6.2831853 * hash12(seed + vec2f(13.73, 7.19));
        let rad = sqrt(hash12(seed + vec2f(3.71, 17.3))) * lc.w;
        lightPt = lp.xyz + (tan1 * cos(ang) + tan2 * sin(ang)) * rad;
      }
      let toT = lightPt - P;
      let td = sqrt(dot(toT, toT));
      if (td < 1e-4) { return vec4f(lightPt, 1.0); }
      let L = toT / td;
      if (max(dot(N, L), 0.0) <= 0.0) { return vec4f(lightPt, 0.0); }
      var sray: Ray;
      sray.origin = P;
      sray.direction = L;
      // same 0.08 stop-short as the hard ray: a host wall flush with a sample
      // face must not occlude that face (the fixture mesh itself is excluded
      // from the shadow BVH); sh.dist > 0.02 ignores only the receiver's own
      // surface — the big 0.25 epsilon used earlier skipped real occluders
      sray.maxDist = max(td - 0.08, 0.001);
      var sh: IntersectionResult;
      if (bvh_RaycastFirstHit(sray, &sh) && sh.dist > 0.02) { return vec4f(lightPt, 0.0); }
      return vec4f(lightPt, 1.0);
    }

    fn directLight(li: u32, P: vec3f, N: vec3f, albedoScale: f32, seed: vec2f, soft: f32, gain: f32) -> vec3f {
      let b = li * 5u;
      let lp = rt_lights.value[b];
      let lc = rt_lights.value[b + 1u];
      let le = rt_lights.value[b + 2u];
      let ld = rt_lights.value[b + 3u];
      let lq = rt_lights.value[b + 4u];
      if (lp.w <= 0.0) { return vec3f(0.0); }
      // one-way cone: lights only the region the fixture POINTS at (Blender
      // prop cone_deg) — a clipped-through fixture stops lighting its outside
      if (ld.w > -0.5) {
        let toP = normalize(P - lp.xyz);
        if (dot(toP, ld.xyz) < ld.w) { return vec3f(0.0); }
      }
      let hasBox = max(le.x, max(le.y, le.z)) > 1e-4;
      let sv = shadowVis(lp, lc, le, lq, P, N, seed, soft);
      if (sv.w <= 0.0) { return vec3f(0.0); }
      // geometry from the SAMPLE for box lights (the sample IS the emitter),
      // from the centre for point lights (legacy behaviour preserved)
      let geom = select(lp.xyz, sv.xyz, hasBox);
      let toL = geom - P;
      let d2 = dot(toL, toL);
      let dist = sqrt(d2);
      if (dist < 1e-4) { return vec3f(0.0); }
      let L = toL / dist;
      // STRICT N*L (the near-field "spill" wrap that made circular lit patches
      // is gone — embedded fixtures are handled by sampling the mesh surface,
      // which is physically consistent)
      let ndotl = max(dot(N, L), 0.0);
      if (ndotl <= 0.0) { return vec3f(0.0); }
      var w = 1.0;
      if (hasBox) {
        w = faceWeight(lp, le, lq, sv.xyz, P, dist);
        if (w <= 0.0) { return vec3f(0.0); }
      }
      return lc.rgb * (lp.w * gain * albedoScale * ndotl * w / max(d2, 0.25)) * sv.w;
    }

    // pure visibility term for debug mode: 1 = lit by this light, 0 = shadowed
    // (a face turned away from the receiver counts as shadowed — it emits
    // nothing toward it; temporal accumulation smooths the per-frame jitter)
    fn shadowFactor(li: u32, P: vec3f, N: vec3f, seed: vec2f, soft: f32) -> f32 {
      let b = li * 5u;
      let lp = rt_lights.value[b];
      let lc = rt_lights.value[b + 1u];
      let le = rt_lights.value[b + 2u];
      let ld = rt_lights.value[b + 3u];
      let lq = rt_lights.value[b + 4u];
      if (lp.w <= 0.0) { return 0.0; }
      if (ld.w > -0.5) {
        let toP = normalize(P - lp.xyz);
        if (dot(toP, ld.xyz) < ld.w) { return 0.0; }
      }
      let sv = shadowVis(lp, lc, le, lq, P, N, seed, soft);
      if (sv.w <= 0.0) { return 0.0; }
      if (max(le.x, max(le.y, le.z)) > 1e-4) {
        let dP = P - sv.xyz;
        if (faceWeight(lp, le, lq, sv.xyz, P, sqrt(dot(dP, dP))) <= 0.0) { return 0.0; }
      }
      return sv.w;
    }
  `;

  const params = {
    lightingTex: textureStore(lightingTex),
    historyTex: texture(historyTex),
    blendAlpha,
    invViewProj,
    frameIndex,
    lightCount,
    bounceCount,
    debugMode,
    softShadow,
    lightGain,
    workgroupSize,
    workgroupId,
    localId,
    // rt_lights is NOT a param: the storage node rides in the wgslFn includes
    // and the raw WGSL indexes `rt_lights.value[...]` at module scope
  };

  // Kernel build is DEFERRED until the BVH update finished: sampleTrianglePoint
  // only exists after update() (its struct depends on resolved attributes) —
  // building eagerly would pass undefined into the deps.
  type KernelNode = Parameters<THREE.WebGPURenderer['compute']>[0];
  let kernelNode: KernelNode | undefined;
  const buildKernel = (): KernelNode => {
    const computeFn = wgslFn(kernelSource, [
      ndcToCameraRay,
      bvhData.fns.raycastFirstHit,
      bvhData.fns.raycastAnyHit,
      bvhData.fns.sampleTrianglePoint,
      // storage node: building its include emits the module-scope
      // `var<storage, read> rt_lights : rt_lightsStruct` the raw WGSL names
      lightsNode!,
    ] as never);
    return computeFn(params).computeKernel([WORKGROUP, WORKGROUP, 1]) as KernelNode;
  };

  // Copy kernel: historyTex := lightingTex, run right after the lighting pass.
  // Own pass with its own bindings — storage-WRITE to history here, sampled
  // READ of history in the lighting kernel — never both in one usage scope
  // (that combination is what Tint rejected with "no matching call to
  // textureStore(texture_2d<f32>, ...)").
  const copySource = /* wgsl */ `
    fn copyHistory(
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
  const copyFn = wgslFn(copySource, [] as never);
  const copyNode = copyFn({
    src: texture(lightingTex),
    dst: textureStore(historyTex),
    workgroupSize,
    workgroupId,
    localId,
  }).computeKernel([WORKGROUP, WORKGROUP, 1]) as KernelNode;

  // ---- composite + bloom ------------------------------------------------------------
  const rtFlag = uniform(0);

  const finalColor = Fn(() => {
    const beauty = scenePass.getTextureNode('output');
    const diffuseN = scenePass.getTextureNode('diffuse');
    const emissiveN = scenePass.getTextureNode('emissive');
    // Storage writes use indexUV (row 0 = TOP in WebGPU) while screenUV is
    // y-up — sample the lighting buffer flipped or the entire lighting image
    // mirrors vertically ("stairs on the ceiling"). Diffuse/emissive come
    // from render targets sampled with screenUV natively and must NOT flip.
    const lightingUv = screenUV.mul(vec2(1.0, -1.0)).add(vec2(0.0, 1.0));
    // 5-tap smoothing: one bounce sample per pixel is inherently noisy — a
    // one-texel cross average kills most of the shimmer (full temporal
    // accumulation/denoise is in the backlog)
    const s0 = texture(lightingTex, lightingUv);
    const s1 = texture(lightingTex, lightingUv.add(tapNE));
    const s2 = texture(lightingTex, lightingUv.add(tapSW));
    const s3 = texture(lightingTex, lightingUv.add(tapSE));
    const s4 = texture(lightingTex, lightingUv.add(tapNW));
    const lightingN = s0.mul(0.4).add(s1.add(s2).add(s3).add(s4).mul(0.15));
    const traced = diffuseN.mul(lightingN).add(emissiveN);
    // rtFlag: 0 = beauty · 1 = traced (albedo x lighting) · 2 = RAW lighting
    // (?rtdebug=3 — the un-multiplied buffer, for isolating flat/banding)
    const rtColor = mix(beauty, traced, step(0.5, rtFlag));
    const shown = mix(rtColor, vec4(lightingN.rgb, 1.0), step(1.5, rtFlag));
    return shown.add(bloom(shown, 0.5, 0.5, 0.75));  })();

  const postPipeline = new THREE.RenderPipeline(renderer);
  // finalColor already includes bloom over whatever branch it displays
  postPipeline.outputNode = finalColor;

  // ---- state -------------------------------------------------------------------------
  let logicalW = 1;
  let logicalH = 1;
  let texW = 1;
  let texH = 1;
  let frame = 0;
  let ranThisFrame = false;
  // temporal accumulation control
  let lastCamX = NaN;
  let lastCamY = 0;
  let lastCamZ = 0;
  let lastPitch = 0;
  let lastYaw = 0;
  let lastDebug = 0;
  let historyReset = true;

  const resizeTex = (scale: number): void => {
    const w = Math.max(1, Math.ceil(logicalW * scale));
    const h = Math.max(1, Math.ceil(logicalH * scale));
    if (w !== texW || h !== texH) {
      texW = w;
      texH = h;
      lightingTex.setSize(w, h, 1);
      historyTex.setSize(w, h, 1);
      historyReset = true;
    }
  };

  return {
    get ready(): boolean {
      return ready;
    },
    dispatch(cam: THREE.PerspectiveCamera, settings: QualitySettings, pixelRatio: number): void {
      ranThisFrame = false;
      if (!ready || !settings.raytracedLighting) {
        rtFlag.value = 0;
        return;
      }
      resizeTex(settings.lightingScale * pixelRatio);
      const ex = 1 / texW;
      const ey = 1 / texH;
      tapNE.value.set(ex, ey);
      tapSW.value.set(-ex, -ey);
      tapSE.value.set(ex, -ey);
      tapNW.value.set(-ex, ey);

      // ---- temporal accumulation control ------------------------------------
      // moving camera or debug view = live frame (no smear); standing still
      // = accumulate (the reliable noise cure: static scenes converge clean)
      const debugNow = debugMode.value;
      const moved =
        !Number.isFinite(lastCamX) ||
        Math.abs(cam.position.x - lastCamX) +
            Math.abs(cam.position.y - lastCamY) +
            Math.abs(cam.position.z - lastCamZ) >
          0.003 ||
        Math.abs(cam.rotation.x - lastPitch) + Math.abs(cam.rotation.y - lastYaw) > 0.0015;
      lastCamX = cam.position.x;
      lastCamY = cam.position.y;
      lastCamZ = cam.position.z;
      lastPitch = cam.rotation.x;
      lastYaw = cam.rotation.y;
      // history holds the PREVIOUS debug mode's output after a switch — reset
      // on any change (0<->N and N<->M) so modes never smear into each other
      if (lastDebug !== debugNow) historyReset = true;
      lastDebug = debugNow;
      if (historyReset) {
        blendAlpha.value = 1;
        historyReset = false;
      } else {
        // static camera accumulates even in debug modes: the per-frame
        // surface-sample jitter is what converges into a clean penumbra in
        // ?rtdebug=2/3 screenshots (motion stays live)
        blendAlpha.value = moved ? 1 : 0.08;
      }

      // lights live in the storage buffer (rebuilt only by setLights) — no
      // per-frame upload; lightGain multiplies in-shader so the slider stays
      // live without touching the buffer

      frame++;
      invViewProj.value.multiplyMatrices(cam.projectionMatrix, cam.matrixWorldInverse).invert();
      frameIndex.value = frame % 1024;
      bounceCount.value = settings.rtBounces >= 1 ? 1 : 0;

      kernelNode ??= buildKernel();
      renderer.compute(kernelNode, [
        Math.ceil(texW / WORKGROUP),
        Math.ceil(texH / WORKGROUP),
        1,
      ]);
      // history := current frame (separate pass = separate bindings)
      renderer.compute(copyNode, [
        Math.ceil(texW / WORKGROUP),
        Math.ceil(texH / WORKGROUP),
        1,
      ]);
      ranThisFrame = true;
      // Any debug mode (?rtdebug=1|2|3) displays the lighting buffer RAW.
      // The traced path multiplies by the gbuffer diffuse — and void/seam
      // pixels have zero diffuse (MRT clear), which multiplied the debug
      // "red = miss" to black, hiding exactly the holes it exists to show.
      rtFlag.value = debugMode.value > 0.5 ? 2 : 1;
    },
    render(): void {
      if (!ranThisFrame) rtFlag.value = 0;
      postPipeline.render();
    },
    setLogicalSize(width: number, height: number): void {
      logicalW = width;
      logicalH = height;
    },
    setDebugMode(mode: number): void {
      debugMode.value = mode;
    },
    setLightGain(value: number): void {
      lightGain.value = value;
    },
    setLights(next: RtLight[]): void {
      // rebuild hook for future chunk-streaming — never truncates: an
      // oversized list throws LOUDLY (see makeLightsNode)
      const nextFloats = Math.max(next.length, 1) * LIGHT_STRIDE * 4;
      if (lightsAttr && lightsAttr.array.length === nextFloats) {
        // same slot count (the common streaming case): rewrite in place — no
        // GPU buffer churn, no kernel rebuild (the kernel's includes name the
        // storage node, so only a SIZE change needs a fresh build)
        fillLightArray(next, lightsAttr.array as Float32Array);
        lightsAttr.needsUpdate = true;
        lightCount.value = next.length;
        return;
      }
      lightsNode = makeLightsNode(next);
      lightCount.value = next.length;
      kernelNode = undefined; // rebuilt lazily on the next dispatch
    },
    dispose(): void {
      postPipeline.dispose();
      lightingTex.dispose();
      historyTex.dispose();
      scenePass.dispose();
    },
  };
}
