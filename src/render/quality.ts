import type { Backend } from './renderer.js';

export type Tier = 'potato' | 'medium' | 'high' | 'ultra';

/**
 * Antialiasing is the player's decision (Settings → Graphics). The tier presets
 * only provide the DEFAULT: SMAA on the weak tiers (a post pass, kinder to a
 * laptop GPU), MSAA where the tier can afford geometry MSAA, and 'off' always
 * stays selectable.
 */
export type AAMode = 'off' | 'msaa' | 'smaa';

export interface QualitySettings {
  /** drawing-buffer scale, 1 = native resolution */
  renderScale: number;

  /** traced shadows + 1-N bounce GI (compute pass); forced off on the WebGL2 backend */
  raytracedLighting: boolean;
  /** resolution factor of the lighting buffer (0.25 = quarter res) */
  lightingScale: number;
  rtBounces: number;

  /** volumetric fog + light shafts — the design requirement that must be toggleable */
  volumetrics: boolean;
  volumetricScale: number;

  bloom: boolean;

  /** player's AA choice; the tier preset is only the starting point */
  antialiasing: AAMode;
  /** what a 'msaa' pick asks for on this tier (0 = no MSAA target: SMAA is a post pass) */
  msaaSamples: number;

  /** runtime multiplier on all traced light powers (match to Blender taste) */
  lightGain: number;
}

export const TIER_PRESETS: Record<Tier, QualitySettings> = {
  // No good GPU: plain raster + bloom, no traced passes, reduced resolution.
  // SMAA here because a CPU/CPU-raster machine cannot afford MSAA targets.
  potato: {
    renderScale: 0.75,
    raytracedLighting: false,
    lightingScale: 0.25,
    rtBounces: 0,
    volumetrics: false,
    volumetricScale: 0.25,
    bloom: true,
    antialiasing: 'smaa',
    // what a manual MSAA pick would use on this tier — 2, the cheapest MSAA the
    // target can ask for. NOTE: WebGPU clamps 2 to 1 (see gpuSampleCount), so a manual
    // 'msaa' pick on this tier runs single-sample. The menu shows the effective value,
    // not this request; that is reported to the owner as an open point.
    msaaSamples: 2,
    lightGain: 1,
  },
  // The default target: quarter-res traced lighting + quarter-res volumetrics.
  // SMAA stays the default — the long soft-lit corridors are exactly the case
  // where a post pass beats an MSAA target on a laptop.
  medium: {
    renderScale: 1,
    raytracedLighting: true,
    lightingScale: 0.25,
    rtBounces: 1,
    volumetrics: true,
    volumetricScale: 0.25,
    bloom: true,
    antialiasing: 'smaa',
    // a manual MSAA pick on this tier runs 4x
    msaaSamples: 4,
    lightGain: 1,
  },
  // Full-res traced lighting. SMAA is the default here as well (owner decision
  // 2026-11-23): the measured cost of a 4x MSAA target is 126.6 MB at 1080p and no
  // gain against the single-sample reference — scripts/smaa-edge-check.mjs run C
  // showed 12.60 ms/frame vs 11.80 for 'off' and a 1.8 % worse spread. The menu still
  // offers 'msaa' for players who render without the post pass, where it does help.
  high: {
    renderScale: 1,
    raytracedLighting: true,
    lightingScale: 0.5,
    rtBounces: 2,
    volumetrics: true,
    volumetricScale: 0.5,
    bloom: true,
    antialiasing: 'smaa',
    // what a manual MSAA pick would use on this tier
    msaaSamples: 4,
    lightGain: 1,
  },
  // Full-res traced lighting.
  ultra: {
    renderScale: 1,
    raytracedLighting: true,
    lightingScale: 1,
    rtBounces: 2,
    volumetrics: true,
    volumetricScale: 1,
    bloom: true,
    antialiasing: 'smaa', // same reason as high, see above
    // 4, not 8: three's Utils.getSampleCount clamps any request to 1 or 4
    // (three.webgpu.js:39100; measured by scripts/smaa-edge-check.mjs, run F — asking
    // for 8 runs 4). A menu that displayed 8 would show a number the GPU never uses,
    // so the preset names the value the hardware actually runs (tolerance 0 in
    // scripts/settings-hud-check.mjs: displayed == effective).
    msaaSamples: 4,
    lightGain: 1,
  },
};

export const TIER_ORDER: Tier[] = ['potato', 'medium', 'high', 'ultra'];

/**
 * Where "SMAA on weak GPUs" lives in code: detectTier() picks the tier, the tier
 * preset names the AA default. Settings use this when nothing is persisted, so
 * a weak machine boots with SMAA and a tier that affords it boots with MSAA.
 */
export function defaultAA(tier: Tier): AAMode {
  return TIER_PRESETS[tier].antialiasing;
}

export type OverrideKey =
  | 'renderScale'
  | 'raytracedLighting'
  | 'volumetrics'
  | 'lightGain'
  | 'antialiasing';

export class QualityManager {
  tier: Tier;
  onChange?: (settings: QualitySettings) => void;
  /** per-setting manual fine-tuning layered over the tier preset */
  private readonly overrides: Partial<Pick<QualitySettings, OverrideKey>> = {};

  constructor(initial: Tier = 'medium') {
    this.tier = initial;
  }

  get settings(): QualitySettings {
    return { ...TIER_PRESETS[this.tier], ...this.overrides };
  }

  get hasOverrides(): boolean {
    return Object.keys(this.overrides).length > 0;
  }

  setTier(tier: Tier): void {
    if (tier === this.tier) return;
    this.tier = tier;
    // picking a preset clears manual fine-tuning — that's what presets mean
    for (const key of Object.keys(this.overrides) as OverrideKey[]) delete this.overrides[key];
    this.onChange?.(this.settings);
  }

  setOverride<K extends OverrideKey>(key: K, value: QualitySettings[K] | undefined): void {
    if (value === undefined) delete this.overrides[key];
    else this.overrides[key] = value;
    this.onChange?.(this.settings);
  }

  override<K extends OverrideKey>(key: K): QualitySettings[K] | undefined {
    return this.overrides[key];
  }

  next(): Tier {
    const i = TIER_ORDER.indexOf(this.tier);
    return TIER_ORDER[(i + 1) % TIER_ORDER.length];
  }
}

/** Rough heuristic for now; a real benchmark ships with the settings menu (phase 1). */
export function detectTier(backend: Backend): Tier {
  if (backend === 'webgl2') return 'potato';

  const cores = navigator.hardwareConcurrency ?? 4;
  const memory = (navigator as Navigator & { deviceMemory?: number }).deviceMemory ?? 4;

  if (cores >= 8 && memory >= 8) return 'high';
  return 'medium';
}
