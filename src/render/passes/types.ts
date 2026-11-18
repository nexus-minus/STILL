import type { Camera, Scene } from 'three';
import type { QualitySettings } from '../quality.js';

/** Everything a render pass needs for one frame. */
export interface FrameContext {
  scene: Scene;
  camera: Camera;
  dt: number;
  time: number;
  settings: QualitySettings;
}

/**
 * A stage of the custom render graph (phase 1):
 *   gbuffer -> rt-lighting -> volumetrics -> composite
 * Every pass declares when it is active; the pipeline skips disabled passes
 * entirely, which is how "turn volumetrics off" stays free.
 */
export interface RenderPass {
  readonly name: string;
  enabled(settings: QualitySettings): boolean;
  render(ctx: FrameContext): void;
  dispose?(): void;
}
