import * as THREE from 'three';
import { MeshBVH, StaticGeometryGenerator } from 'three-mesh-bvh';

const UP = new THREE.Vector3(0, 1, 0);

/**
 * Same walkable limit as the controller (SLOPE_LIMIT_COS − its float margin):
 * contacts flatter than ~50° are ground; steeper are walls. `grounded` must
 * never come from a wall — grounded freezes vy and applies the no-input
 * brake, which HELD players on 50–60° faces (they should slide/fall). The
 * old threshold was dir.y > 0.5 (= 60°), leaving that entire band stuck.
 */
const WALKABLE_NY = Math.cos((50 * Math.PI) / 180) - 1e-3;

export interface CapsuleResolveResult {
  grounded: boolean;
  /** how many depenetration passes were needed this frame (debug/perf) */
  iterations: number;
  /**
   * total correction applied this call (reference — valid until the next
   * resolveCapsule call). Direction ≈ average contact normal; the controller
   * uses it to reject climbing steep surfaces and to stop pressing into walls.
   */
  push: THREE.Vector3;
  /**
   * smallest oriented normal.y among the triangles that pushed this call
   * (1 when none). The averaged `push` can hide a steep face inside a mostly
   * walkable mix (ledge riser + its top edge, wall + floor) — the controller
   * needs the STEEPEST contributing face to classify wall vs slope.
   */
  minNy: number;
}

/**
 * Triangle-mesh collision for the whole static world as ONE merged BVH.
 *
 * - no physics engine: the player is a capsule that is pushed out of geometry
 * - interaction rays and line-of-sight reuse the same BVH (raycastFirst)
 * - phase 2: build moves to a web worker (three-mesh-bvh ships a worker) and
 *   chunks get their own BVHs so the gigantic map loads incrementally
 */
export class WorldCollision {
  readonly bvh: MeshBVH;

  private readonly segment = new THREE.Line3();
  private readonly box = new THREE.Box3();
  private readonly triPoint = new THREE.Vector3();
  private readonly capPoint = new THREE.Vector3();
  private readonly dir = new THREE.Vector3();
  private readonly push = new THREE.Vector3();
  private readonly segMid = new THREE.Vector3();
  private readonly toMid = new THREE.Vector3();
  private readonly ray = new THREE.Ray();
  private readonly pushSum = new THREE.Vector3();

  private constructor(bvh: MeshBVH) {
    this.bvh = bvh;
  }

  static fromMeshes(meshes: THREE.Mesh[]): WorldCollision {
    for (const mesh of meshes) mesh.updateWorldMatrix(true, false);

    // merges every mesh into one geometry with world transforms applied
    const generator = new StaticGeometryGenerator(meshes);
    const geometry = generator.generate();

    const bvh = new MeshBVH(geometry, { targetLeafSize: 10 });
    return new WorldCollision(bvh);
  }

  /** Nearest world hit along the ray, or null. Used for interaction + LOS. */
  raycast(origin: THREE.Vector3, direction: THREE.Vector3, far = Infinity): THREE.Intersection | null {
    this.ray.set(origin, direction);
    return this.bvh.raycastFirst(this.ray, THREE.FrontSide, 0, far);
  }

  /**
   * Depenetrate a vertical capsule around `center` — MUTATES center.
   * Call once per frame after applying movement. Returns whether a floor
   * pushed the capsule up (i.e. we are standing on something).
   */
  resolveCapsule(
    center: THREE.Vector3,
    height: number,
    radius: number,
    maxIterations = 3,
  ): CapsuleResolveResult {
    const half = height / 2 - radius; // segment half length
    let grounded = false;
    let used = 0;
    let minNy = 1;
    this.pushSum.set(0, 0, 0);

    for (let iter = 0; iter < maxIterations; iter++) {
      const { segment, box, push, triPoint, capPoint, dir, segMid, toMid } = this;

      segment.start.copy(center).addScaledVector(UP, -half);
      segment.end.copy(center).addScaledVector(UP, half);
      segment.getCenter(segMid);
      box
        .makeEmpty()
        .expandByPoint(segment.start)
        .expandByPoint(segment.end)
        .expandByScalar(radius + 1e-3);

      push.set(0, 0, 0);
      let hit = false;

      this.bvh.shapecast({
        intersectsBounds: (b) => b.intersectsBox(box),
        intersectsTriangle: (tri) => {
          const distance = tri.closestPointToSegment(segment, triPoint, capPoint);
          if (distance >= radius) return false;

          // Push along the triangle's ORIENTED NORMAL, not the radial
          // capPoint−triPoint vector. A box face is two triangles: the
          // capsule sphere can hit one ON its face (radial ≈ normal) and the
          // other on their shared DIAGONAL (radial tilts off-plane, even
          // sideways) — summing those leaned the contact normal away from
          // the true surface, enough to dip an exactly-50° ramp below the
          // walkable slope limit so the step-up misfired mid-climb. Coplanar
          // triangles agree on the normal, so the sum stays honest; only
          // edge/vertex contacts change, and there the two adjacent face
          // normals together still eject the capsule.
          tri.getNormal(dir);
          toMid.subVectors(capPoint, triPoint);
          // signed distance of the capsule point behind this face's plane
          // (<0 = inner side — the flip below ejects it that way)
          const perp = dir.dot(toMid);
          // Phantom edge contact: the centre is INSIDE this face's slab but
          // the closest point is the triangle's BOUNDARY, not the
          // perpendicular foot (distance > |perp|) — the sphere only reaches
          // the face's edge from behind. E.g. a capsule pressed into a steep
          // ramp's buried toe touches the ramp's side face near its shared
          // top edge while sitting ABOVE the box; pushing along that face's
          // normal is sideways-wrong — it tilts the wall normal (+z) and the
          // wall projection then flips the slide velocity every frame (the
          // stuck crawl at ramp toes). The real constraint (the top face)
          // already pushes correctly, so skipping this one loses nothing.
          if (perp < 0 && distance > -perp + 1e-6) return false;
          if (toMid.lengthSq() < 1e-12) toMid.subVectors(segMid, triPoint);
          if (dir.dot(toMid) < 0) dir.negate();

          push.addScaledVector(dir, radius - distance);
          if (dir.y < minNy) minNy = dir.y;
          if (dir.y >= WALKABLE_NY) grounded = true;
          hit = true;
          return false;
        },
      });

      if (!hit) break;
      center.add(push);
      this.pushSum.add(push);
      used = iter + 1;
    }

    return { grounded, iterations: used, push: this.pushSum, minNy };
  }
}
