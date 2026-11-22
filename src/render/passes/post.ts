import * as THREE from 'three/webgpu';
import type { WebGPURenderer } from 'three/webgpu';
import { pass, renderOutput, vec3, vec4 } from 'three/tsl';
import { bloom } from 'three/addons/tsl/display/BloomNode.js';
import { createBlueNoiseTexture, ditherOffset } from '../bluenoise.js';
import type { PerspectiveCamera, Scene } from 'three';

/**
 * Glow. Bright emissive surfaces bleed into their surroundings.
 * This is a TSL node chain rendered by three's RenderPipeline
 * (formerly PostProcessing — renamed in r183, same class).
 *
 * Phase 1 upgrade: emissive lands in its own MRT channel so bloom only sees
 * actual light sources, and tonemapping moves into this chain as well.
 */
export interface PostChain {
  ok: boolean;
  render(): void;
  dispose(): void;
}

export function createPostChain(
  renderer: WebGPURenderer,
  scene: Scene,
  camera: PerspectiveCamera,
): PostChain {
  try {
    const pipeline = new THREE.RenderPipeline(renderer);
    const scenePass = pass(scene, camera);
    // NOTE: bloom() returns the GLOW ONLY (sum of blurred mips * strength) —
    // the base scene color must be added back in, per three's own example.
    const sceneColor = scenePass.getTextureNode('output');
    const base = sceneColor.add(bloom(sceneColor, 0.5, 0.5, 0.75));

    const ditherOn = new URLSearchParams(location.search).get('dither') !== '0';
    if (!ditherOn) {
      // unchanged behaviour: three applies tone mapping + sRGB after the node
      pipeline.outputNode = base;
      return { ok: true, render: () => pipeline.render(), dispose: () => pipeline.dispose() };
    }

    // The dither has to happen at the 8-bit step, so the chain does tone mapping
    // and the sRGB encode itself (outputColorTransform = false) and adds the
    // threshold afterwards — rounding(value + threshold - 0.5) is the ordered
    // dither decision. Same helper as the raytraced path, so both agree.
    pipeline.outputColorTransform = false;
    const ditherTex = createBlueNoiseTexture();
    const disp = renderOutput(base);
    const off = ditherOffset(ditherTex);
    pipeline.outputNode = vec4(disp.rgb.add(vec3(off)), disp.a);

    return {
      ok: true,
      render: () => pipeline.render(),
      dispose: () => {
        ditherTex.dispose();
        pipeline.dispose();
      },
    };
  } catch (err) {
    console.warn('[post] bloom chain unavailable, using plain forward render', err);
    return { ok: false, render: () => {}, dispose: () => {} };
  }
}
