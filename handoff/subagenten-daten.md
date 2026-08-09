# Subagenten-Zeilen in der Session-Karte (Aufgabe + Laufzeit)

**Repo:** jpschober/flightdeck · **Labels:** enhancement, ui, agents

## Kontext

Der Entwurf 3a ersetzt den stillen Agenten-Zähler in der Sidebar durch eine
Zeile je laufendem Subagenten — Aufgabentext links, Laufzeit rechts. Damit ist
„was läuft gerade" ohne Sessionwechsel ablesbar; das ist der Hauptzweck des
Redesigns.

Farbgebung und Kartenform sind reines CSS (`theme-3a.css`, separat) und hier
nicht Teil des Tickets. Dieses Ticket deckt ausschließlich die fehlenden
**Daten** ab.

## Ist-Zustand

`s.agents` liefert heute nur eine Anzahl, gerendert als Chip in
`.si-agents` (`terminal.js`, `updateAgentChip`). Weder Aufgabentext noch
Startzeitpunkt je Agent stehen zur Verfügung.

## Soll

Pro Session eine Liste laufender Subagenten mit je:

| Feld | Typ | Zweck |
|---|---|---|
| `id` | string | stabile Identität über Polls hinweg, für Ein-/Ausblenden ohne Flackern |
| `task` | string | Kurzbeschreibung, einzeilig gekürzt (~40 Zeichen) |
| `startedAt` | epoch ms | Grundlage für die mitlaufende Laufzeit `m:ss` |
| `state` | `running` \| `done` \| `failed` | abgeschlossene Agenten kurz ausblenden statt hart entfernen |

Abgeleitet in der UI (nicht im Datenmodell):
- Laufzeit = `now - startedAt`, im Sekundentakt lokal hochgezählt, nicht pro Poll neu geholt
- „überfällig" ab einer Schwelle (Vorschlag: 10 min) → Zeile in `--red`

## Offene Frage

Woher kommen `task` und `startedAt`? Die Agenten-Anzahl wird heute aus dem
Terminal-Output abgeleitet. Zu klären, ob sich Aufgabentext und Start ebenso
zuverlässig parsen lassen, oder ob eine strukturierte Quelle nötig ist.
Das ist der eigentliche Aufwandstreiber — vor der Umsetzung klären.

## Akzeptanzkriterien

- [ ] Session mit laufenden Subagenten zeigt je eine Zeile mit Aufgabe und Laufzeit
- [ ] Laufzeit zählt flüssig hoch, ohne Poll-Sprünge
- [ ] Fällt die Datenquelle aus, erscheint wieder der heutige Zähler-Chip — kein leerer Bereich, kein Fehler
- [ ] Mehr als 3 Agenten: erste 3 Zeilen + „+2 weitere"
- [ ] Abgeschlossene Agenten verschwinden verzögert (~2 s), damit kurze Läufe sichtbar bleiben
- [ ] Bei 6 Sessions × 3 Agenten keine messbare Renderlast (kein Neuaufbau der Liste pro Sekunde)

## Betroffene Dateien

`src/renderer/terminal.js` (Session-Item-Template, `updateAgentChip`),
`src/renderer/app.js` (Statusverteilung), `src/renderer/styles.css`,
`src/i18n/locales/*` (neue Schlüssel: Laufzeit, „+n weitere", „überfällig")
