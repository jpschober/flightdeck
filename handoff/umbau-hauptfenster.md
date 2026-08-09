# Auftrag: Hauptfenster des Renderers umbauen

Für einen Coding-Agenten. Keine Design-Entscheidungen nötig — alle Werte stehen
in der Referenzdatei. Repo: `jpschober/flightdeck`, alles unter `src/renderer/`.

## Die Referenzdatei ist die Quelle der Wahrheit

`handoff/zielbild.html` zeigt das fertige Fenster. **Öffne sie und lies die
Werte direkt aus dem Markup ab** — jede Farbe, jeder Abstand, jede
Schriftgröße steht dort als Inline-Style. Wenn dieser Text und die Datei sich
widersprechen, gilt die Datei.

Die Datei enthält zwei Ansichten: das Hauptfenster und das geöffnete
Nutzungs-Popover.

---

## Zielbild in drei Sätzen

Die Sidebar zeigt Sessions nicht mehr als kompakte Zeilen, sondern als Karten
mit Innenleben: Name, Branch, ein Aktivitätsbalken und darunter eine Zeile je
laufendem Subagenten mit Aufgabe und Laufzeit. Die Farbgebung wechselt auf
tiefes Nachtblau; entscheidend ist dabei, dass **Gold ausschließlich für
"wartet auf Deine Antwort"** verwendet wird und sonst nirgends vorkommt — so
findet das Auge die wartende Session ohne Suchen. Kopfleiste und Panel-Tabs
bekommen gefüllte Pillen statt Unterstriche.

Der Grund für den Umbau: heute sieht man, *dass* etwas läuft, aber nicht
*was*. Und "arbeitet" und "wartet auf mich" sind beide blau und damit nur am
Puls-Effekt unterscheidbar.

---

## Schritt 1 — Farbwerte in `styles.css`

Datei: `src/renderer/styles.css`, `:root`-Block, Zeile 5–28.

Ersetze genau diese Deklarationen; `--speed`, `--ease`, `--ease-out`,
`--mono`, `--sans` bleiben unverändert:

| Variable | alt | neu |
|---|---|---|
| `--bg` | `#101116` | `#0d1220` |
| `--bg-panel` | `#16181f` | `#121828` |
| `--bg-panel-2` | `#1b1e27` | `#161d2e` |
| `--bg-hover` | `#232734` | `#1b2337` |
| `--bg-active` | `#2a2f40` | `#1f2942` |
| `--border` | `#262a36` | `#1e2740` |
| `--text` | `#d6dae3` | `#e6ecf7` |
| `--text-dim` | `#9aa1b2` | `#8794b0` |
| `--text-faint` | `#7f8697` | `#65718c` |
| `--accent` | `#4f8cff` | `#7cc4f5` |
| `--accent-soft` | `rgba(79, 140, 255, 0.16)` | `rgba(124, 196, 245, 0.16)` |
| `--green` | `#4ec97a` | `#8fd9a0` |
| `--red` | `#e05f6a` | `#e8837c` |
| `--yellow` | `#d9a441` | `#f0c86a` |
| `--purple` | `#a07bf0` | `#b9a6f2` |
| `--radius` | `8px` | `12px` |

Neu am Ende des Blocks:

```css
  --attention: #f0c86a;
  --attention-soft: rgba(240, 200, 106, 0.14);
  --text-mid: #a6b2c9;      /* Aufgabentexte der Subagenten */
  --card-quiet: #151a29;    /* Karten ohne laufende Arbeit */
```

Das Nutzungs-Fenster (`.uz-*`, ab ca. Zeile 843) und alle Overlays nutzen diese
Variablen bereits und ändern sich dadurch automatisch mit.

---

## Schritt 2 — Statusfarben entflechten

In `styles.css`:

```css
/* vorher: background: var(--yellow) — Gold gehört ab jetzt allein dem Wartezustand */
.si-status.busy {
  background: var(--accent);
  animation: busy-pulse 1.1s ease-in-out infinite;
}

/* vorher: var(--accent) + hartkodiertes rgba */
.si-status.attention {
  background: var(--attention);
  box-shadow: 0 0 0 3px var(--attention-soft);
}
```

`.si-status.idle` (grüner Ring) und `.si-status.unknown` bleiben unverändert.

---

## Schritt 3 — Session-Karte: Aufbau

Heute ist `.session-item` eine Zeile mit `padding: 8px 26px 8px 10px`. Künftig
eine Karte. Zielaufbau (siehe Referenzdatei, Sidebar, zweite Karte
"flightdeck"):

```
┌─────────────────────────────────────┐
│ ▍ flightdeck              3 ✈       │   Kopfzeile
│ ⎇ main                              │   Branch, monospace, gedimmt
│ ▬▬▬▬▬▬▬▬▬░░░░░░░░░░░                │   Aktivitätsbalken, 5px
│ ◆ i18n-Keys prüfen           4:12   │   je Subagent eine Zeile
│ ◆ Tests für osc.js           1:38   │
│ ◆ README straffen            0:21   │
└─────────────────────────────────────┘
```

