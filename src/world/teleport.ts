// Test hook: put the player at a given point, feet first.
//
// Kept deliberately small and free of three.js and DOM: the headless check
// imports the very same function the browser exposes, so what the check measures
// is what the running game does. No walk path, no scripted route — the player is
// simply placed at the point, and the light lookup then reads the cell the point
// falls in.
//
// The capsule size is passed in rather than copied here, so this module never
// carries a second definition of it (the game passes CAPSULE from
// src/gameplay/controller.ts).

export interface PointLike {
  x: number;
  y: number;
  z: number;
}

/** The part of a player this hook needs. Duck-typed so the check can pass a
 *  plain object and the game can pass its real controller. */
export interface TeleportablePlayer {
  position: PointLike;
  feet: PointLike;
}

/**
 * Place the body so the FEET land on `feet`. The head goes straight up by the
 * capsule height, which is how a teleport should read: you do not change where
 * the capsule is measured from.
 */
export function teleportPlayer<T extends TeleportablePlayer>(
  player: T,
  feet: PointLike,
  capsule: { height: number; radius: number }
): T {
  player.feet.x = feet.x;
  player.feet.y = feet.y;
  player.feet.z = feet.z;
  player.position.x = feet.x;
  player.position.y = feet.y + capsule.height / 2;
  player.position.z = feet.z;
  return player;
}

/**
 * Expose the hook in the browser as window.liminalTeleport. In Node (the headless
 * check) `window` does not exist, so registering is skipped and the check calls
 * teleportPlayer directly.
 */
export function registerTeleportHook(
  player: TeleportablePlayer,
  capsule: { height: number; radius: number }
): void {
  if (typeof window === 'undefined') return;
  (window as unknown as { liminalTeleport?: (feet: PointLike) => void }).liminalTeleport = (
    feet: PointLike
  ) => teleportPlayer(player, feet, capsule);
}
