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
  vec3,
  vec4,
  float,
  max,
  mix,
  step,
  mrt,
  pass,
  output,
  diffuseColor,
  emissive,
  renderOutput,
  Fn,
} from 'three/tsl';
import { bloom } from 'three/addons/tsl/display/BloomNode.js';
import { BVHComputeData, ndcToCameraRay } from 'three-mesh-bvh/webgpu';
import { createBlueNoiseTexture, ditherOffset } from './bluenoise.js';
import { VolumetricPass, type VolStats } from './passes/volumetrics.js';
import { DEFAULT_BLEND, type PackedLightGrid } from '../world/light-grid.js';
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
  /**
   * true when a lightmap bake covers this light (backlog #9 rule 1): its
   * light already reaches STATIC pixels through lightmap.png, so the
   * surface-lighting kernel skips it there (no double-lighting) — while fog
   * shafts and DYNAMIC pixels (no lightmap coverage: players, anything
   * without TEXCOORD_1) keep using it from the same buffer. Rides the light
   * struct's free `le.w` slot (every existing reader uses le.xyz only).
   */
  baked?: boolean;
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
  /** runtime intensity multiplier for all lights (settings slider) — marks the frame dirty */
  setLightGain(value: number): void;
  /** replace the light list (future chunk-streaming) — rebuilds the storage buffer, never truncates */
  setLights(lights: RtLight[]): void;
  /** true while the frame is FROZEN: nothing has changed and the settle window is
   *  done, so no rays run and the composite re-shows the accumulated buffers */
  readonly idle: boolean;
  /** something outside the tracked state changed (a light moved, a chunk streamed
   *  in, a material edit) → the next frame is traced even with a still camera */
  markDirty(): void;
  /** fog-march counters (phase 1b): dispatches must stay 0 while
   *  settings.volumetrics is off — scripts/rt-vol-smoke.mjs asserts this */
  readonly volStats: VolStats;
  dispose(): void;
}

