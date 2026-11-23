import {
  TIER_ORDER,
  TIER_PRESETS,
  type AAMode,
  type OverrideKey,
  type QualityManager,
  type Tier,
} from '../render/quality.js';
// the clamp lives in the render layer (pipeline.ts), so the row cannot invent its own rule
import { gpuSampleCount } from '../render/pipeline.js';
import { ACTION_LABELS, keyLabel, PLAYER_ACTIONS, ALL_ACTIONS, type Action, type Bindings } from '../gameplay/bindings.js';
import type { PlayerController } from '../gameplay/controller.js';
import type { OverlayPrefs } from './hud.js';

const STORAGE_KEY = 'liminal.settings.v1';

/** tier presets don't tune exposure — 1× is the neutral value main.ts boots and
 *  restores with, so picking a preset returns the image to that known state. */
const EXPOSURE_DEFAULT = 1;
/** every fine-tuning key a tier defines — all cleared on "reset to preset" */
const OVERRIDE_KEYS: OverrideKey[] = [
  'renderScale',
  'raytracedLighting',
  'volumetrics',
  'lightGain',
  'antialiasing',
];

export interface PersistedSettings {
  tier?: Tier;
  sensitivity?: number;
  invertY?: boolean;
  renderScale?: number;
  raytracedLighting?: boolean;
  /** volumetrics toggle override (QualityManager 'volumetrics') */
  volumetrics?: boolean;
  lightGain?: number;
  glow?: boolean;
  exposure?: number;
  /** Settings → Graphics AA choice (the tier preset only supplies the default) */
  aa?: AAMode;
  /** Settings → Overlays — crosshair and the performance line default on */
  crosshair?: boolean;
  keyHints?: boolean;
  toasts?: boolean;
  perf?: boolean;
}

export function loadSettings(): PersistedSettings {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    return raw ? (JSON.parse(raw) as PersistedSettings) : {};
  } catch {
    return {};
  }
}

function saveSettings(state: PersistedSettings): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
  } catch {
    /* private mode */
  }
}

export interface SettingsHandle {
  readonly isOpen: boolean;
  open(): void;
  close(): void;
}

/**
 * Settings menu — presets + manual fine-tuning + overlays + keybinds + mouse
 * feel. DOM overlay opened when pointer lock is released (Esc). Every change
 * applies live AND persists; picking a preset clears manual overrides (that's
 * what a preset is), touching a slider makes it "custom".
 */
