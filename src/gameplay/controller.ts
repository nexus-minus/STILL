import * as THREE from 'three';
import type { WorldCollision } from '../world/collision.js';
import type { Action, Bindings } from './bindings.js';
import { requestPointerLockSafe } from '../ui/pointer-lock.js';

const UP = new THREE.Vector3(0, 1, 0);
const DOWN = new THREE.Vector3(0, -1, 0);
const DEG = Math.PI / 180;

/** surfaces steeper than this normal.y (≈50°) act as walls, not floors */
export const SLOPE_LIMIT_COS = Math.cos(50 * DEG);
/** while grounded, pull the capsule flush onto the surface within this range */
const GROUND_SNAP = 0.3;

interface Options {
  height: number;
  radius: number;
  eyeHeight: number;
  walkSpeed: number;
  runSpeed: number;
  jumpSpeed: number;
  gravity: number;
  sensitivity: number;
  /** automatic step-up height — obstacles up to this tall are walked over */
  stepUp: number;
}

const DEFAULTS: Options = {
  height: 1.7,
  radius: 0.35,
  eyeHeight: 1.58,
  walkSpeed: 3.1,
  runSpeed: 5.4,
  jumpSpeed: 5.0,
  gravity: 16,
  sensitivity: 0.22 * DEG,
  stepUp: 0.45,
};

/** capsule dimensions, also used by spawn validation in main */
export const CAPSULE = { height: DEFAULTS.height, radius: DEFAULTS.radius };

/**
 * First-person controller: pointer lock, WASD, capsule collision via the
 * world BVH, head bob, fall-out respawn. Deliberately small — no inventory,
 * no states beyond walking, exactly like the design.
 */
export class PlayerController {
  /** capsule CENTER position, world space */
  readonly position = new THREE.Vector3();
  /** feet position (what gameplay code should read) */
  readonly feet = new THREE.Vector3();

  yaw = 0;
  pitch = 0;
  grounded = false;

  /** live-tunable from the settings menu */
  sensitivityMultiplier = 1;
  invertY = false;
  /**
   * Test-harness hook: headless browsers can't pointer-lock, but the smoke
   * tests walk with real key events. Never set in production paths.
   */
  forceActiveForTest = false;

  /** fired on interact key / click while pointer-locked */
  onInteract?: () => void;

  private readonly opts: Options;
  private readonly binds: Bindings;
  private readonly keys = new Set<string>();
  private readonly velocity = new THREE.Vector3();
  private readonly moveDir = new THREE.Vector3();
  private readonly forward = new THREE.Vector3();
  private readonly right = new THREE.Vector3();
  private readonly frameStart = new THREE.Vector3();
  private readonly totalPush = new THREE.Vector3();
  private readonly spawnFeet: THREE.Vector3;
  private jumpQueued = false;
  private bobPhase = 0;

  constructor(
    private readonly camera: THREE.PerspectiveCamera,
    private readonly canvas: HTMLCanvasElement,
    private readonly collision: WorldCollision,
    feetSpawn: THREE.Vector3,
    bindings: Bindings,
    opts: Partial<Options> = {},
  ) {
    this.opts = { ...DEFAULTS, ...opts };
    this.binds = bindings;
    this.spawnFeet = feetSpawn.clone();
    this.position.copy(feetSpawn).addScaledVector(UP, this.opts.height / 2);
    this.respawnAt(feetSpawn);

    // ---- input -----------------------------------------------------------
    document.addEventListener('keydown', (e) => {
      this.keys.add(e.code);
      if (this.binds.matches('jump', e.code)) {
        this.jumpQueued = true;
        e.preventDefault();
      }
      if (this.binds.matches('interact', e.code) && this.locked) this.onInteract?.();
    });
    document.addEventListener('keyup', (e) => this.keys.delete(e.code));
    window.addEventListener('blur', () => this.keys.clear());

    // mouse buttons as bindable inputs ('Mouse1' = right button etc.)
    canvas.addEventListener('mousedown', (e) => {
      if (!this.locked) return;
      const code = `Mouse${e.button}`;
      this.keys.add(code);
      // parity with keyboard: bound interact/jump must fire from mouse too
      if (this.binds.matches('interact', code)) this.onInteract?.();
      if (this.binds.matches('jump', code)) this.jumpQueued = true;
    });
    window.addEventListener('mouseup', (e) => this.keys.delete(`Mouse${e.button}`));

    document.addEventListener('mousemove', (e) => {
      if (!this.locked) return;
      // clamp: some browsers emit one huge movement spike on lock-enter
      const dx = THREE.MathUtils.clamp(e.movementX, -300, 300);
      const dy = THREE.MathUtils.clamp(e.movementY, -300, 300);
      const sens = this.opts.sensitivity * this.sensitivityMultiplier;
      this.yaw -= dx * sens;
      const turn = dy * sens;
      this.pitch = THREE.MathUtils.clamp(
        this.pitch - (this.invertY ? -turn : turn),
        -89 * DEG,
        89 * DEG,
      );
    });

    canvas.addEventListener('click', () => {
      // interact fires ONLY via the bound action (default E) — a plain click
      // must not trigger it, otherwise bound mouse buttons and old keys both
      // seem to "interact" at once.
      if (!this.locked) requestPointerLockSafe(canvas);
    });
  }

