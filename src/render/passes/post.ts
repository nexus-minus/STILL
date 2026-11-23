import * as THREE from 'three/webgpu';
import type { WebGPURenderer } from 'three/webgpu';
import { pass, renderOutput, vec3, vec4 } from 'three/tsl';
import { bloom } from 'three/addons/tsl/display/BloomNode.js';
import { smaa } from 'three/addons/tsl/display/SMAANode.js';
import { createBlueNoiseTexture, ditherOffset } from '../bluenoise.js';
import type { AAMode } from '../quality.js';
import type { PerspectiveCamera, Scene } from 'three';

/**
 * Glow. Bright emissive surfaces bleed into their surroundings.
 * This is a TSL node chain rendered by three's RenderPipeline
 * (formerly PostProcessing — renamed in r183, same class).
 *
 * Phase 1 upgrade: emissive lands in its own MRT channel so bloom only sees
 * actual light sources, and tonemapping moves into this chain as well.
 *
 * The AA choice (Settings → Graphics) lands here too, because this chain is what
 * draws the frame:
 *   'smaa' — the SMAA node is IN the graph, so its three fullscreen passes run.
 *            SMAA reads the picture, detects the edges and blends neighbouring
 *            pixels, so it works no matter how the frame was drawn.
 *   'off'  — the node is not in the graph → the passes do not run, nothing costs.
 *   'msaa' — geometry MSAA. Measured (scripts/smaa-edge-check.mjs): the scene pass
 *            inherits the renderer's sample count (three's PassNode takes
 *            `renderer.samples` when no count is passed), so the geometry still runs
 *            multisampled and the graph samples the resolved picture — the pick does
 *            change the image behind this pass. What it cannot do is smooth anything
 *            the fullscreen pass itself draws, so it is not the same as the SMAA node,
 *            and WebGPU accepts only 1 or 4 samples (three's Utils.getSampleCount),
 *            so ultra's 8 runs as 4.
 *
 * SMAA must run BEFORE the sRGB encode (three's own note on SMAANode), so the node
 * sits on `base` and the dither — which belongs at the 8-bit step — stays after it.
 */
export interface PostChain {
  ok: boolean;
  render(): void;
  dispose(): void;
  /** apply the player's AA choice to this chain (live, from the settings menu) */
  setAA(mode: AAMode): void;
  /** what this chain actually runs right now */
  readonly aa: AAMode;
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

    // Built once. Only the graph that names it runs its passes, so 'off' pays
    // nothing for it — the check counts the passes per frame to prove that.
    const smaaNode = smaa(base);

    let aaMode: AAMode = 'smaa';
    /** the graph input: the SMAA node when the player picked smaa, else plain */
    const aaSource = () => (aaMode === 'smaa' ? smaaNode : base);

    const ditherOn = new URLSearchParams(location.search).get('dither') !== '0';
    if (!ditherOn) {
      // unchanged behaviour: three applies tone mapping + sRGB after the node
      pipeline.outputNode = aaSource();
      return {
        ok: true,
        render: () => pipeline.render(),
        dispose: () => pipeline.dispose(),
        setAA: (mode: AAMode) => {
          aaMode = mode;
          pipeline.outputNode = aaSource();
          // RenderPipeline only rebuilds its graph when needsUpdate is set, so the
          // swap has to ask for it — once per toggle, not per frame.
          pipeline.needsUpdate = true;
        },
        get aa() {
          return aaMode;
        },
      };
    }

    // The dither has to happen at the 8-bit step, so the chain does tone mapping
    // and the sRGB encode itself (outputColorTransform = false) and adds the
    // threshold afterwards — rounding(value + threshold - 0.5) is the ordered
    // dither decision. Same helper as the raytraced path, so both agree.
    pipeline.outputColorTransform = false;
    const ditherTex = createBlueNoiseTexture();

    const buildOutput = () => {
      const disp = renderOutput(aaSource());
      const off = ditherOffset(ditherTex);
      return vec4(disp.rgb.add(vec3(off)), disp.a);
    };
    pipeline.outputNode = buildOutput();

    return {
      ok: true,
      render: () => pipeline.render(),
      dispose: () => {
        ditherTex.dispose();
        smaaNode.dispose();
        pipeline.dispose();
      },
      setAA: (mode: AAMode) => {
        aaMode = mode;
        pipeline.outputNode = buildOutput();
        pipeline.needsUpdate = true; // same rule as above: re-parse once per toggle
      },
      get aa() {
        return aaMode;
      },
    };
  } catch (err) {
    console.warn('[post] bloom chain unavailable, using plain forward render', err);
    return {
      ok: false,
      render: () => {},
      dispose: () => {},
      setAA: () => {},
      aa: 'off',
    };
  }
}
