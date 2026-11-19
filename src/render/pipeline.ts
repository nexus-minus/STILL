import type { WebGPURenderer, Scene, PerspectiveCamera } from 'three/webgpu';
import type { QualitySettings } from './quality.js';
import type { FrameContext, RenderPass } from './passes/types.js';
import type { PostChain } from './passes/post.js';
import type { AdvancedRenderer } from './rt.js';

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

  /** phase 1: addPass(new GBufferPass(...)) etc. */
  addPass(pass: RenderPass): void {
    this.passes.push(pass);
  }

  setPost(post: PostChain): void {
    this.post?.dispose();
    this.post = post;
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
