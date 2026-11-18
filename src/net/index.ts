/**
 * PHASE 5 — MULTIPLAYER (P2P, no paid server)
 *
 * Plan of record:
 *   - assets:        GitHub Pages (this build)
 *   - signaling:     ~50-line Cloudflare Worker (free tier): room -> host peer id, SDP/ICE relay
 *   - game traffic:  WebRTC data channels, one player is the host (listen server)
 *   - 'events' chan: reliable + ordered  -> interactions, anchors, lore, explored cells
 *   - 'state'  chan: unreliable         -> positions at 10-20 Hz, clients interpolate ~100ms
 *   - interest mgmt: only replicate peers within N meters (the map is gigantic)
 *   - authority:     the host (fine for an exploration game)
 *
 * Contract to implement against core/transport.ts:
 *   new WebRTCTransport(signalingUrl) implements Transport
 *   connect({ room }) -> ask worker for host -> offer/answer + ICE over worker ->
 *   MeshTopology: host connects to every guest directly, guests talk via host
 *
 * Known limits (accepted for v1): host must stay online (no host migration),
 * some symmetric-NAT players may fail without TURN (surface a clear error),
 * host can cheat (nobody cares in a walking sim).
 *
 * Later, if P2P stops scaling: ServerTransport on Cloudflare Durable Objects
 * (room = object, still free tier) — game code doesn't change, only createTransport().
 */
export {};
