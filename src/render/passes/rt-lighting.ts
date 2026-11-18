import type { QualitySettings } from '../quality.js';
import type { FrameContext, RenderPass } from './types.js';

/**
 * PHASE 1 — RAYTRACED LIGHTING  (the heart of the renderer)
 *
 * Compute pass (WebGPU only), runs at settings.lightingScale resolution with
 * temporal accumulation across frames:
 *
 *   1. for each lighting pixel: reconstruct world position from the gbuffer
 *   2. trace 1 shadow ray toward the dominant light direction(s)  -> hard,
 *      correct shadows (this is the "raytracing" the player sees)
 *   3. trace settings.rtBounces bounce rays; a hit is lit ONLY if the surface
 *      it hit is emissive (gbuffer target 2) — emissive geometry IS the light
 *      source, exactly like the Blender map authors it
 *   4. accumulate into a history buffer reprojected with motion vectors;
 *      clamp against history to kill smearing
 *
 * GPU-side BVH: three-mesh-bvh ships MeshBVHUniformStruct + BVHShaderGLSL
 * (and a ./webgpu entrypoint) — upload per-chunk BVHs with it instead of
 * writing a traversal from scratch.
 *
 * Fallback (WebGL2 / potato tier): screen-space approximations (SSAO/SSGI),
 * no traced rays. settings.raytracedLighting === false disables this pass
 * completely so "minimum settings = no RT cost".
 */
export class RaytracedLightingPass implements RenderPass {
  readonly name = 'rt-lighting';

  enabled(_settings: QualitySettings): boolean {
    return false; // TODO phase 1: return settings.raytracedLighting && backend === 'webgpu'
  }

  render(_ctx: FrameContext): void {
    // TODO phase 1: compute dispatch over the lighting buffer
  }

  dispose(): void {
    // TODO phase 1: free storage/history buffers
  }
}
