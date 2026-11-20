/**
 * Keybindings: one primary key per action, remappable in settings, persisted.
 * Movement code reads through here — no hardcoded KeyW anywhere else.
 */

export type Action =
  | 'forward'
  | 'back'
  | 'left'
  | 'right'
  | 'jump'
  | 'run'
  | 'interact'
  | 'glow'
  | 'map'
  | 'respawn'
  | 'quality';

export type Binds = Record<Action, string>;

export const DEFAULT_BINDS: Binds = {
  forward: 'KeyW',
  back: 'KeyS',
  left: 'KeyA',
  right: 'KeyD',
  jump: 'Space',
  run: 'ShiftLeft',
  interact: 'KeyE',
  glow: 'KeyB',
  map: 'KeyM',
  respawn: 'KeyR',
  quality: 'KeyT',
};

/** actions the settings menu offers for rebinding — the keys the game is
 *  actually played with. Dev tools (glow/respawn/quality cycle) keep working
 *  on fixed keys but get no row: they're not player controls. */
export const PLAYER_ACTIONS: Action[] = [
  'forward',
  'back',
  'left',
  'right',
  'jump',
  'run',
  'interact',
  'map',
];

/** every action, including the dev tools — conflict detection must see all of
 *  them so stealing a dev key still warns and swaps instead of silently
 *  remapping a tool behind the player's back. */
export const ALL_ACTIONS: Action[] = Object.keys(DEFAULT_BINDS) as Action[];

export const ACTION_LABELS: Record<Action, string> = {
  forward: 'Move forward',
  back: 'Move back',
  left: 'Move left',
  right: 'Move right',
  jump: 'Jump',
  run: 'Run',
  interact: 'Interact',
  glow: 'Toggle glow',
  map: 'Map',
  respawn: 'Respawn at beacon',
  quality: 'Cycle quality',
};

const STORAGE_KEY = 'liminal.binds.v1';

/** Human label: 'KeyW' -> 'W', 'ShiftLeft' -> 'Left Shift', 'Mouse2' -> 'Right Mouse' */
export function keyLabel(code: string): string {
  if (!code) return '— none';
  if (code.startsWith('Mouse')) {
    const button = Number(code.slice(5)); // DOM button: 0=left 1=middle 2=right
    return ['Left Mouse', 'Middle Mouse', 'Right Mouse', 'Mouse 4', 'Mouse 5'][button] ?? code;
  }
  if (code.startsWith('Key')) return code.slice(3);
  if (code.startsWith('Digit')) return code.slice(5);
  if (code.startsWith('Numpad')) return 'Num ' + code.slice(6);
  if (code === 'ShiftLeft') return 'Left Shift';
  if (code === 'ShiftRight') return 'Right Shift';
  if (code === 'Space') return 'Space';
  if (code === 'Escape') return 'Esc';
  if (code.startsWith('Arrow')) return code.slice(5) + ' arrow';
  return code;
}

export class Bindings {
  binds: Binds;

  constructor(persisted?: Partial<Binds>) {
    this.binds = { ...DEFAULT_BINDS, ...persisted };
  }

  get(action: Action): string {
    return this.binds[action];
  }

  matches(action: Action, code: string): boolean {
    return this.binds[action] === code;
  }

  /** empty string = unbound (e.g. pressing Esc during capture) */
  set(action: Action, code: string): void {
    if (code) {
      const stolen = (Object.keys(this.binds) as Action[]).find(
        (other) => other !== action && this.binds[other] === code,
      );
      if (stolen) this.binds[stolen] = this.binds[action]; // swap, never double-bind
    }
    this.binds[action] = code;
    this.save();
  }

  reset(): void {
    this.binds = { ...DEFAULT_BINDS };
    this.save();
  }

  save(): void {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(this.binds));
    } catch {
      /* private mode */
    }
  }
}

export function loadBinds(): Partial<Binds> | undefined {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    return raw ? (JSON.parse(raw) as Partial<Binds>) : undefined;
  } catch {
    return undefined;
  }
}
