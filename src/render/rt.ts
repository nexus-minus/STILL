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
  mix,
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
  collisionMeshes: THREE.Mesh[],
  lights: RtLight[],
): AdvancedRenderer {
  // ---- BVH first: kernel deps reference its fns ------------------------------
  const bvhData = new BVHComputeData(collisionMeshes, {
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

  // ---- lighting storage texture (rgba8unorm — matches three's default) --------
  const lightingTex = new THREE.StorageTexture(1, 1);

  // ---- uniforms -----------------------------------------------------------------
  const invViewProj = uniform(new THREE.Matrix4());
  const frameIndex = uniform(0);
  const lightCount = uniform(Math.min(lights.length, MAX_LIGHTS));
  const bounceCount = uniform(0);
  const debugMode = uniform(0);
  const workgroupSize = uniform(new THREE.Vector3(WORKGROUP, WORKGROUP, 1));

  const lightPos = Array.from({ length: MAX_LIGHTS }, (_, i) => {
    const l = lights[i];
    return uniform(
      new THREE.Vector4(l ? l.position[0] : 0, l ? l.position[1] : 0, l ? l.position[2] : 0, l ? l.power : 0),
    );
  });
  const lightCol = Array.from({ length: MAX_LIGHTS }, (_, i) => {
    const l = lights[i];
    return uniform(new THREE.Vector4(l ? l.color[0] : 0, l ? l.color[1] : 0, l ? l.color[2] : 0, 0));
  });

  // full emissive-light pool (a real map easily exceeds the 12 uniform slots) —
  // the nearest 12 to the camera are uploaded each frame; fixed slots keep the
  // WGSL bindings stable.
  const lightPool = lights;
  const nearestIdx = lights.map((_, i) => i);
  const staticPool = lights.length <= MAX_LIGHTS;

  // ---- WGSL ------------------------------------------------------------------------
  const lightParams = Array.from({ length: MAX_LIGHTS }, (_, i) => `l${i}: vec4f, c${i}: vec4f`).join(',\n      ');
  const shadowChain = Array.from(
    { length: MAX_LIGHTS },
    (_, i) => `if (lightCount > ${i + 0.5}) { acc += directLight(l${i}, c${i}, P, N, 1.0); }`,
  ).join('\n      ');
  const bounceChain = Array.from(
    { length: MAX_LIGHTS },
    (_, i) => `if (lightCount > ${i + 0.5}) { bacc += directLight(l${i}, c${i}, BP, BN, 0.72); }`,
  ).join('\n        ');

  // debug2 visibility chain: which of the active lights actually see this pixel
  const visChain = Array.from(
    { length: MAX_LIGHTS },
    (_, i) => `if (lightCount > ${i + 0.5}) { vis = max(vis, shadowFactor(l${i}, P, N)); }`,
  ).join('\n      ');

  const kernelSource = /* wgsl */ `
    // compute MUST be the first function: three parses the FIRST fn for the
    // signature it binds and calls THAT name from its generated main. It also
    // requires a return identifier (regex) — but Tint rejects '-> void', so we
    // return vec4f and let the caller discard it (Tint-verified accepted).
    fn compute(
      lightingTex: texture_storage_2d<rgba8unorm, write>,
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
        textureStore(lightingTex, indexUV, vec4f(0.0, 0.0, 0.0, 1.0));
        return vec4f(0.0);
      }

      var N = hit.normal;
      if (dot(N, -ray.direction) < 0.0) { N = -N; }
      let P = ray.origin + ray.direction * hit.dist + N * 0.012;

      // debug2: hit/miss colour SHADED by real shadow-ray visibility —
      // bright green = hit & lit · dark green = hit & IN SHADOW · red = miss
      if (debugMode > 1.5) {
        var vis = 0.0;
        ${visChain}
        let base = vec4f(0.0, 1.0, 0.0, 1.0);
        let shade = 0.25 + 0.75 * vis;
        textureStore(lightingTex, indexUV, vec4f(base.rgb * shade, 1.0));
        return vec4f(0.0);
      }

      // hemisphere ambient so nothing is pitch black
      var acc = mix(vec3f(0.028, 0.026, 0.022), vec3f(0.06, 0.058, 0.052), N.y * 0.5 + 0.5);

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
          let BP = bray.origin + dir * bhit.dist + BN * 0.012;
          var bacc = vec3f(0.0);
          ${bounceChain}
          acc += bacc / 3.14159265;
        }
      }

      textureStore(lightingTex, indexUV, vec4f(acc, 1.0));
      return vec4f(0.0);
    }

    // helpers AFTER compute — Tint accepts module-scope forward references
    // (verified by probe), and compute must stay first for three's parser.
    fn hash12(coordinate: vec2f) -> f32 {
      var h3 = fract(vec3f(coordinate.xyx) * 0.1031);
      h3 += dot(h3, h3.yzx + 33.33);
      return fract((h3.x + h3.y) * h3.z);
    }

    fn directLight(lp: vec4f, lc: vec4f, P: vec3f, N: vec3f, albedoScale: f32) -> vec3f {
      if (lp.w <= 0.0) { return vec3f(0.0); }
      let toL = lp.xyz - P;
      let d2 = dot(toL, toL);
      let dist = sqrt(d2);
      let L = toL / dist;
      let ndotl = max(dot(N, L), 0.0);
      if (ndotl <= 0.0) { return vec3f(0.0); }
      var sray: Ray;
      sray.origin = P;
      sray.direction = L;
      sray.maxDist = max(dist - 0.08, 0.001);
      if (bvh_RaycastAnyHit(sray)) { return vec3f(0.0); }
      return lc.rgb * (lp.w * albedoScale * ndotl / max(d2, 0.25));
    }

    // pure visibility term for debug mode: 1 = lit by this light, 0 = shadowed
    fn shadowFactor(lp: vec4f, P: vec3f, N: vec3f) -> f32 {
      if (lp.w <= 0.0) { return 0.0; }
      let toL = lp.xyz - P;
      let d2 = dot(toL, toL);
      let dist = sqrt(d2);
      let L = toL / dist;
      if (max(dot(N, L), 0.0) <= 0.0) { return 0.0; }
      var sray: Ray;
      sray.origin = P;
      sray.direction = L;
      sray.maxDist = max(dist - 0.08, 0.001);
      if (bvh_RaycastAnyHit(sray)) { return 0.0; }
      return 1.0;
    }
  `;

  const computeFn = wgslFn(kernelSource, [
    ndcToCameraRay,
    bvhData.fns.raycastFirstHit,
    bvhData.fns.raycastAnyHit,
  ] as never);

  const params = {
    lightingTex: textureStore(lightingTex),
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
  };

  const kernelNode = computeFn(params).computeKernel([WORKGROUP, WORKGROUP, 1]);

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
    const lightingN = texture(lightingTex, lightingUv);
    const traced = diffuseN.mul(lightingN).add(emissiveN);
    return mix(beauty, traced, rtFlag);
  })();

  const postPipeline = new THREE.RenderPipeline(renderer);
  postPipeline.outputNode = finalColor.add(bloom(finalColor, 0.5, 0.5, 0.75));

  // ---- state -------------------------------------------------------------------------
  let logicalW = 1;
  let logicalH = 1;
  let texW = 1;
  let texH = 1;
  let frame = 0;
  let ranThisFrame = false;

  const resizeTex = (scale: number): void => {
    const w = Math.max(1, Math.ceil(logicalW * scale));
    const h = Math.max(1, Math.ceil(logicalH * scale));
    if (w !== texW || h !== texH) {
      texW = w;
      texH = h;
      lightingTex.setSize(w, h, 1);
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

      // nearest-12 light upload when the pool outgrows the uniform slots
      if (!staticPool) {
        nearestIdx.sort(
          (a, b) => lightDist2(lightPool[a], cam) - lightDist2(lightPool[b], cam),
        );
        for (let i = 0; i < MAX_LIGHTS; i++) {
          const light = lightPool[nearestIdx[i]];
          lightPos[i].value.set(light.position[0], light.position[1], light.position[2], light.power);
          lightCol[i].value.set(light.color[0], light.color[1], light.color[2], 0);
        }
      }
      lightCount.value = Math.min(lightPool.length, MAX_LIGHTS);

      frame++;
      invViewProj.value.multiplyMatrices(cam.projectionMatrix, cam.matrixWorldInverse).invert();
      frameIndex.value = frame % 1024;
      bounceCount.value = settings.rtBounces >= 1 ? 1 : 0;

      renderer.compute(kernelNode, [
        Math.ceil(texW / WORKGROUP),
        Math.ceil(texH / WORKGROUP),
        1,
      ]);
      ranThisFrame = true;
      rtFlag.value = 1;
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
    dispose(): void {
      postPipeline.dispose();
      lightingTex.dispose();
      scenePass.dispose();
    },
  };
}
