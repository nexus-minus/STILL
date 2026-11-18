import * as THREE from 'three/webgpu';
import { createRenderer, type Backend } from './render/renderer.js';
import { FramePipeline } from './render/pipeline.js';
import { createPostChain } from './render/passes/post.js';
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
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
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
  const quality = new QualityManager(detectTier(backend as Backend));
  const pipeline = new FramePipeline(renderer);
  pipeline.setPost(createPostChain(renderer, scene, camera));

  const applyQuality = (): void => {
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2) * quality.settings.renderScale);
  };
  quality.onChange = () => applyQuality();
  applyQuality();

  // ---- gameplay systems ----------------------------------------------------
  setStage('input');
  const controller = new PlayerController(camera, canvas, collision, room.spawn);
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

  document.addEventListener('keydown', (e) => {
    if (e.code === 'KeyT') {
      quality.setTier(quality.next());
      hud.message(`quality — ${quality.tier}`, 1500);
    }
    if (e.code === 'KeyM') hud.toggleMap();
    if (e.code === 'KeyB') {
      const on = pipeline.toggleGlow();
      hud.message(`glow ${on ? 'on' : 'off'}`, 1500);
      console.info(`[liminal] glow toggled ${on ? 'on' : 'off'} by user`);
    }
    if (e.code === 'KeyR') {
      const latest = anchors.list().sort((a, b) => b.discoveredAt - a.discoveredAt)[0];
      if (latest) {
        controller.respawnAt(new THREE.Vector3(latest.position.x, latest.position.y, latest.position.z));
        hud.message(`respawned — ${latest.label}`, 2000);
      }
    }
  });

  overlay.addEventListener('click', () => void canvas.requestPointerLock());
  document.addEventListener('pointerlockchange', () => {
    overlay.classList.toggle('hidden', document.pointerLockElement === canvas);
  });

  // ---- resize ----------------------------------------------------------------
  const resize = (): void => {
    const w = window.innerWidth;
    const h = window.innerHeight;
    renderer.setSize(w, h, false);
    camera.aspect = w / h;
    camera.updateProjectionMatrix();
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

  renderer.setAnimationLoop((time: number) => {
    const dt = Math.min((time - last) / 1000, 0.05);
    last = time;

    controller.update(dt);
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

  hud.message(`${backend} · ${quality.tier} — click to enter`, 4000);
  console.info(
    `[liminal] up — backend=${backend} tier=${quality.tier} ` +
      `navigator.gpu=${'gpu' in navigator} glow=${pipeline.postActive} gl="${glRendererInfo}"\n` +
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
    THREE,
  };
  (window as unknown as Record<string, unknown>).__liminalReady = true;
}

main().catch((err) => {
  console.error(err);
  hud.fatal(err);
});
