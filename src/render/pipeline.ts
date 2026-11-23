import type { WebGPURenderer, Scene, PerspectiveCamera } from 'three/webgpu';
import type { AAMode, QualitySettings } from './quality.js';
import type { FrameContext, RenderPass } from './passes/types.js';
import type { PostChain } from './passes/post.js';
import type { AdvancedRenderer } from './rt.js';

/** three's sample clamp, kept in one place so the menu and the renderer cannot
 *  disagree: the WebGPU backend runs only 1 or 4 samples (`Utils.getSampleCount`,
 *  three.webgpu.js:39100 — measured by scripts/smaa-edge-check.mjs: asking 8 runs 4,
 *  asking 2 runs 1). The settings row prints THIS, never the value the tier asked for.
 *  Kept here (not in quality.ts) so a node check can import it without resolving
 *  quality.js from a .ts file. */
export function gpuSampleCount(samples: number): number {
  return samples >= 4 ? 4 : 1;
}

/**
 * Frame orchestration.
 *
 *   phase 0 (now): forward render (+ bloom when the post chain came up)
 *   phase 1      : gbuffer -> rt-lighting -> volumetrics -> composite,
 *                  registered into `passes` and gated by QualitySettings
 *
 * Owns nothing — the scene/camera/renderer are passed in per frame, so the
 * world streaming (phase 2) can swap scene contents freely.
 */
export class FramePipeline {
  private readonly renderer: WebGPURenderer;
  private readonly passes: RenderPass[] = [];
  private post?: PostChain;
  private advanced?: AdvancedRenderer;
  /** manual (B key) + automatic (black-frame detector) glow gate */
  private glowEnabled = true;

  /** the player's AA choice (Settings → Graphics). The pipeline is its source of
   *  truth, so a menu pick can be read back exactly by the check. */
  private aaMode: AAMode = 'smaa';
  private aaRequestedSamples = 0;

  constructor(renderer: WebGPURenderer) {
    this.renderer = renderer;
  }

  /** Phase 1: the WebGPU raytraced path. Undefined = standard path. */
  setAdvanced(advanced: AdvancedRenderer | undefined): void {
    this.advanced = advanced;
  }

  get hasAdvanced(): boolean {
    return this.advanced !== undefined;
  }

  /**
   * true only when the advanced renderer can actually PRODUCE a frame this
   * tick (BVH uploaded). dispatch() no-ops until then and render() falls back
   * to the beauty pass — main.ts syncs the forward baked layer against this
   * so those pre-ready frames show baked light instead of a dark scene.
   */
  get rtReady(): boolean {
    return this.advanced?.ready ?? false;
  }

  get postActive(): boolean {
    return this.glowEnabled && (this.post?.ok ?? false);
  }

  /** current glow state (settings menu checkbox mirrors this) */
  get glowOn(): boolean {
    return this.glowEnabled;
  }

  setGlowEnabled(enabled: boolean): void {
    this.glowEnabled = enabled;
  }

  toggleGlow(): boolean {
    this.glowEnabled = !this.glowEnabled;
    return this.glowEnabled;
  }

  // ---- antialiasing (the player's choice, Settings → Graphics) --------------

  /**
   * Apply the AA choice.
   *
   *   'off'  — no AA work at all: the canvas target runs single-sample.
   *   'smaa' — no MSAA target either; SMAA is a post pass, so the sample count
   *            must be 0 here. The SMAA pass itself is still open
   *            (docs/realtime-rt-techniques.md) — the mode is recorded now so the
   *            pass can read it when it lands.
   *   'msaa' — geometry MSAA at the tier's sample count. The post chain inherits it:
   *            its scene pass takes the renderer's sample count, so the picture the
   *            graph samples is the resolved one (measured in scripts/smaa-edge-check.mjs).
   *            The fullscreen pass itself still runs single-sample, and WebGPU clamps
   *            the count to 1 or 4, so ultra's 8 lands as 4.
   *
   * three takes the sample count from the renderer CONSTRUCTOR and exposes
   * `samples` as a read-only getter, so a live switch has to write the field
   * three itself writes (`WebGPUBackend` sets `renderer._samples = 0` for the GL
   * fallback). The WebGPU backend rebuilds the canvas target when the count
   * changes, so a switch lands on the next frame; on the GL backend the flag is
   * fixed for the lifetime of the context — there the recorded mode is all there
   * is, and `effectiveSamples()` says so.
   */
  setAA(mode: AAMode, samples: number): void {
    this.aaMode = mode;
    // only a 'msaa' pick can ask for sample work; the tier decides how much
    this.aaRequestedSamples = mode === 'msaa' ? Math.max(1, Math.min(8, Math.round(samples))) : 0;
    const target = this.renderer as unknown as { _samples?: number };
    if (typeof target._samples === 'number') target._samples = this.aaRequestedSamples;
    // the pick has to reach the chain that draws the frame, otherwise the menu only
    // records a mode and the post chain keeps whatever it was built with
    this.post?.setAA(mode);
  }

  /** current AA mode */
  get aa(): AAMode {
    return this.aaMode;
  }

  /** sample count the settings menu asked for (0 for 'off' and 'smaa') */
  get aaSamples(): number {
    return this.aaRequestedSamples;
  }

  /** what the renderer actually runs with: the request AFTER three's clamp (1 or 4,
   *  see gpuSampleCount below), so the settings row can show what the GPU uses.
   *  0 while a fullscreen post pass draws the frame — three zeroes the sample count
   *  for those passes */
  get effectiveSamples(): number {
    return this.aaRequestedSamples === 0 ? 0 : gpuSampleCount(this.renderer.samples);
  }

  /** phase 1: addPass(new GBufferPass(...)) etc. */
  addPass(pass: RenderPass): void {
    this.passes.push(pass);
  }

  setPost(post: PostChain): void {
    this.post?.dispose();
    this.post = post;
    // a chain built after the pick must run it, not its own default
    post.setAA(this.aaMode);
  }

  render(args: {
    scene: Scene;
    camera: PerspectiveCamera;
    settings: QualitySettings;
    dt: number;
    time: number;
  }): void {
    const { scene, camera, settings, dt, time } = args;

    // phase 1: raytraced path (WebGPU) — dispatch compute, then its own
    // raster+composite+bloom graph. Falls back automatically when disabled.
    if (this.advanced && settings.raytracedLighting) {
      this.advanced.dispatch(camera, settings, Math.min(window.devicePixelRatio, 2));
      this.advanced.render();
      return;
    }

    // phase 1 path: full pass graph (none registered yet)
    if (this.passes.length > 0) {
      const ctx: FrameContext = { scene, camera, settings, dt, time };
      let anyActive = false;
      for (const pass of this.passes) {
        if (pass.enabled(settings)) {
          pass.render(ctx);
          anyActive = true;
        }
      }
      if (anyActive && this.post?.ok) {
        this.post.render();
        return;
      }
      if (anyActive) {
        this.renderer.render(scene, camera);
        return;
      }
    }

    // phase 0 path: forward render, optionally through the bloom chain
    if (settings.bloom && this.postActive && this.post?.ok) {
      this.post.render();
      return;
    }
    this.renderer.render(scene, camera);
  }

  dispose(): void {
    for (const pass of this.passes) pass.dispose?.();
    this.post?.dispose();
    this.advanced?.dispose();
  }
}
