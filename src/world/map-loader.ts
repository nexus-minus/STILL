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

// ---------------------------------------------------------------------------
// EMBEDDED-LIGHT NUDGE — backlog #5 "embedded fixture centers sit behind the
// wall, so the spill hotspot shifts". Exports below are also imported by
// scripts/rt-softshadow-smoke.mjs (in-page unit check against synthetic
// geometry) — keep them pure: tris/bounds/center in, offset out.

/** Flatten shadow meshes into world-space triangles (9 floats per triangle). */
export function buildShadowTriangles(meshes: THREE.Mesh[]): Float32Array {
  const out: number[] = [];
  const v = new THREE.Vector3();
  for (const mesh of meshes) {
    const pos = mesh.geometry.getAttribute('position');
    if (!pos) continue;
    const idx = mesh.geometry.getIndex();
    const triCount = Math.floor((idx ? idx.count : pos.count) / 3);
    for (let t = 0; t < triCount; t++) {
      for (let c = 0; c < 3; c++) {
        const vi = idx ? idx.getX(t * 3 + c) : t * 3 + c;
        v.fromBufferAttribute(pos, vi).applyMatrix4(mesh.matrixWorld);
        out.push(v.x, v.y, v.z);
      }
    }
  }
  return Float32Array.from(out);
}

/**
 * First-hit distance of a ray, capped at maxDist. Möller–Trumbore WITHOUT
 * the backface cull on purpose: three's Raycaster honours material.side, and
 * probes here often START INSIDE a wall — a FrontSide test would exit through
 * the backface and report "open in every direction", which is exactly the
 * case the nudge has to detect.
 */
export function probeClearance(
  tris: Float32Array,
  origin: THREE.Vector3,
  dir: THREE.Vector3,
  maxDist: number,
): number {
  let best = maxDist;
  const { x: ox, y: oy, z: oz } = origin;
  const { x: dx, y: dy, z: dz } = dir;
  for (let i = 0; i + 8 < tris.length; i += 9) {
    const ax = tris[i], ay = tris[i + 1], az = tris[i + 2];
    const e1x = tris[i + 3] - ax, e1y = tris[i + 4] - ay, e1z = tris[i + 5] - az;
    const e2x = tris[i + 6] - ax, e2y = tris[i + 7] - ay, e2z = tris[i + 8] - az;
    const hx = dy * e2z - dz * e2y;
    const hy = dz * e2x - dx * e2z;
    const hz = dx * e2y - dy * e2x;
    const det = e1x * hx + e1y * hy + e1z * hz;
    if (det > -1e-12 && det < 1e-12) continue; // parallel — no sign cull, both faces count
    const inv = 1 / det;
    const sx = ox - ax, sy = oy - ay, sz = oz - az;
    const u = inv * (sx * hx + sy * hy + sz * hz);
    if (u < 0 || u > 1) continue;
    const qx = sy * e1z - sz * e1y;
    const qy = sz * e1x - sx * e1z;
    const qz = sx * e1y - sy * e1x;
    const v = inv * (dx * qx + dy * qy + dz * qz);
    if (v < 0 || u + v > 1) continue;
    const t = inv * (e2x * qx + e2y * qy + e2z * qz);
    if (t > 1e-4 && t < best) best = t;
  }
  return best;
}

/**
 * Nearest shadow triangle to a point: distance + winding-oriented face
 * normal. Heuristic: a fixture is authored ON its host surface, and greybox
 * faces point into the room — so the nearest face's normal is the direction
 * the spill is supposed to come from.
 */
