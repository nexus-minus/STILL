# Grafik, wie sie gerade funktioniert (zum Einfügen in eine KI)

Der Text ist auf Deutsch, damit du ihn selbst lesen und in eine KI einfügen kannst.
Messwerte kommen von `scripts/bake-stats.mjs` und `scripts/banding-check.mjs`.
Was neu ist (22.11.2026) steht in Abschnitt 6.

## 1. Stack und Hosting

- Vite + TypeScript + Three.js (r187), gebaut als statische Dateien, gehostet auf
  GitHub Pages (`nexus-minus/STILL`). Kein Server, keine bezahlten Dienste.
- **WebGPU compute** ist der eigentliche Weg. Browser haben **keine Hardware-Raytracing-API**,
  daher wird jeder Strahl softwaremäßig gegen einen `three-mesh-bvh`-BVH geprüft (BVH =
  ein Baum aus Raumkästen, damit man nicht jedes Dreieck einzeln testen muss).
  Wenn WebGPU fehlschlägt, fällt alles auf **WebGL2** zurück (normales Rendering + Bloom,
  ohne Strahlen) — erkannt durch Test, nicht durch Raten.
  Sicherheitsnetze: Startup-Watchdog, `uncapturederror`-Hook, Black-Frame-Erkennung,
  Meldungen auf dem Bildschirm.
- Qualitätsstufen: potato (WebGL2, 0,75 Skalierung, 0 Strahlen) · medium (Viertel-Auflösung RT) ·
  high (halbe Auflösung) · ultra (volle Auflösung).

## 2. Ein Frame (WebGPU-Weg)

```
[1] raster G-buffer    albedo (flache Farben, keine Texturen) + normal/depth + emissive mask
[2] lighting compute   pro Pixel bei lightingScale:
       primary ray → BVH first hit
       shadow ray  → ein zufälliger Punkt auf der Boxfläche jeder Mesh-Lampe (NEE)
       bounce ray  → 1 Reflexion; trifft sie eine leuchtende Fläche = indirektes Licht
       AO ray      → kurzer Strahl um die Normalen
       temporal    → mit dem letzten Frame gemischt (still = sammelt, moving = live)
[3] denoise            kantenerkennender à-trous-Filter, geführt von Normal + Tiefe (4 Runden)
[4] fog (optional)     raymarched, dithered Schritte, 12 m Lichtreichweite; aus = keine Kosten
[5] composite          diffuse × lighting + emissive + specular + baked term,
                       dann fog (beauty·T + S) → bloom → AgX tone map → Dither
```

## 3. Lighting-Aufteilung (das ist der Kern des Designs)

- **Leuchtende Geometrie ist die Lichtquelle** — glühende Meshes mit Principled Emission.
  Keine Blender-Lampen-Objekte. Ein Mesh-Light-Eintrag pro Leuchte (Mitte, Halbe Ausmaße,
  Ausrichtung, Farbe, Leistung, optional `cone_deg`), in einem GPU-Speicher-Puffer ohne
  Obergrenze.
- **Statisches Lighting ist baked** mit Cycles (`tools/bake_map.sh`): automatisches UV2-
  Lightmap-Pack in ein gemeinsames Atlas, Combined-Bake, als **RGBM**-PNG gespeichert,
  glTF-Export mit `TEXCOORD_1`, Verweis im Manifest.
- **Realtime-Strahlen nur für das, was sich ändert** (dynamische Lichter, animierte Objekte,
  Spieler). Ein `baked`-Flag pro Licht verhindert, dass statische Leuchten doppelt beleuchtet
  werden; dynamische Geometrie erkennt man daran, dass sie kein `TEXCOORD_1` hat.
- Der baked Anteil wird **nach** dem Albedo-Multiplikator addiert (ein Combined-Bake enthält
  Albedo schon), einmal CPU-seitig beim Laden dekodiert mit K = π, damit statisch und
  realtime dieselbe Helligkeitsskala nutzen. Potato bekommt den Bake über den forward
  emissive slot.

