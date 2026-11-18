import * as THREE from 'three';

export interface TestRoom {
  group: THREE.Group;
  /** meshes whose triangles build the collision BVH (ceilings excluded on purpose) */
  collisionMeshes: THREE.Mesh[];
  /** feet position: room A, facing the corridor */
  spawn: THREE.Vector3;
  /** world positions main.ts uses to wire demo interactables */
  anchor: { interact: THREE.Vector3; feet: THREE.Vector3 };
  loreTrigger: THREE.Vector3;
}

const WALL_H = 3.2;
const WALL_T = 0.4;

/**
 * PHASE 0 VERTICAL SLICE
 *
 * A hand-built L-shaped backrooms area: room A -> corridor -> room B.
 * Same visual rules as the real Blender map: flat default colors, no
 * textures, ceiling panels that glow (bloom picks them up now, the traced
 * bounce lights the rooms in phase 1).
 *
 * Replaced by glTF chunk loading in phase 2 (world/chunk-streaming.ts).
 */
export function buildTestRoom(): TestRoom {
  const group = new THREE.Group();
  const collision: THREE.Mesh[] = [];

  // --- palette: flat, untextured, backrooms -----------------------------
  const carpetMat = new THREE.MeshStandardMaterial({ color: 0xa89a68, roughness: 1 });
  const wallMat = new THREE.MeshStandardMaterial({ color: 0xd3c892, roughness: 0.95 });
  const ceilMat = new THREE.MeshStandardMaterial({ color: 0xe6e2d4, roughness: 1 });
  const pillarMat = new THREE.MeshStandardMaterial({ color: 0xc4b884, roughness: 0.95 });
  const deskMat = new THREE.MeshStandardMaterial({ color: 0x6b5c43, roughness: 0.9 });
  // emissive-by-nature: MeshBasicMaterial over white reads as "a light" to bloom
  const panelMat = new THREE.MeshBasicMaterial({ color: 0xfff3d8 });
  const beaconMat = new THREE.MeshBasicMaterial({ color: 0x9dffe0 });

  const box = (
    w: number, h: number, d: number,
    x: number, y: number, z: number,
    mat: THREE.Material, collide = true,
  ): THREE.Mesh => {
    const mesh = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), mat);
    mesh.position.set(x, y, z);
    group.add(mesh);
    if (collide) collision.push(mesh);
    return mesh;
  };

  // wall segment from (x1,z1) to (x2,z2), thickness WALL_T.
  // Geometry is built with its length on local X, then ROTATED onto the
  // segment direction — without this, Z-running walls lie flat across the room.
  const wall = (x1: number, z1: number, x2: number, z2: number): THREE.Mesh => {
    const len = Math.hypot(x2 - x1, z2 - z1) + WALL_T;
    const mesh = box(len, WALL_H, WALL_T, (x1 + x2) / 2, WALL_H / 2, (z1 + z2) / 2, wallMat);
    mesh.rotation.y = Math.atan2(-(z2 - z1), x2 - x1);
    return mesh;
  };

  // --- floors / ceilings -------------------------------------------------
  // room A: x,z in [-8,8] · corridor: x in [-2,2], z in [8,16] · room B: z in [16,32]
  box(16.8, 0.2, 16.8, 0, -0.1, 0, carpetMat);
  box(4.4, 0.2, 8.4, 0, -0.1, 12, carpetMat);
  box(16.8, 0.2, 16.8, 0, -0.1, 24, carpetMat);

  box(16.8, 0.2, 16.8, 0, WALL_H + 0.1, 0, ceilMat, false);
  box(4.4, 0.2, 8.4, 0, WALL_H + 0.1, 12, ceilMat, false);
  box(16.8, 0.2, 16.8, 0, WALL_H + 0.1, 24, ceilMat, false);

  // --- room A walls (opening x in [-2,2] on the south side) --------------
  wall(-8, -8, 8, -8);            // north
  wall(-8, -8, -8, 8);            // west
  wall(8, -8, 8, 8);              // east
  wall(-8, 8, -2, 8);             // south-west of opening
  wall(2, 8, 8, 8);               // south-east of opening

  // --- corridor ----------------------------------------------------------
  wall(-2, 8, -2, 16);
  wall(2, 8, 2, 16);

  // --- room B walls (opening x in [-2,2] on the north side) --------------
  wall(-8, 16, -2, 16);           // north-west of opening
  wall(2, 16, 8, 16);             // north-east of opening
  wall(-8, 16, -8, 32);           // west
  wall(8, 16, 8, 32);             // east
  wall(-8, 32, 8, 32);            // south

  // --- pillars in room A -------------------------------------------------
  box(0.7, WALL_H, 0.7, -5, WALL_H / 2, 0, pillarMat);
  box(0.7, WALL_H, 0.7, 5, WALL_H / 2, 0, pillarMat);
  box(0.7, WALL_H, 0.7, 0, WALL_H / 2, -5, pillarMat);

  // --- ceiling light panels (visual only, no collision) ------------------
  const panel = (x: number, z: number) => box(1.4, 0.06, 1.4, x, WALL_H - 0.05, z, panelMat, false);
  panel(-4, -4); panel(4, -4); panel(-4, 4); panel(4, 4);
  panel(0, 10); panel(0, 14);
  panel(-4, 20); panel(4, 20); panel(-4, 28); panel(4, 28);

  // --- temporary lights (phase 1: replaced by traced emissive bounce) ----
  group.add(new THREE.AmbientLight(0xffffff, 0.28));
  const lamp = (x: number, z: number) => {
    const light = new THREE.PointLight(0xfff0d4, 26, 15, 2);
    light.position.set(x, WALL_H - 0.4, z);
    group.add(light);
  };
  lamp(-4, -4); lamp(4, 4); lamp(0, 12); lamp(-4, 24); lamp(4, 28);

  // --- respawn anchor (demo interactable) --------------------------------
  const beacon = new THREE.Mesh(new THREE.CylinderGeometry(0.14, 0.14, 2.1, 12), beaconMat);
  beacon.position.set(-6.4, 1.05, -6.4);
  group.add(beacon);
  const beaconLight = new THREE.PointLight(0x7dffdd, 6, 6, 2);
  beaconLight.position.copy(beacon.position);
  group.add(beaconLight);

  // --- lore desk in room B ------------------------------------------------
  box(1.4, 0.8, 0.7, 0, 0.4, 26, deskMat);
  box(0.3, 0.02, 0.22, 0.1, 0.82, 26, panelMat, false); // the note

  return {
    group,
    collisionMeshes: collision,
    spawn: new THREE.Vector3(0, 0, 2),
    anchor: {
      interact: new THREE.Vector3(-6.4, 1.2, -6.4),
      feet: new THREE.Vector3(-6.4, 0, -6.4),
    },
    loreTrigger: new THREE.Vector3(0, 1, 26),
  };
}
