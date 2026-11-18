import * as THREE from 'three/webgpu';
import { createRenderer, hookWebGPUErrors, type Backend } from './render/renderer.js';
import { FramePipeline } from './render/pipeline.js';
import { createPostChain } from './render/passes/post.js';
import { createAdvancedRenderer, type AdvancedRenderer } from './render/rt.js';
import { QualityManager, detectTier } from './render/quality.js';
import { buildTestRoom } from './world/test-room.js';
import { WorldCollision } from './world/collision.js';
import { PlayerController } from './gameplay/controller.js';
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

  const room = buildTestRoom();
  scene.add(room.group);
  setStage('collision');
  const collision = WorldCollision.fromMeshes(room.collisionMeshes);

  // ---- quality + render pipeline -----------------------------------------
  setStage('pipeline');
  const persisted = loadSettings();
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
  setStage('raytracing');
  let advanced: AdvancedRenderer | undefined;
  if (backend === 'webgpu') {
    try {
      // fresh world matrices BEFORE the GPU BVH bakes transforms — stale
      // identity matrices would park all geometry at local origins
      scene.updateMatrixWorld(true);
      camera.updateMatrixWorld(true);
      advanced = createAdvancedRenderer(renderer, scene, camera, room.collisionMeshes, room.rtLights);
      advanced.setLogicalSize(window.innerWidth, window.innerHeight);
      const rtDebug = Number(new URLSearchParams(location.search).get('rtdebug') ?? 0);
      if (rtDebug > 0) {
        advanced.setDebugMode(rtDebug);
        console.info(`[rt] debug mode ${rtDebug} (1=uv gradient, 2=red=miss/green=hit)`);
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
  const controller = new PlayerController(camera, canvas, collision, room.spawn, bindings);
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

  interactables.register({
    id: 'anchor-01',
    label: 'beacon (room A)',
    position: room.anchor.interact,
    radius: 0.9,
    onInteract: () => {
      const count = anchors.list().length;
      anchors.activate({
        id: 'anchor-01',
        label: 'Beacon · Room A',
        position: { x: room.anchor.feet.x, y: room.anchor.feet.y, z: room.anchor.feet.z },
      });
      hud.message(`beacon registered — respawn point set (${count + 1} total)`);
    },
  });

  lore.addTrigger({
    id: 'RULE-001',
    position: room.loreTrigger,
    radius: 1.7,
    text: 'RULE 001 — if something calls your name, do not answer.',
  });
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
  const statsLine = (fps: number): string => `${backend} · ${quality.tier} · ${fps} fps`;

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
    if (!recoveryScheduled && canSampleFrames && frameNo > 30 && frameNo % 10 === 0) {
      if (frameIsBlack()) {
        blackChecks++;
        if (blackChecks >= 20) {
          blackChecks = 0;
          if (pipeline.postActive) {
            pipeline.setGlowEnabled(false);
            console.error(
              '[liminal] ~3s of black frames WITH glow post-chain — glow disabled automatically.\n' +
                'If the scene appears now, the glow chain is the problem on this driver.\n' +
                'GL renderer: ' + glRendererInfo,
            );
            hud.message('glow disabled (black frames) — is the room visible now? (B toggles)', 8000);
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
