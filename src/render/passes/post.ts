import { RenderPipeline } from 'three/webgpu';
import type { WebGPURenderer } from 'three/webgpu';
import { pass } from 'three/tsl';
import { bloom } from 'three/addons/tsl/display/BloomNode.js';
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
    const pipeline = new RenderPipeline(renderer);
    const scenePass = pass(scene, camera);
    // NOTE: bloom() returns the GLOW ONLY (sum of blurred mips * strength) —
    // the base scene color must be added back in, per three's own example.
    const sceneColor = scenePass.getTextureNode('output');
    pipeline.outputNode = sceneColor.add(bloom(sceneColor, 0.5, 0.5, 0.75));

    return {
      ok: true,
      render: () => pipeline.render(),
      dispose: () => pipeline.dispose(),
    };
  } catch (err) {
    console.warn('[post] bloom chain unavailable, using plain forward render', err);
    return { ok: false, render: () => {}, dispose: () => {} };
  }
}