/**
 * PHASE 1 — ADVANCED (RAYTRACED) RENDER PATH — WebGPU only.
 *
 *   1. compute pass at settings.lightingScale resolution:
 *        primary camera ray   -> ndcToCameraRay + bvh_RaycastFirstHit
 *        direct lighting      -> next-event estimation over the emissive light
 *                                list, occlusion via bvh_RaycastAnyHit shadow rays
 *                                + per-material GGX specular (roughness comes
 *                                from the BVH vertex attributes — the compute
 *                                runs BEFORE the raster pass, so the G-buffer
 *                                cannot feed it; the lobe rides its own buffer
 *                                because the composite multiplies the lighting
 *                                buffer by diffuse albedo)
 *        one bounce           -> cosine-hemisphere ray, shaded at the hit
 *                                point (diffuse only — specScale 0). For a DYNAMIC pixel
 *                                (no TEXCOORD_1) the world light-cell grid replaces this
 *                                ray when the map shipped a grid file: 8 gated corner
 *                                cells, no ray and no jitter to accumulate. No grid file
 *                                = the ray stays.
 *        + hemisphere ambient                               -> storage texture
 *   1b. volumetrics (phase 1b): while settings.volumetrics && !?rtdebug && !?rtmat,
 *        a fog march at settings.volumetricScale over geomTex + the light list
 *        (passes/volumetrics.ts) — OFF = release() + the plain composite,
 *        which carries no fog code at all
 *   2. raster pass -> MRT { output(beauty), diffuse(albedo), emissive }
 *   3. composite: baked lightmap + diffuse * lighting + emissive + specular
 *      (gloss and the baked term masked on emissive pixels — their primary
 *      ray passes through the fixture), selected vs beauty by flag,
 *      fog-composited (beauty·T + S) when volumetrics ran -> bloom ->
 *      tone mapping (outputColorTransform). With a lightmap present the NEE
 *      loop skips baked lights on lightmap-covered pixels (rule: no
 *      double-lighting) and ?rtdebug=3 shows realtime-dynamic-only.
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
  /** decoded static bake — when present, static pixels get it from here and
   *  the NEE loop skips `baked` lights on them (backlog #9 rule 1) */
  lightmap?: { texture: THREE.Texture },
  /** decoded light-cell grid file (assets/map/lightgrid.bin) — when present, a
   *  dynamic surface reads its light from the cell it stands in instead of casting a
   *  bounce ray. Absent = the world has no grid file and keeps the old one-bounce path. */
  lightgrid?: PackedLightGrid,
  /** playable-floor anchor (world Y) for the fog height falloff — the
   *  spawn probe's ground; see VolDeps.floorY */
  fogFloorY?: number,
): AdvancedRenderer {
  // ---- BVH first: kernel deps reference its fns ------------------------------
  // Per-hit MATERIAL data. The lighting compute runs BEFORE the raster pass
  // (pipeline calls dispatch() then render()), so it cannot sample the
  // G-buffer — but it already interpolates the hit's vertex attributes via
  // bvh_sampleTrianglePoint. Roughness is uniform per material, so bake it
  // into a 1-float vertex attribute: every primary hit then carries its
  // material's gloss with zero extra rays and zero extra texture reads
  // (multi-material meshes fill per geometry group; a geometry shared with a
  // mesh of a different material gets its own clone).
  // uv1 (glTF TEXCOORD_1, the lightmap atlas) rides the SAME mechanism for
  // the same reason: the compute pass runs before the raster pass, so the
  // lightmap lookup must come from the primary hit's interpolated vertex
  // data, not from a G-buffer. Declared vec4f (UV in .xy) because the GPU
  // packer writes each struct member at memberIndex*4 floats — only 16-byte
  // members line up (position, normal are vec4f; roughness lands at float 8;
  // uv1 at 12). Geometries without TEXCOORD_1 get the -1 sentinel from
  // getDefaultAttributeValue = "no lightmap coverage" = dynamic surface.
  const roughnessOf = (m: THREE.Material): number => {
    const r = (m as THREE.MeshStandardMaterial).roughness;
    return typeof r === 'number' && Number.isFinite(r) ? Math.min(1, Math.max(0, r)) : 1;
  };
  const prepareRoughness = (mesh: THREE.Mesh): void => {
    const mat = mesh.material;
    const geo = mesh.geometry;
    if (geo.userData.rtRoughMat === mat && geo.getAttribute('roughness')) return;
    let target = geo;
    if (geo.getAttribute('roughness')) {
      target = geo.clone(); // shared geometry, different material — own copy
      mesh.geometry = target;
    }
    const count = target.getAttribute('position').count;
    const data = new Float32Array(count);
    if (Array.isArray(mat)) {
      data.fill(mat.length ? roughnessOf(mat[0]) : 1);
      for (const g of target.groups) {
        const m = (g.materialIndex !== undefined ? mat[g.materialIndex] : undefined) ?? mat[0];
        data.fill(m ? roughnessOf(m) : 1, g.start, g.start + g.count);
      }
    } else {
      data.fill(roughnessOf(mat));
    }
    target.setAttribute('roughness', new THREE.BufferAttribute(data, 1));
    target.userData.rtRoughMat = mat;
  };
  for (const mesh of bvhMeshes) prepareRoughness(mesh);

  const bvhData = new BVHComputeData(bvhMeshes, {
    attributes: { position: 'vec4f', normal: 'vec4f', roughness: 'float', uv1: 'vec4f' },
  });
  // Safety net for the attribute above: a geometry missing `roughness` packs
  // the library default (0 = perfect mirror) — override it to 1 (fully
  // diffuse) so any packing gap degrades to today's look, never to a mirror.
  // `uv1` missing (no TEXCOORD_1 = not covered by the bake) packs the
  // dynamic-surface sentinel (-1) so the kernel never samples the atlas at a
  // surface the bake does not cover.
  const defaultAttr = (
    bvhData as unknown as { getDefaultAttributeValue: (k: string, t: THREE.Vector4) => THREE.Vector4 }
  ).getDefaultAttributeValue.bind(bvhData);
  (bvhData as unknown as { getDefaultAttributeValue: (k: string, t: THREE.Vector4) => THREE.Vector4 }).getDefaultAttributeValue =
    (key, target) =>
      key === 'roughness'
        ? target.set(1, 0, 0, 0)
        : key === 'uv1'
          ? target.set(-1, -1, 0, 0)
          : defaultAttr(key, target);
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
  // per-pixel geometry guide for the à-trous denoise: primary-hit world normal
  // (view-facing) in .xyz, linear view-space depth in .w. MISS pixels carry
  // the sentinel -1 so the filter never averages across a silhouette.
  const geomTex = new THREE.StorageTexture(1, 1);
  geomTex.type = THREE.HalfFloatType;
  geomTex.format = THREE.RGBAFormat;
  geomTex.minFilter = THREE.NearestFilter;
  geomTex.magFilter = THREE.NearestFilter;
  // the SAME guide as it was LAST frame. Reprojection needs it for the
  // disocclusion check: a reprojected texel only counts as this surface's
  // history if last frame it held the same world point. Without that check the
  // blend reads a texel that belonged to a different wall — which is the
  // ghosting TAA is known for. Read only via textureLoad, hence Nearest.
  const geomHistoryTex = new THREE.StorageTexture(1, 1);
  geomHistoryTex.type = THREE.HalfFloatType;
  geomHistoryTex.format = THREE.RGBAFormat;
  geomHistoryTex.minFilter = THREE.NearestFilter;
  geomHistoryTex.magFilter = THREE.NearestFilter;
  // à-trous ping-pong buffers (only ever read via textureLoad, so Nearest is
  // fine for the passes; the composite samples the final one, hence Linear)
  const denoiseTexA = new THREE.StorageTexture(1, 1);
  denoiseTexA.type = THREE.HalfFloatType;
  denoiseTexA.format = THREE.RGBAFormat;
  denoiseTexA.minFilter = THREE.LinearFilter;
  denoiseTexA.magFilter = THREE.LinearFilter;
  const denoiseTexB = new THREE.StorageTexture(1, 1);
  denoiseTexB.type = THREE.HalfFloatType;
  denoiseTexB.format = THREE.RGBAFormat;
  denoiseTexB.minFilter = THREE.LinearFilter;
  denoiseTexB.magFilter = THREE.LinearFilter;
  // ---- SPECULAR (per-material gloss) buffers --------------------------------
  // The specular lobe must NOT ride in the lighting buffer's rgb: the
  // composite multiplies that by diffuse albedo, and a highlight is tinted by
  // the LIGHT, not the surface (nor can one alpha channel hold its colour).
  // So gloss gets its own temporally-blended + à-trous-filtered rgb triplet,
  // updated in lockstep with the diffuse lighting (same kernels, same
  // ping-pong parity, zero extra dispatches).
  const specTex = new THREE.StorageTexture(1, 1);
  specTex.type = THREE.HalfFloatType;
  specTex.format = THREE.RGBAFormat;
  specTex.minFilter = THREE.LinearFilter;
  specTex.magFilter = THREE.LinearFilter;
  const specHistoryTex = new THREE.StorageTexture(1, 1);
  specHistoryTex.type = THREE.HalfFloatType;
  specHistoryTex.format = THREE.RGBAFormat;
  specHistoryTex.minFilter = THREE.LinearFilter;
  specHistoryTex.magFilter = THREE.LinearFilter;
  const specDenoiseA = new THREE.StorageTexture(1, 1);
  specDenoiseA.type = THREE.HalfFloatType;
  specDenoiseA.format = THREE.RGBAFormat;
  specDenoiseA.minFilter = THREE.LinearFilter;
  specDenoiseA.magFilter = THREE.LinearFilter;
  const specDenoiseB = new THREE.StorageTexture(1, 1);
  specDenoiseB.type = THREE.HalfFloatType;
  specDenoiseB.format = THREE.RGBAFormat;
  specDenoiseB.minFilter = THREE.LinearFilter;
  specDenoiseB.magFilter = THREE.LinearFilter;

  // ---- BAKED LIGHTMAP (backlog #9) ------------------------------------------
  // The Cycles bake's outgoing radiance per primary hit — stored in its OWN
  // buffer, never in lightingTex: it is noise-free (no history, no à-trous)
  // and ?rtdebug=3 must stay honestly "realtime-dynamic-only". The composite
  // adds it AFTER the albedo multiply (the bake already contains albedo —
  // receipt: a black-diffuse plane bakes to 0).
  const bakedTex = new THREE.StorageTexture(1, 1);
  bakedTex.type = THREE.HalfFloatType;
  bakedTex.format = THREE.RGBAFormat;
  bakedTex.minFilter = THREE.LinearFilter;
  bakedTex.magFilter = THREE.LinearFilter;
  // placeholder keeps the binding valid on lightmap-less worlds (test room):
  // the kernel gates every read on hasLightmap, it is never sampled
  const lmTexture: THREE.Texture =
    lightmap?.texture ??
    new THREE.DataTexture(new Uint8Array([0, 0, 0, 255]), 1, 1, THREE.RGBAFormat, THREE.UnsignedByteType);
  if (!lightmap) lmTexture.needsUpdate = true;
  const lmImage = lmTexture.image as { width?: number; height?: number } | undefined;
  console.info(
    `[rt] lightmap ${lightmap ? `${lmImage?.width ?? '?'}x${lmImage?.height ?? '?'} half-float` : 'NONE (placeholder 1x1)'}` +
      ` — ${lights.filter((l) => l.baked).length}/${lights.length} baked lights, ` +
      `${lights.filter((l) => !l.baked).length} dynamic`,
  );

  // ---- uniforms -----------------------------------------------------------------
  const invViewProj = uniform(new THREE.Matrix4());
  /** same matrix invViewProj is built from — turns a primary hit into a
   *  view-space depth for the à-trous edge-stopping weights */
  const viewMat = uniform(new THREE.Matrix4());
  const frameIndex = uniform(0);
  const lightCount = uniform(lights.length);
  /** count of NON-baked lights — a baked pixel's bounce ray only ever sees
   *  these (static GI lives in the lightmap), so with none the ray itself is
   *  pure waste and the kernel skips it. Dynamic pixels still need the full
   *  set, hence a separate count from lightCount (which fog also shares). */
  const dynLightCount = uniform(lights.filter((l) => !l.baked).length);
  /** 1 = this world shipped a lightmap → sample it per hit, skip baked lights
   *  on lightmap-covered pixels */
  const hasLightmap = uniform(lightmap ? 1 : 0);
  const bounceCount = uniform(0);
  const debugMode = uniform(0);
  /** area-jittered surface samples on / legacy single-tap off — ?rtsoft=0 = A/B */
  const softShadow = uniform(new URLSearchParams(location.search).get('rtsoft') === '0' ? 0 : 1);
  /** ?rtnd=N — à-trous iterations, 0 = spatial denoise off (default 4) */
  const rtndRaw = new URLSearchParams(location.search).get('rtnd');
  const rtnd = rtndRaw !== null && /^[0-4]$/.test(rtndRaw) ? Number(rtndRaw) : 4;
  /** ?rtspec=0 — per-material specular OFF = the exact pre-gloss code path
   *  (diffuse math untouched, spec buffers stay zero) — the A/B baseline
   *  scripts/rt-mat-smoke.mjs measures "before" against */
  const specOn = uniform(new URLSearchParams(location.search).get('rtspec') === '0' ? 0 : 1);
  /** ?rtmat=1|2 — material inspection views (1 = diffuse/albedo G-buffer,
   *  2 = specular buffer): exact buffer values, no bloom/fog, for the
   *  grid readbacks in scripts/rt-mat-smoke.mjs */
  const matView = uniform(
    new URLSearchParams(location.search).get('rtmat') === '2'
      ? 2
      : new URLSearchParams(location.search).get('rtmat') === '1'
        ? 1
        : 0,
  );
  if (matView.value > 0) {
    console.info(
      `[rt] material view ${matView.value} — showing the ${matView.value === 1 ? 'diffuse/albedo G-buffer' : 'specular buffer'} raw (no lighting, no bloom, fog skipped)`,
    );
  }
  /** temporal blend: 1 = live frame (moving), <1 = accumulate */
  const blendAlpha = uniform(1);
  /** previous frame's camera (kept from the end of the previous dispatch). A
   *  hit point projected with THESE matrices gives the texel this same world
   *  point held last frame — that is motion reprojection, and it is what lets
   *  the accumulation keep converging while the player walks instead of
   *  resetting to a live frame every step. ?reproj=0 = the old hard reset. */
  const prevViewMat = uniform(new THREE.Matrix4());
  const prevViewProj = uniform(new THREE.Matrix4());
  const reproject = uniform(new URLSearchParams(location.search).get('reproj') === '0' ? 0 : 1);
  /** runtime intensity multiplier (settings slider) — multiplied in-shader */
  const lightGain = uniform(1);
  /** ?dither=0 — blue-noise ordered dither for the 8-bit display step (ON by
   *  default; the A/B baseline for scripts/banding-check.mjs on the runtime side).
   *  Off means off: the composite is built WITHOUT the lookup, so nothing runs. */
  const ditherOn = new URLSearchParams(location.search).get('dither') !== '0';
  const ditherTex = ditherOn ? createBlueNoiseTexture() : null;
  /** à-trous stride — mutated before EACH dispatch: three re-reads uniform
   *  values per compute call (objectGroup is NodeUpdateType.OBJECT, so the
   *  binding is re-serialised every time), and all four passes share this one
   *  uniform node so their generated shader — hence their pipeline — is
   *  identical. Values are set in dispatch(), never here. */
  const atrousStep = uniform(1);
  /** projection scale (P00, P11) — reconstructs view-space positions from
   *  (ndc, depth) inside the denoise kernel, which is what turns the depth
   *  test into a true tangent-plane distance instead of a naive Δz */
  const projScale = uniform(new THREE.Vector2(1, 1));
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
      // le.w = BAKED flag (slot was padding). Every existing reader of `le`
      // uses .xyz only — faceWeight, shadowVis, fogLightPoint — so the flag
      // reaches only the surface kernel's skip test, fog keeps iterating the
      // full list (light shafts from static fixtures must survive #9 rule 1)
      arr[o + 11] = l.baked ? 1 : 0;
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

  // ---- LIGHT CELLS (lighting-plan step 6) ------------------------------------
  // The decoded grid file, as two storage buffers referenced BY NAME from the raw WGSL —
  // the same mechanism as rt_lights (verified by scripts/rt-storage-probe.mjs):
  //   rt_grid     = the f32 slot table (SH_GRID_STRIDE_VEC4 vec4s per slot: key header +
  //                 nine SH vec4s, channel-major inside each term)
  //   rt_gridmask = the 27 neighbour-visibility bits per slot, so a pixel reads ONE bit
  //                 instead of casting a ray per corner
  // A world without the file keeps the old one-bounce ray: hasGrid gates every read, and
  // the placeholder keeps the binding valid (same rule as the lightmap placeholder).
  const gridAttr = new THREE.StorageBufferAttribute(lightgrid ? lightgrid.data : new Float32Array(1), 1);
  const gridMaskAttr = new THREE.StorageBufferAttribute(
    lightgrid ? lightgrid.neighbourMask : new Uint32Array(1), 1,
  );
  const gridNode = storage(gridAttr, 'float', 0).toReadOnly().setName('rt_grid');
  const gridMaskNode = storage(gridMaskAttr, 'uint', 0).toReadOnly().setName('rt_gridmask');
  const hasGrid = uniform(lightgrid ? 1 : 0);
  const gridCellSize = uniform(lightgrid?.cellSize ?? 0);
  // the shipped blend strength comes from the module the check measured, not a literal
  // copied into the shader — so a change there changes the picture
  const gridBlend = uniform(lightgrid?.blend ?? DEFAULT_BLEND);
  /** hash mask (slotCount - 1) as f32: u32() inside the kernel, no new node type */
  const gridSlotMask = uniform(lightgrid ? lightgrid.slotCount - 1 : 0);

  // ---- VOLUMETRICS (phase 1b) ------------------------------------------------
  // Owned and dispatched from HERE, not from pipeline.ts's passes[] graph:
  // the fog march needs geomTex (this file's G-buffer), the BVH and the light
  // storage list, and it composites inside the finalColor graph below — that
  // graph only exists on this WebGPU path. rt.ts gates it every frame:
  //   settings.volumetrics === false -> volPass.release() + the plain
  //   composite (no dispatch, no fog-sized texture, no-fog shader) — "off must
  //   cost nothing" (docs/render-pipeline.md quality-tiers rule).
  const volPass = new VolumetricPass({
    bvhData,
    geomTex,
    floorY: fogFloorY,
    lightsNode: () => lightsNode,
    invViewProj,
    viewMat,
    frameIndex,
    lightCount,
    softShadow,
    lightGain,
    workgroupSize,
    workgroupId,
    localId,
  });

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
      geomTex: texture_storage_2d<rgba16float, write>,
      specTex: texture_storage_2d<rgba16float, write>,
      bakedTex: texture_storage_2d<rgba16float, write>,
      historyTex: texture_2d<f32>,
      specHistory: texture_2d<f32>,
      geomHistory: texture_2d<f32>,
      blendAlpha: f32,
      invViewProj: mat4x4f,
      viewMat: mat4x4f,
      prevViewMat: mat4x4f,
      prevViewProj: mat4x4f,
      reproject: f32,
      frameIndex: f32,
      lightCount: f32,
      bounceCount: f32,
      debugMode: f32,
      softShadow: f32,
      lightGain: f32,
      specOn: f32,
      hasLightmap: f32,
      lightmapTex: texture_2d<f32>,
      dynLightCount: f32,
      hasGrid: f32,
      gridCellSize: f32,
      gridBlend: f32,
      gridSlotMask: f32,
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
        // no rays are traced here, so the geometry guide gets the MISS
        // sentinel: the à-trous pass passes such pixels through untouched and
        // the uv gradient is displayed exactly as written
        textureStore(geomTex, indexUV, vec4f(0.0, 0.0, 0.0, -1.0));
        textureStore(lightingTex, indexUV, vec4f(uv, 0.3, 1.0));
        textureStore(specTex, indexUV, vec4f(0.0, 0.0, 0.0, 1.0));
        textureStore(bakedTex, indexUV, vec4f(0.0, 0.0, 0.0, 1.0));
        return vec4f(0.0);
      }

      let ndc = uv * 2.0 - 1.0;
      var ray = ndcToCameraRay(ndc, invViewProj);

      var hit: IntersectionResult;
      bvh_RaycastFirstHit(ray, &hit);

      if (!hit.didHit) {
        // MISS sentinel (view depth -1): the spatial filter must never average
        // geometry into the void or the void into geometry — that is exactly
        // the silhouette bleed this guide exists to stop
        textureStore(geomTex, indexUV, vec4f(0.0, 0.0, 0.0, -1.0));
        // void has no surface to light — baked term is zero here too
        textureStore(bakedTex, indexUV, vec4f(0.0, 0.0, 0.0, 1.0));
        // debug2 promises "red = miss" (HUD + comment below) — paint it so
        // void/seam pixels are unmistakable instead of blending to black
        if (debugMode > 1.5 && debugMode < 2.5) {
          textureStore(lightingTex, indexUV, vec4f(1.0, 0.0, 0.0, 1.0));
          textureStore(specTex, indexUV, vec4f(0.0, 0.0, 0.0, 1.0));
          return vec4f(0.0);
        }
        let prevM = textureLoad(historyTex, indexUV, 0).rgb;
        let blendedM = mix(prevM, vec3f(0.0), blendAlpha);
        textureStore(lightingTex, indexUV, vec4f(blendedM, 1.0));
        // void has no surface to gloss — fade its specular history to zero
        // with the same temporal rule as the diffuse buffer
        let prevSM = textureLoad(specHistory, indexUV, 0).rgb;
        textureStore(specTex, indexUV, vec4f(mix(prevSM, vec3f(0.0), blendAlpha), 1.0));
        return vec4f(0.0);
      }

      var N = hit.normal;
      if (dot(N, -ray.direction) < 0.0) { N = -N; }
      // smooth shading: prefer INTERPOLATED vertex normals (Blender smooth
      // shading) when they agree with the face — flat triangle normals are
      // what makes lighting look stepped "per face". The SAME interpolation
      // call yields the hit's material roughness (baked per vertex in
      // prepareRoughness) — gloss for free, no extra fetch.
      let spt = bvh_sampleTrianglePoint(hit.barycoord, hit.indices.xyz);
      let hitRough = clamp(spt.roughness, 0.0, 1.0);
      let vN3 = spt.normal.xyz;
      if (dot(vN3, vN3) > 1e-6) {
        var sn = normalize(vN3);
        if (dot(sn, -ray.direction) < 0.0) { sn = -sn; }
        if (dot(sn, N) > 0.5) { N = sn; }
      }
      let hitP = ray.origin + ray.direction * hit.dist;
      // per-pixel geometry guide for the à-trous denoise: the same
      // view-facing normal shading uses, rotated into VIEW space, plus linear
      // view depth (positive in front of the camera). Written for every hit —
      // the spatial filter stops at whatever this texture says is an edge.
      let vp = viewMat * vec4f(hitP, 1.0);
      let vn = (viewMat * vec4f(N, 0.0)).xyz;
      textureStore(geomTex, indexUV, vec4f(vn, 0.0 - vp.z));
      let P = hitP + N * 0.04; // clears thin overlaps

      var acc = vec3f(0.0);
      // specular accumulates in its OWN buffer (see DirectLight): never
      // albedo-scaled, clamped once per frame so a mirror-like sample cannot
      // smear a white blob through the denoiser
      var spec = vec3f(0.0);
      let nLights = u32(lightCount + 0.5);

      // BAKED static lighting (backlog #9): the hit's TEXCOORD_1 (uv1 —
      // -1 sentinel = not covered by the bake) samples the decoded Cycles
      // lightmap. Outgoing radiance with albedo already inside, so the
      // composite adds it un-multiplied and NEVER through this buffer —
      // ?rtdebug=3 stays honestly "realtime-dynamic-only".
      // skipBaked: this pixel DISPLAYS its lightmap, so its realtime loops
      // must skip every baked light — that is the whole no-double-lighting
      // rule. A -1 hit (dynamic surface: players, animated) gets NO baked
      // term and the FULL light set instead.
      var baked = vec3f(0.0);
      var skipBaked = 0.0;
      if (hasLightmap > 0.5 && spt.uv1.x >= 0.0) {
        baked = sampleLightmap(lightmapTex, spt.uv1.xy);
        skipBaked = 1.0;
      }
      // A dynamic surface (uv1 = -1 sentinel) has nothing baked AT this pixel, so its static
      // light used to come from one bounce ray. With the world grid it reads the cell it
      // stands in instead: the same light as the wall next to it, from one hash plus 8
      // corner evaluations — no ray, and nothing to accumulate (the value is stable frame to
      // frame, so this path is the noise win the check measured). The cell content IS baked
      // static light, so rule #9-1 applies to this pixel too: the direct loop must skip
      // baked lights, and only DYNAMIC lights still add directly. The cell value is
      // irradiance with the SOURCE surface's albedo already inside, so the composite's
      // albedo multiply is what makes the moving object as bright as the wall beside it.
      // A world with no lightgrid.bin keeps the one-bounce ray.
      var cellStatic = 0.0;
      if (hasGrid > 0.5 && spt.uv1.x < 0.0) {
        skipBaked = 1.0;
        // ?rtdebug=3 promises "realtime-dynamic-only", and a cell is STATIC light read from
        // a file — so it is not added in that view, which falls back to the bounce ray
        // exactly as before. select(), not ?: (Tint rejects the ternary).
        cellStatic = select(1.0, 0.0, debugMode > 2.5 && debugMode < 3.5);
      }
      textureStore(bakedTex, indexUV, vec4f(baked, 1.0));

      if (debugMode > 1.5 && debugMode < 2.5) {
        // debug2: hit/miss colour SHADED by real shadow-ray visibility —
        // bright green = hit & lit · dark green = hit & IN SHADOW · red = miss.
        // max() (not sum) is INTENTIONAL — a binary "lit by ANY light" squeezed
        // into one green channel. Falls through to the temporal blend below:
        // one jittered sample per frame is noisy alone, a static camera
        // converges it (the old early-return skipped history, so the promised
        // accumulation never actually happened).
        // Iterates the FULL light set on purpose: this view diagnoses shadow
        // VISIBILITY of the world's lights, not the baked/realtime split
        // (the split's proof is ?rtdebug=3, which shows realtime-only).
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
        // accumulation converges it into a continuous penumbra). Baked lights
        // are skipped inside directLight when this pixel displays its lightmap.
        let V = -ray.direction; // surface → camera (primary ray), normalised
        for (var li = 0u; li < nLights; li++) {
          let lseed = jseed + vec2f(f32(li) * 17.31, f32(li) * 9.17);
          let dl = directLight(li, P, N, V, hitRough, 1.0, specOn, lseed, softShadow, lightGain, skipBaked);
          acc += dl.diffuse;
          spec += dl.specular;
        }

        // one bounce: cosine hemisphere ray, shade at the hit point.
        // The ray itself is skipped when its light loop would contribute
        // nothing: a baked pixel's bounce only ever sees DYNAMIC lights
        // (static GI is already in the lightmap), a dynamic pixel needs the
        // full set — its bounce may land on a static surface and must still
        // receive static light (nothing at THIS pixel is baked to double).
        // select(), not ?: — this Tint build rejects the ternary operator
        // ("invalid character found" at the '?', probe-verified).
        let bounceLights = select(nLights > 0u, dynLightCount > 0.5, skipBaked > 0.5);
        if (cellStatic > 0.5) {
          // the cell reading replaces this ray for dynamic pixels: no ray, no jitter, so
          // temporal accumulation has nothing to converge. Gate + weights exactly as the
          // CPU reference (scripts/light-grid-check.mjs) — see gridBlendIrradiance below.
          acc += gridBlendIrradiance(P, N, gridCellSize, gridBlend, u32(gridSlotMask));
        } else if (bounceCount > 0.5 && bounceLights) {
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
              // specScale = 0: the bounce is shaded as DIFFUSE radiance
              // (bacc/π below) — a specular lobe leaving the bounce point is
              // directional and would leak the wrong way through this term
              bacc += directLight(li, BP, BN, -dir, 1.0, 0.72, 0.0, lseed, softShadow, lightGain, skipBaked).diffuse;
            }
            // FIREFLY CLAMP: a bounce landing next to a light spikes 1/d² into
            // single white pixels — the "particles" in screenshots. Cap the
            // indirect term; direct pools stay bright (storage clamps at 1).
            acc += min(bacc / 3.14159265, vec3f(0.6));
          }
        }
      }

      // SPECULAR FIREFLY CLAMP: a smooth surface can mirror a near-field
      // sample into the thousands; one spike would smear into a white blob
      // through temporal + à-trous. AgX rolls anything ≥ ~16 to white, so the
      // cap only removes garbage — highlights stay tight and bright.
      spec = min(spec, vec3f(48.0));

      // temporal accumulation: blend with the PREVIOUS frame's result, which
      // historyTex holds as a sampled texture (written by the copy kernel
      // after this pass — one usage per pass, never read+write together).
      //
      // WHICH texel of the history? Without reprojection it was the one under
      // the same screen position — after a camera move that texel belongs to a
      // different wall, so the code hard-reset instead (blendAlpha = 1 whenever
      // the camera moved). That is exactly why walking looked noisy while
      // standing still converged. Reprojection projects THIS hit point with the
      // PREVIOUS camera and reads the texel that point held last frame: the same
      // surface's history, so accumulation keeps converging while the player
      // walks. That is the biggest noise win available, and it costs one matrix
      // multiply plus one texture read per pixel.
      var histUV = indexUV;
      var histOk = true;
      if (reproject > 0.5) {
        let clipPrev = prevViewProj * vec4f(hitP, 1.0);
        if (clipPrev.w > 0.0) {
          let ndcPrev = clipPrev.xyz / clipPrev.w;
          let pxPrev = (ndcPrev.xy * 0.5 + 0.5) * vec2f(dimensions);
          if (all(pxPrev >= vec2f(0.0)) && all(pxPrev < vec2f(dimensions))) {
            histUV = vec2u(floor(pxPrev));
            // Disocclusion check — this is what keeps reprojection from turning
            // into TAA ghosting. The projected texel only counts as THIS
            // surface's history if last frame it held the same world point.
            // geomHistory is that texel's geometry guide from last frame, so the
            // depth it stored is compared against the depth this point would
            // have had from last frame's camera. A mismatch (or the void
            // sentinel) means a different surface was there: this pixel starts
            // fresh instead of blending a wall that is no longer visible.
            let dPrev = 0.0 - (prevViewMat * vec4f(hitP, 1.0)).z;
            let hGeom = textureLoad(geomHistory, histUV, 0);
            if (hGeom.w < 0.0) { histOk = false; }
            else if (abs(hGeom.w - dPrev) > 0.15 + dPrev * 0.05) { histOk = false; }
          } else { histOk = false; }
        } else { histOk = false; }
      }
      // histOk false = this pixel has no trustworthy history → full reset, the
      // same decision the old code made for the whole frame on any movement.
      var aBlend = 1.0;
      if (histOk) { aBlend = blendAlpha; }
      let prev = textureLoad(historyTex, histUV, 0).rgb;
      let blended = mix(prev, acc, aBlend);
      textureStore(lightingTex, indexUV, vec4f(blended, 1.0));
      // specular history in lockstep (same rule, same texel — gloss and the
      // lighting around it must always be the same iteration's output)
      let prevS = textureLoad(specHistory, histUV, 0).rgb;
      textureStore(specTex, indexUV, vec4f(mix(prevS, spec, aBlend), 1.0));
      return vec4f(0.0);
    }

    // helpers AFTER compute — Tint accepts module-scope forward references
    // (verified by probe), and compute must stay first for three's parser.
    // (A struct declared BEFORE compute would break that parser: three's WGSL
    // function regex must match 'fn ...' at the very start of the source.)

    // Direct-light sample: diffuse irradiance (goes through the albedo
    // multiply in the composite) + specular radiance (must NOT — the
    // composite adds it un-multiplied, so a highlight keeps the light's
    // colour). One struct return because WGSL has no multi-value returns.
    struct DirectLight {
      diffuse: vec3f,
      specular: vec3f,
    }

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

    // Per-material specular lobe for direct NEE: Cook-Torrance
    //   f = π · D · F · G / (4 · NdotV · NdotL)
    // GGX (Trowbridge-Reitz) normal distribution, Schlick Fresnel with a
    // dielectric F0 = 0.04 (Blender/Principled default — gloss without
    // metalness; the scope here is colour + gloss only), Smith-style
    // Schlick-GGX geometry. The π factor matches this renderer's diffuse
    // convention: the composite does albedo × buffer (Lambert WITHOUT 1/π —
    // the light-power heuristic was tuned that way), so specular scales the
    // same way or it would read ~3× too dim next to diffuse.
    fn specularLobe(N: vec3f, V: vec3f, L: vec3f, rough: f32) -> f32 {
      let a = max(rough * rough, 0.0016); // α = roughness² (glTF), floored at 0.04
      let a2 = a * a;
      let H = normalize(V + L);
      let ndoth = max(dot(N, H), 0.0);
      let ndotv = max(dot(N, V), 1e-3);
      let ndotl = max(dot(N, L), 1e-3);
      // D — the lobe WIDTH IS the material gloss: smooth = tight bright dot,
      // rough = broad dim sheen (and rough ≥ 0.98 never gets here at all)
      let dDen = ndoth * ndoth * (a2 - 1.0) + 1.0;
      let D = a2 / (3.14159265 * dDen * dDen);
      // F — Schlick, F0 = 0.04, rising to 1 at grazing angles
      let F = 0.04 + 0.96 * pow(1.0 - max(dot(V, H), 0.0), 5.0);
      // G — Schlick-GGX geometry (k = α²/2), keeps grazing from exploding
      let k = a2 * 0.5;
      let G = (ndotl / max(ndotl + k * (1.0 - ndotl), 1e-4))
        * (ndotv / max(ndotv + k * (1.0 - ndotv), 1e-4));
      return 3.14159265 * D * F * G / max(4.0 * ndotv * ndotl, 1e-4);
    }

    fn directLight(
      li: u32,
      P: vec3f,
      N: vec3f,
      V: vec3f,
      rough: f32,
      albedoScale: f32,
      specScale: f32,
      seed: vec2f,
      soft: f32,
      gain: f32,
      skipBaked: f32,
    ) -> DirectLight {
      let b = li * 5u;
      let lp = rt_lights.value[b];
      let lc = rt_lights.value[b + 1u];
      let le = rt_lights.value[b + 2u];
      let ld = rt_lights.value[b + 3u];
      let lq = rt_lights.value[b + 4u];
      // NO DOUBLE-LIGHTING (backlog #9 rule 1): a baked light must not light
      // a pixel that is displaying its lightmap contribution. Skipped BEFORE
      // any ray work — the lightmap makes every static pixel cost 0 shadow
      // rays for the 4 baked fixtures (this is where "realtime renders only
      // the small dynamic pieces" becomes literal). le.w is the baked flag.
      if (skipBaked > 0.5 && le.w > 0.5) { return DirectLight(vec3f(0.0), vec3f(0.0)); }
      if (lp.w <= 0.0) { return DirectLight(vec3f(0.0), vec3f(0.0)); }
      // one-way cone: lights only the region the fixture POINTS at (Blender
      // prop cone_deg) — a clipped-through fixture stops lighting its outside
      if (ld.w > -0.5) {
        let toP = normalize(P - lp.xyz);
        if (dot(toP, ld.xyz) < ld.w) { return DirectLight(vec3f(0.0), vec3f(0.0)); }
      }
      let hasBox = max(le.x, max(le.y, le.z)) > 1e-4;
      let sv = shadowVis(lp, lc, le, lq, P, N, seed, soft);
      if (sv.w <= 0.0) { return DirectLight(vec3f(0.0), vec3f(0.0)); }
      // geometry from the SAMPLE for box lights (the sample IS the emitter),
      // from the centre for point lights (legacy behaviour preserved)
      let geom = select(lp.xyz, sv.xyz, hasBox);
      let toL = geom - P;
      let d2 = dot(toL, toL);
      let dist = sqrt(d2);
      if (dist < 1e-4) { return DirectLight(vec3f(0.0), vec3f(0.0)); }
      let L = toL / dist;
      // STRICT N*L (the near-field "spill" wrap that made circular lit patches
      // is gone — embedded fixtures are handled by sampling the mesh surface,
      // which is physically consistent)
      let ndotl = max(dot(N, L), 0.0);
      if (ndotl <= 0.0) { return DirectLight(vec3f(0.0), vec3f(0.0)); }
      var w = 1.0;
      if (hasBox) {
        w = faceWeight(lp, le, lq, sv.xyz, P, dist);
        if (w <= 0.0) { return DirectLight(vec3f(0.0), vec3f(0.0)); }
      }
      let diffuse = lc.rgb * (lp.w * gain * albedoScale * ndotl * w / max(d2, 0.25)) * sv.w;
      // Gloss: per-material only — rough ≥ 0.98 skips the lobe entirely (and
      // ?rtspec=0 skips it for every material = the pre-gloss baseline). The
      // same shadow sample and the same 1/d² term serve both lobes, so gloss
      // costs ALU, never a shadow ray.
      var specular = vec3f(0.0);
      if (specScale > 0.5 && rough < 0.98) {
        specular = lc.rgb
          * (lp.w * gain * albedoScale * w / max(d2, 0.25))
          * (specularLobe(N, V, L, rough) * ndotl * sv.w);
      }
      return DirectLight(diffuse, specular);
    }

    // Bilinear sample of the decoded lightmap (CPU RGBM → linear half-float).
    // textureLoad with manual filtering, NOT textureSample: a sampler would
    // have to be plumbed through wgslFn's param binding, and the data is
    // already linear (no colorspace transfer to reason about). Four taps cost
    // less than the rays the baked split removed. Clamped at the atlas border.
    fn sampleLightmap(tex: texture_2d<f32>, uv: vec2f) -> vec3f {
      let dims = vec2f(textureDimensions(tex));
      let p = uv * dims - 0.5;
      let i0 = vec2i(floor(p));
      let f = p - vec2f(i0);
      let maxI = max(vec2i(dims) - vec2i(1), vec2i(0));
      let lo = vec2i(0);
      let a = textureLoad(tex, clamp(i0, lo, maxI), 0).rgb;
      let b = textureLoad(tex, clamp(i0 + vec2i(1, 0), lo, maxI), 0).rgb;
      let c = textureLoad(tex, clamp(i0 + vec2i(0, 1), lo, maxI), 0).rgb;
      let d = textureLoad(tex, clamp(i0 + vec2i(1, 1), lo, maxI), 0).rgb;
      return mix(mix(a, b, f.x), mix(c, d, f.x), f.y);
    }

    // ---- LIGHT CELLS: the read path (mirrors src/world/light-grid.ts exactly) -----
    // Every number here is the same number the CPU reference was measured against, and
    // scripts/light-grid-check.mjs parses THIS block and asserts the mirror, because WebGPU
    // cannot run on the machine that wrote it — the picture side is checked on the owner's
    // hardware (docs/test-checklist-de.md, test 7). Tint rejects the ternary operator, so
    // every choice uses select(). Constants are written as plain decimal literals so the
    // check can read them out of the source.
    // Slot layout (packLightGrid): SH_GRID_STRIDE_VEC4 = 10 vec4 per slot = 40 floats —
    // key + occupied flag, then nine term vec4s (rgb + pad), CHANNEL-major inside a term.
    // Probe limit 64 and blend strength 0.25 are the declared rules; strength comes from
    // the uniform, so a change in the module changes the picture.

    // hash the same way the packer does. u32() is the wrapping two's-complement conversion
    // that matches "ix | 0" + ">>> 0" in JS, and u32 multiplication wraps at 32 bits like
    // Math.imul, so the CPU packer and this lookup cannot land on different slots.
    // Parentheses are REQUIRED when operators of different precedence are mixed (WGSL rule —
    // the parse on the owner's machine rejected the unparenthesised form). Same grouping the
    // JS reference uses, so the result cannot change.
    fn gridHash(ix: i32, iy: i32, iz: i32, hmask: u32) -> u32 {
      var h = ((bitcast<u32>(ix) * 73856093u) ^ (bitcast<u32>(iy) * 19349663u)) ^ (bitcast<u32>(iz) * 83492791u);
      h = h ^ (h >> 16u);
      h = h * 2146121005u;   // 0x7feb352d
      h = h ^ (h >> 15u);
      h = h * 2221713035u;   // 0x846ca68b
      h = h ^ (h >> 16u);
      return h & hmask;
    }

    // slot of one voxel key. -1 = empty slot (the chain ends there: a missing voxel is NOT
    // a wrong cell), -2 = probe limit reached, the declared stop condition instead of an
    // endless loop.
    fn gridSlotAt(ix: i32, iy: i32, iz: i32, hmask: u32) -> i32 {
      var slot = gridHash(ix, iy, iz, hmask);
      for (var step: u32 = 0u; step < 64u; step = step + 1u) {
        let base = slot * 40u;
        if (rt_grid.value[base + 3u] == 0.0) { return -1; }
        if (rt_grid.value[base] == f32(ix) && rt_grid.value[base + 1u] == f32(iy) &&
            rt_grid.value[base + 2u] == f32(iz)) { return i32(slot); }
        slot = (slot + 1u) & hmask;
      }
      return -2;
    }

    // cosine-lobe factor per band (Ramamoorthi): band 0 = pi, band 1 = 2pi/3, band 2 = pi/4.
    // Without the band factor this would evaluate RADIANCE, not irradiance — the factor is
    // what makes a cell comparable with the measured reference.
    fn gridLobe(k: u32) -> f32 {
      if (k == 0u) { return 3.141592653589793; }
      if (k < 4u) { return 2.0943951023931953; }
      return 0.7853981633974483;
    }

    // one orthonormal SH basis term at the surface normal, as an if-chain so each number
    // is literally the same literal as shBasis() in the module.
    fn gridBasis(k: u32, n: vec3f) -> f32 {
      let c1 = 0.4886029218335914;
      let c2 = 1.0925484305920792;
      if (k == 0u) { return 0.28209479177387814; }
      if (k == 1u) { return c1 * n.y; }
      if (k == 2u) { return c1 * n.z; }
      if (k == 3u) { return c1 * n.x; }
      if (k == 4u) { return c2 * n.x * n.y; }
      if (k == 5u) { return c2 * n.y * n.z; }
      if (k == 6u) { return 0.31539156525252005 * (3.0 * n.z * n.z - 1.0); }
      if (k == 7u) { return c2 * n.x * n.z; }
      return 0.5462742152960396 * (n.x * n.x - n.y * n.y);
    }

    // irradiance for a normal out of ONE slot, channel-major (base + k*4 + channel).
    fn gridSlotIrradiance(slot: i32, n: vec3f) -> vec3f {
      var e = vec3f(0.0);
      if (slot < 0) { return e; }
      let base = bitcast<u32>(slot) * 40u + 4u;
      for (var k = 0u; k < 9u; k = k + 1u) {
        let w = gridLobe(k) * gridBasis(k, n);
        e += vec3f(rt_grid.value[base + k * 4u], rt_grid.value[base + k * 4u + 1u],
                   rt_grid.value[base + k * 4u + 2u]) * w;
      }
      return e;
    }

    // irradiance from the 8 corner voxels around the point, gated by the load-time mask:
    // a corner this point cannot see never contributes — that is the rule that light cannot
    // come through a wall. Weights are renormalised over the corners that count, so a corner
    // inside a wall does not pull the value towards zero. Same order of operations as
    // packedBlend() + packedBlendIrradiance(): normalise, then mix with the own cell.
    fn gridBlendIrradiance(P: vec3f, n: vec3f, cs: f32, strength: f32, hmask: u32) -> vec3f {
      // one declaration per line: WGSL has no multi-assignment let (the parse on the owner's
      // machine rejected the comma form)
      let gx = floor(P.x / cs);
      let gy = floor(P.y / cs);
      let gz = floor(P.z / cs);
      let ix = i32(gx);
      let iy = i32(gy);
      let iz = i32(gz);
      let fx = gx - f32(ix);
      let fy = gy - f32(iy);
      let fz = gz - f32(iz);
      let own = gridSlotAt(ix, iy, iz, hmask);
      // no own cell → nothing gates, the CPU path uses an all-ones mask there
      var mask = 4294967295u;
      if (own >= 0) { mask = rt_gridmask.value[bitcast<u32>(own)]; }
      var acc = vec3f(0.0);
      var wsum = 0.0;
      for (var a: u32 = 0u; a < 2u; a = a + 1u) {
        for (var b: u32 = 0u; b < 2u; b = b + 1u) {
          for (var c: u32 = 0u; c < 2u; c = c + 1u) {
            let slot = gridSlotAt(ix + i32(a), iy + i32(b), iz + i32(c), hmask);
            if (slot < 0) { continue; }   // corner not in the table (solid or unlit air)
            // neighbourBit(a,b,c) — a bit read, not a ray cast
            if ((mask & (1u << ((a + 1u) * 9u + (b + 1u) * 3u + (c + 1u)))) == 0u) { continue; }
            let wx = select(fx, 1.0 - fx, a == 0u);
            let wy = select(fy, 1.0 - fy, b == 0u);
            let wz = select(fz, 1.0 - fz, c == 0u);
            let w = wx * wy * wz;
            acc += gridSlotIrradiance(slot, n) * w;
            wsum += w;
          }
        }
      }
      var blended = vec3f(0.0);
      if (wsum > 0.0) { blended = acc / wsum; }
      if (strength >= 1.0 || own < 0) { return blended; }
      let ownE = gridSlotIrradiance(own, n);
      return ownE * (1.0 - strength) + blended * strength;
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
    geomTex: textureStore(geomTex),
    specTex: textureStore(specTex),
    bakedTex: textureStore(bakedTex),
    historyTex: texture(historyTex),
    specHistory: texture(specHistoryTex),
    geomHistory: texture(geomHistoryTex),
    blendAlpha,
    invViewProj,
    viewMat,
    prevViewMat,
    prevViewProj,
    reproject,
    frameIndex,
    lightCount,
    bounceCount,
    debugMode,
    softShadow,
    lightGain,
    specOn,
    hasLightmap,
    lightmapTex: texture(lmTexture),
    dynLightCount,
    hasGrid,
    gridCellSize,
    gridBlend,
    gridSlotMask,
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
      // the two grid storage buffers, same mechanism (rt_grid / rt_gridmask)
      gridNode,
      gridMaskNode,
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
      srcSpec: texture_2d<f32>,
      dstSpec: texture_storage_2d<rgba16float, write>,
      srcGeom: texture_2d<f32>,
      dstGeom: texture_storage_2d<rgba16float, write>,
      workgroupSize: vec3u,
      workgroupId: vec3u,
      localId: vec3u,
    ) -> vec4f {
      let dimensions = textureDimensions(src);
      let indexUV = workgroupSize.xy * workgroupId.xy + localId.xy;
      if (indexUV.x >= dimensions.x || indexUV.y >= dimensions.y) { return vec4f(0.0); }
      textureStore(dst, indexUV, textureLoad(src, indexUV, 0));
      // specular history follows the diffuse one in the SAME dispatch —
      // gloss must converge (still camera) and reset (motion) identically
      textureStore(dstSpec, indexUV, textureLoad(srcSpec, indexUV, 0));
      // the geometry guide too, so next frame can check which world point this
      // texel actually held (see the disocclusion test in compute)
      textureStore(dstGeom, indexUV, textureLoad(srcGeom, indexUV, 0));
      return vec4f(0.0);
    }
  `;
  const copyFn = wgslFn(copySource, [] as never);
  const copyNode = copyFn({
    src: texture(lightingTex),
    dst: textureStore(historyTex),
    srcSpec: texture(specTex),
    dstSpec: textureStore(specHistoryTex),
    srcGeom: texture(geomTex),
    dstGeom: textureStore(geomHistoryTex),
    workgroupSize,
    workgroupId,
    localId,
  }).computeKernel([WORKGROUP, WORKGROUP, 1]) as KernelNode;

  // ---- À-TROUS EDGE-AWARE DENOISE (SVGF-lite) ------------------------------
  // Spatial pass over the temporally-blended lighting buffer: four dispatches
  // at strides 1,2,4,8, ping-ponging A/B (never read+write the same texture in
  // one usage scope — same rule as lightingTex/historyTex above). The
  // edge-stopping weights come from geomTex (primary-hit view normal + view
  // depth), so noise averages away ON a surface while bright light can never
  // cross a silhouette or a corner — which is exactly what the depth-blind
  // 5-tap cross in the composite used to do.
  //
  // No luminance term on purpose: luminance variance IS the noise we are
  // removing, so weighting by it would preserve the very speckle this pass
  // exists to kill. Geometry edges are what made corners glow.
  const denoiseSource = /* wgsl */ `
    fn denoise(
      src: texture_2d<f32>,
      geom: texture_2d<f32>,
      dst: texture_storage_2d<rgba16float, write>,
      srcSpec: texture_2d<f32>,
      dstSpec: texture_storage_2d<rgba16float, write>,
      stride: f32,
      projScale: vec2f,
      workgroupSize: vec3u,
      workgroupId: vec3u,
      localId: vec3u,
    ) -> vec4f {
      let dimensions = textureDimensions(src);
      let indexUV = workgroupSize.xy * workgroupId.xy + localId.xy;
      if (indexUV.x >= dimensions.x || indexUV.y >= dimensions.y) { return vec4f(0.0); }

      let g0 = textureLoad(geom, indexUV, 0);
      let c0 = textureLoad(src, indexUV, 0);
      // specular rides the SAME edge-aware weights (same surface = same
      // gloss): a highlight denoises exactly like the light around it
      let s0 = textureLoad(srcSpec, indexUV, 0);
      // MISS sentinel (view depth < 0): void keeps its own value — averaging
      // a lit neighbour into the background (or the reverse) is precisely the
      // silhouette bleed this pass exists to prevent
      if (g0.w < 0.0) {
        textureStore(dst, indexUV, c0);
        textureStore(dstSpec, indexUV, s0);
        return vec4f(0.0);
      }

      let dims = vec2f(dimensions);
      let uv0 = (vec2f(indexUV) + vec2f(0.5)) / dims;
      let ndc0 = uv0 * 2.0 - 1.0;
      let z0 = g0.w;
      let n0 = g0.xyz;
      // view-space position of the centre tap: for a pinhole camera
      // x = ndc.x * z / P00, y = ndc.y * z / P11, z_view = -z
      let p0 = vec3f(ndc0.x * z0 / projScale.x, ndc0.y * z0 / projScale.y, 0.0 - z0);

      let s = i32(stride);
      // B3-spline kernel: centre 4, axis 2, corner 1 (sums to 16), then
      // renormalised by whatever survives the edge-stopping weights below
      var acc = c0.rgb * 4.0;
      var sacc = s0.rgb * 4.0;
      var wsum = 4.0;
      for (var j = -1; j <= 1; j++) {
        for (var i = -1; i <= 1; i++) {
          if (i == 0 && j == 0) { continue; }
          let p = vec2i(i32(indexUV.x), i32(indexUV.y)) + vec2i(i * s, j * s);
          if (p.x < 0 || p.y < 0 || p.x >= i32(dimensions.x) || p.y >= i32(dimensions.y)) { continue; }
          let g1 = textureLoad(geom, p, 0);
          if (g1.w < 0.0) { continue; }   // void neighbour: no weight
          let c1 = textureLoad(src, p, 0);
          let s1 = textureLoad(srcSpec, p, 0);

          let uv1 = (vec2f(p) + vec2f(0.5)) / dims;
          let ndc1 = uv1 * 2.0 - 1.0;
          let z1 = g1.w;
          let p1 = vec3f(ndc1.x * z1 / projScale.x, ndc1.y * z1 / projScale.y, 0.0 - z1);

          // normal similarity: a 90° corner stops dead, smooth shading passes
          let nd = clamp(dot(n0, g1.xyz), 0.0, 1.0);
          let wn = pow(max(nd, 1e-6), 32.0);
          // depth: distance from the centre's tangent PLANE. Zero on a slanted
          // surface at ANY stride (so grazing floors still filter), metres
          // across a silhouette (so light never crosses it)
          let dz = abs(dot(n0, p1 - p0));
          let wz = exp(-dz / (0.01 * z0 + 1e-4));
          // axis taps weigh 2, corners 1
          let kw = select(1.0, 2.0, i == 0 || j == 0);
          let w = kw * wn * wz;
          acc += c1.rgb * w;
          sacc += s1.rgb * w;
          wsum += w;
        }
      }
      textureStore(dst, indexUV, vec4f(acc / max(wsum, 1e-6), c0.a));
      textureStore(dstSpec, indexUV, vec4f(sacc / max(wsum, 1e-6), 1.0));
      return vec4f(0.0);
    }
  `;
  const denoiseFn = wgslFn(denoiseSource, [] as never);
  /** stride values for iterations 0..3 — set on the shared uniform right
   *  before each dispatch so all four nodes compile to ONE shader */
  const DENOISE_STEPS = [1, 2, 4, 8];
  const mkDenoise = (
    src: THREE.Texture,
    dst: THREE.StorageTexture,
    specSrc: THREE.Texture,
    specDst: THREE.StorageTexture,
  ) =>
    denoiseFn({
      src: texture(src),
      geom: texture(geomTex),
      dst: textureStore(dst),
      srcSpec: texture(specSrc),
      dstSpec: textureStore(specDst),
      stride: atrousStep,
      projScale,
      workgroupSize,
      workgroupId,
      localId,
    }).computeKernel([WORKGROUP, WORKGROUP, 1]) as KernelNode;
  // ping-pong: lightingTex → A → B → A → B ; after k passes the result sits
  // in A for odd k, B for even k (k = 0 means "no spatial pass at all").
  // The specular twins follow the SAME parity so gloss and the diffuse
  // lighting around it are always the same iteration's output.
  const denoiseNodes = [
    mkDenoise(lightingTex, denoiseTexA, specTex, specDenoiseA),
    mkDenoise(denoiseTexA, denoiseTexB, specDenoiseA, specDenoiseB),
    mkDenoise(denoiseTexB, denoiseTexA, specDenoiseB, specDenoiseA),
    mkDenoise(denoiseTexA, denoiseTexB, specDenoiseA, specDenoiseB),
  ];
  const denoiseOut: THREE.Texture =
    rtnd === 0 ? lightingTex : rtnd % 2 === 1 ? denoiseTexA : denoiseTexB;
  const specOut: THREE.Texture =
    rtnd === 0 ? specTex : rtnd % 2 === 1 ? specDenoiseA : specDenoiseB;

  // ---- composite + bloom ------------------------------------------------------------
  const rtFlag = uniform(0);

  const makeFinalColor = (fog: boolean) =>
    Fn(() => {
      const beauty = scenePass.getTextureNode('output');
      const diffuseN = scenePass.getTextureNode('diffuse');
      const emissiveN = scenePass.getTextureNode('emissive');
      // Storage writes use indexUV (row 0 = TOP in WebGPU) while screenUV is
      // y-up — sample the lighting buffer flipped or the entire lighting image
      // mirrors vertically ("stairs on the ceiling"). Diffuse/emissive come
      // from render targets sampled with screenUV natively and must NOT flip.
      const lightingUv = screenUV.mul(vec2(1.0, -1.0)).add(vec2(0.0, 1.0));
      // The OLD code averaged a depth-blind 5-tap cross here (0.4 centre + 4 ×
      // 0.15 diagonal). It killed shimmer, but it happily dragged bright light
      // across silhouettes and into corners — the "light goes through objects"
      // artefact. The à-trous pass does that job now, guided by geomTex, so the
      // composite just picks a buffer:
      //   rtFlag 1 → traced: albedo × DENOISED lighting + emissive (emissive is
      //              added here raw, never filtered — it is noise-free by
      //              construction)
      //   rtFlag 2 → buffer view for ?rtdebug=1|2 (denoised; for debug1 the geom
      //              guide is all-sentinel so the pass is a no-op anyway)
      //   rtFlag 3 → buffer view for ?rtdebug=3: RAW temporal buffer, undenoised
      //              — the raw-lighting diagnostic must stay honest
      const rawN = texture(lightingTex, lightingUv);
      const denN = texture(denoiseOut, lightingUv);
      const bufferN = mix(denN, rawN, step(2.5, rtFlag));
      // specular buffer (per-material gloss), denoised in lockstep: mixed the
      // same way so ?rtdebug=3 stays RAW — including its raw specular, which
      // is lighting too
      const specRawN = texture(specTex, lightingUv);
      const specDenN = texture(specOut, lightingUv);
      const specN = mix(specDenN, specRawN, step(2.5, rtFlag));
      // BAKED lightmap, its own buffer (noise-free, no history): added AFTER
      // the albedo multiply because the Cycles Combined bake stores OUTGOING
      // radiance — albedo is already inside (receipt: black diffuse bakes 0).
      // Scaled by lightGain so the slider keeps meaning "brightness of all
      // light". Never in lightingTex — hence ?rtdebug=3 = realtime-dynamic-only.
      const bakedN = texture(bakedTex, lightingUv);
      const lit = diffuseN.mul(denN).add(emissiveN);
      // Gloss is added UN-multiplied by albedo (a highlight is tinted by the
      // light, not the wall) — but masked on EMISSIVE pixels: the primary ray
      // passes straight through a fixture (fixtures are excluded from the
      // BVH), so the spec computed there belongs to the hidden wall behind it
      // and must not glow on top of the fixture's own emission. The baked
      // term gets the same mask for the same reason.
      const emMask = vec3(1.0, 1.0, 1.0).sub(emissiveN.rgb.clamp(0.0, 1.0));
      const beautyRgb = bakedN.rgb.mul(lightGain).mul(emMask)
        .add(lit.rgb)
        .add(specN.rgb.mul(emMask));
      // Volumetrics composites over the FINAL image (denoised lighting ×
      // albedo + emissive + gloss) so fixtures get hazed too (reference/
      // vibe.png): premultiplied fog — final = beauty·T + S, rgb only, beauty
      // alpha kept. Gloss therefore hazes with everything else — no special
      // case, same composite order.
      // Built into the fog composite ONLY: render() picks the plain graph
      // whenever the toggle/debug/material view is off, so that shader
      // carries no fog code at all ("off must cost nothing").
      // Buffer views (rtFlag ≥ 2) never reach this branch — ?rtdebug=3 raw
      // stays raw even with the toggle on.
      const fogN = fog ? texture(volPass.fogTexture, lightingUv) : null;
      const traced = fogN
        ? vec4(beautyRgb.mul(fogN.a).add(fogN.rgb), lit.a)
        : vec4(beautyRgb, lit.a);
      const rtColor = mix(beauty, traced, step(0.5, rtFlag));
      const bufferShown = vec4(bufferN.rgb.add(specN.rgb), 1.0);
      const shown = mix(rtColor, bufferShown, step(1.5, rtFlag));
      // ?rtdebug=4 — the baked lightmap buffer raw (bake consumption check)
      const shownBaked = mix(shown, vec4(bakedN.rgb, 1.0), step(3.5, rtFlag));
      // ?rtmat=1|2 — material inspection views: EXACT buffer values (albedo /
      // specular), no bloom, no fog — the grid readbacks in rt-mat-smoke.mjs
      // measure these directly
      const matShown = mix(
        vec4(diffuseN.rgb, 1.0),
        vec4(specN.rgb, 1.0),
        step(1.5, matView),
      );
      const viewShown = mix(shownBaked, matShown, step(0.5, matView));
      const bloomed = viewShown.add(bloom(viewShown, 0.5, 0.5, 0.75));
      const normalView = mix(bloomed, viewShown, step(0.5, matView));
      // Tone mapping + sRGB happen HERE (buildPost sets outputColorTransform =
      // false) because the dither must be applied at the moment the value becomes
      // 8-bit. On linear radiance a 1/255 offset is the wrong size, and darks —
      // precisely where banding shows — are where the curve stretches values.
      const disp = renderOutput(normalView);
      if (!ditherTex) return disp;
      // Debug (2/3/4) and material views stay EXACT: scripts/*-smoke.mjs compare
      // canvas readbacks against expected buffer values, so no offset there.
      // rtFlag 0 (beauty) and 1 (traced beauty) ARE the normal picture and DO
      // get the dither — that is the whole point of it.
      const gate = float(1.0).sub(max(step(1.5, rtFlag), step(0.5, matView)));
      const off = ditherOffset(ditherTex);
      return vec4(disp.rgb.add(vec3(gate.mul(off))), disp.a);
    })();

  // TWO composites built once at construction: the plain graph carries the
  // whole frame (albedo/lighting/emissive/gloss + bloom, but no fog code —
  // toggle off → no fog cost, no rebuild churn on toggling), the fog graph
  // adds `beauty·T + S`. Tier changes never rebuild either — volumetricScale
  // only resizes the fog TEXTURE inside the pass.
  const buildPost = (fog: boolean): THREE.RenderPipeline => {
    const p = new THREE.RenderPipeline(renderer);
    // each build includes bloom over the normal branches (the ?rtmat
    // inspection views mix it out — they show exact buffer values)
    // tone mapping + sRGB now happen INSIDE the graph (makeFinalColor calls
    // renderOutput) so the dither can be applied at the 8-bit step — this flag
    // is what three requires for that, see RenderOutputNode's docstring.
    p.outputColorTransform = false;
    p.outputNode = makeFinalColor(fog);
    return p;
  };
  const postPlain = buildPost(false);
  const postFog = buildPost(true);
  /** true only on frames where the fog march actually ran → render() picks
   *  postFog; every other frame (toggle off, ?rtdebug, RT idle) runs postPlain */
  let volActive = false;

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

  // ---- dirty-flag scheduler (why a settled frame needs no rays) --------------
  // Everything the lighting kernel reads is either static (BVH, lightmap, light
  // list) or per-frame (camera pose, jitter seed). When nothing changed AND the
  // settle window is done, the buffers already hold the picture the eye was shown:
  // the same rays would return the same answer, so the dispatch is skipped and the
  // composite re-shows the frozen buffers. That is where the frame budget comes
  // back for a laptop — and the picture is not a single-sample frame, it is the
  // settle-window average. Honest limit: blendAlpha 0.08 needs ~1/0.08 = 12
  // effective samples before the history dominates, so 6 frames is PARTIAL
  // convergence. SETTLE_FRAMES is therefore the quality knob (raise it for cleaner
  // dark gradients, give up the freeze), not a free win.
  // The composite still runs every frame: the canvas is not guaranteed to keep
  // its content, and the screenshot + black-frame paths read it back.
  /** ?settle=N — frames allowed after a change before the frame freezes.
   *  Default 6 (the window the owner said is acceptable); 0 = never freeze, which
   *  is the always-dispatch A/B baseline and what the readback scripts pin. */
  const settleRaw = Number(new URLSearchParams(location.search).get('settle'));
  const SETTLE_FRAMES = Number.isFinite(settleRaw) && settleRaw >= 0 ? settleRaw : 6;
  /** ?idle=0 — never freeze (dispatch every frame), for the A/B comparison */
  const idleFreeze = new URLSearchParams(location.search).get('idle') !== '0';
  let settleLeft = SETTLE_FRAMES;
  let dirty = true;
  let lastSettingsKey = '';
  /** true once a dispatch has produced buffers. An idle frame re-shows them, so
   *  rtFlag must NOT be forced to 0 — 0 means "show the raster beauty pass",
   *  which would replace the accumulated frame with an unlit one. */
  let buffersValid = false;

  /** settings the shader path depends on, as a comparable key. Compared per
   *  frame: a change is a dirty event, everything else costs nothing. */
  const settingsKey = (s: QualitySettings): string =>
    [
      s.renderScale,
      s.lightingScale,
      s.volumetricScale,
      s.rtBounces,
      s.bloom ? 1 : 0,
      s.raytracedLighting ? 1 : 0,
      s.volumetrics ? 1 : 0,
    ].join('|');

  const resizeTex = (scale: number): void => {
    const w = Math.max(1, Math.ceil(logicalW * scale));
    const h = Math.max(1, Math.ceil(logicalH * scale));
    if (w !== texW || h !== texH) {
      texW = w;
      texH = h;
      lightingTex.setSize(w, h, 1);
      historyTex.setSize(w, h, 1);
      geomTex.setSize(w, h, 1);
      geomHistoryTex.setSize(w, h, 1);
      bakedTex.setSize(w, h, 1);
      denoiseTexA.setSize(w, h, 1);
      denoiseTexB.setSize(w, h, 1);
      specTex.setSize(w, h, 1);
      specHistoryTex.setSize(w, h, 1);
      specDenoiseA.setSize(w, h, 1);
      specDenoiseB.setSize(w, h, 1);
      // a resize invalidates every buffer, so this frame is always dispatched
      historyReset = true;
      dirty = true;
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
        volActive = false;
        return;
      }

      // ---- what would change this frame's picture? ------------------------
      const key = settingsKey(settings);
      if (key !== lastSettingsKey) { lastSettingsKey = key; dirty = true; }
      // history holds the PREVIOUS debug mode's output after a switch — reset
      // on any change (0<->N and N<->M) so modes never smear into each other
      const debugNow = debugMode.value;
      if (lastDebug !== debugNow) { historyReset = true; dirty = true; }
      lastDebug = debugNow;
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
      if (moved) dirty = true;
      resizeTex(settings.lightingScale * pixelRatio);

      if (dirty) {
        dirty = false;
        settleLeft = SETTLE_FRAMES;
      } else if (idleFreeze && settleLeft <= 0) {
        // Frozen: the buffers already hold the converged frame and nothing can
        // change it this frame, so no ray work. volActive and rtFlag keep their
        // last values, which is what makes render() show the SAME picture.
        return;
      } else {
        settleLeft -= 1;
      }

      // ---- temporal accumulation control ------------------------------------
      // standing still = accumulate (the reliable noise cure); moving used to
      // mean a hard reset every frame, which is why walking looked noisy. With
      // reprojection each pixel's history is matched to the same world point,
      // so accumulation continues while walking — only the pixels where the
      // match fails (disocclusion) reset, one at a time.
      if (historyReset) {
        blendAlpha.value = 1;
        historyReset = false;
      } else {
        blendAlpha.value = moved
          ? (reproject.value > 0.5 ? 0.12 : 1)
          : 0.08;
      }

      // lights live in the storage buffer (rebuilt only by setLights) — no
      // per-frame upload; lightGain multiplies in-shader so the slider stays
      // live without touching the buffer

      frame++;
      volActive = false;   // only a frame that actually ran can show fog      // Camera matrices are only refreshed by renderer.render(), which runs
      // AFTER this dispatch (inside advanced.render()). Reading them here
      // would use LAST frame's pose while the raster G-buffer — drawn a
      // moment later by render() — uses the current one, i.e. RT lighting
      // offset from geometry by exactly one frame of camera motion: light
      // spilling past edges / through objects whenever the player moves.
      // Refresh first so invViewProj and viewMat describe the pose the
      // G-buffer is actually drawn with. No-op when the camera is still.
      cam.updateMatrixWorld();
      invViewProj.value.multiplyMatrices(cam.projectionMatrix, cam.matrixWorldInverse).invert();
      // same matrix, same moment as invViewProj → the geometry guide lines up
      // with the rays that produced lightingTex exactly
      viewMat.value.copy(cam.matrixWorldInverse);
      projScale.value.set(cam.projectionMatrix.elements[0], cam.projectionMatrix.elements[5]);
      frameIndex.value = frame % 1024;
      bounceCount.value = settings.rtBounces >= 1 ? 1 : 0;

      const gx = Math.ceil(texW / WORKGROUP);
      const gy = Math.ceil(texH / WORKGROUP);
      kernelNode ??= buildKernel();
      renderer.compute(kernelNode, [gx, gy, 1]);
      // history := current frame (separate pass = separate bindings) — and it
      // must stay the PRE-denoise temporal result, otherwise the à-trous blur
      // would feed back into history and compound every frame
      renderer.compute(copyNode, [gx, gy, 1]);
      // spatial à-trous AFTER the temporal blend, BEFORE the composite:
      // temporal → spatial → composite. Each iteration is its own pass (a pass
      // may not read a texture it writes), and the shared atrousStep uniform
      // is re-uploaded per dispatch.
      if (rtnd > 0) {
        for (let i = 0; i < rtnd; i++) {
          atrousStep.value = DENOISE_STEPS[i];
          renderer.compute(denoiseNodes[i], [gx, gy, 1]);
        }
      }

      // ---- volumetrics (phase 1b) ------------------------------------------
      // The sacred toggle: volumetrics OFF (enabled() = settings.volumetrics)
      // releases the fog buffers (back to 1×1 — no texture cost) and
      // dispatches NOTHING; render() then picks postPlain, the no-fog graph.
      // Debug views skip the march too: rtdebug=1|2|3
      // are raw buffer diagnostics and fog must never tint them (the
      // raw-buffer view in particular stays honestly raw). Material
      // inspection views (?rtmat=1|2) are raw-buffer reads as well.
      if (!volPass.enabled(settings)) {
        volPass.release();
      } else if (debugMode.value < 0.5 && matView.value < 0.5) {
        volPass.dispatch(renderer, {
          logicalW,
          logicalH,
          scale: settings.volumetricScale * pixelRatio,
          // same temporal rule as the lighting pass: still = converge
          // (the per-frame dither averages into smooth fog), moving = live
          blendAlpha: blendAlpha.value,
        });
        volActive = true;
      }
      ranThisFrame = true;
      // rtFlag: 0 = beauty · 1 = traced (albedo × DENOISED lighting + baked lightmap + emissive)
      //         · 2 = buffer view (?rtdebug=1|2) · 3 = RAW buffer view
      //         (?rtdebug=3 — REALTIME-DYNAMIC-ONLY: the raw temporal lighting
      //         buffer, undenoised, and (with a lightmap) deliberately without
      //         the baked static light — that lives in its own buffer and is
      //         added only in the traced composite).
      //         · 4 = the BAKED lightmap buffer (?rtdebug=4 — bake-consumption
      //         diagnostic: what the lightmap term contributes, pre-gain,
      //         no albedo/emissive/gloss applied on top)
      // Buffer view rather than traced, because the traced path multiplies by
      // the gbuffer diffuse — and void/seam pixels have zero diffuse (MRT
      // clear), which multiplied the debug "red = miss" to black, hiding
      // exactly the holes it exists to show.
      rtFlag.value =
        debugMode.value > 3.5 ? 4 : debugMode.value > 2.5 ? 3 : debugMode.value > 0.5 ? 2 : 1;
      // Next frame's reprojection reference = THIS frame's pose, stored after the
      // kernel ran (the kernel read last frame's values this frame). geomHistory
      // is written by the copy pass in the same order, so history texel and the
      // pose it belongs to always describe the same frame.
      prevViewMat.value.copy(viewMat.value);
      prevViewProj.value.copy(invViewProj.value);
      buffersValid = true;
    },
    render(): void {
      // An idle (frozen) frame must keep rtFlag: 0 means "show the raster beauty
      // pass", which would replace the accumulated frame with an unlit one.
      if (!ranThisFrame && !buffersValid) rtFlag.value = 0;
      // fog marched this frame → fog composite; otherwise the plain graph,
      // which contains no fog code at all (toggle off / debug / material
      // views cost exactly what no-fog costs)
      (volActive ? postFog : postPlain).render();
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
      dirty = true;
    },
    setLights(next: RtLight[]): void {
      dirty = true;
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
        dynLightCount.value = next.filter((l) => !l.baked).length;
        return;
      }
      lightsNode = makeLightsNode(next);
      lightCount.value = next.length;
      dynLightCount.value = next.filter((l) => !l.baked).length;
      kernelNode = undefined; // rebuilt lazily on the next dispatch
      volPass.invalidate(); // the fog kernel indexes rt_lights at module scope
    },
    get idle(): boolean {
      return idleFreeze && buffersValid && settleLeft <= 0 && !dirty;
    },
    markDirty(): void {
      // A change outside the tracked state invalidates the accumulated history
      // too: what the buffers hold was lit by the PREVIOUS state.
      dirty = true;
      historyReset = true;
    },
    volStats: volPass.stats,
    dispose(): void {
      postPlain.dispose();
      postFog.dispose();
      volPass.dispose();
      lightingTex.dispose();
      historyTex.dispose();
      geomTex.dispose();
      geomHistoryTex.dispose();
      bakedTex.dispose();
      denoiseTexB.dispose();
      specTex.dispose();
      specHistoryTex.dispose();
      specDenoiseA.dispose();
      specDenoiseB.dispose();
      ditherTex?.dispose();
      scenePass.dispose();
    },
  };
}
