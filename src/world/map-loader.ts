import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { DRACOLoader } from 'three/addons/loaders/DRACOLoader.js';
import { buildTestRoom } from './test-room.js';
import type { RtLight } from '../render/rt.js';

export interface WorldCheckpoint {
  name: string;
  label: string;
  position: THREE.Vector3;
  kind: string; // respawn | interact | spawn
  radius: number;
}

export interface WorldDef {
  group: THREE.Group;
  collisionMeshes: THREE.Mesh[];
  /**
   * Shadow/tracing geometry = collision meshes MINUS emissive fixtures.
   * A light must never occlude itself: shadow rays stop only marginally short
   * of the light centre (0.08m), but a0.44m cube fixture reaches0.22m in —
   * it blocked every ray toward itself (uniform-green debug, shadowless
   * normal mode). Thin test-room panels never triggered it.
   */
  shadowMeshes: THREE.Mesh[];
  rtLights: RtLight[];
  spawn: THREE.Vector3;
  checkpoints: WorldCheckpoint[];
  /** world AABB from the loaded geometry (Blender-space manifest bounds differ!) */
  bounds: THREE.Box3;
  /** 'test' keeps the demo anchor/lore wiring in main */
  source: 'map' | 'test';
  /** demo-room extras (only present for the test fallback) */
  demo?: {
    anchorInteract: THREE.Vector3;
    anchorFeet: THREE.Vector3;
    loreTrigger: THREE.Vector3;
  };
}

interface Manifest {
  collections: Record<string, { file?: string | null; count?: number }>;
  checkpoints?: Array<{
    name: string;
    label?: string;
    position: [number, number, number];
    kind?: string;
    radius?: number;
  }>;
  skipped?: string[];
}

/**
 * PHASE 2 entry: assets/map/manifest.json + objects.glb (your Blender export)
 * become the world. Falls back to the procedural test room when the map isn't
 * exported yet. Emissive meshes (L_*) are extracted as raytracing lights —
 * emission strength × largest-face area is the power heuristic (tuned later).
 */