  get locked(): boolean {
    return document.pointerLockElement === this.canvas;
  }

  /** teleport (anchors use this); feet position, falls settle naturally */
  respawnAt(feet: THREE.Vector3): void {
    this.position.copy(feet).addScaledVector(UP, this.opts.height / 2);
    this.velocity.set(0, 0, 0);
    this.syncFeet();
  }

  private down(action: Action): boolean {
    return this.keys.has(this.binds.get(action));
  }

  update(dt: number): void {
    const { opts, velocity } = this;

    // ---- NaN guard: one corrupt value (bad persisted setting, input spike)
    // can poison pitch/yaw/position permanently → "everything looks wrong".
    // Reset loudly instead of rendering garbage.
    if (
      !Number.isFinite(this.pitch) ||
      !Number.isFinite(this.yaw) ||
      !Number.isFinite(this.position.x) ||
      !Number.isFinite(this.position.y) ||
      !Number.isFinite(this.position.z)
    ) {
      console.error('[controller] NaN in player state — resetting', {
        pitch: this.pitch,
        yaw: this.yaw,
        position: this.position.toArray(),
      });
      this.pitch = 0;
      this.yaw = 0;
      this.respawnAt(this.spawnFeet);
      this.velocity.set(0, 0, 0);
    }

    // Unlocked (settings open, menus): no movement input, physics stays alive.
    const active = this.locked || this.forceActiveForTest;

    // ---- desired horizontal movement (yaw-relative) -----------------------
    const fz = active
      ? (this.down('forward') ? 1 : 0) - (this.down('back') ? 1 : 0)
      : 0;
    const rx = active
      ? (this.down('right') ? 1 : 0) - (this.down('left') ? 1 : 0)
      : 0;

    this.forward.set(-Math.sin(this.yaw), 0, -Math.cos(this.yaw));
    this.right.set(Math.cos(this.yaw), 0, -Math.sin(this.yaw));
    this.moveDir
      .set(0, 0, 0)
      .addScaledVector(this.forward, fz)
      .addScaledVector(this.right, rx);
    if (this.moveDir.lengthSq() > 1) this.moveDir.normalize();

    const speed = active && this.down('run') ? opts.runSpeed : opts.walkSpeed;
    const accel = this.grounded ? 14 : 4;
    const t = 1 - Math.exp(-accel * dt);
    velocity.x += (this.moveDir.x * speed - velocity.x) * t;
    velocity.z += (this.moveDir.z * speed - velocity.z) * t;

    // ---- jump / gravity ---------------------------------------------------
    if (active && this.jumpQueued && this.grounded) {
      velocity.y = opts.jumpSpeed;
      this.grounded = false;
    }
    this.jumpQueued = false;

    velocity.y = Math.max(velocity.y - opts.gravity * dt, -55);

    // ---- integrate + resolve (substepped: hitches make big single jumps that
    // could tunnel the capsule straight through floors) ----------------------
    this.frameStart.copy(this.position);
    const intendedH = Math.hypot(velocity.x, velocity.z) * dt;
    const maxDisp = Math.max(Math.abs(velocity.x), Math.abs(velocity.y), Math.abs(velocity.z)) * dt;
    const substeps = Math.max(1, Math.min(6, Math.ceil(maxDisp / (opts.radius * 0.5))));
    const stepDt = dt / substeps;
    let stepGrounded = false;
    this.totalPush.set(0, 0, 0);
    for (let step = 0; step < substeps; step++) {
      this.position.addScaledVector(velocity, stepDt);
      const res = this.collision.resolveCapsule(this.position, opts.height, opts.radius);
      stepGrounded = res.grounded;
      this.totalPush.add(res.push);
    }
    this.grounded = stepGrounded;
    if (this.grounded && velocity.y < 0) velocity.y = 0;

    // ---- contact response: slope limit + stop grinding into walls ---------
    const pushLen = this.totalPush.length();
    if (pushLen > 1e-5) {
      const contactNy = this.totalPush.y / pushLen;
      // steeper than walkable (≈50°): keep the horizontal block, discard the
      // vertical component — steep surfaces become non-climbable
      if (contactNy > 0.12 && contactNy < SLOPE_LIMIT_COS && velocity.y <= 0) {
        this.position.y -= this.totalPush.y;
      }
      // remove the velocity component pressing INTO the contact — this is the
      // stutter/"teleported back" feeling when walking into things
      const px = this.totalPush.x;
      const pz = this.totalPush.z;
      const hLen = Math.hypot(px, pz);
      if (hLen > 1e-4) {
        const ux = px / hLen;
        const uz = pz / hLen;
        const into = velocity.x * ux + velocity.z * uz;
        if (into < 0) {
          velocity.x -= ux * into;
          velocity.z -= uz * into;
        }
      }
    }

    // ---- stick to ground: snap flush onto walkable surfaces — no bouncing,
    // no slow glide down ramps; steep surfaces get no snap (they're walls) --
    if (this.grounded && velocity.y <= 0) {
      const hit = this.collision.raycast(this.position, DOWN, opts.height / 2 + GROUND_SNAP);
      if (hit && (!hit.face || hit.face.normal.y >= SLOPE_LIMIT_COS)) {
        const gap = this.position.y - opts.height / 2 - hit.point.y;
        if (gap > -0.08 && gap <= GROUND_SNAP) {
          this.position.y -= gap;
          velocity.y = 0;
          this.grounded = true;
        }
      }
    }

    // ---- automatic step-up: blocked + grounded + moving -> lift, advance,
    // drop. Accepts only a genuine small gain (0.03..stepUp+0.06) so tall
    // walls and low ceilings still block. -----------------------------------
    const movedH = Math.hypot(this.position.x - this.frameStart.x, this.position.z - this.frameStart.z);
    if (this.grounded && velocity.y <= 0 && intendedH > 0.02 && movedH < intendedH * 0.5) {
      const trial = this.position.clone();
      trial.y += opts.stepUp;
      this.collision.resolveCapsule(trial, opts.height, opts.radius);
      trial.x += velocity.x * dt;
      trial.z += velocity.z * dt;
      this.collision.resolveCapsule(trial, opts.height, opts.radius);
      trial.y -= opts.stepUp + 0.1;
      const drop = this.collision.resolveCapsule(trial, opts.height, opts.radius);
      const gained = trial.y - this.position.y;
      if (drop.grounded && gained > 0.03 && gained <= opts.stepUp + 0.06) {
        this.position.copy(trial);
        this.grounded = true;
        velocity.y = 0;
      }
    }

    // ---- fell out of the world? ------------------------------------------
    if (this.position.y < -60) this.respawnAt(this.spawnFeet);

    this.syncFeet();

    // ---- camera ------------------------------------------------------------
    const speedNow = Math.hypot(velocity.x, velocity.z);
    if (this.grounded && speedNow > 0.4) {
      this.bobPhase += dt * (4 + speedNow * 1.6);
    }
    const bob = this.grounded ? Math.sin(this.bobPhase) * Math.min(speedNow / opts.walkSpeed, 1.2) * 0.032 : 0;

    this.camera.position.set(
      this.feet.x,
      this.feet.y + opts.eyeHeight + bob,
      this.feet.z,
    );
    this.camera.rotation.set(this.pitch, this.yaw, 0, 'YXZ');
  }

  private syncFeet(): void {
    this.feet.copy(this.position).addScaledVector(UP, -this.opts.height / 2);
  }
}
