const $ = <T extends HTMLElement>(id: string): T => {
  const el = document.getElementById(id);
  if (!el) throw new Error(`missing #${id} in index.html`);
  return el as T;
};

let messageTimer: number | undefined;

/**
 * Tiny DOM HUD. Phase 3 replaces #message/#map with the in-world device UI;
 * the API stays so gameplay code doesn't care.
 */
export const hud = {
  /** transient center message (lore, anchor confirmations, hints) */
  message(text: string, ms = 2800): void {
    const el = $('message');
    el.textContent = text;
    el.classList.add('visible');
    window.clearTimeout(messageTimer);
    messageTimer = window.setTimeout(() => el.classList.remove('visible'), ms);
  },

  /** persistent top-left line: backend / tier / fps */
  stats(text: string): void {
    $('stats').textContent = text;
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
    el.textContent = `the game failed to start:\n\n${err instanceof Error ? err.stack ?? err.message : String(err)}`;
  },
};