**3a) CSS.** In `styles.css`, `.session-item` ersetzen:

```css
.session-item {
  position: relative;
  padding: 12px 13px;
  border-radius: var(--radius);
  background: var(--bg-panel-2);
  border: 1.5px solid transparent;
  margin-bottom: 8px;
  cursor: pointer;
  transition: background var(--speed) var(--ease), border-color var(--speed) var(--ease);
}
.session-item:hover { background: var(--bg-hover); }
.session-item.active { background: var(--bg-active); border-color: var(--accent); }
.session-item.attention { background: var(--bg-hover); border-color: var(--attention); }
/* Aktiv UND wartend: Gold gewinnt, es ist die dringendere Aussage */
.session-item.active.attention { border-color: var(--attention); }
.session-item.idle,
.session-item.unknown { background: var(--card-quiet); }
.session-item.unknown { opacity: 0.5; }
.session-item.exited { opacity: 0.55; }

.si-top { display: flex; align-items: center; gap: 9px; min-width: 0; padding-left: 11px; position: relative; }
.si-name { font-size: 14px; font-weight: 600; color: var(--text); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.si-branch { font-family: var(--mono); font-size: 11px; color: var(--text-dim); margin-top: 6px; padding-left: 11px; }
```

**3b) Farbstreifen links.** 3 px breit, 16 px hoch, Farbe je Session — damit
sich sechs Karten ohne Lesen des Namens unterscheiden lassen:

```css
.si-top::before {
  content: "";
  position: absolute;
  left: 0; top: 1px;
  width: 3px; height: 16px;
  border-radius: 2px;
  background: var(--session-color, var(--text-faint));
}
```

In `terminal.js` beim Erzeugen des Elements (Zeile ~283, nach
`el.className = 'session-item';`) eine **stabile** Farbe aus der Session-ID
setzen — dieselbe Session muss nach einem Neustart dieselbe Farbe haben:

```js
const SESSION_COLORS = ['#7cc4f5', '#8fd9a0', '#b9a6f2', '#8fd9cf', '#c9a0dc'];
let h = 0;
for (const ch of String(s.id)) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
el.style.setProperty('--session-color', SESSION_COLORS[h % SESSION_COLORS.length]);
```

Gold ist bewusst nicht in der Palette — es ist für den Wartezustand reserviert.

**3c) Zustandsklasse auf die Karte.** In `terminal.js` bei
`statusEl.className = 'si-status ' + state;` (Zeile ~318) ergänzen:

```js
el.classList.remove('attention', 'idle', 'busy', 'unknown');
el.classList.add(state);
```

In `app.js` Zeile ~76 und in `grid.js` Zeile ~38 gilt dasselbe für die
Grid-Ansicht.

---

## Schritt 4 — Aktivitätsbalken

Ein 5 px hoher Balken unter der Branch-Zeile, sichtbar nur bei laufender
Arbeit. Er zeigt Output-Aktivität der letzten Sekunden — er beantwortet die
Frage "hängt die Session oder läuft sie?".

```css
.si-meter { height: 5px; border-radius: 3px; background: var(--border); overflow: hidden; margin-top: 9px; display: none; }
.session-item.busy .si-meter { display: block; }
.si-meter-fill { height: 100%; border-radius: 3px; background: var(--accent); transition: width 400ms var(--ease-out); }
```

Speisung: Anteil der letzten ~10 s mit Terminal-Output, 0–100 %, gedeckelt bei
mindestens 8 % damit der Balken nie ganz leer wirkt. Falls sich das nicht
sinnvoll messen lässt, den Balken **nicht** animieren, sondern durchgehend auf
100 % füllen — ein Zappeln ohne Aussage ist schlechter als ein statischer
Balken.

---

## Schritt 5 — Subagenten-Zeilen

Der eigentliche Zweck des Umbaus, und der einzige Punkt, der **neue Daten**
braucht.

```css
.si-agent-list { display: flex; flex-direction: column; gap: 5px; margin-top: 10px; }
.si-agent { display: flex; align-items: center; gap: 8px; }
.si-agent::before {
  content: ""; width: 5px; height: 5px; flex: none;
  background: var(--accent); transform: rotate(45deg);
}
.si-agent-task { font-size: 11px; color: var(--text-mid); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.si-agent-time { margin-left: auto; font-family: var(--mono); font-size: 10.5px; color: var(--text-faint); }
.si-agent.overdue::before { background: var(--red); }
.si-agent.overdue .si-agent-time { color: var(--red); }
```

Benötigte Felder je Subagent:

| Feld | Typ | Zweck |
|---|---|---|
| `id` | string | stabile Identität über Polls, kein Flackern beim Neuaufbau |
| `task` | string | Kurzbeschreibung, einzeilig gekürzt |
| `startedAt` | epoch ms | Grundlage der Laufzeit |
| `state` | `running` \| `done` \| `failed` | abgeschlossene kurz ausblenden statt hart entfernen |

