import * as THREE from 'three/webgpu';
import { createRenderer, hookWebGPUErrors, type Backend } from './render/renderer.js';
import { FramePipeline } from './render/pipeline.js';
import { createPostChain } from './render/passes/post.js';
import { createAdvancedRenderer, type AdvancedRenderer } from './render/rt.js';
import { QualityManager, detectTier } from './render/quality.js';
import { loadWorld } from './world/map-loader.js';
import { WorldCollision } from './world/collision.js';
import { PlayerController, CAPSULE } from './gameplay/controller.js';
import { InteractableSystem } from './gameplay/interactable.js';
import { AnchorRegistry } from './gameplay/anchors.js';
import { MapDevice } from './gameplay/map-device.js';
import { LoreSystem } from './gameplay/lore.js';
import { createTransport } from './core/transport.js';
import { hud } from './ui/hud.js';
import { loadSettings, initSettings } from './ui/settings.js';
import { requestPointerLockSafe } from './ui/pointer-lock.js';
import { Bindings, loadBinds } from './gameplay/bindings.js';

// ---- startup watchdog -------------------------------------------------------
// If startup hangs anywhere (a promise that never settles, a driver call that
// blocks), the player gets a message naming the stuck stage instead of an
// eternal black screen with no error. Cleared when main() finishes.
let startupStage = 'boot';
const setStage = (stage: string): void => {
  startupStage = stage;
};

window.setTimeout(() => {
  if ((window as unknown as { __liminalReady?: boolean }).__liminalReady) return;
  const fatalEl = document.getElementById('fatal');
  if (fatalEl && fatalEl.style.display === 'block') return; // a real error already showed
  const err = new Error(
    `startup is stuck at stage "${startupStage}" — no error was raised\n` +
      `(a graphics call is probably hanging in this browser/driver)`,
  );
  console.error('[liminal]', err.message);
  hud.fatal(err);
}, 20000);

