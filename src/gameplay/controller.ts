import * as THREE from 'three';
import type { WorldCollision } from '../world/collision.js';
import type { Action, Bindings } from './bindings.js';
import { requestPointerLockSafe } from '../ui/pointer-lock.js';

const UP = new THREE.Vector3(0, 1, 0);
const DOWN = new THREE.Vector3(0, -1, 0);
const DEG = Math.PI / 180;

/** surfaces steeper than this normal.y (≈50°) act as walls, not floors */
export const SLOPE_LIMIT_COS = Math.cos(50 * DEG);
/**
 * Float margin around the walkable limit. Collision normals derive from
 * float32 vertices, so a surface built at EXACTLY 50° can measure a hair
 * below cos50 — without a margin the slope is misjudged as a wall and its
 * upward depenetration push is discarded every frame (the "stalls partway
 * up steep ramps" bug). Within the margin = walkable slope; clearly steeper
 * = a real step/ledge/wall that step-up may climb.
 */
const WALKABLE_EPS = 1e-3;
/** while grounded, pull the capsule flush onto the surface within this range */
const GROUND_SNAP = 0.3;
/**
 * Step-up feel: the physics snap stays instant (collision may never lag),
 * the VIEW eases with this time constant — ~150 ms to settle to 95 %.
 */
const STEP_VIEW_TAU = 0.05;
/** upward corrections below this are terrain noise, not a step-up */
const STEP_VIEW_MIN = 0.06;
/** wall-contact sleep: hold into-wall velocity for this long instead of the
 * per-frame penetrate → push → cancel equilibrium that judders */
const WALL_SLEEP = 0.1;
/**
 * Momentum: speed carried above the walk/sprint cap (downhill runs, landings
 * from a drop) bleeds off toward the cap with this time constant — ~1–2 s to
 * settle, so excess speed never clamps instantly but also doesn't linger.
 */
const MOMENTUM_TAU = 1.0;
/**
 * Classification hold: a single steep contact flips the wall-like verdict
 * ON, and edge contacts (and exactly-limit slopes) alternate between face
 * sets frame to frame — the wall response / sleep / step-up gate then
 * toggled every other frame (stutter on ramps and edges). Hold the steep
 * verdict this long after any steep contact; a genuine walkable contact
 * with no steep face in the window releases it.
 */
const WALL_LIKE_HOLD = 0.1;
/** m/s² — jumpSpeed is derived from this (see JUMP_HEIGHT) */
const GRAVITY = 16;
/**
 * Jump tuning is HEIGHT-driven (user: "jump → 0.5"). Read-only git-history
 * dig: `jumpSpeed` was 5.0 m/s IMPULSE in every commit since the first
 * (c0b2809) — never changed — i.e. a 0.78 m hop at g = 16 ("before").
 * 0.5 was never an impulse in the old units (as an impulse it would be an
 * ~8 mm hop), so 0.5 is the requested hop HEIGHT: v = √(2·g·h) = 4.0 m/s.
 */
const JUMP_HEIGHT = 0.5;
/**
 * Coyote time: after walking off a ledge the jump stays valid this long
 * (~6 frames @60 fps) — players press jump a frame too late and shouldn't
 * just fall. Reset on ground contact, ZEROED by a real jump, so it only
 * ever covers the "walked off" case — never a mid-air second jump.
 */
const COYOTE_MS = 100;
/**
 * Jump input buffer: a press up to this long BEFORE landing still fires
 * (on the landing frame) — an early press used to be swallowed whole and
 * the jump felt unresponsive. Same 100 ms as coyote: the standard
 * "feels instant" input window. No settings, no keybinds — feel only.
 */
const JUMP_BUFFER_MS = 100;

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
  jumpSpeed: Math.sqrt(2 * GRAVITY * JUMP_HEIGHT), // 4.0 m/s → exactly JUMP_HEIGHT
  gravity: GRAVITY,
  sensitivity: 0.22 * DEG,
  stepUp: 0.3, // user tuning: match the tallest common lip, not a counter
};

/** capsule dimensions, also used by spawn validation in main */
export const CAPSULE = { height: DEFAULTS.height, radius: DEFAULTS.radius };