Regeln:
- Laufzeit `m:ss`, **lokal im Sekundentakt** hochgezählt, nicht pro Poll neu geholt.
- Ab 10 min Laufzeit Klasse `overdue`.
- Mehr als 3 Agenten: die ersten 3 Zeilen plus `+n weitere`.
- Abgeschlossene Agenten nach ~2 s ausblenden, damit kurze Läufe sichtbar bleiben.
- Bei 6 Sessions × 3 Agenten darf die Liste nicht jede Sekunde neu aufgebaut
  werden — nur die Zeittexte aktualisieren.

**Wenn die Daten nicht verfügbar sind:** `s.agents` liefert heute nur eine
Anzahl. Lässt sich Aufgabentext und Startzeit nicht zuverlässig aus dem
Terminal-Output gewinnen, **hier stoppen und nachfragen**, statt eine Quelle zu
erfinden. Fallback bis dahin: der heutige Zähler-Chip `.si-agents` bleibt, in
`var(--accent)` auf `var(--accent-soft)`, Radius 5 px.

---

## Schritt 6 — Kopfleiste

44 px hoch, `--bg-panel`, unten 1 px `--border`. Von links: Wortmarke
"Flightdeck" (14 px, 700), daneben eine Statuspille mit dem Gesamtbild
("6 Agenten arbeiten · 1 wartet auf Dich", 11 px, `--text-dim`, Hintergrund
`#182034`, `border-radius: 20px`), rechts das Überlaufmenü und "Neue Session"
als gefüllter Knopf in `--accent` mit Textfarbe `--bg`.

Die Statuspille wird aus den Sessions berechnet: Summe laufender Agenten,
Anzahl Sessions im Zustand `attention`. Steht keine Zahl an, entfällt der
jeweilige Teil; sind beide null, zeigt die Pille die Anzahl offener Sessions.

---

## Schritt 7 — Panel-Tabs als Pillen

```css
.panel-tab { border-radius: 7px; border-bottom: 0; padding: 5px 9px; }
.panel-tab.active { background: var(--accent); color: var(--bg); font-weight: 600; }
.panel-tab.active .tab-count { opacity: 0.7; color: inherit; }
```

Falls die Zählerspans anders heißen als `.tab-count`, den tatsächlichen
Klassennamen verwenden.

---

## Schritt 8 — Nutzungs-Popover

Inhalt, Berechnung und Text bleiben **unverändert**. Zu ändern sind nur:

- Farben (kommen über die Variablen aus Schritt 1 automatisch).
- `.uz-card`: `border-radius: 11px`, `border-left-width: 3px`, Hintergrund `#151c2c`.
- `.uz-bar`: `height: 7px`, `border-radius: 4px`.
- Das Panel öffnet als Popover über der Limit-Leiste statt als eigenständiges
  Fenster: `position: absolute`, unten rechts verankert, 407 px breit, Radius
  14 px, Schatten `0 18px 44px rgba(0,0,0,.6)`, ein um 45° gedrehtes Quadrat
  als Pfeil an der Unterkante.
- Schließen-X links neben dem Neuladen-Knopf, beide 30 × 30 px, Radius 9 px.
- Solange das Popover offen ist, bekommt die Limit-Leiste im Panel
  `background: var(--bg-panel-2)` und ihre Beschriftung `var(--green)`.

Exakte Werte: zweite Ansicht in `handoff/zielbild.html`.

---

## Nicht Teil dieses Auftrags

- Spaltenbreiten und Grundaufbau (Sidebar 312 px, Panel 334 px) bleiben.
- Keine Änderung an Terminal-Rendering, xterm-Konfiguration oder Tastaturkürzeln.
- Keine Änderung an der Logik oder Berechnung im Nutzungs-Panel.
- Keine neue CSS-Datei — alles in `styles.css`.

---

## Abnahme

Mit mindestens vier gleichzeitigen Sessions starten, davon eine wartend, zwei
arbeitend, eine untätig:

1. Die wartende Session hat goldenen Punkt und goldenen Kartenrahmen. Gold
   kommt sonst **nirgends** im Fenster vor.
2. Arbeitende Sessions zeigen Balken und Subagenten-Zeilen; die Laufzeit läuft
   flüssig, ohne Sprünge im Poll-Takt.
3. Jede Session hat einen farbigen Streifen links; nach Neustart der App ist
   die Farbe je Session unverändert.
4. Untätige und statuslose Sessions treten sichtbar zurück, ohne unlesbar zu sein.
5. Nutzungs-Popover öffnet über der Limit-Leiste, mit Pfeil, und schließt per X
   und per Klick daneben. Zahlen identisch zu vorher.
6. Overlays (Preview, DB-Diff, Session-Browser) und Grid-Ansicht durchklicken:
   keine Restflächen aus der alten Palette.
7. `grep -rn "#4f8cff\|#101116\|#16181f\|#1b1e27\|#d9a441\|#232734\|#2a2f40" src/renderer/`
   liefert keine Treffer mehr.
8. Textkontrast überall mindestens 4.5:1.
