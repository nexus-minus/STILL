import * as THREE from 'three/webgpu';
import {
  uniform,
  wgslFn,
  textureStore,
  texture,
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

const MAX_LIGHTS = 12;
const WORKGROUP = 8;

function lightDist2(light: RtLight, cam: THREE.PerspectiveCamera): number {
  const dx = light.position[0] - cam.position.x;
  const dy = light.position[1] - cam.position.y;
  const dz = light.position[2] - cam.position.z;
  return dx * dx + dy * dy + dz * dz;
}

export interface RtLight {
  /** world position (center of the emissive surface) */
  position: [number, number, number];
  /** linear RGB color */
  color: [number, number, number];
  /** radiometric power — feeds 1/d² falloff */
  power: number;
  /** half of the fixture's largest dimension — near-field spill radius + self-hit margin */
  halfSize: number;
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
 *  - lights are individual uniform vec4 params (proven example pattern), not
 *    uniformArray inside raw WGSL (unproven combination);
 *  - never throws to the caller: main() catches construction failures and
 *    degrades to the standard path with a player-visible message.
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
  const lightCount = uniform(Math.min(lights.length, MAX_LIGHTS));
  const bounceCount = uniform(0);
  const debugMode = uniform(0);
  /** temporal blend: 1 = live frame (moving/debug), <1 = accumulate */
  const blendAlpha = uniform(1);
  /** runtime intensity multiplier (settings slider) — applied at light upload */
  const lightGain = uniform(1);
  // Precomputed4-tap offsets: TSL miscompiles unary minus on swizzle
  // components inside vec2(...) (it emitted literal NaN.0 into WGSL and broke
  // every fragment pipeline) — no node arithmetic, just four uniforms.
  const tapNE = uniform(new THREE.Vector2(1, 1));
  const tapSW = uniform(new THREE.Vector2(-1, -1));
  const tapSE = uniform(new THREE.Vector2(1, -1));
  const tapNW = uniform(new THREE.Vector2(-1, 1));
  const workgroupSize = uniform(new THREE.Vector3(WORKGROUP, WORKGROUP, 1));

  const lightPos = Array.from({ length: MAX_LIGHTS }, (_, i) => {
    const l = lights[i];
    return uniform(
      new THREE.Vector4(l ? l.position[0] : 0, l ? l.position[1] : 0, l ? l.position[2] : 0, l ? l.power : 0),
    );
  });
  const lightCol = Array.from({ length: MAX_LIGHTS }, (_, i) => {
    const l = lights[i];
    // w = fixture half-size (self-hit margin + near-field spill radius)
    return uniform(new THREE.Vector4(l ? l.color[0] : 0, l ? l.color[1] : 0, l ? l.color[2] : 0, l ? l.halfSize : 0));
  });
  // cone gate: xyz = emitting direction, w = cos(half-angle); w < -0.5 = omni
  const lightDir = Array.from({ length: MAX_LIGHTS }, (_, i) => {
    const l = lights[i];
    const hasCone = !!l?.direction && l.coneCos !== undefined;
    return uniform(
      new THREE.Vector4(
        hasCone ? l!.direction![0] : 0,
        hasCone ? l!.direction![1] : 0,
        hasCone ? l!.direction![2] : 0,
        hasCone ? l!.coneCos! : -1,
      ),
    );
  });

  // full emissive-light pool (a real map easily exceeds the 12 uniform slots) —
  // the nearest 12 to the camera are uploaded each frame; fixed slots keep the
  // WGSL bindings stable.
  const lightPool = lights;
  const nearestIdx = lights.map((_, i) => i);

  // ---- WGSL ------------------------------------------------------------------------
  const lightParams = Array.from(
    { length: MAX_LIGHTS },
    (_, i) => `l${i}: vec4f, c${i}: vec4f, d${i}: vec4f`,
  ).join(',\n      ');
  const shadowChain = Array.from(
    { length: MAX_LIGHTS },
    (_, i) => `if (lightCount > ${i + 0.5}) { acc += directLight(l${i}, c${i}, d${i}, P, N, 1.0); }`,
  ).join('\n      ');
  const bounceChain = Array.from(
    { length: MAX_LIGHTS },
    (_, i) => `if (lightCount > ${i + 0.5}) { bacc += directLight(l${i}, c${i}, d${i}, BP, BN, 0.72); }`,
  ).join('\n        ');

  // debug2 visibility chain: which of the active lights actually see this pixel
  const visChain = Array.from(
    { length: MAX_LIGHTS },
    (_, i) => `if (lightCount > ${i + 0.5}) { vis = max(vis, shadowFactor(l${i}, c${i}, d${i}, P, N)); }`,
  ).join('\n      ');

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
      workgroupSize: vec3u,
      ${lightParams},
      workgroupId: vec3u,
      localId: vec3u,
    ) -> vec4f {
      let dimensions = textureDimensions(lightingTex);
      let indexUV = workgroupSize.xy * workgroupId.xy + localId.xy;
      if (indexUV.x >= dimensions.x || indexUV.y >= dimensions.y) { return vec4f(0.0); }

      let uv = (vec2f(indexUV) + vec2f(0.5)) / vec2f(dimensions);

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

      // debug2: hit/miss colour SHADED by real shadow-ray visibility —
      // bright green = hit & lit · dark green = hit & IN SHADOW · red = miss
      if (debugMode > 1.5 && debugMode < 2.5) {
        var vis = 0.0;
        ${visChain}
        let base = vec4f(0.0, 1.0, 0.0, 1.0);
        let shade = 0.25 + 0.75 * vis;
        textureStore(lightingTex, indexUV, vec4f(base.rgb * shade, 1.0));
        return vec4f(0.0);
      }

      // hemisphere ambient so nothing is pitch black — modulated by RAYTRACED
      // AO (one short jittered ray up the normal): without this the ambient
      // ignores geometry and every corner reads flat/wrong
      var aor: Ray;
      aor.origin = P;
      let jseed = uv * 91.7 + vec2f(frameIndex * 0.37, frameIndex * 0.73);
      let j1 = hash12(jseed) - 0.5;
      let j2 = hash12(jseed + vec2f(7.31, 2.17)) - 0.5;
      aor.direction = normalize(N + vec3f(j1, j2, j1 * j2) * 0.7);
      aor.maxDist = 0.6;
      var aoh: IntersectionResult;
      var ao = 1.0;
      if (bvh_RaycastFirstHit(aor, &aoh)) { ao = clamp(aoh.dist / 0.6, 0.0, 1.0); }
      var acc = mix(vec3f(0.012, 0.011, 0.010), vec3f(0.028, 0.027, 0.024), N.y * 0.5 + 0.5) * ao;

      // direct lighting: next-event estimation with traced shadow rays
      ${shadowChain}

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
          ${bounceChain}
          // FIREFLY CLAMP: a bounce landing next to a light spikes 1/d² into
          // single white pixels — the "particles" in screenshots. Cap the
          // indirect term; direct pools stay bright (storage clamps at 1).
          acc += min(bacc / 3.14159265, vec3f(0.6));
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

    fn directLight(lp: vec4f, lc: vec4f, ld: vec4f, P: vec3f, N: vec3f, albedoScale: f32) -> vec3f {
      if (lp.w <= 0.0) { return vec3f(0.0); }
      // one-way cone: lights only the region the fixture POINTS at (Blender
      // prop cone_deg) — a clipped-through fixture stops lighting its outside
      if (ld.w > -0.5) {
        let toP = normalize(P - lp.xyz);
        if (dot(toP, ld.xyz) < ld.w) { return vec3f(0.0); }
      }
      let toL = lp.xyz - P;
      let d2 = dot(toL, toL);
      let dist = sqrt(d2);
      let L = toL / dist;
      // STRICT N*L (the near-field "spill" wrap that made circular lit patches
      // is gone — embedded fixtures are handled by nudging the analytic light
      // into the open room at load, which is physically consistent)
      let ndotl = max(dot(N, L), 0.0);
      if (ndotl <= 0.0) { return vec3f(0.0); }
      var sray: Ray;
      sray.origin = P;
      sray.direction = L;
      sray.maxDist = max(dist - 0.08, 0.001);
      var sh: IntersectionResult;
      // small numerical epsilon only (0.05) — the big0.25 caused edge leaks
      if (bvh_RaycastFirstHit(sray, &sh) && sh.dist > 0.02) { return vec3f(0.0); }
      return lc.rgb * (lp.w * albedoScale * ndotl / max(d2, 0.25));
    }

    // pure visibility term for debug mode: 1 = lit by this light, 0 = shadowed
    fn shadowFactor(lp: vec4f, lc: vec4f, ld: vec4f, P: vec3f, N: vec3f) -> f32 {
      if (lp.w <= 0.0) { return 0.0; }
      if (ld.w > -0.5) {
        let toP = normalize(P - lp.xyz);
        if (dot(toP, ld.xyz) < ld.w) { return 0.0; }
      }
      let toL = lp.xyz - P;
      let d2 = dot(toL, toL);
      let dist = sqrt(d2);
      let L = toL / dist;
      if (max(dot(N, L), 0.0) <= 0.0) { return 0.0; }
      var sray: Ray;
      sray.origin = P;
      sray.direction = L;
      sray.maxDist = max(dist - 0.08, 0.001);
      var sh: IntersectionResult;
      if (bvh_RaycastFirstHit(sray, &sh) && sh.dist > 0.02) { return 0.0; }
      return 1.0;
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
    workgroupSize,
    workgroupId,
    localId,
    ...Object.fromEntries(lightPos.map((u, i) => [`l${i}`, u])),
    ...Object.fromEntries(lightCol.map((u, i) => [`c${i}`, u])),
    ...Object.fromEntries(lightDir.map((u, i) => [`d${i}`, u])),
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
    return shown.add(bloom(shown, 0.5, 0.5, 0.75));
  })();

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
      if (lastDebug > 0 && debugNow === 0) historyReset = true; // stale after debug
      lastDebug = debugNow;
      if (historyReset) {
        blendAlpha.value = 1;
        historyReset = false;
      } else {
        blendAlpha.value = debugNow > 0 || moved ? 1 : 0.08;
      }

      // refill lights every frame (cheap; lets the intensity gain apply live);
      // nearest-12 when the pool outgrows the uniform slots
      if (lightPool.length > MAX_LIGHTS) {
        nearestIdx.sort(
          (a, b) => lightDist2(lightPool[a], cam) - lightDist2(lightPool[b], cam),
        );
      }
      const count = Math.min(lightPool.length, MAX_LIGHTS);
      for (let i = 0; i < MAX_LIGHTS; i++) {
        const use = i < count;
        const light = lightPool[lightPool.length > MAX_LIGHTS ? nearestIdx[i] : i];
        lightPos[i].value.set(
          use ? light.position[0] : 0,
          use ? light.position[1] : 0,
          use ? light.position[2] : 0,
          use ? light.power * lightGain.value : 0,
        );
        lightCol[i].value.set(
          use ? light.color[0] : 0,
          use ? light.color[1] : 0,
          use ? light.color[2] : 0,
          use ? light.halfSize : 0,
        );
        const hasCone = use && !!light.direction && light.coneCos !== undefined;
        lightDir[i].value.set(
          hasCone ? light.direction![0] : 0,
          hasCone ? light.direction![1] : 0,
          hasCone ? light.direction![2] : 0,
          hasCone ? light.coneCos! : -1,
        );
      }
      lightCount.value = count;

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
      rtFlag.value = debugMode.value > 2.5 ? 2 : 1;
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
    dispose(): void {
      postPipeline.dispose();
      lightingTex.dispose();
      historyTex.dispose();
      scenePass.dispose();
    },
  };
}
