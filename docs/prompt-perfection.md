# Prompt — die komplette Überarbeitung (für eine stärkere KI)

Kopiere alles zwischen den Linien in die KI. Vorher einmal `docs/` durchlesen lassen —
die Doku ist der Stand der Dinge, und sie enthält die Entscheidungen, die schon gefallen sind.

---

Du arbeitest am Projekt **Liminal** (Repo: `https://github.com/nexus-minus/STILL`,
Arbeitsverzeichnis des Nutzers). Der Nutzer ist 14–16 Jahre alt und kann nicht programmieren, deshalb programmierst du
alles für ihn. Er arbeitet künstlerisch: Modellbau, Story, Map.

## Sprache und Ton (Pflicht)

- Antworten auf **Deutsch**, du-Form, einfach, locker, sparsam mit Emojis.
- Fachbegriffe beim ersten Mal in einem Satz erklären.
- Immer genau sagen: **was er testen soll und worauf er achten soll.**
- Nicht behaupten, etwas sei besser — nur Zahlen nennen, die gemessen wurden.
  Wenn etwas nicht gemessen werden kann, steht ausdrücklich: „das kann ich hier nicht
  messen, das sieht nur er auf seinem Rechner."
- Zwischen jeder Änderung: 1–2 Sätze, was du tust und warum, und wie man es prüft.

## Harten Rahmen (gilt für alles, was du vorschlägst oder baust)

1. **60 fps auf Gaming-GPUs, und es muss auf einfachen Laptops laufen.** Alles, was du
   vorschlägst, braucht eine Kosten-Abschätzung pro Frame und einen Fallback für kleine GPUs.
2. **Noise darf praktisch unsichtbar sein** (nach dem Settle-Fenster). Bänder dürfen auf dem
   Schirm nicht sichtbar sein.
3. **Deterministisch, wo sich nichts ändert; Strahlen nur für das, was sich ändert.**
   Stillstand = kein Rechenanteil.
4. **Er kann nicht programmieren.** Jede Lösung muss ohne sein Zutun laufen; was er tun muss,
   ist nur: Map bauen, Lampen setzen, `tools/bake_map.sh` ausführen, im Spiel schauen.
5. **Er kann keine Node-Skripte ausführen.** Messwerkzeuge laufen hier (bei dir), nicht bei ihm.
   WebGPU läuft hier nicht (kein Browser) — alles, was das **Bild** betrifft, muss er auf seinem
   Rechner schauen; dafür gibt es `docs/test-checklist-de.md`.
6. Commits an `https://github.com/nexus-minus/STILL` mit
   `git commit --author="blackphoenix <epicbrine_11@outlook.com>"`, Meldung beschreibt, **was
   geändert** wurde. Branch ist `master`. `package-lock.json` nicht unnötig ändern.
7. `assets/artwork/` wird ohne Bild-Metadaten ausgeliefert (Künstler-Credit: **Eldar**).
   `tools/check_metadata.py` prüft das.

## Entscheidungen, die schon gefallen sind (nicht wieder aufbrechen, nur verbessern)

- **Kein Raum-Begriff.** Die Welt ist kein Zimmer-Grundriss (Gänge, Hallen, Höhlen, Höfe,
  Außenbereiche). Die Licht-Zuordnung ist ein **weltweites, automatisch aus der Geometrie
  gebautes Raster** (Spatial Hash / Voxelzellen), nie ein benanntes Zimmer. Der Nutzer soll
  nichts benennen.
- **16-Bit-Half-Float als Bake-Speicher** (`assets/map/lightmap.bin`, Manifest
  `encoding: "half"`), 8-Bit-PNG bleibt Vorschau und Bericht. Begründung gemessen.
- **Dither gehört an den 8-Bit-Schirm-Schritt** (nach dem Tone-Mapping,
  `src/render/bluenoise.ts`), nicht in den Speicher. Blauer Rauschen, Ditherindex =
  Bildschirmpixel.
- **Antialiasing = Entscheidung des Spielers im Settings-Menü** (aus / MSAA / SMAA),
  Standard: SMAA auf schwachen GPUs, MSAA wenn die GPU es kann.
- **Bake ist das Fundament, Raytracing ist optionale Ambience** (reflections nur bei
  niedriger Roughness + dynamische Lichter).
- Dithering ist ein **wahrgenommenes** Fix, kein Genauigkeits-Fix: einfaches Runden ist
  messbar genauer (0,00 % vs. 0,01 % Blockfehler). Das soll dabeistehen.

## Was du überarbeiten sollst (in dieser Reihenfolge)

### A. Beleuchtung: „egal wie die Map aussieht, es sieht gut aus"

Das ist das Ziel, nicht eine Liste von Techniken. Prüfe den jetzigen Weg
(`tools/bake_map.py`, `src/world/map-loader.ts`, `src/render/rt.ts`,
`src/render/passes/*`) und verbessere ihn so, dass er **geometrie-unabhängig** funktioniert:

- Raster über die ganze Welt (kein Raum, kein Box-Grundriss): Zellengröße automatisch aus
  der Geometrie, keine Autorenarbeit, keine Spezialfälle für Wände oder Decken.
