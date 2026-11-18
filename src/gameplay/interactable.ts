import * as THREE from 'three';
import type { WorldCollision } from '../world/collision.js';

export interface Interactable {
  id: string;
  label?: string;
  /** world position of the interaction target */
  position: THREE.Vector3;
  /** radius of its interaction sphere */
  radius: number;
  /** how close the player must be (ray distance), default 3m */
  reach?: number;
  onInteract?: () => void;
}

/**
 * Click / E targets. Spheres + a line-of-sight check against the world BVH —
 * cheap enough for dozens of objects; if phase 2 ever needs hundreds per
 * chunk, give each chunk a small BVH or a uniform grid.
 *
 * Blender source: objects carrying a custom `interact` property get
 * registered automatically when their chunk loads (phase 2).
 */
export class InteractableSystem {
  private readonly items: Interactable[] = [];
  private readonly ray = new THREE.Ray();

  register(item: Interactable): void {
    this.items.push(item);
  }

  unregister(id: string): void {
    const i = this.items.findIndex((item) => item.id === id);
    if (i >= 0) this.items.splice(i, 1);
  }

  /** Nearest interactable hit by the view ray (walls block it). Fires onInteract. */
  tryInteract(from: THREE.Vector3, dir: THREE.Vector3, collision: WorldCollision): Interactable | null {
    this.ray.set(from, dir);

    const worldHit = collision.raycast(from, dir, 32);
    let best: Interactable | null = null;
    let bestDist = worldHit ? worldHit.distance : Infinity;

    for (const item of this.items) {
      const reach = item.reach ?? 3;
      const t = raySphere(this.ray, item.position, item.radius, Math.min(reach, bestDist));
      if (t !== null && t < bestDist) {
        best = item;
        bestDist = t;
      }
    }

    if (best) best.onInteract?.();
    return best;
  }
}

/** Ray vs sphere. Returns entry distance, or null when out of `maxT`. */
function raySphere(ray: THREE.Ray, center: THREE.Vector3, radius: number, maxT: number): number | null {
  const oc = center.clone().sub(ray.origin);
  const tca = oc.dot(ray.direction);
  if (tca < 0) return null;

  const d2 = oc.lengthSq() - tca * tca;
  const r2 = radius * radius;
  if (d2 > r2) return null;

  const t = tca - Math.sqrt(r2 - d2);
  if (t > maxT) return null;
  return Math.max(t, 0);
}
