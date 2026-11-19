import * as THREE from 'three/webgpu';
import { WebGPUPathTracer } from 'three-gpu-pathtracer/webgpu';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';

async function main(): Promise<void> {
  const status = document.getElementById('status')!;
  const scene = new THREE.Scene();
  scene.background = new THREE.Color(0x101722);
  scene.add(new THREE.AmbientLight(0xffffff, 0.55));

  const light = new THREE.DirectionalLight(0xffffff, 2);
  light.position.set(2, 4, 3);
  scene.add(light);

  const floor = new THREE.Mesh(
    new THREE.PlaneGeometry(20, 20),
    new THREE.MeshStandardMaterial({ color: 0x666a70, roughness: 0.9 }),
  );
  floor.rotation.x = -Math.PI / 2;
  floor.position.y = -1.25;
  scene.add(floor);

  const knot = new THREE.Mesh(
    new THREE.TorusKnotGeometry(0.9, 0.28, 180, 24),
    new THREE.MeshStandardMaterial({ color: 0xd38a48, roughness: 0.45 }),
  );
  scene.add(knot);

  const camera = new THREE.PerspectiveCamera(55, innerWidth / innerHeight, 0.1, 50);
  camera.position.set(0, 1.2, 5);
  camera.lookAt(0, 0, 0);

  const renderer = new THREE.WebGPURenderer({ antialias: false });
  renderer.toneMapping = THREE.AgXToneMapping;
  await renderer.init();
  renderer.setPixelRatio(Math.min(devicePixelRatio, 1.5));
  renderer.setSize(innerWidth, innerHeight);
  document.body.appendChild(renderer.domElement);

  const tracer = new WebGPUPathTracer(renderer);
  tracer.maxSamples = 64;
  tracer.maxBounces = 3;
  tracer.setScene(scene, camera);

  const controls = new OrbitControls(camera, renderer.domElement);
  controls.target.set(0, 0, 0);
  controls.addEventListener('change', () => tracer.updateCamera());
  controls.update();

  window.addEventListener('resize', () => {
    camera.aspect = innerWidth / innerHeight;
    camera.updateProjectionMatrix();
    renderer.setSize(innerWidth, innerHeight);
    tracer.updateCamera();
  });

  tracer.addEventListener('progress', (event) => {
    const avg = event.samples?.avg;
    status.textContent = `path tracer: ${event.stage}${avg === undefined ? '' : ` · ${avg.toFixed(1)} spp`}`;
  });
  renderer.setAnimationLoop(() => tracer.renderSample());

  (window as unknown as Record<string, unknown>).__pathtraceSanity = { renderer, tracer, scene, camera };
}

main().catch((error) => {
  const status = document.getElementById('status');
  if (status) status.textContent = `Failed: ${error instanceof Error ? error.message : String(error)}`;
  console.error('[pathtrace sanity]', error);
});
