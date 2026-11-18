# liminal

Browser game about exploring gigantic liminal spaces. One shared world,
raytraced lighting, volumetrics, no paid servers.

**Stack (decided):** Three.js + custom WebGPU compute passes · hybrid
raytracing (traced shadows + 1–2 bounce GI) · WebGL2 fallback for weak GPUs ·
P2P multiplayer with a `Transport` seam · GitHub Pages hosting.

## Run it

```sh
npm install
npm run dev        # http://localhost:5173
npm run build      # typecheck + production build (deploy this to GitHub Pages)
```

**Controls:** click to lock pointer · WASD move · shift run · space jump ·
click/E interact · R respawn at last beacon · T cycle quality tier · M map.

## Layout

```
docs/blender-conventions.md   how to author the map in Blender (chunks, L_* lights, respawn/lore props)
docs/render-pipeline.md       pass order, tiers, fallback strategy
tools/export_map.sh|.py       Blender CLI -> chunked Draco .glb + manifest
assets/map/                   served as site root (/map/*.glb)
src/
  main.ts                     wiring
  render/                     renderer (WebGPU→WebGL2), quality tiers, frame pipeline
  render/passes/              post/bloom ✅ · gbuffer · rt-lighting · volumetrics (phase 1 stubs)
  world/                      test room ✅, collision (BVH) ✅, chunk streaming (phase 2 stub)
  gameplay/                   controller ✅, interactables ✅, anchors ✅, map device ✅, lore ✅
  core/transport.ts           THE multiplayer seam — LocalTransport now, WebRTC phase 5
  net/                        phase 5 plan (P2P + Cloudflare Worker signaling)
```

## Status

| phase | what                              | state     |
| ----- | --------------------------------- | --------- |
| 0     | vertical slice: walk the test room, glow + bloom | ✅ scaffolded |
| 1     | gbuffer + traced lighting + volumetrics + settings menu | stubs ready |
| 2     | Blender chunk streaming + worker BVHs            | conventions + export script ready |
| 3     | anchors/map-device/lore as the real in-world device | data systems ready |
| 4     | audio + atmosphere                             | not started |
| 5     | P2P multiplayer                                | `Transport` seam in place |
| 6     | GitHub Pages ship                              | not started |

## Design invariants (don't regress these)

1. **Emissive geometry is the light source** — rays hit glowy surfaces, that's
   the lighting. No Blender light objects for anything the RT must see.
2. **Volumetrics is a toggleable pass** — off must cost nothing.
3. **WebGL2 fallback always works** — "no good graphics card" is a requirement.
4. **Game code talks to `Transport`, never to WebRTC directly.**
5. **Story is data** (`lore` ids, JSON), never engine code.
