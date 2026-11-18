/**
 * THE MULTIPLAYER SEAM
 *
 * Decided in planning: everyone plays together, no paid server.
 *   phase 0-4 : LocalTransport   — single player, but every system already
 *                                  talks through this interface.
 *   phase 5   : WebRTCTransport  — P2P listen-server, one player hosts;
 *                                  signaling via a ~50-line Cloudflare Worker.
 *   later     : ServerTransport  — dedicated relay/authoritative server
 *                                  (Cloudflare Durable Objects free tier)
 *                                  once one world isn't enough.
 *
 * Rule: game code never imports a concrete transport. Call createTransport().
 */

export type TransportKind = 'local' | 'webrtc' | 'server';

/** 'state'   = unreliable, high-frequency positions (send latest only)
 *  'events'  = reliable, ordered (interactions, anchors, lore, explored cells) */
export type Channel = 'state' | 'events';

export interface TransportPeer {
  id: string;
}

export interface Transport {
  readonly kind: TransportKind;
  status: 'idle' | 'connecting' | 'connected' | 'closed';

  connect(opts?: { room?: string }): Promise<void>;
  send(channel: Channel, payload: unknown): void;
  disconnect(): void;

  onStatus?: (status: Transport['status']) => void;
  onPeerJoin?: (peer: TransportPeer) => void;
  onPeerLeave?: (peer: TransportPeer) => void;
  onMessage?: (channel: Channel, payload: unknown, from: TransportPeer) => void;
}

/** Single-player loopback. send() has nobody to talk to. */
export class LocalTransport implements Transport {
  readonly kind: TransportKind = 'local';
  status: Transport['status'] = 'idle';

  onStatus?: (status: Transport['status']) => void;
  onPeerJoin?: (peer: TransportPeer) => void;
  onPeerLeave?: (peer: TransportPeer) => void;
  onMessage?: (channel: Channel, payload: unknown, from: TransportPeer) => void;

  async connect(): Promise<void> {
    this.status = 'connected';
    this.onStatus?.('connected');
  }

  send(): void {
    // nobody to talk to in single player
  }

  disconnect(): void {
    this.status = 'closed';
    this.onStatus?.('closed');
  }
}

export function createTransport(): Transport {
  // phase 5: return new WebRTCTransport(signalingUrl);
  return new LocalTransport();
}
