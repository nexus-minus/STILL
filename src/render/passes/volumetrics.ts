import type { QualitySettings } from '../quality.js';
import type { FrameContext, RenderPass } from './types.js';

/**
 * PHASE 1 — VOLUMETRICS  (fog + light shafts)
 *
 * Separate pass so the design requirement "volumetrics can be turned on/off"
 * costs nothing when off.
 *
 *   1. march the view ray from the camera to the gbuffer depth in
 *      settings.volumetricScale resolution, blue-noise dithered step offsets
 *   2. accumulate a homogeneous + height-falloff density (backrooms haze)
 *   3. at each step, shadow-ray toward the light; unoccluded steps glow ->
 *      volumetric lightning / shafts out of the ceiling panels
 *   4. temporally reproject + upscale bilinearly over the lit image
 *
 * three ships a GodraysNode addon (three/addons/tsl/display/GodraysNode.js)
 * that can seed the shaft look; our own march handles the in-scattering from
 * emissive geometry.
 *
 * On WebGL2 a cheaper fragment-shader march without traced shadow rays.
 */
export class VolumetricPass implements RenderPass {
  readonly name = 'volumetrics';

  enabled(_settings: QualitySettings): boolean {
    return false; // TODO phase 1: return settings.volumetrics
  }

  render(_ctx: FrameContext): void {
    // TODO phase 1: raymarch + composite
  }

  dispose(): void {
    // TODO phase 1: free targets
  }
}
