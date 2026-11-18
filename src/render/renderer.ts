import { WebGPURenderer } from 'three/webgpu';

export type Backend = 'webgpu' | 'webgl2';

export interface GameRenderer {
  renderer: WebGPURenderer;
  backend: Backend;
  /**
   * The canvas actually in use. A failed WebGPU attempt can leave the original
   * canvas bound to a dead 'webgpu' context (a canvas only ever gets ONE
   * context type, ever), so the WebGL2 retry must happen on a fresh element —
   * this is handed back so the caller binds input to the real one.
   */
  canvas: HTMLCanvasElement;
  /** human-readable step-by-step log, shown by the fatal screen if we fail */
  diagnostics: string[];
}

/** Carries its diagnostics to the fatal screen — the player sees WHY. */
export class RendererInitError extends Error {
  readonly diagnostics: string[];

  constructor(message: string, diagnostics: string[]) {
    super(message);
    this.name = 'RendererInitError';
    this.diagnostics = diagnostics;
  }
}

const INIT_TIMEOUT_MS = 15000;

/**
 * WebGPU first, WebGL2 fallback — this function IS the "runs on most
 * browsers / no good graphics card" guarantee.
 *
 * Rules learned the hard way:
 *  1. probe WebGPU with requestAdapter() BEFORE touching the game canvas;
 *  2. after any failed attempt, swap in a fresh <canvas> — a failed attempt
 *     may have claimed the only context slot;
 *  3. never hang: every init gets a timeout;
 *  4. every step is recorded, and the records go into the thrown error so the
 *     in-game fatal screen tells the player what went wrong.
 */
export async function createRenderer(canvasIn: HTMLCanvasElement): Promise<GameRenderer> {
  const notes: string[] = [];

  // ---- probe 1: is WebGPU genuinely usable? (does not touch our canvas) ----
  let webgpuWorthTrying = false;
  const gpu = (navigator as unknown as { gpu?: { requestAdapter?: () => Promise<unknown> } }).gpu;
  if (gpu?.requestAdapter) {
    try {
      const adapter = await gpu.requestAdapter();
      webgpuWorthTrying = adapter !== null && adapter !== undefined;
      notes.push(`navigator.gpu: yes, adapter: ${webgpuWorthTrying ? 'yes' : 'no'}`);
    } catch (err) {
      notes.push(`navigator.gpu probe threw: ${errText(err)}`);
    }
  } else {
    notes.push('navigator.gpu: absent');
  }

  // ---- probe 2: WebGL2 on a THROWAWAY canvas (never the game canvas) -------
  const webgl2Ok = probeWebGL2();
  notes.push(`webgl2 probe: ${webgl2Ok ? 'ok' : 'FAILED'}`);

  // ---- attempts, most capable first -----------------------------------------
  const attempts: Array<{ label: string; forceWebGL: boolean }> = [];
  if (webgpuWorthTrying) attempts.push({ label: 'webgpu', forceWebGL: false });
  if (webgl2Ok) attempts.push({ label: 'webgl2', forceWebGL: true });

  let current = canvasIn;
  for (const attempt of attempts) {
    try {
      const renderer = new WebGPURenderer({
        canvas: current,
        antialias: true,
        forceWebGL: attempt.forceWebGL,
      });
      await withTimeout(renderer.init(), INIT_TIMEOUT_MS, `${attempt.label} renderer.init`);

      const backend = actualBackend(renderer);
      notes.push(`${attempt.label}: init ok -> backend=${backend}`);
      console.info('[renderer] diagnostics:', notes.join(' | '));
      return { renderer, backend, canvas: current, diagnostics: notes };
    } catch (err) {
      notes.push(`${attempt.label}: FAILED — ${errText(err)}`);
      console.warn(`[renderer] ${attempt.label} attempt failed`, err);
      // The canvas may be poisoned (WebGPU claims it even when init later
      // throws) — the next attempt must run on a brand-new element.
      current = replaceCanvas(current);
    }
  }

  throw new RendererInitError(
    attempts.length === 0
      ? 'this browser/driver offers neither WebGPU nor WebGL2 — the game cannot start here'
      : `no usable graphics backend (tried: ${attempts.map((a) => a.label).join(', ')})`,
    notes,
  );
}

/** navigator.gpu existing means nothing — only the adapter does. */
function actualBackend(renderer: WebGPURenderer): Backend {
  const backend = renderer.backend as { isWebGPUBackend?: true };
  return backend.isWebGPUBackend ? 'webgpu' : 'webgl2';
}

function probeWebGL2(): boolean {
  try {
    const probe = document.createElement('canvas');
    const gl = probe.getContext('webgl2');
    // free the context immediately so we don't eat a context slot
    gl?.getExtension('WEBGL_lose_context')?.loseContext();
    return gl !== null;
  } catch {
    return false;
  }
}

/**
 * Swap the canvas element for a clean clone (same id/attrs/styles) and return
 * it. Required because a canvas that ever got a 'webgpu' context can never
 * return a WebGL context — getContext('webgl2') would be null forever.
 */
function replaceCanvas(old: HTMLCanvasElement): HTMLCanvasElement {
  const fresh = document.createElement('canvas');
  fresh.id = old.id;
  fresh.className = old.className;
  fresh.style.cssText = old.style.cssText;
  old.parentNode?.replaceChild(fresh, old);
  return fresh;
}

function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`${label} timed out after ${ms / 1000}s`)), ms);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (err) => {
        clearTimeout(timer);
        reject(err);
      },
    );
  });
}

function errText(err: unknown): string {
  if (err instanceof Error) return `${err.name}: ${err.message}`;
  return String(err);
}
