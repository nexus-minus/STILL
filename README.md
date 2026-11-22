# liminal (actively in developement)

Browser game about exploring gigantic liminal spaces. One shared world,
raytraced lighting, volumetrics, no paid servers.

**Stack:** Three.js + WebGPU compute (experimental real-time hybrid lighting),
WebGL2 fallback, P2P multiplayer seam, GitHub Pages hosting.

**Lighting note:** `/pathtrace.html` is the A/B test for the maintained
`three-gpu-pathtracer` implementation (true rectangular area lights + MIS).
The game's current custom hybrid pass is an approximation, not Cycles. See
`docs/render-pipeline.md` for the tested comparison and recommended
static-bake + dynamic-light split.

## Run it

```sh
npm install
npm run dev        # http://localhost:5173
npm run build      # typecheck + production build (deploy this to GitHub Pages)
```
or: https://nexus-minus.github.io/STILL

**Controls:** click to lock pointer · WASD move · shift run · space jump ·
E interact · R respawn · T quality · M map · B glow · F freecam · F2 screenshot
(saves to a picked folder).

## Layout

```
docs/blender-conventions.md   how to author the map in Blender (chunks, L_* lights, respawn/lore props)
docs/render-pipeline.md       renderer status, path-tracer comparison, lighting plan
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
| 1a    | custom WebGPU hybrid lighting                    | experimental; compare with `/pathtrace.html` |
| 1b    | volumetrics + denoiser / quality settings         | planned |
| 2a    | Blender map export + static world load           | ✅ works (first map imported) |
| 2b    | Cycles-baked static GI/lightmaps + dynamic shadow | recommended next lighting architecture |
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
