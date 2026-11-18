const STORAGE_KEY = 'liminal.map.v1';
const CELL = 4; // meters per explored cell

/**
 * THE MAP DEVICE
 *
 * Tracks where you have been. Cells are 4m squares recorded as you walk;
 * explored state persists per browser (and syncs over the transport's
 * reliable channel in phase 5, so the shared world remembers what anyone
 * explored).
 *
 * draw() is the fog-of-war view: explored cells lit, everything else black,
 * you in the middle. Phase 3 upgrades this into the in-world device UI.
 */
export class MapDevice {
  private readonly cells = new Set<string>();
  dirty = false;

  constructor() {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (raw) for (const key of JSON.parse(raw) as string[]) this.cells.add(key);
    } catch (err) {
      console.warn('[map] failed to restore', err);
    }
  }

  markVisited(x: number, z: number): void {
    const key = cellKey(x, z);
    if (this.cells.has(key)) return;
    this.cells.add(key);
    this.dirty = true;
    this.save();
  }

  has(x: number, z: number): boolean {
    return this.cells.has(cellKey(x, z));
  }

  get exploredCells(): number {
    return this.cells.size;
  }

  get exploredMeters(): number {
    return this.cells.size * CELL * CELL;
  }

  /** Fog-of-war render into ctx, centered on world (x, z). */
  draw(
    ctx: CanvasRenderingContext2D,
    x: number,
    z: number,
    opts: { cellPx?: number; range?: number } = {},
  ): void {
    const cellPx = opts.cellPx ?? 4;
    const range = opts.range ?? 24; // cells each way from center

    const w = ctx.canvas.width;
    const h = ctx.canvas.height;
    ctx.clearRect(0, 0, w, h);
    ctx.fillStyle = 'rgba(0, 0, 0, 0.9)';
    ctx.fillRect(0, 0, w, h);

    const cx = Math.floor(x / CELL);
    const cz = Math.floor(z / CELL);

    for (let dz = -range; dz <= range; dz++) {
      for (let dx = -range; dx <= range; dx++) {
        if (!this.has((cx + dx) * CELL, (cz + dz) * CELL)) continue;
        ctx.fillStyle = '#f2e9c9';
        ctx.fillRect(w / 2 + dx * cellPx - cellPx / 2, h / 2 + dz * cellPx - cellPx / 2, cellPx - 1, cellPx - 1);
      }
    }

    // player marker
    ctx.fillStyle = '#ff5f5f';
    ctx.beginPath();
    ctx.arc(w / 2, h / 2, 3, 0, Math.PI * 2);
    ctx.fill();

    this.dirty = false;
  }

  private save(): void {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify([...this.cells]));
    } catch (err) {
      console.warn('[map] failed to persist', err);
    }
  }
}

function cellKey(x: number, z: number): string {
  return `${Math.floor(x / CELL)},${Math.floor(z / CELL)}`;
}