/**
 * First-person controller: pointer lock, WASD, capsule collision via the
 * world BVH, fall-out respawn. Deliberately small — no inventory, no states
 * beyond walking, exactly like the design.
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
  private stepDebugCount = 0;
  /** ms left in which a jump press still counts (see JUMP_BUFFER_MS) */
  private jumpBuffer = 0;
  /** ms of jump grace left after the last ground contact (see COYOTE_MS) */
  private coyote = 0;
  /** view-only Y offset: eased out after a sudden upward correction (step-up) */
  private camYOffset = 0;
  /** remaining seconds of wall-contact sleep + the normal we're pressed into */
  private wallSleep = 0;
  /** remaining seconds of the wall-LIKE classification hold (chatter guard) */
  private wallLikeHold = 0;
  private readonly wallNormal = new THREE.Vector3();
  /** normalized step-up advance direction (reused ray direction) */
  private readonly advanceDir = new THREE.Vector3();
  /** scratch capsule position for the ground-snap penetration probe */
  private readonly snapProbe = new THREE.Vector3();
  /** horizontal motion direction for the gentle-approach ray */
  private readonly predictDir = new THREE.Vector3();
  /** negated wall normal: the wall is BACK along the outward push direction */
  private readonly wallRayDir = new THREE.Vector3();
  /** last walkable contact normal (world) — feeds tangential gravity */
  private readonly slopeN = new THREE.Vector3(0, 1, 0);

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
        this.jumpBuffer = JUMP_BUFFER_MS;
        e.preventDefault();
      }
      if (this.binds.matches('interact', e.code) && this.locked && !this.freecam) this.onInteract?.();
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
      if (this.binds.matches('jump', code)) this.jumpBuffer = JUMP_BUFFER_MS;
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

  /**
   * F: free camera — fly anywhere, no collision, no gravity. Switching back
   * drops the capsule at the camera position and lets physics settle it.
   */
  freecam = false;

  toggleFreecam(): boolean {
    this.freecam = !this.freecam;
    if (this.freecam) {
      this.velocity.set(0, 0, 0);
      this.jumpBuffer = 0;
    } else {
      this.position.copy(this.camera.position);
      this.velocity.set(0, 0, 0);
      this.jumpBuffer = 0;
      this.coyote = 0; // physics resumes fresh — no grace inherited from freecam
      this.camYOffset = 0; // re-entering from freecam snaps, it doesn't ease
      this.wallSleep = 0;
      this.wallLikeHold = 0;
      this.collision.resolveCapsule(this.position, this.opts.height, this.opts.radius);
      this.syncFeet();
    }
    return this.freecam;
  }

  private updateFreecam(dt: number): void {
    const { keys } = this;
    this.jumpBuffer = 0; // swallow space-jump input meant for normal mode
    this.camera.rotation.set(this.pitch, this.yaw, 0, 'YXZ');

    const fz = (keys.has('KeyW') || keys.has('ArrowUp') ? 1 : 0)
      - (keys.has('KeyS') || keys.has('ArrowDown') ? 1 : 0);
    const rx = (keys.has('KeyD') || keys.has('ArrowRight') ? 1 : 0)
      - (keys.has('KeyA') || keys.has('ArrowLeft') ? 1 : 0);
    const ry = (keys.has('Space') ? 1 : 0) - (keys.has('KeyC') ? 1 : 0);

    this.forward.set(0, 0, -1).applyEuler(this.camera.rotation);
    this.right.set(1, 0, 0).applyEuler(this.camera.rotation);
    this.moveDir
      .set(0, 0, 0)
      .addScaledVector(this.forward, fz)
      .addScaledVector(this.right, rx)
      .addScaledVector(UP, ry);
    if (this.moveDir.lengthSq() > 1) this.moveDir.normalize();

    const speed = keys.has('ShiftLeft') || keys.has('ShiftRight') ? 14 : 6;
    this.camera.position.addScaledVector(this.moveDir, speed * dt);
    this.position.copy(this.camera.position); // keep capsule in sync for return
    this.syncFeet();
  }

  /** teleport (anchors use this); feet position, falls settle naturally */
  respawnAt(feet: THREE.Vector3): void {
    this.position.copy(feet).addScaledVector(UP, this.opts.height / 2);
    this.velocity.set(0, 0, 0);
    this.camYOffset = 0; // teleports snap, they don't ease
    this.wallSleep = 0; // contact normal belongs to the old spot
    this.wallLikeHold = 0; // so does the wall-like classification
    this.coyote = 0; // jump grace belongs to the OLD ground, not here
    this.stepDebugCount = 0; // fresh spawn → fresh [stepup] debug budget
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
    if (this.freecam) {
      if (active) this.updateFreecam(dt);
      return;
    }

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

    // ---- smooth speed cap -------------------------------------------------
    // Velocity-based: input steers toward walk/run speed, but speed already
    // carried ABOVE the cap (a downhill run) only blends back toward it with
    // the slow MOMENTUM_TAU drag — never a hard clamp. Braking against the
    // motion keeps the fast curve so control stays responsive.
    const cap = active && this.down('run') ? opts.runSpeed : opts.walkSpeed;
    const tx = this.moveDir.x * cap;
    const tz = this.moveDir.z * cap;
    const speedNow = Math.hypot(velocity.x, velocity.z);
    const accel = this.grounded ? 14 : 3;
    const overCap = speedNow > cap + 1e-3;
    const braking = overCap && velocity.x * tx + velocity.z * tz < 0;
    // Ground + NO input = brake on the fast curve: releasing a sprint must
    // stop in ~0.15 s. The slow momentum tau only applies to speed that is
    // still accounted for — over-cap coasting WITH input (downhill runs keep
    // steering toward the cap) and airborne momentum. Coasting on the ground
    // used to bleed 5.4 → 3.1 over half a second on the tau: "when I press
    // nothing I want to stop".
    const coasting = this.moveDir.lengthSq() < 1e-6;
    const t = braking || (coasting && this.grounded)
      ? 1 - Math.exp(-accel * dt)
      : overCap
        ? 1 - Math.exp(-dt / MOMENTUM_TAU)
        : 1 - Math.exp(-accel * dt);
    velocity.x += (tx - velocity.x) * t;
    velocity.z += (tz - velocity.z) * t;

    // ---- jump / gravity ---------------------------------------------------
    // Fires from ground contact, from COYOTE_MS of recent ground (walked off
    // a ledge), or from a JUMP_BUFFER_MS press made just before landing.
    // Both windows make jump feel instant; the impulse below zeroes BOTH of
    // them, so a real jump can never be followed by a coyote/buffered second
    // jump mid-air (single jump per airtime — the e2e asserts this).
    if (!active) this.jumpBuffer = 0; // menus swallow jump intent, as before
    if (active && this.jumpBuffer > 0 && (this.grounded || this.coyote > 0)) {
      // impulse ADDS to any upward velocity (a jump off a rising slope
      // carries it); from rest this is the plain fixed-height jump
      velocity.y = Math.max(velocity.y, 0) + opts.jumpSpeed;
      this.grounded = false;
      this.coyote = 0; // consumed — no coyote after a real jump
      this.jumpBuffer = 0;
    }

    velocity.y = Math.max(velocity.y - opts.gravity * dt, -55);
    // Momentum: on a slope, add gravity's TANGENT component to horizontal
    // velocity — descents build real, carried speed (the over-cap drag above
    // bleeds it back off), ascents feel the honest pull-back. Flat ground is
    // unaffected (n=(0,1) → component 0); the no-input slope pin zeroes
    // velocity afterwards anyway, so standing still still doesn't slide.
    if (this.grounded) {
      velocity.x += opts.gravity * this.slopeN.y * this.slopeN.x * dt;
      velocity.z += opts.gravity * this.slopeN.y * this.slopeN.z * dt;
    }

    // ---- integrate + resolve (substepped: hitches make big single jumps that
    // could tunnel the capsule straight through floors) ----------------------
    this.frameStart.copy(this.position);
    const intendedH = Math.hypot(velocity.x, velocity.z) * dt;
    // Save the intended horizontal displacement BEFORE contact response: wall
    // projection cancels velocity-into-the-wall, and the step-up trial must
    // re-advance with the ORIGINAL intent (that's what climbs the ledge).
    const intendedDX = velocity.x * dt;
    const intendedDZ = velocity.z * dt;
    // ---- wall-contact sleep: pressing into a wall re-projects velocity
    // every frame (penetrate → push → cancel) and that equilibrium judders.
    // Hold the into-wall component at zero while the press continues — the
    // intent was captured ABOVE, so the step-up trial still climbs with the
    // full push. Armed by wall-like contact below; the window refreshes only
    // while that surface is still within reach, so full control returns
    // ~100 ms after the press (or the wall) ends.
    if (this.wallSleep > 0) {
      this.wallSleep -= dt;
      const into = velocity.x * this.wallNormal.x + velocity.z * this.wallNormal.z;
      // Refresh whenever the wall is STILL THERE — not only while pressing:
      // with the into-wall component already zeroed the window expired
      // anyway, steering re-added the component, penetration returned and
      // the capsule bounced every ~100 ms (the wall stutter). Cast BACK toward
      // the wall: wallNormal is the OUTWARD push, so the surface lies at
      // -wallNormal (the old ray cast +wallNormal — away from the wall —
      // always missed, so the hold never refreshed OR stripped: dead code).
      // The ray still hands control back when the wall ends or the player
      // walks away (ray misses → window decays out).
      this.wallRayDir.copy(this.wallNormal).negate();
      const near = this.collision.raycast(this.position, this.wallRayDir, opts.radius + 0.05);
      if (near) {
        if (into < -1e-4) {
          velocity.x -= this.wallNormal.x * into;
          velocity.z -= this.wallNormal.z * into;
        }
        this.wallSleep = WALL_SLEEP; // contact persists → keep the hold alive
      }
    }
    // ---- gentle approach: a fast walk into a wall-like surface used to
    // PENETRATE up to a full frame of motion (9 cm at sprint) and get yanked
    // back by depenetration — the visible crash jolt ("should be subtle").
    // Predict the steep face in the path and cap the into-face travel to a
    // hair of overlap: contact still registers (step-up gate + wall sleep
    // arm on the first frame) but there's nothing to push back. Only steep
    // faces count — a walkable slope ahead must never be slowed — and only
    // the NORMAL component is limited: tangential keeps direction and speed
    // (no redirect; near-parallel glides are untouched).
    if (intendedH > 1e-4) {
      const invH = 1 / intendedH;
      this.predictDir.set(intendedDX * invH, 0, intendedDZ * invH);
      const ahead = this.collision.raycast(
        this.position, this.predictDir, opts.radius + intendedH + 0.05,
      );
      if (ahead && ahead.face && ahead.face.normal.y < SLOPE_LIMIT_COS - WALKABLE_EPS) {
        const n = ahead.face.normal;
        // normal points back AT us while we approach → negate the ray·normal
        // product to get travel-into-face cosine (and the perpendicular gap).
        const dot = -(this.predictDir.x * n.x + this.predictDir.z * n.z);
        const towards = -(velocity.x * n.x + velocity.z * n.z);
        if (dot > 1e-3 && towards > 1e-6) {
          const gap = ahead.distance * dot - opts.radius; // sphere-to-face
          const maxInto = (Math.max(gap, 0) + 0.001) / dt; // kiss: 1 mm overlap
          if (towards > maxInto) {
            const remove = towards - maxInto;
            velocity.x += n.x * remove;
            velocity.z += n.z * remove;
          }
        }
      }
    }
    const maxDisp = Math.max(Math.abs(velocity.x), Math.abs(velocity.y), Math.abs(velocity.z)) * dt;
    const substeps = Math.max(1, Math.min(6, Math.ceil(maxDisp / (opts.radius * 0.5))));
    const stepDt = dt / substeps;
    let stepGrounded = false;
    let stepMinNy = 1;
    this.totalPush.set(0, 0, 0);
    for (let step = 0; step < substeps; step++) {
      this.position.addScaledVector(velocity, stepDt);
      const res = this.collision.resolveCapsule(this.position, opts.height, opts.radius);
      stepGrounded = res.grounded;
      if (res.minNy < stepMinNy) stepMinNy = res.minNy;
      this.totalPush.add(res.push);
    }
    this.grounded = stepGrounded;
    if (this.grounded && velocity.y < 0) velocity.y = 0;

    // contact classification — needed by BOTH the ground block below (the
    // snap must not fight an active slope lift) and the wall response.
    // wallLike reads the STEEPEST face, not the average: an averaged mix of
    // ramp + vertical riser reads walkable and used to swallow step-ups
    // (stalls at ledges/junctions mid-climb).
    const pushLen = this.totalPush.length();
    const contactNy = pushLen > 1e-5 ? this.totalPush.y / pushLen : 1;
    const steepNow = pushLen > 1e-5 && stepMinNy < SLOPE_LIMIT_COS - WALKABLE_EPS;
    // Hysteresis (WALL_LIKE_HOLD): edges chatter between face sets frame to
    // frame — a raw threshold toggled the wall response, sleep and step-up
    // gate every other frame (stutter against edges). The hold needs an
    // actual contact too, so walking off a wall stops feeding the verdict.
    // Pure-slope walks (30°/50° ramps) never see a steep face → never latch.
    if (steepNow) this.wallLikeHold = WALL_LIKE_HOLD;
    else this.wallLikeHold = Math.max(0, this.wallLikeHold - dt);
    const wallLike = steepNow || (this.wallLikeHold > 0 && pushLen > 1e-5);
    // a walkable SLOPE (not a flat floor) is pushing us this frame
    const slopePush = pushLen > 1e-5 && contactNy < 0.999 && !wallLike;

    // ---- ground support: DOWN-RAY first, then contact response ------------
    // The ray sees the OUTERMOST surface below: a merged-box BVH also keeps
    // faces buried inside other solids (the ramp's end cap under the
    // platform), and projecting velocity onto those phantom faces launched
    // the player walking off edges. Snap flush, project the velocity onto
    // THIS plane (converting into-plane motion — uphill becomes climb
    // velocity — instead of discarding it), remember it for tangential
    // gravity. Steep ray hits get no snap/slide: they're walls.
    let groundNormal: THREE.Vector3 | null = null;
    if (this.grounded || velocity.y <= 0) {
      // range covers the airborne slope-stick's catch window (feet-gap ≤ 0.6)
      const hit = this.collision.raycast(this.position, DOWN, opts.height / 2 + 0.6);
      if (hit && (!hit.face || hit.face.normal.y >= SLOPE_LIMIT_COS - WALKABLE_EPS)) {
        const n = hit.face ? hit.face.normal : UP;
        const gap = this.position.y - opts.height / 2 - hit.point.y;
        // Supported = standing on it, OR (falling toward a SLOPE just below
        // — never flat floors). Walking off a flat onto a steeper descent
        // launches a flat-velocity projectile (the surface falls away faster
        // than gravity catches), which turned whole descents into parabolas
        // that never touched the ramp; sticking keeps them grounded,
        // accelerating and readable. The catch range is generous (edge bumps
        // throw the capsule up a little) but the DOWNWARD correction is
        // clamped per frame — a soft chase, never a yank. Jumps are safe:
        // they need vy > 0 while rising, and the snap never runs then.
        const supported =
          this.grounded || (n.y < 0.999 && gap > -0.08 && gap <= 0.6);
        if (supported) {
          groundNormal = n;
          if (velocity.y <= 0) {
            // Never let the snap UNDO this frame's upward depenetration: at
            // a ramp toe the down-ray hits the flat floor ahead while the
            // ramp face pushes the capsule up — snapping to the lower hit
            // each frame pinned feet.y to 0 and made steep ramps
            // unclimbable. An active walkable slope push also wins. The
            // airborne chase below must not fight that lift either (it
            // yanked the capsule down at wall-on-ramp corners each frame).
            const undoLift =
              gap > 0 &&
              (gap <= this.totalPush.y + 1e-4 || (this.grounded && slopePush));
            if (this.grounded && gap > -0.08 && gap <= GROUND_SNAP && !undoLift) {
              // Never snap INTO geometry: walking off a small edge the centre
              // passes the lip's footprint, the down-ray misses the lip and
              // sees the floor below — snapping down there buries the sphere
              // in the edge corner and the NEXT frame's depenetration bursts
              // the capsule up+forward (+0.35 m measured: the phantom
              // "autjump high then slide down" after small steps). Probe the
              // snapped spot; any overlap means a real edge is holding us —
              // keep the contact placement. Buried-below faces lie outside
              // the flush spot's sphere, so phantom-face snapping still runs.
              let snap = true;
              if (gap > 0.015) {
                this.snapProbe.copy(this.position);
                this.snapProbe.y -= gap;
                const re = this.collision.resolveCapsule(
                  this.snapProbe, opts.height, opts.radius, 3,
                );
                snap = re.push.length() < 0.02;
              }
              if (snap) {
                this.position.y -= gap;
                velocity.y = 0;
              }
            } else if (!this.grounded && gap > -0.08 && gap <= 0.6 && !undoLift) {
              this.position.y -= Math.min(gap, 0.18); // soft slope chase
              velocity.y = 0;
            }
            this.grounded = true;
          }
          // Tangent projection — runs every supported frame (mid-climb with
          // vy > 0 too, otherwise the injected climb velocity gates the
          // projection off for frames and the climb moves in unstable
          // bursts). Only ever removes INTO-plane velocity.
          const vn = velocity.x * n.x + velocity.y * n.y + velocity.z * n.z;
          if (vn < 0) {
            velocity.x -= n.x * vn;
            velocity.y -= n.y * vn;
            velocity.z -= n.z * vn;
          }
          this.slopeN.copy(n); // support surface for next frame's tangential gravity
        }
      }
    }

    // ---- contact response: slope limit + stop grinding into walls ---------
    // wallLike (steepest face) decides: some face below the walkable limit
    // (minus float margin) → wall/step — block, arm the wall sleep, allow
    // the step-up trial; all-walkable → slope — keep the full upward push
    // (walking up P2) and never sleep.
    if (pushLen > 1e-5) {
      // steeper than walkable (≈50°): keep the horizontal block, discard the
      // vertical component — steep surfaces become non-climbable. The eps
      // keeps an exactly-50° face walkable (its normaly sits ON the limit).
      // ONLY with no walkable support under us: on a wall+ground mix the
      // y-push belongs to the floor/ramp below (steep faces contribute
      // dir.y≈0) and rolling it back sank the capsule through floors or
      // juddered it at wall-on-ramp corners. With walkable ground below,
      // the support keeps the capsule up — only the horizontal block matters.
      if (
        contactNy > 0.12 &&
        wallLike &&
        contactNy < SLOPE_LIMIT_COS - WALKABLE_EPS &&
        velocity.y <= 0 &&
        !groundNormal
      ) {
        this.position.y -= this.totalPush.y;
      }
      // remove the velocity component pressing INTO the contact — this is the
      // stutter/"teleported back" feeling when walking into things
      const px = this.totalPush.x;
      const pz = this.totalPush.z;
      if (wallLike) {
        const hLen = Math.hypot(px, pz);
        if (hLen > 1e-4) {
          const ux = px / hLen;
          const uz = pz / hLen;
          const into = velocity.x * ux + velocity.z * uz;
          if (into < 0) {
            velocity.x -= ux * into;
            velocity.z -= uz * into;
          }
          // Wall contact may never ADD or KEEP over-cap speed: the projected
          // tangential of an over-cap approach (downhill momentum) used to
          // ride along the wall above the sprint cap — clamp the POST-
          // projection vector so tangential re-addition can't grow past it.
          const hSpd = Math.hypot(velocity.x, velocity.z);
          if (hSpd > opts.runSpeed) {
            velocity.x *= opts.runSpeed / hSpd;
            velocity.z *= opts.runSpeed / hSpd;
          }
          // only wall-like contact arms the sleep; floors and ramps keep the
          // per-frame projection — sleeping a ramp normal would cancel
          // up-slope walking velocity
          this.wallNormal.set(ux, 0, uz);
          this.wallSleep = WALL_SLEEP;
        }
      } else {
        // walkable push but no usable ray this frame (mid-climb, vy > 0):
        // still remember the surface so tangential gravity keeps acting
        this.slopeN.set(px / pushLen, contactNy, pz / pushLen);
      }
    }

    // ---- automatic step-up ------------------------------------------------
    // Gate = a wall-LIKE contact this frame (some face steeper than 50°): an
    // all-walkable contact is a slope — walk up it, never step it (P3), and
    // because the gate is the contact push itself, the trial runs on the
    // FIRST contact frame — no stall-then-delay (P4; the old movedH ratio
    // stayed above threshold for frames while depenetration bounce inflated
    // it). No vy<=0 condition: while grounded on a slope the tangent
    // projection keeps vy positive (climb velocity) and requiring vy<=0
    // starved the step-up exactly when climbing into a ledge face. Jumps
    // set grounded=false, which still excludes them. The destination is
    // then PROVEN valid before accepting (P5): free space along the
    // advance, headroom above, floor below, no residual overlap.
    let steppedUp = false;
    if (this.grounded && intendedH > 0.004 && wallLike) {
      // The capsule centre sits a full RADIUS behind the riser — advancing one
      // frame of movement (~5cm) never reaches over it. Advance at least
      // radius + margin along the intended direction (that's the climb-over).
      const advLen = Math.hypot(intendedDX, intendedDZ);
      let advX = intendedDX;
      let advZ = intendedDZ;
      if (advLen > 1e-5) {
        const minAdvance = opts.radius + 0.08;
        if (advLen < minAdvance) {
          advX *= minAdvance / advLen;
          advZ *= minAdvance / advLen;
        }
      }
      let realAdv = Math.hypot(advX, advZ);
      const trial = this.position.clone();
      // Measure BEFORE lifting (T5a): one down-ray at the landing column
      // gives the TRUE destination height, so the lift is only what clears
      // THAT — min(stepUp, obstacle + margin). A small lip is climbed with a
      // proportional lift (0.05 lip → 0.10 lift, not the full 0.3) and the
      // drop+settle below lands exactly on the true surface — no overshoot
      // pop, nothing to slide off. Over-tall / walkable-flat destinations
      // keep the standard lift; fit checks and the gained cap still reject.
      let lift = opts.stepUp;
      let measY = -Infinity; // true surface at the intended destination
      const feetY = this.position.y - opts.height / 2;
      const measureAt = (ax: number, az: number): number => {
        trial.set(
          this.position.x + ax,
          this.position.y + opts.stepUp + 0.5,
          this.position.z + az,
        );
        const h = this.collision.raycast(trial, DOWN, opts.stepUp + opts.height / 2 + 0.6);
        if (h && (!h.face || h.face.normal.y >= SLOPE_LIMIT_COS - WALKABLE_EPS)) return h.point.y;
        return -Infinity;
      };
      measY = measureAt(advX, advZ);
      if (!(measY > feetY + 0.02) && realAdv > 0.3) {
        // No step at the full advance: the radius-sized min-advance OVERSHOT
        // a thin lip (the landing column fell past its far edge → measured
        // "nothing to climb" → such edges were never climbed at all). Probe
        // halfway and land there: half of radius+margin still puts the centre
        // ON a 0.1 m-deep lip, so the trial gets its step.
        advX *= 0.5;
        advZ *= 0.5;
        realAdv = Math.hypot(advX, advZ);
        measY = measureAt(advX, advZ);
      }
      if (measY > -Infinity) {
        const obstacleH = measY - feetY;
        if (obstacleH > -0.05) {
          lift = Math.min(opts.stepUp, Math.max(obstacleH + 0.05, 0.02));
        }
      }
      trial.copy(this.position);
      trial.y += lift;
      this.collision.resolveCapsule(trial, opts.height, opts.radius);

      // (fit 1) the landing capsule occupies realAdv + radius ahead of the
      // lifted spot — a hit along that ray means solid sits where we'd
      // materialise (pressing into a corner/wall used to resolve the trial
      // THROUGH thin walls and dump the player outside the map).
      let valid = true;
      if (realAdv > 1e-5) {
        this.advanceDir.set(advX / realAdv, 0, advZ / realAdv);
        valid = !this.collision.raycast(trial, this.advanceDir, realAdv + opts.radius - 0.01);
      }

      let dropGrounded = false;
      let gained = 0;
      let preSettle = this.position.y;
      let settleY = -1;
      if (valid) {
        trial.x += advX;
        trial.z += advZ;
        this.collision.resolveCapsule(trial, opts.height, opts.radius);
        trial.y -= lift + 0.1; // proportional drop (matches the lift)
        const drop = this.collision.resolveCapsule(trial, opts.height, opts.radius);
        dropGrounded = drop.grounded;
        // Settle BEFORE judging the gain: depenetration overshoot (capsule
        // propped on a corner, or dropped inside geometry) reads as a fake
        // climb otherwise — the accept would teleport the player against flat
        // walls. Settling first puts the feet ON the landed surface, so
        // `gained` becomes the REAL step height. Range reaches 0.5 below the
        // START: the drop-resolve can overshoot the centre up to ~0.8 m after
        // the settle origin, and with stepUp 0.3 the old +0.15 range missed a
        // 0.25 lip by a centimetre — the overshoot then slipped through the
        // gained cap as a 0.71 m pop.
        const settleFar = opts.height / 2 + opts.stepUp + 0.5;
        const hit = this.collision.raycast(trial, DOWN, settleFar);
        preSettle = trial.y;
        // Land at the true surface — but never BELOW the measured one: the
        // drop-resolve can SHOVE the trial sideways past a thin lip's far
        // edge (logged at x=4.66 for a lip ending at 4.6), the local ray then
        // sees the floor and the climb reads as "nothing here" — an edge you
        // can never walk over. The capsule still overlaps the obstacle it
        // was shoved across, so it rests on max(local, measured).
        let surface = measY;
        if (hit && (!hit.face || hit.face.normal.y >= SLOPE_LIMIT_COS - WALKABLE_EPS)) {
          surface = Math.max(surface, hit.point.y);
        }
        settleY = Number.isFinite(surface) ? surface : -1;
        if (Number.isFinite(surface)) {
          const gap = trial.y - opts.height / 2 - surface;
          if (gap > -0.1 && gap <= opts.stepUp + opts.radius + 0.15) {
            trial.y -= gap;
          }
        }

        // Motion is BOUNDED by the advance: drop-settle can walk the spot
        // sideways/deeper (sphere catching a step's top edge depenetrates
        // INTO the footprint), which read as a >1 m teleport on accept.
        // Pull back onto the advance line + margin and re-settle there.
        const drX = trial.x - this.position.x;
        const drZ = trial.z - this.position.z;
        const drift = Math.hypot(drX, drZ);
        const maxDrift = realAdv + 0.1;
        if (drift > maxDrift) {
          trial.x = this.position.x + (drX * maxDrift) / drift;
          trial.z = this.position.z + (drZ * maxDrift) / drift;
          const hit2 = this.collision.raycast(trial, DOWN, opts.height / 2 + opts.stepUp + 0.5);
          // same rule as the first settle: never below the measured surface
          let surface2 = measY;
          if (hit2 && (!hit2.face || hit2.face.normal.y >= SLOPE_LIMIT_COS - WALKABLE_EPS)) {
            surface2 = Math.max(surface2, hit2.point.y);
          }
          if (Number.isFinite(surface2)) {
            const gap2 = trial.y - opts.height / 2 - surface2;
            if (gap2 > -0.1 && gap2 <= opts.stepUp + opts.radius + 0.15) trial.y -= gap2;
            else valid = false;
          } else {
            valid = false;
          }
        }

        // (fit 2) headroom: no geometry clipping the capsule top at the
        // landing spot (low overhang above a step).
        // (fit 3) no residual overlap: re-resolving a copy must be a no-op —
        // a destination wedged inside geometry keeps correcting and would
        // drag the player deeper on accept.
        const above = this.collision.raycast(trial, UP, opts.height / 2 + 1e-3);
        const probe = trial.clone();
        const re = this.collision.resolveCapsule(probe, opts.height, opts.radius, 4);
        valid = !above && re.push.length() < 0.02 && probe.distanceTo(trial) < 0.05;
        gained = trial.y - this.position.y;
      }

      // Depenetration can overshoot (summed corrections settle up to a radius
      // high over the corner) — accept that range and settle down after.
      // Floor 0.015 (was 0.03): the edge graze can lift the player a hair
      // before the trial runs (0.05 lip − 0.02 graze = 0.03 read), which
      // starved the smallest steps; flat destinations read ≤ 0 and are
      // sign-rejected anyway.
      const inRange =
        valid && dropGrounded && gained > 0.015 && gained <= opts.stepUp + opts.radius + 0.1;
      // attempts are budgeted (console spam); real ACCEPTS always log —
      // they're rare and every one must be auditable in the e2e traces
      const attemptLog = inRange || this.stepDebugCount < 8;
      if (attemptLog) {
        this.stepDebugCount++;
        console.info(
          `[stepup] attempt intended=${intendedH.toFixed(3)} lift=${lift.toFixed(2)} ` +
            `adv=(${advX.toFixed(2)},${advZ.toFixed(2)}) gained=${gained.toFixed(3)} ` +
            `dropY=${(preSettle - opts.height / 2).toFixed(2)} hitY=${settleY.toFixed(2)} ` +
            `grounded=${dropGrounded} valid=${valid} accepted=${inRange} ` +
            `trial=(${trial.x.toFixed(2)},${trial.y.toFixed(2)},${trial.z.toFixed(2)})`,
        );
      }
      if (inRange) {
        this.position.copy(trial);
        this.grounded = true;
        velocity.y = 0;
        steppedUp = true;
        // the riser is behind us now — drop the wall sleep, otherwise holding
        // forward would stall the walk-on for the rest of the window
        this.wallSleep = 0;
        this.wallNormal.set(0, 0, 0);
      }
    }

    // ---- stand still on a walkable slope: with no input, cancel the
    // tangential drift AND the depenetration creep (gravity pushes us back
    // along the surface normal every frame, which walks a resting player
    // down the ramp — that's the reported slide). Flat ground keeps its
    // normal momentum decay; input pressed → no pin (walking down a ramp
    // must work). Skipped right after a step-up so the climb's horizontal
    // advance is never undone.
    if (groundNormal && groundNormal.y < 0.999 && !steppedUp && this.moveDir.lengthSq() < 1e-6) {
      velocity.set(0, 0, 0);
      this.position.x = this.frameStart.x;
      this.position.z = this.frameStart.z;
      // Re-snap at the restored x: the ground raycast above ran AFTER
      // depenetration pushed us down-slope, so it measured the surface
      // ~push.x away — pinning x back without this would leave the capsule
      // (and the eye) sunk into the ramp by that drop.
      const hit = this.collision.raycast(this.position, DOWN, opts.height / 2 + GROUND_SNAP);
      if (hit && (!hit.face || hit.face.normal.y >= SLOPE_LIMIT_COS - WALKABLE_EPS)) {
        const gap = this.position.y - opts.height / 2 - hit.point.y;
        if (gap > -0.08 && gap <= GROUND_SNAP) this.position.y -= gap;
      }
    }

    // ---- jump timing windows (AFTER every grounded write — resolve, ground
    // snap, step-up: each of those counts as ground contact) ---------------
    // Coyote: refreshed while grounded, burned down while airborne. A real
    // jump zeroed it above and nothing re-arms it until the next landing, so
    // the grace only ever covers walking off a ledge — never a double jump.
    if (this.grounded) this.coyote = COYOTE_MS;
    else this.coyote = Math.max(0, this.coyote - dt * 1000);
    // Buffer: ages every frame; consumed by the jump above when it fires.
    this.jumpBuffer = Math.max(0, this.jumpBuffer - dt * 1000);

    // ---- fell out of the world? ------------------------------------------
    if (this.position.y < -60) this.respawnAt(this.spawnFeet);

    this.syncFeet();

    // ---- camera ------------------------------------------------------------
    // Rock-steady view: no walk bob (user request — walking must not shake
    // the camera). The eye only ever moves with the feet plus the step-up
    // ease below; mouse look untouched.

    // Step-up teleports the capsule up in one frame. The physics snap must
    // stay instant (collision may never lag), so the EYE eases instead: a
    // sudden upward correction while grounded parks the view at the old
    // height and lets it catch up over ~150 ms. Jumps (vy > 0 / airborne)
    // and falls are never eased; the dt-scaled threshold keeps even a run up
    // the steepest walkable ramp out of it (climb rate < runSpeed·dt).
    const rise = this.position.y - this.frameStart.y;
    this.camYOffset *= Math.exp(-dt / STEP_VIEW_TAU);
    if (this.grounded && velocity.y <= 0 && rise > Math.max(STEP_VIEW_MIN, opts.runSpeed * dt * 0.9)) {
      this.camYOffset -= rise; // hold the view here, then ease up to the feet
    }

    this.camera.position.set(
      this.feet.x,
      this.feet.y + opts.eyeHeight + this.camYOffset,
      this.feet.z,
    );
    this.camera.rotation.set(this.pitch, this.yaw, 0, 'YXZ');
  }

  private syncFeet(): void {
    this.feet.copy(this.position).addScaledVector(UP, -this.opts.height / 2);
  }
}