export async function loadWorld(opts: { forceTest?: boolean } = {}): Promise<WorldDef> {
  if (opts.forceTest) {
    console.info('[world] testroom requested — using the procedural test room');
    return testWorld();
  }
  const manifest = (await fetch('map/manifest.json')
    .then((r) => (r.ok ? r.json() : null))
    .catch(() => null)) as Manifest | null;
  const objectsFile = manifest?.collections?.objects?.file;

  if (!manifest || !objectsFile) {
    console.info('[world] no map export found — using test room');
    return testWorld();
  }

  const loader = new GLTFLoader();
  const draco = new DRACOLoader();
  draco.setDecoderPath('draco/');
  loader.setDRACOLoader(draco);

  const gltf = await loader.loadAsync(`map/${objectsFile}`);
  draco.dispose();

  const group = gltf.scene;
  group.updateMatrixWorld(true);

  const collisionMeshes: THREE.Mesh[] = [];
  const emissiveMeshes = new Set<THREE.Mesh>();
  const rtLights: RtLight[] = [];
  const bounds = new THREE.Box3();

  group.traverse((obj) => {
    if (!(obj as THREE.Mesh).isMesh) return;
    const mesh = obj as THREE.Mesh;
    collisionMeshes.push(mesh);
    bounds.expandByObject(mesh);

    const materials = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
    for (const material of materials) {
      const std = material as THREE.MeshStandardMaterial;
      const emissive = std.emissive;
      const strength = std.emissiveIntensity ?? 1;
      if (!emissive || strength <= 0) continue;
      const luma = Math.max(emissive.r, emissive.g, emissive.b);
      if (luma < 0.001) continue;

      const meshBox = new THREE.Box3().setFromObject(mesh);
      const size = meshBox.getSize(new THREE.Vector3());
      const faceArea = Math.max(size.x * size.y, size.y * size.z, size.x * size.z, 0.15);
      const power = strength * faceArea;
      const halfSize = Math.max(size.x, size.y, size.z) / 2;
      const center = meshBox.getCenter(new THREE.Vector3());

      // optional one-way cone: Blender custom prop `cone_deg` on the fixture.
      // Direction = the object's +Z after export (Blender -Y; if the spill
      // points the wrong way, rotate the fixture 180°).
      const cone = Number((mesh.userData as Record<string, unknown>).cone_deg ?? 0);
      let direction: [number, number, number] | undefined;
      let coneCos: number | undefined;
      if (cone > 0 && cone < 360) {
        const fwd = new THREE.Vector3();
        mesh.getWorldDirection(fwd);
        direction = [fwd.x, fwd.y, fwd.z];
        coneCos = Math.cos((cone * Math.PI) / 360);
      }

      rtLights.push({
        position: center.toArray() as [number, number, number],
        color: [emissive.r, emissive.g, emissive.b],
        power,
        halfSize,
        direction,
        coneCos,
      });

      // Fallback illumination: the WebGL2/potato/compat paths have no traced
      // lighting — without this the imported map is pitch black there (the
      // test room had fake point lights; imported maps need the same).
      // Their test material is dim emission, so the floor is deliberately high.
      const pointLight = new THREE.PointLight(
        new THREE.Color(emissive.r, emissive.g, emissive.b),
        Math.max(power * 8, 25),
        Math.max(10, Math.sqrt(power) * 10),
        2,
      );
      pointLight.position.copy(center);
      group.add(pointLight);
      emissiveMeshes.add(mesh);
      break; // one light per mesh for now
    }
  });

  // ---- checkpoints -----------------------------------------------------------
  const checkpoints: WorldCheckpoint[] = (manifest.checkpoints ?? []).map((cp) => ({
    name: cp.name,
    label: cp.label ?? cp.name,
    position: new THREE.Vector3(...cp.position),
    kind: cp.kind ?? 'respawn',
    radius: cp.radius ?? 1.2,
  }));

  // ---- spawn: kind='spawn' checkpoint wins; otherwise main raycasts DOWN
  // from above the bounds centre (min.y is unreliable: a low-hanging light can
  // drag it below the actual floor — that spawned players under the world).
  const spawnCheckpoint = checkpoints.find((cp) => cp.kind === 'spawn');
  const center = bounds.getCenter(new THREE.Vector3());
  const spawn = spawnCheckpoint
    ? spawnCheckpoint.position.clone()
    : new THREE.Vector3(center.x, bounds.max.y + 1, center.z);

  if (manifest.skipped?.length) {
    console.info(`[world] collections ignored by export: ${manifest.skipped.join(', ')}`);
  }
  console.info(
    `[world] loaded ${objectsFile} — ${collisionMeshes.length} meshes, ` +
      `${rtLights.length} emissive lights, ${checkpoints.length} checkpoints, ` +
      `bounds ${bounds.min.toArray().map((v) => v.toFixed(1)).join('/')}..${bounds.max.toArray().map((v) => v.toFixed(1)).join('/')}`,
  );

  const shadowMeshes = collisionMeshes.filter((m) => !emissiveMeshes.has(m));
  if (shadowMeshes.length < collisionMeshes.length) {
    console.info(
      `[world] shadow BVH: ${shadowMeshes.length}/${collisionMeshes.length} meshes ` +
        `(${collisionMeshes.length - shadowMeshes.length} emissive fixtures excluded so lights never block themselves)`,
    );
  }

  return {
    group,
    collisionMeshes,
    shadowMeshes,
    rtLights,
    spawn,
    checkpoints,
    bounds,
    source: 'map',
  };
}

/** Procedural fallback — the demo content used until a real map exists. */
function testWorld(): WorldDef {
  const room = buildTestRoom();
  const bounds = new THREE.Box3().setFromObject(room.group);
  return {
    group: room.group,
    collisionMeshes: room.collisionMeshes,
    shadowMeshes: room.collisionMeshes, // test-room lights are already no-collide
    rtLights: room.rtLights,
    spawn: room.spawn,
    checkpoints: [
      {
        name: 'anchor-01',
        label: 'Beacon · Room A',
        position: room.anchor.interact,
        kind: 'respawn',
        radius: 0.9,
      },
    ],
    source: 'test',
    bounds,
    demo: {
      anchorInteract: room.anchor.interact,
      anchorFeet: room.anchor.feet,
      loreTrigger: room.loreTrigger,
    },
  };
}