## 4. Spieler-Controller

Kapsel-Physik mit Depenetration + Substeps, begehbare Hänge ≤ 50°, getesteter Step-up
(kann nie durch Wände drücken), Bewegungsmodell (Tempolimit, Abfahrten darüber, Sprünge
behalten ≥ 85 %), coyote time + 100 ms Eingabe-Puffer, keine Kamera-Bob. Getestet mit
33 Checks.

## 5. Deine Anforderungen (das sind Entscheidungen, keine Vorschläge)

1. **Noise muss praktisch unsichtbar sein.** Nicht "denoised bis akzeptabel", sondern
   unter dem, was das Auge sieht.
2. **Ein fertiger Frame bleibt erhalten.** Wenn nichts ändert, wird derselbe Frame weiter
   benutzt — kein Neu-Rechnen. Idle kostet also nichts.
3. **Es soll wie Cycles aussehen** (weiches indirektes Licht, Farb-Blending, Areaschatten,
   AgX-Roll-off), aber spielbar bleiben.
4. **60 fps auf Gaming-GPUs, und einfache Laptops dürfen nicht ausgeschlossen werden**
   (dafür ist die WebGL2-Stufe da).
5. **Kein sichtbarer Übergang zwischen baked und realtime.** Der Spieler darf nicht sehen,
   welche Pixel aus dem Bake kommen.
6. Nur flache Materialien, keine Texturen; UI ist fast nichts; Interaktionen ändern die Welt,
   nicht eine Meldung.
7. Map-Arbeit bleibt eine einzige `.blend`-Datei mit Collections; der Exporteur darf nie
   Handarbeit verlangen (Chunking, UVs, Baken laufen automatisch).

## 6. Was am 22.11.2026 dazukam

**a) Dither gegen Banding.** Das Problem: 8 Bit haben nur 256 Werte. Ein glatter Verlauf
landet dann auf Treppenstufen (Platteaus), und die Kante zwischen zwei Stufen ist das Band,
das man sieht. Dither verteilt den Fehler gleichmäßig über viele Pixel statt auf eine Kante;
das Auge mischt das zu einem glatten Verlauf. Ehrlich gesagt: Dithering kann keine
Information zurückholen — das normale Runden ist sogar minimal genauer (0,00 % vs 0,01 %
Blockfehler), Dithering ist eine **wahrgenommene** Verbesserung, keine genauere. Darum sind
 beide Wege gemessen und dokumentiert.
 Wichtig ist der Ort: der Dither muss **nach** Tone Mapping und sRGB passieren, also genau
 beim Moment, in dem der Wert 8 Bit wird. Auf linearem Licht wäre 1/255 die falsche Größe,
 und die Tonkurve dehnt genau die dunklen Bereiche, wo Banding sichtbar ist. Der Index ist
 das **Anzeige-Pixel**, nicht das Lighting-Texel (ein Viertel-Auflösungs-Puffer würde sonst
 allen Pixeln im selben Texel denselben Schwellwert geben und das Banding bleibt).

**b) Frame-Einfrieren (Dirty-Flag-Scheduler).** Gerechnet wird nur, wenn sich etwas geändert
hat (Kamera, Einstellungen, Debug-Ansicht, Lichtwerte, Lichtliste, Puffergröße). Nach dem
Ändern laufen `?settle=N` Frames (Standard 6), dann friert das Bild ein und der Composite
zeigt die vorhandenen Puffer noch einmal — daher der Frame-Gewinn auf dem Laptop.
Die Grenze, ehrlich: bei `blendAlpha = 0,08` braucht man etwa 12 effective Samples, damit die
History dominiert. Nach 6 Frames ist das Bild nur **teilweise** zusammengerechnet — deshalb ist `?settle=N` der
Qualitäts-Regler: höher = schönere dunkle Verläufe, weniger Frame-Budget. Was du gesagt hast:
4–6 Frames sind okay, und lange Flure mit weichem Licht sind wichtiger als glänzende Böden.
Der HUD zeigt `· frozen` in der FPS-Zeile, damit man es sehen kann.