export function initSettings(opts: {
  quality: QualityManager;
  bindings: Bindings;
  controller: PlayerController;
  hasRaytracing: boolean;
  onResume: () => void;
  getExposure: () => number;
  setExposure: (value: number) => void;
  getGlow: () => boolean;
  setGlow: (value: boolean) => void;
  /** is the fullscreen post pass the one drawing the frame? The MSAA row is greyed
   *  out while it runs (see syncUI) */
  isPostActive: () => boolean;
  getOverlays: () => OverlayPrefs;
  setOverlays: (next: OverlayPrefs) => void;
}): SettingsHandle {
  const { quality, bindings, controller } = opts;

  const root = document.createElement('div');
  root.id = 'settings';
  root.classList.add('hidden');
  root.innerHTML = `
    <div class="panel">
      <h2>Settings</h2>
      <div class="cols">
        <div class="stack">
          <section>
            <h3>Graphics</h3>
            <label class="row">
              <span>Preset</span>
              <select id="set-preset">
                ${TIER_ORDER.map((t) => `<option value="${t}">${t}</option>`).join('')}
                <option value="__custom">custom</option>
              </select>
            </label>
            <label class="row">
              <span>Render scale <em id="set-scale-val"></em></span>
              <input type="range" id="set-scale" min="0.5" max="1" step="0.05" />
            </label>
            <label class="row">
              <span>Antialiasing <em id="set-aa-val"></em></span>
              <select id="set-aa">
                <option value="off">off</option>
                <option value="msaa">msaa</option>
                <option value="smaa">smaa</option>
              </select>
            </label>
            <label class="row">
              <span>Exposure <em id="set-exp-val"></em></span>
              <input type="range" id="set-exp" min="0.5" max="4" step="0.1" />
            </label>
            <label class="row">
              <span>Light intensity <em id="set-gain-val"></em></span>
              <input type="range" id="set-gain" min="0.2" max="3" step="0.1" />
            </label>
            <label class="row check">
              <input type="checkbox" id="set-glow" />
              <span>Glow (bloom)</span>
            </label>
            <label class="row check">
              <input type="checkbox" id="set-rt" ${opts.hasRaytracing ? '' : 'disabled'} />
              <span>Raytraced shadows + GI${opts.hasRaytracing ? '' : ' — unavailable (no WebGPU)'}</span>
            </label>
            <label class="row check">
              <input type="checkbox" id="set-vol" ${opts.hasRaytracing ? '' : 'disabled'} />
              <span>Volumetrics (fog + light shafts)${opts.hasRaytracing ? '' : ' — unavailable (no WebGPU)'}</span>
            </label>
          </section>
          <section>
            <h3>Overlays</h3>
            <label class="row check">
              <input type="checkbox" id="set-ov-crosshair" />
              <span>Crosshair</span>
            </label>
            <label class="row check">
              <input type="checkbox" id="set-ov-hints" />
              <span>Key hints</span>
            </label>
            <label class="row check">
              <input type="checkbox" id="set-ov-toasts" />
              <span>Toasts</span>
            </label>
            <label class="row check">
              <input type="checkbox" id="set-ov-perf" />
              <span>Performance line (fps + frozen)</span>
            </label>
          </section>
        </div>
        <section>
          <h3>Controls</h3>
          <label class="row">
            <span>Mouse sensitivity <em id="set-sens-val"></em></span>
            <input type="range" id="set-sens" min="0.1" max="3" step="0.05" />
          </label>
          <label class="row check">
            <input type="checkbox" id="set-invert" />
            <span>Invert Y</span>
          </label>
          <div class="binds" id="set-binds"></div>
          <button type="button" class="ghost" id="set-reset">Reset keybinds</button>
        </section>
      </div>
      <div class="actions">
        <button type="button" id="set-resume">Resume</button>
      </div>
    </div>`;
  document.body.appendChild(root);

  // menu-local styles: index.html owns the shared stylesheet (a file this
  // module doesn't own), so the badge/warning classes this menu adds are
  // styled here instead of growing cross-file CSS edits.
  const style = document.createElement('style');
  style.textContent = `
    #settings .row em.mod {
      font-size: 10px; letter-spacing: 0.08em; text-transform: uppercase;
      color: #f2e9c9; border: 1px solid rgba(242, 233, 201, 0.45);
      border-radius: 2px; padding: 0 4px; opacity: 1;
    }
    #settings .note.warn { color: #ffb07a; bottom: 46px; }
    /* Graphics + Overlays share the left column so both columns stay balanced */
    #settings .stack { display: flex; flex-direction: column; gap: 22px; }
  `;
  document.head.appendChild(style);

  const $ = <T extends HTMLElement>(id: string): T => {
    // tolerate both 'set-x' and '#set-x' at call sites — a stray double hash
    // is a SyntaxError, and a missing node must fail loudly, not silently
    const selector = id.startsWith('#') ? id : `#${id}`;
    const el = root.querySelector<T>(selector);
    if (!el) throw new Error(`settings UI: missing ${selector}`);
    return el;
  };

  const persisted: PersistedSettings = {
    tier: quality.tier,
    sensitivity: controller.sensitivityMultiplier,
    invertY: controller.invertY,
    renderScale: quality.override('renderScale'),
    raytracedLighting: quality.override('raytracedLighting'),
    volumetrics: quality.override('volumetrics'),
    lightGain: quality.override('lightGain'),
    aa: quality.settings.antialiasing,
    exposure: opts.getExposure(),
    crosshair: opts.getOverlays().crosshair,
    keyHints: opts.getOverlays().keyHints,
    toasts: opts.getOverlays().toasts,
    perf: opts.getOverlays().perf,
  };
  const persist = (): void => {
    persisted.tier = quality.tier;
    persisted.sensitivity = controller.sensitivityMultiplier;
    persisted.invertY = controller.invertY;
    persisted.renderScale = quality.override('renderScale');
    persisted.raytracedLighting = quality.override('raytracedLighting');
    persisted.volumetrics = quality.override('volumetrics');
    persisted.exposure = opts.getExposure();
    persisted.lightGain = quality.override('lightGain');
    persisted.glow = opts.getGlow();
    persisted.aa = quality.settings.antialiasing;
    persisted.crosshair = opts.getOverlays().crosshair;
    persisted.keyHints = opts.getOverlays().keyHints;
    persisted.toasts = opts.getOverlays().toasts;
    persisted.perf = opts.getOverlays().perf;
    saveSettings(persisted);
  };

  // ---- keybind rows ---------------------------------------------------------
  // only PLAYER_ACTIONS get rows — dev tools (glow/respawn/quality) keep their
  // fixed keys and stay out of the player-facing list.
  const bindsRoot = $('#set-binds');
  const bindButtons = new Map<Action, HTMLButtonElement>();
  for (const action of PLAYER_ACTIONS) {
    const row = document.createElement('div');
    row.className = 'bind-row';
    const label = document.createElement('span');
    label.textContent = ACTION_LABELS[action];
    const button = document.createElement('button');
    button.type = 'button';
    button.textContent = keyLabel(bindings.get(action));
    row.append(label, button);
    bindsRoot.appendChild(row);
    bindButtons.set(action, button);
  }

  let capturing: Action | null = null;
  /** timestamp of the press we just consumed — its trailing click must not
   *  re-enter capture (setTimeout raced the browser's click event).
   *  -Infinity: never blocks early clicks (page uptime can be < 400ms). */
  let inputConsumedAt = -Infinity;
  const finishCapture = (): void => {
    if (!capturing) return;
    const button = bindButtons.get(capturing)!;
    button.classList.remove('capturing');
    button.textContent = keyLabel(bindings.get(capturing));
    capturing = null;
  };
  const applyBind = (action: Action, code: string): void => {
    inputConsumedAt = performance.now();
    finishCapture();
    // find the current holder BEFORE set(): Bindings.set swaps keys (it never
    // double-binds), so afterwards the old holder no longer reports this code.
    // Search ALL actions (not just rows): a dev tool's key can be stolen too,
    // and that swap must be named in the warning, not happen silently.
    const conflict = code
      ? ALL_ACTIONS.find((a) => a !== action && bindings.get(a) === code)
      : undefined;
    bindings.set(action, code);
    // a swap may have changed other rows — refresh everything
    for (const [a, btn] of bindButtons) btn.textContent = keyLabel(bindings.get(a));
    hudNote(`bound: ${ACTION_LABELS[action]} → ${keyLabel(code)}`);
    // non-blocking warning naming the action that lost the key (the swapped
    // key shows up on that action's row right below); a clean bind/unbind
    // clears any previous warning. Esc-unbind passes code '' → no conflict.
    hudWarn(
      conflict
        ? `⚠ ${keyLabel(code)} was already bound to ${ACTION_LABELS[conflict]} — swapped`
        : null,
    );
  };

  bindsRoot.addEventListener('click', (e) => {
    const button = (e.target as HTMLElement).closest('button');
    if (!button) return;
    const action = PLAYER_ACTIONS.find((a) => bindButtons.get(a) === button);
    if (!action) return;
    // the click that concludes the press we just bound — ignore it
    if (performance.now() - inputConsumedAt < 400) return;
    if (capturing === action) {
      finishCapture(); // second click on the same row = cancel
      return;
    }
    finishCapture();
    capturing = action;
    button.classList.add('capturing');
    button.textContent = 'press a key or mouse button…';
  });

  // capture-phase listeners: beat the controller's handlers and swallow browser
  // defaults while remapping. Esc unbinds the action (no key).
  window.addEventListener(
    'keydown',
    (e) => {
      if (!capturing) return;
      e.preventDefault();
      e.stopPropagation();
      const action = capturing;
      if (e.code === 'Escape') {
        applyBind(action, ''); // bound to nothing
        hudNote(`unbound: ${ACTION_LABELS[action]}`);
        return;
      }
      applyBind(action, e.code);
    },
    true,
  );
  window.addEventListener(
    'keyup',
    (e) => {
      if (capturing) {
        e.preventDefault();
        e.stopPropagation();
      }
    },
    true,
  );
  window.addEventListener(
    'mousedown',
    (e) => {
      if (!capturing) return;
      e.preventDefault();
      e.stopPropagation();
      const action = capturing;
      applyBind(action, `Mouse${e.button}`);
    },
    true,
  );
  root.addEventListener('contextmenu', (e) => e.preventDefault());

  // ---- graphics controls -------------------------------------------------------
  const preset = $<HTMLSelectElement>('set-preset');
  const scale = $<HTMLInputElement>('set-scale');
  const scaleVal = $<HTMLElement>('set-scale-val');
  const exposure = $<HTMLInputElement>('set-exp');
  const exposureVal = $<HTMLElement>('set-exp-val');
  const gain = $<HTMLInputElement>('set-gain');
  const gainVal = $<HTMLElement>('set-gain-val');
  const glow = $<HTMLInputElement>('set-glow');
  const rt = $<HTMLInputElement>('set-rt');
  const vol = $<HTMLInputElement>('set-vol');
  const aaSelect = $<HTMLSelectElement>('set-aa');
  const aaVal = $<HTMLElement>('set-aa-val');
  const aaMsaaOption = aaSelect.querySelector('option[value="msaa"]') as HTMLOptionElement;
  const sens = $<HTMLInputElement>('set-sens');
  const sensVal = $<HTMLElement>('set-sens-val');
  const invert = $<HTMLInputElement>('set-invert');
  const ovCrosshair = $<HTMLInputElement>('set-ov-crosshair');
  const ovHints = $<HTMLInputElement>('set-ov-hints');
  const ovToasts = $<HTMLInputElement>('set-ov-toasts');
  const ovPerf = $<HTMLInputElement>('set-ov-perf');

  /** badge = "this row no longer shows the selected preset's value" — a small
   *  marker parked at the end of the row label, shown/hidden on every sync. */
  const markRow = (input: HTMLElement, modified: boolean): void => {
    const row = input.closest('.row');
    if (!row) return;
    let badge = row.querySelector<HTMLElement>('.mod');
    if (!badge) {
      badge = document.createElement('em');
      badge.className = 'mod';
      badge.textContent = 'custom';
      badge.hidden = true;
      // label text lives in the row's <span> (slider rows also hold the value <em>)
      (row.querySelector('span') ?? row).appendChild(badge);
    }
    badge.hidden = !modified;
  };

  /** The AA row's value text. MSAA names the count the GPU RUNS, not the count the
   *  tier asks for: three clamps to 1 or 4 (`Utils.getSampleCount`,
   *  three.webgpu.js:39100 — measured in scripts/smaa-edge-check.mjs), so showing the
   *  request could show a number the hardware never uses. Displayed == effective,
   *  tolerance 0 (scripts/settings-hud-check.mjs). */
  const aaNote = (mode: AAMode, samples: number): string => {
    if (mode === 'msaa') {
      const runs = gpuSampleCount(samples);
      const clamped = runs === samples ? '' : ` (asks ${samples}, runs ${runs})`;
      return `${runs} samples, max 4${clamped}${opts.isPostActive() ? ' · geometry only' : ''}`;
    }
    if (mode === 'smaa') return 'post pass';
    return 'none';
  };

  /** Why the menu declines 'msaa'. Tolerance 0 in scripts/settings-hud-check.mjs.
   *  (1) While the fullscreen post pass draws the frame: MSAA only smooths the geometry,
   *      never what the pass itself draws, and the measurement (run C in
   *      scripts/smaa-edge-check.mjs) shows no gain there. It is not technically
   *      impossible behind the pass (the check measured 320 changed pixels) — this is the
   *      menu declining a pick that does little for the player.
   *  (2) When the request clamps to 1 sample: three runs only 1 or 4 (gpuSampleCount), so
   *      potato's request of 2 runs 1, and 1 sample is no antialiasing at all. A player
   *      could pick something that visibly does nothing, so the menu greys 'msaa' out on
   *      that tier (owner decision 2026-11-23). The row text still prints the truth
   *      ("asks 2, runs 1"), because a value persisted from another tier can still show up. */
  const msaaReasons = (samples: number): string[] => {
    const reasons: string[] = [];
    if (opts.isPostActive()) reasons.push('geometry only, off while bloom is on');
    if (gpuSampleCount(samples) === 1) reasons.push(`runs ${gpuSampleCount(samples)} sample -> no effect`);
    return reasons;
  };

  const syncUI = (): void => {
    const s = quality.settings;
    preset.value = quality.hasOverrides ? '__custom' : quality.tier;
    scale.value = String(s.renderScale);
    scaleVal.textContent = `${Math.round(s.renderScale * 100)}%`;
    aaSelect.value = s.antialiasing;
    aaVal.textContent = aaNote(s.antialiasing, s.msaaSamples);
    // The grey-out and the hint text come from the SAME list of reasons (see msaaReasons),
    // so the row cannot print one thing and disable for another.
    const reasons = msaaReasons(s.msaaSamples);
    aaMsaaOption.disabled = reasons.length > 0;
    aaMsaaOption.textContent = reasons.length ? `msaa (${reasons.join(', ')})` : 'msaa';
    exposure.value = String(opts.getExposure());
    exposureVal.textContent = `${opts.getExposure().toFixed(1)}×`;
    gain.value = String(s.lightGain);
    gainVal.textContent = `${s.lightGain.toFixed(1)}×`;
    glow.checked = opts.getGlow();
    rt.checked = s.raytracedLighting;
    vol.checked = s.volumetrics;
    sens.value = String(controller.sensitivityMultiplier);
    sensVal.textContent = `${controller.sensitivityMultiplier.toFixed(2)}×`;
    invert.checked = controller.invertY;
    const ov = opts.getOverlays();
    ovCrosshair.checked = ov.crosshair;
    ovHints.checked = ov.keyHints;
    ovToasts.checked = ov.toasts;
    ovPerf.checked = ov.perf;
    // per-row deviation markers against the selected tier's preset values.
    // glow stays unmarked: it's a runtime preference (B key, auto-disabled on
    // broken drivers) gated by a preset field (bloom) that is constantly true —
    // badging it would force it back on at preset pick, re-black-screening the
    // machines the auto-disable protects. Sensitivity / invert Y are likewise
    // user preferences, not preset values.
    const tierPreset = TIER_PRESETS[quality.tier];
    markRow(scale, s.renderScale !== tierPreset.renderScale);
    markRow(exposure, opts.getExposure() !== EXPOSURE_DEFAULT);
    markRow(gain, s.lightGain !== tierPreset.lightGain);
    markRow(rt, s.raytracedLighting !== tierPreset.raytracedLighting);
    // AA is a preset field too, so a manual pick gets the same "custom" badge —
    // and picking a preset hands the default back (SMAA on the weak tiers).
    markRow(aaSelect, s.antialiasing !== tierPreset.antialiasing);
    // volumetrics is a TIER preset field (potato off, medium+ on), so it gets
    // the deviation badge exactly like the RT row — unlike glow, which is a
    // runtime preference on top of a constantly-true preset field
    markRow(vol, s.volumetrics !== tierPreset.volumetrics);
  };

  preset.addEventListener('change', () => {
    if (preset.value !== '__custom') {
      const tier = preset.value as Tier;
      quality.setTier(tier);
      // QualityManager.setTier early-returns when the tier didn't change, so
      // re-selecting the SAME preset would leave stale overrides behind —
      // clear them here to make "reset to preset" always reset.
      for (const key of OVERRIDE_KEYS) {
        if (quality.override(key) !== undefined) quality.setOverride(key, undefined);
      }
      opts.setExposure(EXPOSURE_DEFAULT); // known state: neutral exposure (badge clears)
    }
    syncUI();
    persist();
  });
  scale.addEventListener('input', () => {
    quality.setOverride('renderScale', Number(scale.value));
    syncUI();
    persist();
  });
  exposure.addEventListener('input', () => {
    opts.setExposure(Number(exposure.value));
    syncUI();
    persist();
  });
  gain.addEventListener('input', () => {
    quality.setOverride('lightGain', Number(gain.value));
    syncUI();
    persist();
  });
  glow.addEventListener('change', () => {
    opts.setGlow(glow.checked);
    // syncUI is needed here too: the AA row greys 'msaa' out while the post pass runs,
    // so turning glow off must make that row selectable again without reopening the menu
    syncUI();
    persist();
  });
  rt.addEventListener('change', () => {
    quality.setOverride('raytracedLighting', rt.checked);
    syncUI(); // the override flips the preset select to "custom" + marks the row
    persist();
  });
  // volumetrics toggle: QualityManager override, applied live (rt.ts reads
  // settings.volumetrics every frame — off means no dispatch at all)
  vol.addEventListener('change', () => {
    quality.setOverride('volumetrics', vol.checked);
    syncUI();
    persist();
  });
  // AA: the player's decision, the tier preset only supplied the default. The
  // menu writes the override; main.ts (quality.onChange) hands it to the
  // pipeline, which is where the sample count actually lands.
  aaSelect.addEventListener('change', () => {
    quality.setOverride('antialiasing', aaSelect.value as AAMode);
    syncUI();
    persist();
  });
  sens.addEventListener('input', () => {
    controller.sensitivityMultiplier = Number(sens.value);
    syncUI();
    persist();
  });
  invert.addEventListener('change', () => {
    controller.invertY = invert.checked;
    persist();
  });
  // overlay toggles: apply live (main.ts owns the prefs object + hud wiring)
  // and persist, exactly like every other row in this menu.
  const setOverlay = (key: keyof OverlayPrefs, value: boolean): void => {
    opts.setOverlays({ ...opts.getOverlays(), [key]: value });
    persist();
  };
  ovCrosshair.addEventListener('change', () => setOverlay('crosshair', ovCrosshair.checked));
  ovHints.addEventListener('change', () => setOverlay('keyHints', ovHints.checked));
  ovToasts.addEventListener('change', () => setOverlay('toasts', ovToasts.checked));
  ovPerf.addEventListener('change', () => setOverlay('perf', ovPerf.checked));
  $('#set-reset').addEventListener('click', () => {
    bindings.reset();
    for (const [a, btn] of bindButtons) btn.textContent = keyLabel(bindings.get(a));
    hudWarn(null); // the old binds are gone — their conflict warning is stale
    hudNote('keybinds reset');
  });
  $('#set-resume').addEventListener('click', () => {
    // NB: not `close()` — that resolves to window.close() and would try to
    // close the TAB. Close the menu panel itself:
    finishCapture();
    root.classList.add('hidden');
    opts.onResume();
  });

  function hudNote(text: string): void {
    // local transient line inside the panel (hud.message may be hidden behind us)
    // — exclude .warn so it never writes into the conflict-warning element.
    let note = root.querySelector<HTMLElement>('.note:not(.warn)');
    if (!note) {
      note = document.createElement('div');
      note.className = 'note';
      root.querySelector('.panel')!.appendChild(note);
    }
    note.textContent = text;
  }

  function hudWarn(text: string | null): void {
    // persistent, non-blocking conflict line: kept separate from .note so the
    // transient "bound:" status can update without swallowing the warning.
    const existing = root.querySelector<HTMLElement>('.note.warn');
    if (!text) {
      if (existing) existing.hidden = true;
      return;
    }
    const warn = existing ?? document.createElement('div');
    if (!existing) {
      warn.className = 'note warn';
      root.querySelector('.panel')!.appendChild(warn);
    }
    warn.textContent = text;
    warn.hidden = false;
  }

  syncUI();

  const handle: SettingsHandle = {
    get isOpen(): boolean {
      return !root.classList.contains('hidden');
    },
    open(): void {
      finishCapture();
      syncUI();
      persist(); // captures anything changed in-game (e.g. T tier cycling)
      root.classList.remove('hidden');
    },
    close(): void {
      finishCapture();
      root.classList.add('hidden');
    },
  };

  // Esc closes the menu — but only outside keybinding capture (capture-mode
  // Esc is handled above: it unbinds). Re-locking may be rate-limited by the
  // browser right after Esc; the canvas click handler is the fallback.
  window.addEventListener('keydown', (e) => {
    if (e.code !== 'Escape' || capturing) return;
    if (root.classList.contains('hidden')) return;
    handle.close();
    opts.onResume();
  });

  return handle;
}