async function main(): Promise<void> {
  const overlay = document.getElementById('overlay') as HTMLDivElement;

  // An explicit rtdebug request always retries the GPU path — a compat flag
  // parked by an earlier auto-recovery would boot WebGL2 and make the debug
  // modes silently inert ("looks the same as normal").
  const rtDebugParam = Number(new URLSearchParams(location.search).get('rtdebug') ?? 0);
  if (rtDebugParam > 0) {
    try {
      sessionStorage.removeItem('liminal.forcegl');
    } catch {
      /* private mode */
    }
  }

  // ---- renderer: WebGPU first, WebGL2 fallback, fresh canvas per attempt ---
  setStage('renderer');
  const initialCanvas = document.getElementById('game') as HTMLCanvasElement;
  const { renderer, backend, canvas, diagnostics } = await createRenderer(initialCanvas);
  // Match Blender's default view transform so the game looks like the viewport
  // (Blender 4/5 defaults to AgX).
  renderer.toneMapping = THREE.AgXToneMapping;
  renderer.toneMappingExposure = 1.0;

  // ---- scene --------------------------------------------------------------
  setStage('room');
  const scene = new THREE.Scene();
  scene.background = new THREE.Color(0x040404);
  const camera = new THREE.PerspectiveCamera(76, 1, 0.05, 300);

  // ---- world: Blender export (manifest+objects.glb) or test-room fallback --
  setStage('map');
  const world = await loadWorld({
    forceTest: new URLSearchParams(location.search).has('testroom'),
  });
  scene.add(world.group);
  setStage('collision');
  const collision = WorldCollision.fromMeshes(world.collisionMeshes);

  // ---- spawn probe (their rules): ground UNDER the feet at the authored
  // point — never from bounds top (that grabs roofs), never bounds-center
  // (scattered lights skew it). Checkpoint rule: probe down from the
  // checkpoint; wall-clipping resolves itself via capsule depenetration.
  let spawnFeet = world.spawn;
  if (world.source === 'map') {
    const down = new THREE.Vector3(0, -1, 0);
    const min = world.bounds.min;
    const max = world.bounds.max;
    const probeDown = (from: THREE.Vector3): THREE.Vector3 | null => {
      const hit = collision.raycast(from, down, 200);
      return hit ? hit.point.clone().addScaledVector(down, -0.05) : null;
    };

    const cpSpawn = world.checkpoints.find((cp) => cp.kind === 'spawn');
    const attempts: Array<() => THREE.Vector3 | null> = [];
    if (cpSpawn) {
      // their rule: ~1m ring around the checkpoint where ground is and no wall
      const RING: Array<[number, number]> = [
        [1, 0], [-1, 0], [0, 1], [0, -1],
        [0.71, 0.71], [0.71, -0.71], [-0.71, 0.71], [-0.71, -0.71],
        [0, 0],
      ];
      attempts.push(() => {
        for (const [dx, dz] of RING) {
          const x = cpSpawn.position.x + dx;
          const z = cpSpawn.position.z + dz;
          const feet = probeDown(new THREE.Vector3(x, cpSpawn.position.y + 1.5, z));
          if (!feet) continue;
          if (Math.abs(feet.y - cpSpawn.position.y) > 1.5) continue; // ground near the point
          // not inside a wall: depenetration must not shove us sideways
          const trial = feet
            .clone()
            .addScaledVector(new THREE.Vector3(0, 1, 0), CAPSULE.height / 2 + 0.02);
          const res = collision.resolveCapsule(trial, CAPSULE.height, CAPSULE.radius);
          if (Math.hypot(res.push.x, res.push.z) > 0.15) continue;
          return feet;
        }
        return null;
      });
    }
    // default: their stated start (0,0) from just above walking height
    attempts.push(() => probeDown(new THREE.Vector3(0, 3, 0)));
    // grid scans, starting UNDER roofs, then from above as last resort
    const grid = (fromY: number): (() => THREE.Vector3 | null)[] => {
      const pts: Array<[number, number]> = [
        [0.5, 0.5], [0.3, 0.3], [0.7, 0.7], [0.3, 0.7], [0.7, 0.3],
        [0.15, 0.5], [0.85, 0.5], [0.5, 0.15], [0.5, 0.85],
      ];
      return pts.map(([fx, fz]) => () =>
        probeDown(new THREE.Vector3(min.x + (max.x - min.x) * fx, fromY, min.z + (max.z - min.z) * fz)));
    };
    attempts.push(...grid(Math.max(max.y - 0.5, 3)));
    attempts.push(...grid(max.y + 2));

    let feet: THREE.Vector3 | null = null;
    for (const attempt of attempts) {
      feet = attempt();
      if (feet) break;
    }

    if (feet) {
      spawnFeet = feet;
      console.info(`[world] spawn probe landed at [${feet.toArray().map((v) => v.toFixed(1)).join(', ')}]`);
    } else {
      console.warn('[world] spawn probe found NO ground — add a kind="spawn" checkpoint');
    }
  }

  // ---- quality + render pipeline -----------------------------------------
  setStage('pipeline');
  const persisted = loadSettings();
  renderer.toneMappingExposure = persisted.exposure ?? 1.0;
  const quality = new QualityManager(persisted.tier ?? detectTier(backend as Backend));
  if (persisted.renderScale !== undefined) quality.setOverride('renderScale', persisted.renderScale);
  if (persisted.raytracedLighting !== undefined) {
    quality.setOverride('raytracedLighting', persisted.raytracedLighting);
  }
  const pipeline = new FramePipeline(renderer);
  pipeline.setPost(createPostChain(renderer, scene, camera));

  const applyQuality = (): void => {
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2) * quality.settings.renderScale);
  };
  quality.onChange = () => applyQuality();
  applyQuality();

  // ---- raytraced path (WebGPU only; graceful failure is the design) ----------
  // Construction or WGSL validation errors never take the game down: we keep
  // the standard post chain as the permanent fallback and say so on screen.
  const rtDebug = rtDebugParam;
  setStage('raytracing');
  let advanced: AdvancedRenderer | undefined;
  if (backend === 'webgpu') {
    try {
      // fresh world matrices BEFORE the GPU BVH bakes transforms — stale
      // identity matrices would park all geometry at local origins
      scene.updateMatrixWorld(true);
      camera.updateMatrixWorld(true);
      advanced = createAdvancedRenderer(renderer, scene, camera, world.shadowMeshes, world.rtLights);
      advanced.setLogicalSize(window.innerWidth, window.innerHeight);
      if (rtDebug > 0) {
        advanced.setDebugMode(rtDebug);
        // a debug request implies "I want the traced path" — never let a
        // potato-tier override leave rtdebug silently inert
        quality.setOverride('raytracedLighting', true);
        console.info(
          `[rt] debug mode ${rtDebug} (1=uv gradient, 2=red=miss/green=hit) — ` +
            'black-frame detector paused, raytraced lighting forced on',
        );
        hud.message(
          rtDebug === 2
            ? 'RT DEBUG — bright green: lit · dark green: SHADOW · red: miss'
            : rtDebug === 3
              ? 'RT DEBUG 3 — raw lighting buffer (no albedo, no emissive)'
              : 'RT DEBUG 1 — uv gradient',
          9000,
        );
      }
      pipeline.setAdvanced(advanced);
      let rtErrorShown = false;
      hookWebGPUErrors(renderer, () => {
        if (rtErrorShown) return;
        rtErrorShown = true;
        pipeline.setAdvanced(undefined);
        console.error('[rt] raytraced path disabled after a WebGPU error (see message above)');
        hud.message('raytracing disabled after a GPU error — standard renderer (details in console)', 9000);
      });
      console.info('[rt] raytraced lighting armed (medium+ tiers)');
    } catch (err) {
      console.warn('[rt] raytraced path unavailable, using standard path', err);
      hud.message('raytracing unavailable on this device — standard renderer', 6000);
      advanced = undefined;
    }
  }

  // ---- gameplay systems ----------------------------------------------------
  setStage('input');
  const bindings = new Bindings(loadBinds());
  const controller = new PlayerController(camera, canvas, collision, spawnFeet, bindings);
  controller.sensitivityMultiplier = persisted.sensitivity ?? 1;
  controller.invertY = persisted.invertY ?? false;
  const interactables = new InteractableSystem();
  const anchors = new AnchorRegistry();
  const map = new MapDevice();
  const lore = new LoreSystem();
  const transport = createTransport();
  setStage('transport');
  await transport.connect();
  setStage('hud');

  // ---- interactables: demo wiring (test room) or Blender checkpoints --------
  if (world.source === 'test' && world.demo) {
    const demo = world.demo;
    interactables.register({
      id: 'anchor-01',
      label: 'beacon (room A)',
      position: demo.anchorInteract,
      radius: 0.9,
      onInteract: () => {
        const count = anchors.list().length;
        anchors.activate({
          id: 'anchor-01',
          label: 'Beacon · Room A',
          position: { x: demo.anchorFeet.x, y: demo.anchorFeet.y, z: demo.anchorFeet.z },
        });
        hud.message(`beacon registered — respawn point set (${count + 1} total)`);
      },
    });
    lore.addTrigger({
      id: 'RULE-001',
      position: demo.loreTrigger,
      radius: 1.7,
      text: 'RULE 001 — if something calls your name, do not answer.',
    });
  } else {
    for (const cp of world.checkpoints) {
      if (cp.kind === 'spawn') continue; // spawn marker, not clickable
      interactables.register({
        id: cp.name,
        label: cp.label,
        position: cp.position,
        radius: cp.radius,
        onInteract: () => {
          anchors.activate({
            id: cp.name,
            label: cp.label,
            position: { x: cp.position.x, y: cp.position.y, z: cp.position.z },
          });
          hud.message(`checkpoint — ${cp.label} (client-side)`, 2500);
        },
      });
    }
  }
  lore.onFound = (trigger) => {
    hud.message(`${trigger.id} · ${trigger.text}`, 8000);
    void trigger;
  };

  controller.onInteract = () => {
    const dir = camera.getWorldDirection(new THREE.Vector3());
    const hit = interactables.tryInteract(camera.position, dir, collision);
    if (!hit) hud.message('nothing here', 900);
  };

  // ---- HUD / hotkeys --------------------------------------------------------
  const statsLine = (fps: number): string => {
    const f = controller.feet;
    return (
      `${backend} · ${quality.tier} · ${fps} fps\n` +
      `x ${f.x.toFixed(1)}  y ${f.y.toFixed(1)}  z ${f.z.toFixed(1)}`
    );
  };

  const sessionForced = (() => {
    try {
      return sessionStorage.getItem('liminal.forcegl') === '1';
    } catch {
      return false;
    }
  })();
  const urlForced = new URLSearchParams(location.search).get('forcegl') === '1';

  const settings = initSettings({
    quality,
    bindings,
    controller,
    hasRaytracing: backend === 'webgpu',
    getExposure: () => renderer.toneMappingExposure,
    setExposure: (value) => {
      renderer.toneMappingExposure = value;
    },
    onResume: () => {
      // Chrome forbids immediate relock after an Esc-exit (SecurityError) —
      // show the click-to-enter overlay as the guaranteed path, and retry
      // silently once the cooldown passes (success hides it again).
      overlay.classList.remove('hidden');
      window.setTimeout(() => {
        if (document.pointerLockElement !== canvas) requestPointerLockSafe(canvas);
      }, 1400);
    },
  });

  document.addEventListener('keydown', (e) => {
    if (settings.isOpen) return; // menu owns the keyboard (incl. remap capture)
    if (bindings.matches('quality', e.code)) {
      quality.setTier(quality.next());
      hud.message(`quality — ${quality.tier}`, 1500);
    }
    if (bindings.matches('map', e.code)) hud.toggleMap();
    if (bindings.matches('glow', e.code)) {
      const on = pipeline.toggleGlow();
      hud.message(`glow ${on ? 'on' : 'off'}`, 1500);
      console.info(`[liminal] glow toggled ${on ? 'on' : 'off'} by user`);
    }
    // escape hatch: the auto-recovery parks a session flag that keeps WebGPU
    // off until the tab closes — G retries immediately (for after bug fixes)
    if (e.code === 'KeyG' && (sessionForced || urlForced)) {
      try {
        sessionStorage.removeItem('liminal.forcegl');
      } catch {
        /* private mode */
      }
      if (urlForced) {
        const url = new URL(location.href);
        url.searchParams.delete('forcegl');
        history.replaceState(null, '', url);
      }
      hud.message('retrying WebGPU…', 1500);
      window.setTimeout(() => location.reload(), 500);
    }
    // dev view: N = wireframe, so the exact collision/render mesh is visible
    if (e.code === 'KeyN') {
      wireframeOn = !wireframeOn;
      const seen = new Set<THREE.Material>();
      world.group.traverse((obj) => {
        const mesh = obj as THREE.Mesh;
        if (!mesh.isMesh) return;
        const materials = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
        for (const material of materials) {
          if (seen.has(material)) continue;
          seen.add(material);
          (material as THREE.MeshStandardMaterial).wireframe = wireframeOn;
        }
      });
      hud.message(`wireframe ${wireframeOn ? 'on — this is the collision mesh' : 'off'}`, 2500);
    }
    if (bindings.matches('respawn', e.code)) {
      const latest = anchors.list().sort((a, b) => b.discoveredAt - a.discoveredAt)[0];
      if (latest) {
        controller.respawnAt(new THREE.Vector3(latest.position.x, latest.position.y, latest.position.z));
        hud.message(`respawned — ${latest.label}`, 2000);
      }
    }
  });

  overlay.addEventListener('click', () => requestPointerLockSafe(canvas));
  canvas.addEventListener('contextmenu', (e) => e.preventDefault()); // bindable right mouse
  let everLocked = false;
  document.addEventListener('pointerlockchange', () => {
    const locked = document.pointerLockElement === canvas;
    if (locked) {
      everLocked = true;
      overlay.classList.add('hidden');
      settings.close();
    } else if (everLocked) {
      // Esc (or any unlock) after first entry -> settings menu
      settings.open();
    }
  });

  // ---- resize ----------------------------------------------------------------
  const resize = (): void => {
    const w = window.innerWidth;
    const h = window.innerHeight;
    renderer.setSize(w, h, false);
    camera.aspect = w / h;
    camera.updateProjectionMatrix();
    advanced?.setLogicalSize(w, h);
  };
  window.addEventListener('resize', resize);
  resize();

  // ---- graphics diagnostics + safety net ------------------------------------
  // On the GL backend: identify the actual driver, catch context loss, and
  // auto-disable the glow chain if it produces black frames (some Linux GL
  // stacks misbehave with the TSL post pipeline — better to degrade than to
  // hand the player a black screen).
  let glRendererInfo = 'n/a';
  let glCtx: WebGL2RenderingContext | null = null;
  const driverEl = document.getElementById('driver');
  if (backend === 'webgl2') {
    glCtx = canvas.getContext('webgl2');
    const dbg = glCtx?.getExtension('WEBGL_debug_renderer_info');
    glRendererInfo = dbg
      ? String(glCtx?.getParameter(dbg.UNMASKED_RENDERER_WEBGL))
      : String(glCtx?.getParameter(glCtx.RENDERER));
    console.info('[liminal] GL renderer:', glRendererInfo);
    if (driverEl) driverEl.textContent = glRendererInfo;

    // Software rasterizers (SwiftShader/llvmpipe) draw every pixel on the CPU —
    // the glow chain is full-screen passes, i.e. the most expensive thing we
    // could ask a CPU rasterizer for. Default it off there; B re-enables it.
    if (/swiftshader|llvmpipe|softwarerasterizer|software/i.test(glRendererInfo)) {
      pipeline.setGlowEnabled(false);
      console.info('[liminal] software rasterizer detected — glow off for performance (B re-enables)');
      hud.message('software rendering — glow off for performance (B turns it on)', 6000);
    }

    canvas.addEventListener('webglcontextlost', (e) => {
      e.preventDefault();
      console.error('[liminal] WebGL context LOST — display driver problem. GL:', glRendererInfo);
      hud.message('graphics context lost — reload the page (details in console)', 10000);
    });
  } else if (driverEl) {
    driverEl.textContent = 'WebGPU device';
  }

  // ---- black-frame sampling (both backends) --------------------------------
  // GL: direct readPixels of the drawing buffer.
  // WebGPU: same-frame drawImage into a tiny 2D canvas — WebGPU has no
  // synchronous readback, and this is the backend whose silent black deaths
  // (flaky driver stacks) historically went completely unnoticed.
  // Threshold: max channel < 8/255 counts as black — our near-black background
  // survives tonemapping at ~2-3, so a scene that "renders" but looks pitch
  // black still trips the net, while a working frame (geometry at 100+) never does.
  let frameNo = 0;
  let blackChecks = 0;
  let recoveryScheduled = false;
  const samplePixel = new Uint8Array(4);
  const sample2d = document.createElement('canvas');
  sample2d.width = 16;
  sample2d.height = 10;
  const sample2dCtx = sample2d.getContext('2d', { willReadFrequently: true });

  const frameIsBlackGL = (): boolean => {
    if (!glCtx) return false;
    const w = glCtx.drawingBufferWidth;
    const h = glCtx.drawingBufferHeight;
    const spots = [
      [0.5, 0.5],
      [0.25, 0.25],
      [0.75, 0.25],
      [0.25, 0.75],
      [0.75, 0.75],
    ] as const;
    for (const [fx, fy] of spots) {
      glCtx.readPixels(Math.floor(w * fx), Math.floor(h * fy), 1, 1, glCtx.RGBA, glCtx.UNSIGNED_BYTE, samplePixel);
      if (Math.max(samplePixel[0], samplePixel[1], samplePixel[2]) >= 8) return false;
    }
    return true;
  };

  const frameIsBlackWebGPU = (): boolean => {
    if (!sample2dCtx) return false;
    try {
      sample2dCtx.drawImage(canvas, 0, 0, sample2d.width, sample2d.height);
      const data = sample2dCtx.getImageData(0, 0, sample2d.width, sample2d.height).data;
      for (let i = 0; i < data.length; i += 4) {
        if (Math.max(data[i], data[i + 1], data[i + 2]) >= 8) return false;
      }
      return true;
    } catch {
      return false; // can't read → never claim black (no false recovery loops)
    }
  };

  const frameIsBlack = (): boolean => (backend === 'webgl2' ? frameIsBlackGL() : frameIsBlackWebGPU());
  const canSampleFrames = backend === 'webgl2' ? glCtx !== null : sample2dCtx !== null;

  // ---- main loop ---------------------------------------------------------------
  let last = performance.now();
  let fpsFrames = 0;
  let fpsTimer = 0;
  let mapTimer = 0;
  let selfcheckDone = !pipeline.hasAdvanced; // only armed when RT exists
  let wireframeOn = false;

  renderer.setAnimationLoop((time: number) => {
    const dt = Math.min((time - last) / 1000, 0.05);
    last = time;

    controller.update(dt);

    // one-shot RT selfcheck: the CPU replica of the GPU's center-pixel ray.
    // "HIT" = camera math + BVH are sane on the CPU side; a GPU-side black
    // frame then isolates the problem to the compute/uniform/texture path.
    if (!selfcheckDone) {
      selfcheckDone = true;
      camera.updateMatrixWorld();
      const centerTarget = new THREE.Vector3(0, 0, 0.5).unproject(camera);
      const centerDir = centerTarget.sub(camera.position).normalize();
      const probeHit = collision.raycast(camera.position.clone(), centerDir, 300);
      console.info(
        `[rt] selfcheck: center ray ${probeHit ? `HIT at ${probeHit.distance.toFixed(2)}m` : 'MISS'} ` +
          `— camera [${camera.position.toArray().map((v) => v.toFixed(2)).join(', ')}]`,
      );
    }

    map.markVisited(controller.feet.x, controller.feet.z);
    lore.check(controller.feet);

    pipeline.render({
      scene,
      camera,
      settings: quality.settings,
      dt,
      time: time / 1000,
    });

    // ---- black-frame safety net --------------------------------------------
    // Stage 1 (~3s of black): disable the glow chain (its output can't be
    //   trusted when the frame is dark anyway).
    // Stage 2 (still black with glow off):
    //   webgpu backend  → auto-reload into forced-WebGL2 compatibility mode,
    //                     once per session (sessionStorage) — no reload loops;
    //   webgl2 backend  → permanent on-screen error + console dump.
    frameNo++;
    // webgpu-black = broken path → recover fast; webgl2-black might just be a
    // dark map → be patient before touching the player's glow (it was annoying)
    const stageThreshold = backend === 'webgpu' ? 20 : 45;
    if (rtDebug === 0 && !recoveryScheduled && canSampleFrames && frameNo > 30 && frameNo % 10 === 0) {
      if (frameIsBlack()) {
        blackChecks++;
        if (blackChecks >= stageThreshold) {
          blackChecks = 0;
          if (pipeline.postActive) {
            pipeline.setGlowEnabled(false);
            console.error(
              '[liminal] sustained black frames WITH glow post-chain — glow disabled automatically.\n' +
                'If the scene appears now, the glow chain is the problem on this driver.\n' +
                'GL renderer: ' + glRendererInfo,
            );
            hud.message('black frames — glow off (B re-enables)', 3500);
          } else if (backend === 'webgpu') {
            recoveryScheduled = true;
            try {
              sessionStorage.setItem('liminal.forcegl', '1');
            } catch {
              /* private browsing — reload with ?forcegl=1 won't persist either */
            }
            console.error(
              '[liminal] WebGPU renders black frames on this device — reloading into compatibility mode (WebGL2).',
            );
            hud.message("WebGPU isn't working on this device — switching to compatibility renderer…", 3000);
            window.setTimeout(() => location.reload(), 2000);
          } else {
            console.error(
              '[liminal] STILL black WITHOUT glow — GPU driver or browser rendering problem.\n' +
                'Please paste this console block in the chat. GL renderer: ' +
                glRendererInfo +
                '\nAlso check about:support (Firefox) or chrome://gpu (Chromium) for the WebGL renderer line.',
            );
            hud.message('still black — GPU/driver problem, paste the console output (F12)', 10000);
          }
        }
      } else {
        blackChecks = 0;
      }
    }

    // stats twice a second
    fpsFrames++;
    fpsTimer += dt;
    if (fpsTimer >= 0.5) {
      hud.stats(statsLine(Math.round(fpsFrames / fpsTimer)));
      fpsFrames = 0;
      fpsTimer = 0;
    }

    // fog-of-war refresh while the map is open
    mapTimer += dt;
    if (mapTimer >= 0.4 && hud.mapVisible()) {
      const ctx = hud.mapCanvas().getContext('2d');
      if (ctx) map.draw(ctx, controller.feet.x, controller.feet.z);
      mapTimer = 0;
    }
  });

  hud.message(
    sessionForced
      ? `compatibility mode — WebGPU off (from an earlier error) — press G to retry`
      : `${backend} · ${quality.tier} — click to enter`,
    sessionForced ? 12000 : 4000,
  );
  console.info(
    `[liminal] up — backend=${backend} tier=${quality.tier} ` +
      `navigator.gpu=${'gpu' in navigator} glow=${pipeline.postActive} gl="${glRendererInfo}" ` +
      `rt=${pipeline.hasAdvanced ? 'armed' : 'off'} ` +
      `forcegl=${urlForced ? 'url' : sessionForced ? 'session' : 'no'}\n` +
      `[liminal] diagnostics: ${diagnostics.join(' | ')}`,
  );

  // debug handle for scripts/smoke.mjs (and the console, feel free)
  (window as unknown as Record<string, unknown>).__liminal = {
    renderer,
    pipeline,
    quality,
    controller,
    scene,
    camera,
    collision,
    settings,
    bindings,
    THREE,
  };
  (window as unknown as Record<string, unknown>).__liminalReady = true;
}

main().catch((err) => {
  console.error(err);
  hud.fatal(err);
});
