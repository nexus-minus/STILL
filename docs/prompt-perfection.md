# Prompt — Grafik wirklich fertig machen (für eine starke KI)

Vorher `docs/` lesen. Der Prompt ist nur wirksam, wenn du ihn **im Repo** ausführst und ihr
erlaubst, Dateien zu ändern und Tests laufen zu lassen.

---

Du arbeitest am Projekt **Liminal** (`https://github.com/nexus-minus/STILL`, Branch `master`).
Der Nutzer ist 14–16 und kann nicht programmieren: du programmierst, er baut Modell und Story. Ziel: **eine Version, in der die Grafik komplett korrekt funktioniert,
egal wie die Map aussieht**, sodass er nur noch die Map baut.

## Regel 0 — Doku ist keine Arbeit

Ein Commit, der nur Text ändert, zählt als **keine Arbeit**. Wenn du nichts am Code änderst,
hast du nichts geliefert. Doku darfst du nur schreiben, **nachdem** die Änderung existiert und
geprüft ist.

## Regel 1 — Beweisbarkeit ohne Grafikkarte (das ist der Kern)

WebGPU kannst du nicht ausführen. Deshalb darfst du jede Grafikfunktion nur dann als
„funktionierend" melden, wenn du sie **auf der CPU nachrechnest** und das Ergebnis gegen die
Implementationsformel prüfst. Baue dafür einen headless Prüfrahmen in `scripts/`:

- **CPU-Referenz** (reines Node, keine Abhängigkeiten) für: Lightmap-Dekodierung,
  Irradiance/SH-Basis, Dither-Maske, Denoiser-Filter, Reprojektions-Mapping,
  Direct-Light-Sampling. Für jede: gleiche Eingaben, gleiche Formel, Vergleich mit der
  Implementierung in `src/render/`, Toleranz vorher festlegen (z. B. ±1 Anzeiger).
- **Synthetische Testbilder** im Skript erzeugen (bekannter Grundwert + bekanntes Rauschen),
  denselben Filter in JS ausführen und melden: Besserung in %, verbleibender Fehler,
  längste flache Strecke, Anzahl der Stufen.
- **Testszene** in Node als kleine Polygonliste (2 Räume, 1 Gang, 1 Lampe, 1 bewegte Kugel):
  Referenz-Licht pro Flächenpunkt berechnen, dann das Raster aufbauen und prüfen, ob der
  Wert für die Kugel im selben Raster denselben Wert bekommt (Toleranz benennen).
- Jeder neue Punkt braucht **ein Skript in `scripts/`, das grün durchläuft**. Ohne Skript gilt
  die Änderung als nicht geprüft.

Bestehende Skripte (`banding-check.mjs`, `bake-stats.mjs`, `lightmap-16bit-check.mjs`,
`rt-*-smoke.mjs`, `steptest.mjs`) müssen weiter grün laufen. **Asserts dürfen nicht weicher
gemacht werden, um grün zu werden.** Wenn eine Änderung eine Messgröße verändert, muss das Skript
den alten Wert, den neuen Wert und den Grund zeigen. Wenn ein Skript eine echte Regression zeigt,
ist das ein Ergebnis — nicht ein Fehler im Skript.

## Regel 2 — was wirklich gebaut werden muss (Definition of Done)