**c) Motion-Reprojektion.** Früher wurde der ganze Frame zurückgesetzt, sobald die Kamera sich
bewegte — genau deshalb sah Stillstehen sauber aus und Gehen noisy. Jetzt projiziert jeder
Pixel seinen Trefferpunkt mit der **letzten** Kamera und liest das History-Texel, in dem dieser
Punkt vorher lag. Ein Tiefen-Check prüft, ob dort wirklich dieselbe Fläche war; wenn nicht
(disocclusion), startet dieser Pixel neu statt ein Geist nachzuziehen. Kostet eine
Matrix-Multiplikation und einen Textur-Read pro Pixel.

## 7. Bekannte Probleme (gemessen)

**Banding im Bake** — `scripts/banding-check.mjs` auf dem aktuellen 2048²-Atlas:
- 70,9 % des Atlas liegen in flachen Platteaus ≥ 8 px Breite; ein Platteau plus ein
  1-LSB-Sprung ist genau das, was als Band aussieht.
- Im dunklen Bereich (Luma 5–32) gibt es nur **15 verschiedene Werte** über den dunklen
  Pixeln; der RGBM-Multiplikator verschwendet 42 % des Atlas mit Wert 0 (leere Inseln +
  Schwarz).
- Ein gemeinsames Atlas für eine Map von ~163 × 88 × 35 m ergibt etwa 10–20 Texel pro Meter.
  Für gute Qualität will man meist 64–128 Texel/m, also ist die niedrige Auflösung, die du
  siehst, hauptsächlich ein **Texel-Dichte**-Problem und nicht nur ein Bit-Depth-Problem.

**Weitere offene Punkte:**
- Der zweite Bounce wird von high/ultra verlangt, ist aber in `rt.ts` auf 1 begrenzt.
- Licht-Culling gibt es für Fog, noch nicht für die Oberflächen-Schleife.
- Dynamische Objekte (Entitäten, Spieler) haben keine Licht-Proben, können dem baked Look
  nicht entsprechen; sie brauchen ein realtime Licht + einen Schatten-Term.
- Ein weltweiter BVH wird beim Laden im Hauptthread gebaut; automatisches Chunk-Streaming
  ist Phase 2.
- Reflexionen sind als raytraced pro Material entschieden (roughness-gated), nicht
  screen-space; noch nicht implementiert.
- Bei den Lampen: der Verdacht, dass einige zu hell sind, ist noch nicht bestätigt. Eine
  Warnung im Bake-Report pro Leuchte wäre billiger als das visuell zu suchen.

## 8. Wofür ich eine Meinung brauche

1. Ist "Frame einfrieren wenn nichts sich ändert" das richtige Muster für ein langsames
   Explorations-Spiel, und wie machen das Spiele, die echt realtime bleiben müssen?
2. Was ist der billigste Weg zu einem banding-freien Bake: Blue-Noise-Dither, 10/16-Bit
   Speicherung, oder per-Chunk Lightmap-Atlanten mit Streaming (oder alles drei)?
3. Wie macht man baked und realtime ununterscheidbar — irradiance ohne Albedo bakhen,
   Licht-Proben für bewegte Objekte, ein eigener Dynamik-Schatten-Term, und eine weiche
   Coverage-Mischung? Gibt es einen besseren Weg?
4. Ohne Hardware-RT im Browser: welcher Ray-Budget pro Pixel ist realistisch für 60 fps auf
   einer Mittelklasse-GPU, während der Noise unsichtbar bleibt?
5. Zwei Entscheidungen, die ich von dir brauche: **Zimmer** automatisch per Grid oder deine
   `rooms`-Collection im `.blend`? Und Anti-Aliasing: **MSAA** oder **SMAA**?
