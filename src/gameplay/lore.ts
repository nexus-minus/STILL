import type { Vector3 } from 'three';

export interface LoreTrigger {
  id: string;
  position: Vector3;
  radius: number;
  text: string;
  /** trigger once (default) or re-fire every visit */
  once?: boolean;
  fired?: boolean;
}

/**
 * STORY / RULES system.
 *
 * Triggers are data — in phase 2 they are Blender objects carrying a `lore`
 * property (the note on the desk, the sign on the wall), exported with the
 * chunk. Nothing about the story lives in engine code; swapping lore = new
 * JSON/data, no recompile.
 *
 * Delivery: HUD text for now -> in-world readable UI + audio in phase 4.
 */
export class LoreSystem {
  private readonly triggers: LoreTrigger[] = [];

  onFound?: (trigger: LoreTrigger) => void;

  addTrigger(trigger: LoreTrigger): void {
    this.triggers.push(trigger);
  }

  /** call each frame with the player's feet position */
  check(playerPos: Vector3): void {
    for (const trigger of this.triggers) {
      if (trigger.once !== false && trigger.fired) continue;
      const dx = playerPos.x - trigger.position.x;
      const dy = playerPos.y - trigger.position.y;
      const dz = playerPos.z - trigger.position.z;
      if (dx * dx + dy * dy + dz * dz > trigger.radius * trigger.radius) continue;
      trigger.fired = true;
      this.onFound?.(trigger);
    }
  }
}
