const STORAGE_KEY = 'liminal.anchors.v1';

export interface Anchor {
  id: string;
  label: string;
  position: { x: number; y: number; z: number };
  discoveredAt: number;
}

/**
 * Respawn anchors: interact with a beacon -> it becomes a fast-travel /
 * respawn point. Persisted in localStorage for now; the same records go over
 * the transport's reliable channel in phase 5 so everyone shares discovery
 * (host keeps the authoritative list).
 */
export class AnchorRegistry {
  private readonly anchors = new Map<string, Anchor>();

  constructor() {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (raw) {
        for (const anchor of JSON.parse(raw) as Anchor[]) this.anchors.set(anchor.id, anchor);
      }
    } catch (err) {
      console.warn('[anchors] failed to restore', err);
    }
  }

  list(): Anchor[] {
    return [...this.anchors.values()];
  }

  get(id: string): Anchor | undefined {
    return this.anchors.get(id);
  }

  activate(anchor: Omit<Anchor, 'discoveredAt'>): Anchor {
    const record: Anchor = { ...anchor, discoveredAt: Date.now() };
    this.anchors.set(anchor.id, record);
    this.save();
    return record;
  }

  private save(): void {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(this.list()));
    } catch (err) {
      console.warn('[anchors] failed to persist', err);
    }
  }
}