- **Was sich bewegt, kann nicht gebaked werden** — ein Bake speichert Licht pro Flächenort,
  ein bewegtes Objekt besucht viele Orte. Baue dafür die Licht-in-Raum-Zellen-Version
  (order-2 SH / irradiance), damit bewegte Objekte gleich aussehen wie statische Wände,
  ohne Strahlen pro Frame.
- **Was seinen Zustand ändert** (Tür, Lampe an/aus): zeige eine Lösung, die ohne
  Runtime-Cycles auskommt. Optionen, die du gegeneinander abwägen sollst:
  vorberechnete Varianten pro markiertem Zustand, Overlay-Layer über den Bake,
  Dirty-Flag-Update nur für die betroffenen Inseln, Partial-Rebake im Editor.
  Nenne, was davon wirklich läuft und was nur gut klingt.
- Kein Banding, kein Seam, kein Doppellicht (statische Lichter dürfen nicht nochmal per
  Strahl kommen), keine sichtbare Noise nach dem Settle.
- Prüfe ausdrücklich bessere Technologien: SSAO/SSGI, DDGI, Screen-Space Reflections mit
  Roughness-Gate, Lightmap-Kompression (BC7), VRS/Tier-System, Temporal AA,
  denoiser mit Führung (Normal + Depth + Motion), History-Reprojektion mit Disocclusion.
  Nenne für jede: Gewinn, Kosten pro Frame, Risiko, und ob sie auf Laptop läuft.

### B. Player-Controller

Die offenen Punkte stehen in `docs/backlog.md` (#1 Step-up fühlt sich wie Teleport, #2 Gleiten
auf begbaren Hängen, #3 Rest-Stottern an Wänden). Ziel: **bewegt sich clean anfühlt** —
Kamera-Dämpfung, keine Sprünge, kein Ruckeln, kein Gleiten. Außerdem: der Controller soll
sich nicht gegen die Beleuchtung/Physik widersprechen (Ground-Snap, Capsule-Kollision,
Spawn-Regeln in `src/main.ts`).

### C. Engine-Zustand

Was fehlt, damit der Nutzer **nur noch die Map baut** und alles funktioniert:
Export-Contract (Collectionn, `TEXCOORD_1`, Manifest), Bake-Contract, Material-Contract,
Settings-Menü (Qualität, Antialiasing, Gain), HUD/FPS-Zeile, `?dev=1` Flags, und die
Test-Checkliste. Fehlendes sollst du benennen und bauen, nicht nur vorschlagen.

## Arbeitsweise (Pflicht)

1. Erst **lesen und messen**, dann entscheiden. Jede Aussage braucht eine Zahl oder das Wort
   „nicht gemessen".
2 Kleine Schritte. Pro Schritt: was, warum, wie prüfbar.
3. Jedes Skript in `scripts/` muss weiter laufen und grün bleiben; die Readback-Asserts sind
   Messtechnik — sie dürfen durch Änderungen nicht still werden. Wenn eine Änderung eine
   Messgröße verändert, **dokumentiere das in dem Skript**.
4. `npm run typecheck` muss grün bleiben. Nutze das npm-Cache-Workaround
   (`--cache /tmp/.../npm-cache`), wenn install nötig ist.
5. Blender ist hier nicht im PATH: `/Applications/Blender.app/Contents/MacOS/Blender`
   (5.2.3 LTS). System-`python3` ist kaputt; für reine Python-Checks nutze Blender selbst
   (`blender -b --python-expr`) oder Blender's Python.
6. Ergebnisse immer in dieser Form: **Was gemessen wurde → was sich dadurch ändert → was der
   Nutzer sieht → was er testen soll.**
7. Wenn du etwas nicht prüfen kannst (Bildwirkung auf seiner Hardware), formuliere es als
   Hypothese und sag, woran er es erkennt.

## Erfolgskriterien (messbar, nicht geschmacklich)

- Kein sichtbares Banding auf glatten dunklen Flächen aus normaler Entfernung.
- Noise nach dem Settle-Fenster praktisch unsichtbar; Settle 4–6 Frames.
- Stillstand erzeugt keinen Rechenanteil (FPS-Zeile zeigt `frozen`).
- Bewegtes Objekt hat dasselbe Licht wie die Wand daneben (Vergleich Messung, nicht Auge).
- Dynamisches Licht reagiert innerhalb eines Frames, ohne Doppellicht.
- 60 fps auf Gaming-GPU; auf Laptop weiterhin spielbar mit Fallback.
- Der Nutzer muss für ein neues Map-Set nichts tun außer: Modell bauen, Lampen setzen,
  `tools/bake_map.sh`, im Spiel schauen.

## Übergabe am Ende

Am Ende jede Entscheidung mit: Grund, Kosten, Risiko, was der Nutzer im Spiel sieht,
und was er testen soll. Und eine kurze Liste der Dinge, die **er entscheiden muss**
(Geschmack: welche Lampe ist zu hell, welche Atmosphäre, Antialiasing-Präferenz).
Das Maximum an Entscheidungen soll bei ihm liegen, das Maximum an Technik bei dir.

---
