import * as THREE from 'three/webgpu';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { DRACOLoader } from 'three/addons/loaders/DRACOLoader.js';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { RectAreaLightNode, WebGPURenderer } from 'three/webgpu';
import { RectAreaLightTexturesLib } from 'three/addons/lights/RectAreaLightTexturesLib.js';
import { WebGPUPathTracer } from 'three-gpu-pathtracer/webgpu';
import { GradientEquirectTexture } from 'three-gpu-pathtracer';
import { GenerateMeshBVHWorker } from 'three-mesh-bvh/worker';
import { getLights as getPathTracerLights } from 'three-gpu-pathtracer/src/core/utils/sceneUpdateUtils.js';

const $ = <T extends HTMLElement>(id: string): T => document.getElementById(id) as T;
const status = $('status');

async function main(): Promise<void> {
  if (!('gpu' in navigator)) {
    throw new Error('WebGPU is unavailable in this browser. Open this page in Chromium.');
  }

  const adapter = await navigator.gpu.requestAdapter();
  if (!adapter) throw new Error('WebGPU found no adapter.');

  const renderer = new WebGPURenderer({ antialias: false, trackTimestamp: true });
  renderer.toneMapping = THREE.AgXToneMapping;
  renderer.toneMappingExposure = 1;
  await renderer.init();
  $('view').appendChild(renderer.domElement);

  // RectAreaLightNode is for the ordinary raster preview while the path
  // tracer builds; path tracing uses its own exact rectangle-light sampler.
  RectAreaLightTexturesLib.init();
  RectAreaLightNode.setLTC(RectAreaLightTexturesLib.init());

  const params = new URLSearchParams(location.search);
  const scene = new THREE.Scene();
  // ?bg=green makes missed camera rays obvious: a green wall of background
  // means the tracer's BVH never sees the map mesh.
  scene.background = params.get('bg') === 'green'
    ? new THREE.Color(0x00ff00)
    : new THREE.Color(0x080808);
  // Diagnostic knobs (all optional, default = original behaviour):
  //   ?env=N      environment intensity (default 0.35)
  //   ?lscale=N   multiply every area-light intensity (default 1)
  //   ?flip=1     aim each area light's +Z at the room instead of -Z
  const envIntensity = Number(params.get('env') ?? 0.35);
  // The exported fixtures are physically dim (radiance ~5 over 0.19 m²), which
  // AgX maps to pure black at exposure 1. Scale radiance so the comparison is
  // readable; ?lscale overrides, the gain slider fine-tunes on top.
  const lightScale = Number(params.get('lscale') ?? 400);
  const flipLights = params.has('flip');
  // A dim HDR world fill, like a Blender World shader. This is both the
  // physically correct environment light path tracers need and a readable
  // baseline for surfaces outside direct area-light illumination.
  const environment = new GradientEquirectTexture(64);
  environment.topColor.set(0x555b66);
  environment.bottomColor.set(0x181a20);
  environment.update();
  scene.environment = environment;
  scene.environmentIntensity = envIntensity;
  const camera = new THREE.PerspectiveCamera(76, innerWidth / innerHeight, 0.03, 600);
  scene.add(new THREE.AmbientLight(0xffffff, 0.25)); // raster preview only

  const manifest = await fetch('map/manifest.json').then((r) => {
    if (!r.ok) throw new Error(`map/manifest.json returned HTTP ${r.status}`);
    return r.json();
  });
  const objectFile = manifest.collections?.objects?.file;
  if (!objectFile) throw new Error('manifest has no objects.glb');

  const draco = new DRACOLoader();
  draco.setDecoderPath('draco/');
  const gltf = await new GLTFLoader().setDRACOLoader(draco).loadAsync(`map/${objectFile}`);
  draco.dispose();
  scene.add(gltf.scene);
  scene.updateMatrixWorld(true);
  const bounds = new THREE.Box3().setFromObject(gltf.scene);

  // Start at the game's known walkable spawn, not the AABB centre. The map
  // includes distant light fixtures, so its bounds centre can be empty space.
  const viewer = new THREE.Vector3(-6.3, -7.5, -30.7);
  // The production spawn currently faces a close solid wall on -Z; aim toward
  // the nearby strip emitter for the lighting comparison rather than staring
  // into that unlit back face.
  const lookAt = viewer.clone().add(new THREE.Vector3(0, 0, 8));
  camera.position.copy(viewer);
  camera.lookAt(lookAt);
  camera.updateProjectionMatrix();

  // Replace emissive mesh light approximations with actual RectAreaLights.
  // The RectAreaLight is the source AND visible panel. The original emissive
  // meshes must be removed from the path-tracer BVH: after disabling their
  // emission they would be black occluders directly in front of each area
  // light, blocking every sampled shadow ray.
  const emitters: Array<{ light: THREE.RectAreaLight; base: number }> = [];
  const emitterMeshes: THREE.Mesh[] = [];
  const receiverMaterials: THREE.MeshStandardMaterial[] = [];
  scene.traverse((obj) => {
    const mesh = obj as THREE.Mesh;
    if (!mesh.isMesh) return;
    const materials = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
    const emissiveMat = materials.find((m) => {
      const mat = m as THREE.MeshStandardMaterial;
      return mat.emissive && mat.emissiveIntensity > 0 &&
        Math.max(mat.emissive.r, mat.emissive.g, mat.emissive.b) > 0.001;
    }) as THREE.MeshStandardMaterial | undefined;
    if (!emissiveMat) {
      // The path-tracer comparison is testing light transport, not material
      // translation. Use a known-good neutral PBR material so unsupported
      // Blender node setups cannot make the whole diagnostic scene black.
      mesh.geometry.computeVertexNormals();
      const neutral = new THREE.MeshStandardMaterial({
        color: 0x8b8580,
        roughness: 0.9,
        metalness: 0,
        side: THREE.DoubleSide,
      });
      mesh.material = neutral;
      receiverMaterials.push(neutral);
      return;
    }

    mesh.updateWorldMatrix(true, false);
    const localBox = mesh.geometry.boundingBox ?? new THREE.Box3().setFromBufferAttribute(
      mesh.geometry.attributes.position as THREE.BufferAttribute,
    );
    const localSize = localBox.getSize(new THREE.Vector3());
    const objectScale = [mesh.scale.x, mesh.scale.y, mesh.scale.z];
    const dims = [
      localSize.x * objectScale[0],
      localSize.y * objectScale[1],
      localSize.z * objectScale[2],
    ];
    const normalAxis = dims.indexOf(Math.min(...dims));
    const spanAxes = [0, 1, 2].filter((i) => i !== normalAxis);
    const width = Math.max(0.08, dims[spanAxes[0]]);
    const height = Math.max(0.08, dims[spanAxes[1]]);
    const centerLocal = localBox.getCenter(new THREE.Vector3());
    const centerWorld = mesh.localToWorld(centerLocal);

    const localNormal = new THREE.Vector3(
      normalAxis === 0 ? 1 : 0,
      normalAxis === 1 ? 1 : 0,
      normalAxis === 2 ? 1 : 0,
    );
    const normalWorld = localNormal.transformDirection(mesh.matrixWorld);
    const base = Math.max(0.1, emissiveMat.emissiveIntensity) * lightScale;
    const light = new THREE.RectAreaLight(
      emissiveMat.emissive.clone(),
      base,
      width,
      height,
    );
    // Fixtures may be intentionally embedded in a wall. If the analytic area
    // remains at the fixture centre, every sampled path to the room crosses
    // the host wall and is shadowed. Move the area just outside the fixture on
    // the room-facing side (same clearance principle as the game's fallback
    // light placement).
    const toRoom = viewer.clone().sub(centerWorld);
    const roomDir = toRoom.lengthSq() > 1e-6 ? toRoom.normalize() : normalWorld.clone();
    const projectedHalfExtent =
      Math.abs(roomDir.x) * dims[0] * 0.5 +
      Math.abs(roomDir.y) * dims[1] * 0.5 +
      Math.abs(roomDir.z) * dims[2] * 0.5;
    const lightPosition = centerWorld.clone().addScaledVector(roomDir, projectedHalfExtent + 0.12);
    light.position.copy(lightPosition);
    (light as THREE.RectAreaLight & { visibleToCameraRays?: boolean }).visibleToCameraRays = true;
    scene.add(light);
    emitters.push({ light, base });
    emitterMeshes.push(mesh);

    // Match three-gpu-pathtracer's official area-light example: RectAreaLight
    // is aimed with lookAt(the illuminated point in the room). ?flip=1 inverts
    // this to test which side the tracer's cross(u,v) normal actually lights.
    if (flipLights) light.lookAt(centerWorld.clone().addScaledVector(roomDir, -1));
    else light.lookAt(viewer);

  });
  for (const mesh of emitterMeshes) mesh.removeFromParent();

  const controls = new OrbitControls(camera, renderer.domElement);
  // Keep the path-tracer test aimed down the corridor, not at the global AABB
  // centre (which was empty space because scattered fixtures skew the bounds).
  controls.target.copy(lookAt);
  controls.enableDamping = false;
  controls.update();

  const sun = new THREE.DirectionalLight(0xffffff, 40);
  sun.position.set(viewer.x, viewer.y + 8, viewer.z);
  sun.target.position.copy(viewer.clone().add(new THREE.Vector3(0, -1, 0)));
  const sunInitiallyEnabled = params.has('sun');
  if (sunInitiallyEnabled) scene.add(sun, sun.target);
  const diagnosticPoint = new THREE.PointLight(0xffffff, 80, 0, 2);
  diagnosticPoint.position.copy(viewer).add(new THREE.Vector3(0, 1, -2));

  const tracer = new WebGPUPathTracer(renderer);
  // ?worker=1 exercises the async worker BVH path (the game-sized default);
  // without it the tiny test map builds its BVH synchronously like the sanity
  // scene, which isolates worker-BVH bugs from lighting bugs.
  const useWorker = params.has('worker');
  if (useWorker) tracer.setBVHWorker(GenerateMeshBVHWorker);
  tracer.maxBounces = 4;
  tracer.maxSamples = Number(($('samples') as HTMLInputElement).value);
  tracer.renderScale = Number(($('scale') as HTMLInputElement).value);
  tracer.multipleImportanceSampling = true;
  tracer.clampIndirect = 3;
  tracer.filterGlossyFactor = 1;
  tracer.dynamicLowRes = true;
  tracer.targetFrameTime = 14;
  status.textContent = useWorker
    ? `Building BVHs (worker) for ${emitters.length} rectangular area lights…`
    : `Building BVHs (sync) for ${emitters.length} rectangular area lights…`;
  if (useWorker) await tracer.setSceneAsync(scene, camera);
  else tracer.setScene(scene, camera);
  console.info(
    `[pathtrace] scene area lights=${getPathTracerLights(scene).length}, ` +
      `captured=${(tracer as unknown as { _lightsInfo?: { count?: number } })._lightsInfo?.count ?? 'unknown'}`,
  );
  status.textContent = `Ready · ${emitters.length} area lights · orbit to inspect`;

  controls.addEventListener('change', () => tracer.updateCamera());
  window.addEventListener('resize', () => {
    camera.aspect = innerWidth / innerHeight;
    camera.updateProjectionMatrix();
    renderer.setSize(innerWidth, innerHeight);
    tracer.updateCamera();
  });

  const samples = $('samples') as HTMLInputElement;
  const scale = $('scale') as HTMLInputElement;
  const gain = $('gain') as HTMLInputElement;
  samples.addEventListener('input', () => {
    $('samples-v').textContent = samples.value;
    tracer.maxSamples = Number(samples.value);
    tracer.reset();
  });
  scale.addEventListener('input', () => {
    $('scale-v').textContent = scale.value;
    tracer.renderScale = Number(scale.value);
    tracer.reset();
  });
  gain.addEventListener('input', () => {
    const multiplier = Number(gain.value);
    $('gain-v').textContent = multiplier.toFixed(1);
    for (const entry of emitters) entry.light.intensity = entry.base * multiplier;
    tracer.updateLights();
  });
  ($('sun') as HTMLInputElement).checked = sunInitiallyEnabled;
  ($('sun') as HTMLInputElement).addEventListener('change', (event) => {
    const enabled = (event.currentTarget as HTMLInputElement).checked;
    if (enabled) scene.add(sun, sun.target);
    else scene.remove(sun, sun.target);
    scene.updateMatrixWorld(true);
    tracer.updateLights();
    status.textContent = enabled
      ? 'Diagnostic sun enabled; path tracer reset'
      : 'Area lights only; path tracer reset';
  });
  ($('point') as HTMLInputElement).addEventListener('change', (event) => {
    const enabled = (event.currentTarget as HTMLInputElement).checked;
    if (enabled) scene.add(diagnosticPoint);
    else scene.remove(diagnosticPoint);
    scene.updateMatrixWorld(true);
    tracer.updateLights();
    status.textContent = enabled
      ? 'Diagnostic point light enabled; path tracer reset'
      : 'Diagnostic point light disabled';
  });
  ($('selfemit') as HTMLInputElement).addEventListener('change', (event) => {
    const enabled = (event.currentTarget as HTMLInputElement).checked;
    for (const material of receiverMaterials) {
      material.emissive.setRGB(enabled ? 0.5 : 0, enabled ? 0.5 : 0, enabled ? 0.5 : 0);
      material.emissiveIntensity = enabled ? 1 : 0;
    }
    tracer.updateMaterials();
    status.textContent = enabled
      ? 'Self-emission probe: ON (tests camera rays + material path)'
      : 'Self-emission probe: OFF';
  });
  let showRaster = false;
  $('reset').addEventListener('click', () => tracer.reset());
  $('raster').addEventListener('click', () => {
    showRaster = !showRaster;
    $('raster').textContent = showRaster ? 'Show path trace' : 'Show raster preview';
  });
  tracer.addEventListener('progress', (event) => {
    const avg = event.samples?.avg;
    status.textContent = `${event.stage}${avg === undefined ? '' : ` · ${avg.toFixed(1)} spp`}`;
  });

  renderer.setSize(innerWidth, innerHeight);
  renderer.setAnimationLoop(() => {
    if (showRaster) renderer.render(scene, camera);
    else tracer.renderSample();
  });

  (window as unknown as Record<string, unknown>).__pathtrace = {
    renderer,
    tracer,
    scene,
    camera,
    controls,
    bounds,
    emitters,
    three: THREE,
    lightCount: () =>
      (tracer as unknown as { _pathTracer?: { lightsInfo?: { count?: number } } })
        ._pathTracer?.lightsInfo?.count ?? 0,
    lightData: () => {
      const data = (
        tracer as unknown as {
          _pathTracer?: { lightsInfo?: { tex?: { image?: { data?: Float32Array } } } };
        }
      )._pathTracer?.lightsInfo?.tex?.image?.data;
      return data ? Array.from(data.slice(0, 24)) : null;
    },
    allLightData: () => {
      const data = (
        tracer as unknown as {
          _pathTracer?: { lightsInfo?: { tex?: { image?: { data?: Float32Array } } } };
        }
      )._pathTracer?.lightsInfo?.tex?.image?.data;
      return data ? Array.from(data) : null;
    },
    tracerLights: getPathTracerLights(scene).length,
    sceneRectLights: () => {
      let count = 0;
      scene.traverse((obj) => {
        if ((obj as THREE.RectAreaLight).isRectAreaLight) count++;
      });
      return count;
    },
  };
}

main().catch((error) => {
  console.error('[pathtrace demo]', error);
  status.textContent = `Failed: ${error instanceof Error ? error.message : String(error)}`;
  status.style.color = '#ff7777';
});
