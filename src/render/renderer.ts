import { WebGPURenderer } from 'three/webgpu';

export type Backend = 'webgpu' | 'webgl2';

export interface GameRenderer {
  renderer: WebGPURenderer;
  backend: Backend;
}

/**
 * WebGPU first, WebGL2 fallback — this function IS the "no good graphics card"
 * guarantee. Same three.js renderer class either way; forceWebGL switches the
 * backend. The fallback must keep working forever (old Safari, weak laptops).
 */
export async function createRenderer(canvas: HTMLCanvasElement): Promise<GameRenderer> {
  const hasWebGPU = typeof navigator !== 'undefined' && 'gpu' in navigator;

  if (hasWebGPU) {
    try {
      const renderer = new WebGPURenderer({ canvas, antialias: true });
      await renderer.init();
      return { renderer, backend: actualBackend(renderer) };
    } catch (err) {
      console.warn('[renderer] WebGPU init failed, falling back to WebGL2', err);
    }
  }

  const renderer = new WebGPURenderer({ canvas, antialias: true, forceWebGL: true });
  await renderer.init();
  return { renderer, backend: actualBackend(renderer) };
}

/**
 * navigator.gpu existing means nothing (headless/no adapter machines have the
 * API but no device) — three then silently runs its WebGL2 backend. Ask the
 * renderer which backend it actually ended up on, or quality detection and the
 * phase-1 RT gating would lie.
 */
function actualBackend(renderer: WebGPURenderer): Backend {
  const backend = renderer.backend as { isWebGPUBackend?: true };
  return backend.isWebGPUBackend ? 'webgpu' : 'webgl2';
}