export function nearestFace(
  tris: Float32Array,
  point: THREE.Vector3,
): { dist: number; normal: THREE.Vector3 } | null {
  let bestDist = Infinity;
  let bestNormal: THREE.Vector3 | null = null;
  const a = new THREE.Vector3(), b = new THREE.Vector3(), c = new THREE.Vector3();
  const ab = new THREE.Vector3(), ac = new THREE.Vector3(), n = new THREE.Vector3();
  const ap = new THREE.Vector3(), q = new THREE.Vector3(), tmp = new THREE.Vector3();
  const closestOnSeg = (p: THREE.Vector3, s: THREE.Vector3, e: THREE.Vector3): number => {
    tmp.subVectors(e, s);
    const denom = tmp.lengthSq();
    const t = denom > 0 ? Math.min(1, Math.max(0, tmp.dot(p.clone().sub(s)) / denom)) : 0;
    return p.distanceTo(tmp.multiplyScalar(t).add(s));
  };
  for (let i = 0; i + 8 < tris.length; i += 9) {
    a.set(tris[i], tris[i + 1], tris[i + 2]);
    b.set(tris[i + 3], tris[i + 4], tris[i + 5]);
    c.set(tris[i + 6], tris[i + 7], tris[i + 8]);
    ab.subVectors(b, a);
    ac.subVectors(c, a);
    n.crossVectors(ab, ac);
    const n2 = n.lengthSq();
    if (n2 < 1e-16) continue; // degenerate triangle
    ap.subVectors(point, a);
    // planar projection; inside test = all three edge crosses on the normal side
    q.copy(point).addScaledVector(n, -ap.dot(n) / n2);
    const inside = (s: THREE.Vector3, e: THREE.Vector3): boolean => {
      tmp.subVectors(e, s).cross(q.clone().sub(s));
      return tmp.dot(n) >= 0;
    };
    const dist = inside(a, b) && inside(b, c) && inside(c, a)
      ? Math.abs(ap.dot(n)) / Math.sqrt(n2)
      : Math.min(closestOnSeg(point, a, b), closestOnSeg(point, b, c), closestOnSeg(point, c, a));
    if (dist < bestDist) {
      bestDist = dist;
      bestNormal = n.clone().normalize();
    }
  }
  return bestNormal ? { dist: bestDist, normal: bestNormal } : null;
}

export interface NudgeOutcome {
  /** world-space offset to add — null = leave the light where it is */
  offset: THREE.Vector3 | null;
  /** distance centre → host surface along `dir`, capped at the step (Infinity = open) */
  embed: number;
  /** outward unit direction that was evaluated */
  dir: THREE.Vector3;
  /** 'moved' out of the wall · 'clear' already in open air · 'failed' could not exit */
  status: 'moved' | 'clear' | 'failed';
}

/**
 * Decide how far to walk a fixture centre out of its host wall.
 *
 * Heuristic (documented per backlog #5):
 *  1. outward axis = the authored cone direction when the fixture has one
 *     (Blender `cone_deg` — the fixture POINTS into the room, so its +Z is
 *     where the spill belongs); otherwise the nearest shadow-face normal
 *     (winding-oriented, see nearestFace). Greybox walls are double-sided,
 *     so the winding is trusted FIRST but not blindly: step 3 flips it.
 *  2. gate: a surface within one step along the axis means the centre sits
 *     at/behind its host surface → walk out in (halfSize + 0.05) steps until
 *     the landing point is ≥0.3 m clear AND inside the level bounds — bounds
 *     rejects the empty void behind outer walls, which would otherwise read
 *     as "open air" and strand the light behind the wall.
 *  3. only if that walk failed: retry along the flipped face normal (inverted
 *     winding insurance). Never first — a flush fixture must not be pushed
 *     through its wall just because the flip probe found a near surface.
 */
