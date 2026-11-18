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
  const canvas = document.getElementById('game') as HTMLCanvasElement;
  const overlay = document.getElementById('overlay') as HTMLDivElement;

  // ---- renderer: WebGPU, WebGL2 fallback guaranteed ----------------------
  const { renderer, backend } = await createRenderer(canvas);
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
  const statsLine = (fps: number): string =>
    `${backend} · ${quality.tier} · ${fps} fps\n${map.exploredCells} cells explored`;

  document.addEventListener('keydown', (e) => {
    if (e.code === 'KeyT') {
      quality.setTier(quality.next());
      hud.message(`quality — ${quality.tier}`, 1500);
    }
    if (e.code === 'KeyM') hud.toggleMap();
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
  console.info(`[liminal] up — backend=${backend} tier=${quality.tier}`);

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
