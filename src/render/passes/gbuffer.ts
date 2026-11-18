import type { QualitySettings } from '../quality.js';
import type { FrameContext, RenderPass } from './types.js';

/**
 * PHASE 1 — G-BUFFER
 *
 * Rasterize the world once into screen-space targets. Cheap on any GPU,
 * which is why the base image never depends on raytracing.
 *
 *   target 0: albedo      RGBA16F   flat material color (no textures in this game)
 *   target 1: normal      RGBA16F   view-space, from the depth pass
 *   target 2: emissive    RGBA16F   emissive color * intensity — these pixels are
 *                                   the game's ONLY light sources
 *   depth   : hardware depth, reused by lighting + volumetrics
 *
 * Built with three's MRT node system (mrt() from three/tsl). On the WebGL2
 * backend this pass stays disabled and the forward renderer draws directly.
 */
export class GBufferPass implements RenderPass {
  readonly name = 'gbuffer';

  enabled(_settings: QualitySettings): boolean {
    // active as soon as implemented; for now the forward path renders instead
    return false; // TODO phase 1
  }

  render(_ctx: FrameContext): void {
    // TODO phase 1: render scene into MRT targets
  }

  dispose(): void {
    // TODO phase 1: free render targets
  }
}