export function nudgeEmbeddedLight(
  tris: Float32Array,
  bounds: THREE.Box3,
  center: THREE.Vector3,
  step: number,
  authoredDir?: [number, number, number],
): NudgeOutcome {
  const nearest = nearestFace(tris, center);
  const dir = authoredDir
    ? new THREE.Vector3(authoredDir[0], authoredDir[1], authoredDir[2]).normalize()
    : nearest?.normal.clone();
  if (!dir) {
    return { offset: null, embed: Infinity, dir: new THREE.Vector3(0, 1, 0), status: 'clear' };
  }

  const attempt = (axis: THREE.Vector3): NudgeOutcome => {
    const embed = probeClearance(tris, center, axis, step);
    const ahead = center.clone().addScaledVector(axis, step);
    if (embed >= step && bounds.containsPoint(ahead)) {
      return { offset: null, embed, dir: axis, status: 'clear' };
    }
    for (let k = 1; k <= 4; k++) {
      const landing = center.clone().addScaledVector(axis, step * k);
      if (bounds.containsPoint(landing) && probeClearance(tris, landing, axis, 0.3) >= 0.3) {
        return { offset: axis.clone().multiplyScalar(step * k), embed, dir: axis, status: 'moved' };
      }
    }
    return { offset: null, embed, dir: axis, status: 'failed' };
  };

  const primary = attempt(dir);
  if (primary.status !== 'failed' || authoredDir) return primary;
  // inverted-winding insurance (see step 3 above); on total failure return
  // the PRIMARY outcome so the log reports the direction we actually trust
  const alt = attempt(dir.clone().negate());
  return alt.status === 'moved' ? alt : primary;
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
  // fixtures whose centres still need the embed-nudge — collected here (the
  // shadow geometry isn't known until the traverse finished)
  const pendingLights: Array<{
    name: string;
    center: THREE.Vector3;
    first: number;
    count: number;
    step: number;
    authoredDir?: [number, number, number];
    pointLight: THREE.PointLight;
  }> = [];

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

      // SHAPE-AWARE sampling: a single point at the bbox centre makes a long
      // strip fixture throw a circular pool on the opposite wall (the "one
      // light with a weird circle" bug). Sample along the fixture's longest
      // axis instead — always derived from GEOMETRY bounds, never the object
      // origin, so an origin outside the level cannot skew placement.
      const dims = [size.x, size.y, size.z];
      const longAxis = dims.indexOf(Math.max(...dims));
      const longLen = dims[longAxis];
      const sampleCount = Math.min(8, Math.max(1, Math.round(longLen / 0.9)));
      const powerEach = power / sampleCount;
      const otherMax = Math.max(...dims.filter((_, i) => i !== longAxis));
      const halfEach = Math.max(otherMax, longLen / sampleCount) / 2;
      for (let s = 0; s < sampleCount; s++) {
        const t = sampleCount === 1 ? 0 : s / (sampleCount - 1) - 0.5;
        const pos: [number, number, number] = [center.x, center.y, center.z];
        pos[longAxis] += t * longLen;
        rtLights.push({
          position: pos,
          color: [emissive.r, emissive.g, emissive.b],
          power: powerEach,
          halfSize: halfEach,
          direction,
          coneCos,
        });
      }


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
      // remember the fixture so the nudge can move its samples AND the GL
      // fallback light together (both must stay on the same side of the wall)
      pendingLights.push({
        name: mesh.name || '(unnamed)',
        center: center.clone(),
        first: rtLights.length - sampleCount,
        count: sampleCount,
        step: halfEach + 0.05,
        authoredDir: direction,
        pointLight,
      });
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

  // ---- embedded-fixture nudge (backlog #5) --------------------------------
  // Fixture centres sit at/behind their host surface, which drags every spill
  // hotspot toward the wall. Walk each centre OUT along the outward direction
  // (authored cone dir, else nearest shadow-face normal — full heuristic in
  // nudgeEmbeddedLight) before the lights reach the RT uniform upload and the
  // GL fallback. One outward axis per fixture: its samples all share the host.
  if (pendingLights.length > 0 && new URLSearchParams(location.search).has('nolightnudge')) {
    // A/B switch for screenshots of the nudge's visual effect
    console.info('[map] light nudge disabled by ?nolightnudge — centres stay as exported');
  } else if (pendingLights.length > 0) {
    const shadowTris = buildShadowTriangles(shadowMeshes);
    const fmt = (v: THREE.Vector3): string => `(${v.x.toFixed(2)}, ${v.y.toFixed(2)}, ${v.z.toFixed(2)})`;
    if (shadowTris.length === 0) {
      console.info('[map] light nudge skipped — no shadow geometry to probe');
    }
    for (const p of pendingLights) {
      const res = shadowTris.length
        ? nudgeEmbeddedLight(shadowTris, bounds, p.center, p.step, p.authoredDir)
        : { offset: null, embed: Infinity, dir: new THREE.Vector3(0, 1, 0), status: 'clear' as const };
      if (res.offset) {
        const after = p.center.clone().add(res.offset);
        for (let i = p.first; i < p.first + p.count; i++) {
          rtLights[i].position[0] += res.offset.x;
          rtLights[i].position[1] += res.offset.y;
          rtLights[i].position[2] += res.offset.z;
        }
        p.pointLight.position.add(res.offset); // GL fallback follows the RT lights
        console.info(
          `[map] light "${p.name}": ${fmt(p.center)} -> ${fmt(after)} ` +
            `outward (${res.dir.x.toFixed(2)}, ${res.dir.y.toFixed(2)}, ${res.dir.z.toFixed(2)}) ` +
            `embed=${res.embed >= p.step ? `>${p.step.toFixed(2)}` : res.embed.toFixed(2)}m step=${p.step.toFixed(2)}m`,
        );
      } else {
        console.info(
          `[map] light "${p.name}": ${fmt(p.center)} — ` +
            (res.status === 'clear'
              ? `clear of surfaces (embed ≥${p.step.toFixed(2)}m), not nudged`
              : 'EMBEDDED but no clear exit found — left in place'),
        );
      }
    }
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
