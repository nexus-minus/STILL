import * as THREE from 'three';
import type { WorldCollision } from '../world/collision.js';

const UP = new THREE.Vector3(0, 1, 0);
const DEG = Math.PI / 180;

interface Options {
  height: number;
  radius: number;
  eyeHeight: number;
  walkSpeed: number;
  runSpeed: number;
  jumpSpeed: number;
  gravity: number;
  sensitivity: number;
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
};

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

  /** fired on click / E while pointer-locked */
  onInteract?: () => void;

  private readonly opts: Options;
  private readonly keys = new Set<string>();
  private readonly velocity = new THREE.Vector3();
  private readonly moveDir = new THREE.Vector3();
  private readonly forward = new THREE.Vector3();
  private readonly right = new THREE.Vector3();
  private readonly spawnFeet: THREE.Vector3;
  private jumpQueued = false;
  private bobPhase = 0;

  constructor(
    private readonly camera: THREE.PerspectiveCamera,
    private readonly canvas: HTMLCanvasElement,
    private readonly collision: WorldCollision,
    feetSpawn: THREE.Vector3,
    opts: Partial<Options> = {},
  ) {
    this.opts = { ...DEFAULTS, ...opts };
    this.spawnFeet = feetSpawn.clone();
    this.position.copy(feetSpawn).addScaledVector(UP, this.opts.height / 2);
    this.respawnAt(feetSpawn);

    // ---- input -----------------------------------------------------------
    document.addEventListener('keydown', (e) => {
      this.keys.add(e.code);
      if (e.code === 'Space') {
        this.jumpQueued = true;
        e.preventDefault();
      }
      if (e.code === 'KeyE' && this.locked) this.onInteract?.();
    });
    document.addEventListener('keyup', (e) => this.keys.delete(e.code));
    window.addEventListener('blur', () => this.keys.clear());

    document.addEventListener('mousemove', (e) => {
      if (!this.locked) return;
      this.yaw -= e.movementX * this.opts.sensitivity;
      this.pitch = THREE.MathUtils.clamp(
        this.pitch - e.movementY * this.opts.sensitivity,
        -89 * DEG,
        89 * DEG,
      );
    });

    canvas.addEventListener('click', () => {
      if (this.locked) this.onInteract?.();
      else void canvas.requestPointerLock();
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

  update(dt: number): void {
    const { opts, keys, velocity } = this;

    // ---- desired horizontal movement (yaw-relative) -----------------------
    const fz = (keys.has('KeyW') || keys.has('ArrowUp') ? 1 : 0)
      - (keys.has('KeyS') || keys.has('ArrowDown') ? 1 : 0);
    const rx = (keys.has('KeyD') || keys.has('ArrowRight') ? 1 : 0)
      - (keys.has('KeyA') || keys.has('ArrowLeft') ? 1 : 0);

    this.forward.set(-Math.sin(this.yaw), 0, -Math.cos(this.yaw));
    this.right.set(Math.cos(this.yaw), 0, -Math.sin(this.yaw));
    this.moveDir
      .set(0, 0, 0)
      .addScaledVector(this.forward, fz)
      .addScaledVector(this.right, rx);
    if (this.moveDir.lengthSq() > 1) this.moveDir.normalize();

    const speed = keys.has('ShiftLeft') || keys.has('ShiftRight') ? opts.runSpeed : opts.walkSpeed;
    const accel = this.grounded ? 14 : 4;
    const t = 1 - Math.exp(-accel * dt);
    velocity.x += (this.moveDir.x * speed - velocity.x) * t;
    velocity.z += (this.moveDir.z * speed - velocity.z) * t;

    // ---- jump / gravity ---------------------------------------------------
    if (this.jumpQueued && this.grounded) {
      velocity.y = opts.jumpSpeed;
      this.grounded = false;
    }
    this.jumpQueued = false;

    velocity.y = Math.max(velocity.y - opts.gravity * dt, -55);

    // ---- integrate + resolve ---------------------------------------------
    this.position.addScaledVector(velocity, dt);
    const res = this.collision.resolveCapsule(this.position, opts.height, opts.radius);
    this.grounded = res.grounded;
    if (this.grounded && velocity.y < 0) velocity.y = 0;

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
