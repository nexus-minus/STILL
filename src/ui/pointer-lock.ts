/**
 * requestPointerLock() can REJECT with SecurityError (Chrome enforces a cooldown
 * after Esc-exits) — as a returned promise or even synchronously. Every call
 * site must go through here so a rejection can never surface as an uncaught
 * error in the console.
 */
export function requestPointerLockSafe(canvas: HTMLCanvasElement): void {
  try {
    const result = canvas.requestPointerLock() as unknown as Promise<void> | undefined;
    if (result && typeof result.then === 'function') {
      result.catch(() => {
        /* cooldown or gesture missing — caller shows the click-to-enter overlay */
      });
    }
  } catch {
    /* synchronous SecurityError on some browsers */
  }
}
