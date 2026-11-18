import type { Backend } from './renderer.js';

export type Tier = 'potato' | 'medium' | 'high' | 'ultra';

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
}

export const TIER_PRESETS: Record<Tier, QualitySettings> = {
  // No good GPU: plain raster + bloom, no traced passes, reduced resolution.
  potato: {
    renderScale: 0.75,
    raytracedLighting: false,
    lightingScale: 0.25,
    rtBounces: 0,
    volumetrics: false,
    volumetricScale: 0.25,
    bloom: true,
  },
  // The default target: quarter-res traced lighting + quarter-res volumetrics.
  medium: {
    renderScale: 1,
    raytracedLighting: true,
    lightingScale: 0.25,
    rtBounces: 1,
    volumetrics: true,
    volumetricScale: 0.25,
    bloom: true,
  },
  high: {
    renderScale: 1,
    raytracedLighting: true,
    lightingScale: 0.5,
    rtBounces: 2,
    volumetrics: true,
    volumetricScale: 0.5,
    bloom: true,
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
  },
};

export const TIER_ORDER: Tier[] = ['potato', 'medium', 'high', 'ultra'];

export class QualityManager {
  tier: Tier;
  onChange?: (settings: QualitySettings) => void;

  constructor(initial: Tier = 'medium') {
    this.tier = initial;
  }

  get settings(): QualitySettings {
    return TIER_PRESETS[this.tier];
  }

  setTier(tier: Tier): void {
    if (tier === this.tier) return;
    this.tier = tier;
    this.onChange?.(this.settings);
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
