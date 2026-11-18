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

async function main(): Promise<void> {
  const overlay = document.getElementById('overlay') as HTMLDivElement;

  // ---- renderer: WebGPU first, WebGL2 fallback, fresh canvas per attempt ---
  const initialCanvas = document.getElementById('game') as HTMLCanvasElement;
  const { renderer, backend, canvas, diagnostics } = await createRenderer(initialCanvas);
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1.0;

  // ---- scene --------------------------------------------------------------
  const scene = new THREE.Scene();
  scene.background = new THREE.Color(0x040404);
  const camera = new THREE.PerspectiveCamera(76, 1, 0.05, 300);

  const room = buildTestRoom();
  scene.add(room.group);
  const collision = WorldCollision.fromMeshes(room.collisionMeshes);

  // ---- quality + render pipeline -----------------------------------------
  const quality = new QualityManager(detectTier(backend as Backend));
  const pipeline = new FramePipeline(renderer);
  pipeline.setPost(createPostChain(renderer, scene, camera));

  const applyQuality = (): void => {
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2) * quality.settings.renderScale);
  };
  quality.onChange = () => applyQuality();
  applyQuality();

  // ---- gameplay systems ----------------------------------------------------
  const controller = new PlayerController(camera, canvas, collision, room.spawn);
  const interactables = new InteractableSystem();
  const anchors = new AnchorRegistry();
  const map = new MapDevice();
  const lore = new LoreSystem();
  const transport = createTransport();
  await transport.connect();

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

    canvas.addEventListener('webglcontextlost', (e) => {
      e.preventDefault();
      console.error('[liminal] WebGL context LOST — display driver problem. GL:', glRendererInfo);
      hud.message('graphics context lost — reload the page (details in console)', 10000);
    });
  } else if (driverEl) {
    driverEl.textContent = 'WebGPU device';
  }

  let frameNo = 0;
  let blackChecks = 0;
  const samplePixel = new Uint8Array(4);
  /**
   * true = every sampled pixel is essentially black (max channel < 8/255).
   * The threshold matters: our near-black background survives tonemapping at
   * ~2-3/255, and a scene that RENDERS but looks pitch black (broken shaders,
   * driver misbehaving) must count as black — otherwise the safety net would
   * never fire exactly when it's needed. A working frame always has geometry
   * at 100+.
   */
  const frameIsBlack = (): boolean => {
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

    // ---- black-frame safety net (GL backend only) --------------------------
    // Sample the drawing buffer every 10 frames, right after drawing.
    frameNo++;
    if (glCtx && frameNo > 30 && frameNo % 10 === 0) {
      if (frameIsBlack()) {
        blackChecks++;
        if (blackChecks === 20 && pipeline.postActive) {
          pipeline.setGlowEnabled(false);
          blackChecks = 0;
          console.error(
            '[liminal] ~3s of black frames WITH glow post-chain — glow disabled automatically.\n' +
              'If the scene appears now, your GL driver dislikes the TSL post chain.\n' +
              'GL renderer: ' + glRendererInfo,
          );
          hud.message('glow disabled (black frames) — is the room visible now? (B toggles)', 8000);
        } else if (blackChecks === 40) {
          blackChecks = 0;
          console.error(
            '[liminal] STILL black WITHOUT glow — GPU driver or browser rendering problem.\n' +
              'Please paste this console block in the chat. GL renderer: ' +
              glRendererInfo +
              '\nAlso check chrome://gpu for "WebGL" being "Hardware accelerated".',
          );
          hud.message('still black — GPU/driver problem, paste the console output (F12)', 10000);
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
}

main().catch((err) => {
  console.error(err);
  hud.fatal(err);
});
