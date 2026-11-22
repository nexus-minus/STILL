# Test-Checkliste (Deutsch) — was du auf deinem Rechner prüfen kannst

Ich kann WebGPU hier nicht ausführen (kein Browser zum Testen auf meinem Rechner),
daher sind Messungen bei mir nur auf der Bake-Seite möglich. Alles, was das **Bild**
betrifft, musst du schauen — dafür ist diese Liste da.

## Vorbereitung

1. Chrome oder Edge (WebGPU nötig), Spiel starten: `npm run dev`, dann die URL öffnen.
2. `?dev=1` dazu — dann siehst du oben links die FPS-Zeile. Ohne sie ist sie ausgeblendet.
3. Pro Test **zwei Screenshots**: einer mit Flag, einer ohne. Flag in den Dateinamen
   schreiben, damit man sie auseinanderhält.
4. Immer: hinstellen, ~2 Sekunden warten, bis das Bild ruhig ist, dann schauen.

Im HUD steht dann zum Beispiel `webgpu · medium · 58 fps · frozen`. Das `frozen` ist
neu und wichtig für Test 3.

---

## Test 1 — Dither (`?dither=0` vergleichen)

**Was du anschaust:** eine dunkle, lange, glatte Wand (Flur), aus ein paar Metern
Entfernung, nicht aus nächster Nähe.

| URL | was du sehen solltest |
| --- | --- |
| `?dev=1` (Standard) | der Übergang von dunkel zu hell wirkt glatt, aus der Entfernung kein Band |
| `?dev=1&dither=0` | dasselbe Bild, aber der Übergang zeigt Stufen/Bänder mit scharfen Kanten |

**Worauf du achten solltest:**
- Aus der Nähe siehst du mit Dither ein feines Körnen. Das ist normal und gewollt —
  das Auge mischt es zu einem glatten Verlauf.
- Der Dither macht nichts heller oder dunkler. Er verschiebt nur die harte Kante.
- Wenn eine Wand wirklich überall genau gleich dunkel ist, hilft kein Dither: dann ist
  schlicht zu wenig Licht auf dieser Fläche (das ist ein Bake-Problem, kein Banding-Problem).
- Bitte melden: siehst du im Standard-Bild noch Bänder? Wenn ja, wo genau?

---

## Test 2 — Bewegung (`?reproj=0` vergleichen)

**Was du anschaust:** langsam einen Flur entlanggehen.

| URL | was du sehen solltest |
| --- | --- |
| `?dev=1` (Standard) | es bleibt ruhig beim Gehen — die accumulation läuft weiter |
| `?dev=1&reproj=0` | jeder Frame wird zurückgesetzt → beim Gehen flackert/körnt es mehr |

**Danach auf Geisterbildung schauen:** um eine Ecke gehen, durch eine offene Tür schauen,
schnell umdrehen.
- Wenn etwas **nachzieht** (ein Schatten oder eine Farbe bleibt hängen, obwohl die Wand
  nicht mehr sichtbar ist) → die Disocclusion-Prüfung ist zu lax. Bitte melden, wo.
- Wenn es beim Gehen **plötzlich komplett neu aufbaut** (Bild flackert stark) → die Prüfung
  ist zu streng. Auch melden.

---

## Test 3 — Standbild / Freeze (`?settle=N`, `?idle=0`)

**Was du prüfen solltest:**
1. Stillstehen, ~2 Sekunden warten. In der FPS-Zeile muss `· frozen` stehen.
2. Während `frozen` da ist: das Bild darf sich **nicht mehr verändern**. Wenn es trotzdem
   weiter flackert, ist der Freeze kaputt → melden.
3. Auf dem Laptop: FPS sollte hochspringen, sobald `frozen` da ist (das ist der Gewinn).
4. Vergleich: `?dev=1&settle=0` oder `?dev=1&idle=0` → nie `frozen`, FPS bleibt niedriger.
   Das ist die Vergleichsbasis.
5. Nach jeder Änderung muss der Freeze weggehen und neu gerechnet werden. Teste:
   - Qualität-/Light-Gain-Slider bewegen → das Bild darf nicht eingefroren bleiben.
   - Debug-View wechseln (`?rtdebug=2` → `?rtdebug=3`) → das Bild muss sofort wechseln,
     nicht das alte behalten.
   - Fenstergröße ändern → muss neu rechnen.

---

## Test 4 — Sind manche Lampen zu hell?

- `?rtdebug=3` zeigt nur das Live-Licht (ohne Bake). `?rtdebug=4` zeigt den Baked-Puffer
  (ohne Gain, sieht dunkel aus — das ist normal).
- Wenn im Live-Bild eine Lampe deutlich heller wirkt als im Baked-Bild, stimmt das
  Verhältnis nicht. Dann ist meistens die Emission im `.blend` zu hoch — im Zweifel senken
  und re-baken (`tools/bake_map.sh`).
- Dafür brauch ich: **welche** Lampe, wie sie im Live-Bild und im Baked-Bild aussieht.

---

## Zwei Entscheidungen, die ich von dir brauche

1. **Zimmer definieren:** automatisch per Raster-Grid (nichts zu tun, aber die Zimmer sind
   nicht deine) oder eine `rooms`-Collection im `.blend` (du benennst sie, kostet Arbeit
   im Editor, passt besser zur Story)?
2. **Anti-Aliasing:** MSAA (scharfe Kanten, kostet GPU) oder SMAA (Nachbearbeitung, läuft
   auf kleinen Grafikkarten besser)? Für lange Flure mit weichem Licht ist SMAA meistens
   günstiger.

Kurzfassung zum Mitschicken: **Dither = glatte Übergänge aus der Entfernung, Körnen aus der
Nähe. Reprojektion = ruhig beim Gehen. Freeze = Standbild kostet keine Rechenzeit.**
Wenn etwas davon bei dir nicht so aussieht, ist das genau die Info, die ich brauche.