| # | was | gilt als fertig wenn |
|---|-----|----------------------|
| 1 | **Weltweites Raster für bewegte Objekte** (SH order 2, Spatial Hash / Voxel über die ganze Welt, kein Raum-Begriff, keine Box-Grundrisse, keine Wand-/Decken-Spezialfälle) | Code in `src/world` oder `src/render` baut das Raster zur Ladezeit aus der Geometrie; bewegte Pixel sampling es; `scripts/`-Test vergleicht mit CPU-Referenz; ohne Raster läuft der Weg weiter (Fallback) |
| 2 | **Zellengröße automatisch** aus der Geometrie (Ziel 64–128 Texel/m auf Flächen), keine Autorenarbeit | Test zeigt Dichte pro Bereich und warnt bei unter 32 Texel/m; kein manuelles Setzen nötig |
| 3 | **Zustandsänderungen** (Tür, Lampe an/aus, Objekt bewegt): Dirty-Flag aktualisiert nur betroffene Inseln/Zellen; Varianten nur für markierte Zustände | Test: ein Zustand wird geändert, nur die betroffenen Zellen werden neu gerechnet, Zellenzahl vor/nach gemeldet; keine Runtime-Cycles-Behauptung |
| 4 | **Antialiasing im Settings-Menü** (aus / MSAA / SMAA), Standard nach GPU-Stärke | Code existiert und ist schaltbar; die Umschaltung ist im HUD sichtbar |
| 5 | **Settings-Menü + HUD** (Qualität, Antialiasing, Gain, FPS-Zeile mit `frozen`) | Code existiert; Änderung löst `markDirty()` aus; HUD zeigt die Werte |
| 6 | **Controller: Vorwärtsschritt bei Step-up** | Gemessen, nicht behauptet: alter Wert (0,54 m in einem Frame), neuer Wert, Lag nach 150 ms; `scripts/steptest.mjs` oder ein headless Ersatz, der dasselbe prüft |
| 7 | **Rampen gleiten + Wand-Stottern** (Backlog #2, #3) | Gemessen mit Zahlen (Rutschgeschwindigkeit, Stöße pro Sekunde), nicht mit Adjektiven |
| 8 | **Bake robust** (Segfault-safe, CPU-Fallback wenn kein GPU, klare Fehlermeldung) | Ein Lauf auf der Testmap schreibt `lightmap.bin` + `manifest.json` und der 16-Bit-Vergleich ist grün |

## Regel 3 — Sprache und Ehrlichkeit

- Deutsch, du-Form, einfach, Fachbegriffe in einem Satz erklärt.
- Immer: **was gemessen wurde → was sich dadurch ändert → was er im Spiel sieht → was er testen soll.**
- Schätzungen müssen als **Schätzung** dastehen (Arbeit pro Frame kannst du nicht auf einer GPU
  messen; zähle Strahlen/Pixel und Filter-Taps, nenne es Schätzung).
- Nicht behaupten, etwas sei „besser", ohne Zahl. Was du nicht prüfen kannst, klar als
  Hypothese markieren und sagen, woran er es erkennt.
- Am Ende: Liste **geprüft** vs. **nicht geprüft** (nur er kann das Bild prüfen).

## Regel 4 — Rahmen, der nicht verhandelbar ist

1. 60 fps auf Gaming-GPUs **und** spielbar auf einfachen Laptops: jeder Punkt braucht einen
   Fallback für kleine GPUs.
2. Noise praktisch unsichtbar nach dem Settle-Fenster (4–6 Frames); kein sichtbares Banding am
   Schirm; Stillstand kostet keinen Rechenanteil (`frozen`).
3. Dither bleibt am 8-Bit-Schirmschritt (nach Tone-Mapping), nicht im Speicher.
4. 16-Bit Half-Float ist der Bake-Speicher (`lightmap.bin`, `encoding: "half"`), PNG bleibt
   Vorschau und Bericht.
5. Raytracing ist optionale Ambience (Reflexionen nur bei niedriger Roughness + dynamische
   Lichter), Bake ist das Fundament. Kein Doppellicht für statische Lichter.
6. Commits mit `git commit --author="blackphoenix <epicbrine_11@outlook.com>"`, Meldung
   beschreibt **was geändert wurde**. `package-lock.json` nicht ändern.
7. `assets/artwork/` ohne Bild-Metadaten (Credit **Eldar**), prüft `tools/check_metadata.py`.

## Regel 5 — Umgebung (damit sie nicht an der Technik scheitert)

- Blender ist **nicht im PATH**: `BLENDER=/Applications/Blender.app/Contents/MacOS/Blender`
  (5.2.3 LTS). Bake von Repo-Wurzel mit `OUT_DIR=...` starten. Ein voller 1024²/48-Bake dauert
  hier etwa 1 Minute; wenn Blender mit Segfault endet, erst ohne GPU (`cycles_device cpu`) prüfen
  und das Ergebnis klar melden.
- System-`python3` ist kaputt (`posix_spawn`). Für reine Python-Checks Blender selbst
  (`blender -b --python-expr`) oder Blender's Python nutzen.
- `npm install` braucht `--cache /private/var/folders/cp/ctx88hms25vf8s383_skt20m0000gn/T/opencode/npm-cache`.
- `npm run typecheck` muss grün bleiben.
- Kein Browser: Puppeteer-/Readback-Skripte laufen hier nicht. Sie dürfen nicht als „bestanden"
  gemeldet werden, ohne ausgeführt zu sein.
- Blender-Python hat `bpy`; `bake_map.py` hat keinen `__main__`-Guard — zum Testen einer
  Funktion Definitionen bis `def main():` ausführen.

## Regel 6 — Arbeitsweise

1. Erst lesen und messen, dann entscheiden.
2. Kleine Schritte; pro Schritt 1–2 Sätze: was, warum, wie prüfbar.
3. Jeder Schritt: implementieren → `node --check` → das passende Skript ausführen →
   `npm run typecheck` → erst dann commit.
4. Wenn etwas blockiert ist: nicht umgehen, sondern **genau sagen was blockiert** und was der
   Nutzer auf seinem Rechner schauen muss. Nicht „fertig" melden, wenn nur die Doku geändert ist.
5. Wenn sie eine bessere Technik findet (SSAO/SSGI, DDGI, SSR mit Roughness-Gate, BC7-Lightmaps,
   VRS-Tiers, Temporal AA, Denoiser mit Führung durch Normal/Depth/Motion): sie muss nennen,
   **was sie kostet, was sie bringt, ob sie auf dem Laptop läuft, und wie man sie ohne GPU
   validiert** — sonst ist sie nur ein Vorschlag.

## Erfolg (messbar)

- Kein sichtbares Banding auf glatten dunklen Flächen aus normaler Entfernung.
- Bewegtes Objekt hat dasselbe Licht wie die Wand daneben — per CPU-Referenz belegt, nicht per Auge.
- Dynamisches Licht reagiert in einem Frame, ohne Doppellicht.
- Stillstand kostet keinen Rechenanteil.
- 60 fps auf Gaming-GPU (Schätzung + Strahlenzahl), Laptop läuft mit Fallback.
- Für ein neues Map-Set tut der Nutzer nichts außer: Modell bauen, Lampen setzen,
  `tools/bake_map.sh`, im Spiel schauen.

---
