import { TIER_ORDER, type QualityManager, type Tier } from '../render/quality.js';
import { ACTION_LABELS, keyLabel, type Action, type Bindings } from '../gameplay/bindings.js';
import type { PlayerController } from '../gameplay/controller.js';

const STORAGE_KEY = 'liminal.settings.v1';

export interface PersistedSettings {
  tier?: Tier;
  sensitivity?: number;
  invertY?: boolean;
  renderScale?: number;
  raytracedLighting?: boolean;
  lightGain?: number;
  exposure?: number;
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

const BIND_ACTIONS: Action[] = [
  'forward',
  'back',
  'left',
  'right',
  'jump',
  'run',
  'interact',
  'glow',
  'map',
  'respawn',
  'quality',
];

/**
 * Settings menu — presets + manual fine-tuning + keybinds + mouse feel.
 * DOM overlay opened when pointer lock is released (Esc). Every change applies
 * live AND persists; picking a preset clears manual overrides (that's what a
 * preset is), touching a slider makes it "custom".
 */
export function initSettings(opts: {
  quality: QualityManager;
  bindings: Bindings;
  controller: PlayerController;
  hasRaytracing: boolean;
  onResume: () => void;
  getExposure: () => number;
  setExposure: (value: number) => void;
}): SettingsHandle {
  const { quality, bindings, controller } = opts;

  const root = document.createElement('div');
  root.id = 'settings';
  root.classList.add('hidden');
  root.innerHTML = `
    <div class="panel">
      <h2>Settings</h2>
      <div class="cols">
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
            <span>Exposure <em id="set-exp-val"></em></span>
            <input type="range" id="set-exp" min="0.5" max="4" step="0.1" />
          </label>
          <label class="row">
            <span>Light intensity <em id="set-gain-val"></em></span>
            <input type="range" id="set-gain" min="0.2" max="3" step="0.1" />
          </label>
          <label class="row check">
            <input type="checkbox" id="set-rt" ${opts.hasRaytracing ? '' : 'disabled'} />
            <span>Raytraced shadows + GI${opts.hasRaytracing ? '' : ' — unavailable (no WebGPU)'}</span>
          </label>
          <label class="row check disabled">
            <input type="checkbox" disabled />
            <span>Volumetrics — arrives with phase 1b</span>
          </label>
        </section>
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
    lightGain: quality.override('lightGain'),
    exposure: opts.getExposure(),
  };
  const persist = (): void => {
    persisted.tier = quality.tier;
    persisted.sensitivity = controller.sensitivityMultiplier;
    persisted.invertY = controller.invertY;
    persisted.renderScale = quality.override('renderScale');
    persisted.raytracedLighting = quality.override('raytracedLighting');
    persisted.exposure = opts.getExposure();
    persisted.lightGain = quality.override('lightGain');
    saveSettings(persisted);
  };

  // ---- keybind rows ---------------------------------------------------------
  const bindsRoot = $('#set-binds');
  const bindButtons = new Map<Action, HTMLButtonElement>();
  for (const action of BIND_ACTIONS) {
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
    bindings.set(action, code);
    // a swap may have changed other rows — refresh everything
    for (const [a, btn] of bindButtons) btn.textContent = keyLabel(bindings.get(a));
    hudNote(`bound: ${ACTION_LABELS[action]} → ${keyLabel(code)}`);
  };

  bindsRoot.addEventListener('click', (e) => {
    const button = (e.target as HTMLElement).closest('button');
    if (!button) return;
    const action = BIND_ACTIONS.find((a) => bindButtons.get(a) === button);
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
  const rt = $<HTMLInputElement>('set-rt');
  const sens = $<HTMLInputElement>('set-sens');
  const sensVal = $<HTMLElement>('set-sens-val');
  const invert = $<HTMLInputElement>('set-invert');

  const syncUI = (): void => {
    const s = quality.settings;
    preset.value = quality.hasOverrides ? '__custom' : quality.tier;
    scale.value = String(s.renderScale);
    scaleVal.textContent = `${Math.round(s.renderScale * 100)}%`;
    exposure.value = String(opts.getExposure());
    exposureVal.textContent = `${opts.getExposure().toFixed(1)}×`;
    gain.value = String(s.lightGain);
    gainVal.textContent = `${s.lightGain.toFixed(1)}×`;
    rt.checked = s.raytracedLighting;
    sens.value = String(controller.sensitivityMultiplier);
    sensVal.textContent = `${controller.sensitivityMultiplier.toFixed(2)}×`;
    invert.checked = controller.invertY;
  };

  preset.addEventListener('change', () => {
    if (preset.value !== '__custom') quality.setTier(preset.value as Tier);
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
  rt.addEventListener('change', () => {
    quality.setOverride('raytracedLighting', rt.checked);
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
  $('#set-reset').addEventListener('click', () => {
    bindings.reset();
    for (const [a, btn] of bindButtons) btn.textContent = keyLabel(bindings.get(a));
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
    let note = root.querySelector<HTMLElement>('.note');
    if (!note) {
      note = document.createElement('div');
      note.className = 'note';
      root.querySelector('.panel')!.appendChild(note);
    }
    note.textContent = text;
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
