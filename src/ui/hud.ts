const $ = <T extends HTMLElement>(id: string): T => {
  const el = document.getElementById(id);
  if (!el) throw new Error(`missing #${id} in index.html`);
  return el as T;
};

let messageTimer: number | undefined;
/** Toasts default OFF: a fresh load shows game + crosshair only — every other
 *  player overlay is opt-in via Settings → Overlays (persisted in main.ts). */
let toastsOn = false;

/** Settings → Overlays. crosshair and the performance line are the default-on
 *  overlays; everything else is opt-in. */
export interface OverlayPrefs {
  crosshair: boolean;
  keyHints: boolean;
  toasts: boolean;
  /** the fps + frozen line (bottom-left) — the HUD readout the player asked for */
  perf: boolean;
}

function showMessage(text: string, ms: number): void {
  const el = $('message');
  el.textContent = text;
  el.classList.add('visible');
  window.clearTimeout(messageTimer);
  messageTimer = window.setTimeout(() => el.classList.remove('visible'), ms);
}

/**
 * Tiny DOM HUD. Phase 3 replaces #message/#map with the in-world device UI;
 * the API stays so gameplay code doesn't care.
 */
export const hud = {
  /** transient center message (lore, anchor confirmations, hints) — a toast:
   *  suppressed unless the Toasts overlay is enabled */
  message(text: string, ms = 2800): void {
    if (!toastsOn) return;
    showMessage(text, ms);
  },

  /** same visual as message(), but ignores the toasts toggle — for things the
   *  player must see regardless of overlay prefs (critical errors, ?rtdebug
   *  legend) */
  alert(text: string, ms = 2800): void {
    showMessage(text, ms);
  },

  /** apply Settings → Overlays (restored from persistence in main.ts) */
  setOverlays(prefs: OverlayPrefs): void {
    toastsOn = prefs.toasts;
    $('crosshair').classList.toggle('hidden', !prefs.crosshair);
    $('hint').classList.toggle('hidden', !prefs.keyHints);
    $('perf').classList.toggle('hidden', !prefs.perf);
    if (!toastsOn) {
      // an active toast must not linger after the toggle turns toasts off
      window.clearTimeout(messageTimer);
      $('message').classList.remove('visible');
    }
  },

  /** ?dev=1 readouts (coords/fps + driver line) — developer tools, never
   *  offered in player settings */
  setDevVisible(on: boolean): void {
    $('stats').classList.toggle('hidden', !on);
    $('driver').classList.toggle('hidden', !on);
  },

  /** persistent top-left line: backend / tier / fps */
  stats(text: string): void {
    $('stats').textContent = text;
  },

  /** the player-facing performance line (bottom-left): fps + the idle freeze.
   *  A frozen frame and a slow frame look identical on screen, so the line has
   *  to say which one it is — that is what the settings-hud check asserts. */
  perf(text: string): void {
    $('perf').textContent = text;
  },

  mapCanvas(): HTMLCanvasElement {
    return $<HTMLCanvasElement>('map');
  },

  mapVisible(): boolean {
    return $('map').classList.contains('visible');
  },

  toggleMap(): boolean {
    const el = $('map');
    el.classList.toggle('visible');
    return el.classList.contains('visible');
  },

  fatal(err: unknown): void {
    const el = $<HTMLDivElement>('fatal');
    el.style.display = 'block';
    const diagnostics = (err as { diagnostics?: string[] } | null)?.diagnostics;
    el.textContent =
      `the game failed to start:\n\n` +
      `${err instanceof Error ? (err.stack ?? err.message) : String(err)}` +
      (diagnostics ? `\n\n--- what we tried ---\n${diagnostics.join('\n')}` : '') +
      `\n\nbrowser: ${navigator.userAgent}\n` +
      `Please copy this screen (or the browser console, F12) when asking for help.`;
  },
};
