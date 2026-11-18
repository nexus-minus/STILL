import type { Group, Mesh } from 'three';

/**
 * PHASE 2 — WORLD STREAMING
 *
 * The gigantic Blender map ships as one .glb per chunk (see
 * docs/blender-conventions.md), Draco-compressed, exported by
 * tools/export_map.sh and served from assets/map/ (publicDir root).
 *
 * Design:
 *   1. load manifest.json  -> chunk names + AABBs
 *   2. around the player, load chunks within radius R, unload beyond R+slack
 *      (GLTFLoader + draco decoder, in flight at most N chunks at once)
 *   3. per chunk: frustum-cull by AABB, merge static meshes -> own BVH
 *      (built in a worker, see three-mesh-bvh/worker)
 *   4. repeated corridor geometry becomes InstancedMesh — biggest win in a
 *      backrooms-style map
 *   5. interactables/anchors/lore come from Blender custom properties
 *      (respawn / lore / interact) read at chunk load
 */
export interface ChunkHandle {
  name: string;
  group: Group;
  collisionMeshes: Mesh[];
}

export interface ChunkStreamer {
  /** call every frame with the player position */
  update(playerPos: { x: number; y: number; z: number }): void;
  loadedCount(): number;
  dispose(): void;
}

/** Not implemented until phase 2 — the test room covers gameplay meanwhile. */
export function createChunkStreamer(): ChunkStreamer {
  throw new Error('chunk streaming lands in phase 2 (see src/world/chunk-streaming.ts)');
}
