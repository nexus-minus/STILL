import * as THREE from 'three/webgpu';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { DRACOLoader } from 'three/addons/loaders/DRACOLoader.js';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { RectAreaLightNode, WebGPURenderer } from 'three/webgpu';
import { RectAreaLightTexturesLib } from 'three/addons/lights/RectAreaLightTexturesLib.js';
import { WebGPUPathTracer } from 'three-gpu-pathtracer/webgpu';
import { GenerateMeshBVHWorker } from 'three-mesh-bvh/worker';

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

  const scene = new THREE.Scene();
  scene.background = new THREE.Color(0x080808);
  const camera = new THREE.PerspectiveCamera(76, innerWidth / innerHeight, 0.03, 600);

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
  const center = bounds.getCenter(new THREE.Vector3());
  camera.position.set(center.x + 1.5, center.y + 1, center.z + 2);
  camera.lookAt(center);
  camera.updateProjectionMatrix();

  // Replace emissive mesh light approximations with actual RectAreaLights.
  // Retain a visible emitter panel for the camera, but turn off its material
  // emission so it isn't double-counted; RectAreaLight is the sole source.
  const emitters: Array<{ light: THREE.RectAreaLight; base: number }> = [];
  scene.traverse((obj) => {
    const mesh = obj as THREE.Mesh;
    if (!mesh.isMesh) return;
    const materials = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
    const emissiveMat = materials.find((m) => {
      const mat = m as THREE.MeshStandardMaterial;
      return mat.emissive && mat.emissiveIntensity > 0 &&
        Math.max(mat.emissive.r, mat.emissive.g, mat.emissive.b) > 0.001;
    }) as THREE.MeshStandardMaterial | undefined;
    if (!emissiveMat) return;

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
    const base = Math.max(0.1, emissiveMat.emissiveIntensity);
    const light = new THREE.RectAreaLight(
      emissiveMat.emissive.clone(),
      base,
      width,
      height,
    );
    light.position.copy(centerWorld);
    light.lookAt(centerWorld.clone().add(normalWorld));
    (light as THREE.RectAreaLight & { visibleToCameraRays?: boolean }).visibleToCameraRays = true;
    scene.add(light);
    emitters.push({ light, base });

    // The rectangular source now supplies illumination and is itself visible
    // to camera rays; disable mesh emission to avoid counting the same source
    // twice. Keep base color so the panel remains visible to raster preview.
    emissiveMat.emissiveIntensity = 0;
    emissiveMat.emissive.setRGB(0, 0, 0);
  });

  const controls = new OrbitControls(camera, renderer.domElement);
  controls.target.copy(center);
  controls.enableDamping = false;
  controls.update();

  const tracer = new WebGPUPathTracer(renderer);
  tracer.setBVHWorker(GenerateMeshBVHWorker);
  tracer.maxBounces = 4;
  tracer.maxSamples = Number(($('samples') as HTMLInputElement).value);
  tracer.renderScale = Number(($('scale') as HTMLInputElement).value);
  tracer.multipleImportanceSampling = true;
  tracer.clampIndirect = 3;
  tracer.filterGlossyFactor = 1;
  tracer.dynamicLowRes = true;
  tracer.targetFrameTime = 14;
  status.textContent = `Building BVHs for ${emitters.length} rectangular area lights…`;
  await tracer.setSceneAsync(scene, camera);
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
  $('reset').addEventListener('click', () => tracer.reset());
  tracer.addEventListener('progress', (event) => {
    const avg = event.samples?.avg;
    status.textContent = `${event.stage}${avg === undefined ? '' : ` · ${avg.toFixed(1)} spp`}`;
  });

  renderer.setSize(innerWidth, innerHeight);
  renderer.setAnimationLoop(() => tracer.renderSample());

  (window as unknown as Record<string, unknown>).__pathtrace = {
    renderer,
    tracer,
    scene,
    camera,
    emitters,
  };
}

main().catch((error) => {
  console.error('[pathtrace demo]', error);
  status.textContent = `Failed: ${error instanceof Error ? error.message : String(error)}`;
  status.style.color = '#ff7777';
});
