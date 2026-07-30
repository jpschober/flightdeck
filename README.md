# Flightdeck ✈️

Warp-ähnliche Terminal-App für die Arbeit mit parallelen KI-Agenten
(Electron + xterm.js + node-pty). Viele Maschinen auf dem Deck — du gibst die
Startfreigaben.

## Features

- **Mehrere Shell-Sessions parallel**: PowerShell, PowerShell 7, Git Bash, CMD,
  WSL (Windows) bzw. Bash/Zsh (Linux). Neue Session über `+` (Standard-Shell)
  oder `▾` (Shell-Auswahl), `Strg+T` / `Strg+Shift+W`.
- **Session-Liste links** – jeder Tab zeigt:
  - **Status**: 🟡 arbeitet · ⭕ wartet auf Kommando · 🔵 Agent (z. B. Claude
    Code) wartet auf *deine* Eingabe — du siehst sofort, wer dich braucht
  - aktuelles Verzeichnis (live über Shell-Integration / OSC 7) und Git-Branch
  - optionales manuelles **Label** (Chip) und optionalen manuellen **Titel**
    → Doppelklick/Rechtsklick auf den Tab öffnet das Bearbeiten-Popover
- **Kontextpanel rechts** mit Tabs (folgt der aktiven Session):
  - **Git**: zugehöriger Pull Request (via `gh` CLI) + geänderte Dateien;
    Klick auf eine Datei öffnet die Diff-/Datei-Vorschau, `Esc` schließt
  - **Verlauf**: deine Eingaben dieser Session — Shell-Kommandos exakt,
    Prompts an Agenten rekonstruiert; Klick kopiert, `↩` fügt ins Terminal ein
  - **Notizen**: kurze TODOs pro Projekt (Repo-Root), persistiert über
    Neustarts; Badges zeigen offene Notizen und neue Verlaufseinträge
  - **DB-Schema**: Tabellen, Spalten, Typen und Constraints des Projekts —
    plus ein Signal, sobald der aktuelle Vorgang oder PR das Schema ändert
    (s. u.)
- Panels per Trenner in der Breite verstellbar.

## Start

```
npm install
npm start
```

Voraussetzungen: `git` im PATH; für PR-Anzeige zusätzlich
[GitHub CLI](https://cli.github.com/) (`gh auth login`).

## Architektur

```
src/main/main.js     Electron-Main: PTY-Sessions (node-pty), Shell-Erkennung,
                     OSC-Parsing (cwd, Busy/Idle, Kommandos), Verlauf,
                     Notizen-Persistenz, IPC
src/main/gitinfo.js  git status/branch + PR-Infos via gh (gecacht)
src/main/dbschema/   DB-Schema: Plugin-Registry ("Senser"), DDL-Leser, Diff
src/preload.js       contextBridge-API für den Renderer
src/renderer/        UI: Sidebar, xterm-Terminals, Tab-Panel, Vorschau
```

### Shell-Integration

Beim Start der Shell wird der Prompt erweitert (PowerShell via
`-EncodedCommand`, Bash via rc-Datei) und sendet:

- `OSC 7` — aktuelles Verzeichnis (file://-URL), wie in Warp/WezTerm/VS Code
- `OSC 133` — `C` = Kommando gestartet, `A`/`D` = Prompt wieder da
- `OSC 7770;cmd` — die abgesendete Kommandozeile (Base64)

Der Main-Prozess parst die Sequenzen aus dem PTY-Strom und leitet daraus
Verzeichnis, Branch, geänderte Dateien, PR (Refresh 4 s, PR-Cache 45 s) und
den Busy-/Idle-Status ab. Bei beobachteten Agenten-TUIs (`claude`, `codex`,
`aider`) gilt zusätzlich: >2 s Stille bei laufendem Kommando = „Eingabe
erwartet“ (blauer Punkt), da diese TUIs beim Arbeiten permanent rendern.

### DB-Schema

Ein Agent, der eine Migration schreibt, ändert das Datenmodell — und das ist
die Art Änderung, die man gesehen haben will, bevor sie durchgeht. Der Tab
zeigt deshalb nicht nur das Schema, sondern vor allem, **was sich daran
geändert hat**.

```
src/main/dbschema/index.js       Senser: fragt die Plugins, cached, wählt die Basis
src/main/dbschema/files.js       Dateizugriff: Arbeitsverzeichnis oder Git-Stand
src/main/dbschema/sql-ddl.js     Postgres-DDL-Leser (Migrationen nachspielen)
src/main/dbschema/ir.js          das standardisierte Schema-Format
src/main/dbschema/diff.js        struktureller Vergleich zweier Stände
src/main/dbschema/plugins/       je Technik ein Plugin (derzeit: supabase.js)
```

**Plugins.** Der Senser weiß nichts über Supabase, Drizzle oder SQL. Er kennt
nur diese Schnittstelle — Erkennung *und* Lesen stecken vollständig im Plugin:

```js
{
  id, label,
  detect(provider) -> { confidence, evidence[], watch[] } | null,
  read(provider)   -> IR,
}
```

Der Senser fragt beim aktiven Arbeitsverzeichnis alle Plugins, ob sie sich
zuständig fühlen; das überzeugteste gewinnt und liefert das Schema im
standardisierten Format zurück. Ein weiteres Plugin einzuhängen heißt: Datei
unter `plugins/` anlegen, in `PLUGINS` eintragen, fertig.

`provider` abstrahiert den Dateizugriff (`exists` / `read` / `list` / `stamp`),
damit ein Plugin dasselbe Schema aus dem Arbeitsverzeichnis **und** aus einem
Git-Commit lesen kann — ohne das gäbe es kein „vorher“.

**Supabase-Plugin.** Erkennung über `supabase/config.toml` bzw.
`supabase/migrations/`; gelesen wird durch Nachspielen der Migrationen in
Namensreihenfolge (`CREATE`/`ALTER`/`DROP TABLE`, Enums, Indizes, RLS-Policies,
`COMMENT ON`). Die Migrationen sind die Quelle der Wahrheit im Repo — anders
als eine laufende Datenbank sind sie immer da und liegen im Git.

**Diff.** Verglichen wird strukturell, nicht zeichenweise: Tabellen, Spalten
(Typ, NULL, Default, Identity, berechnet, Kommentar), Constraints, Indizes,
Enum-Werte und RLS-Policies. Ein Zeichen-Diff wäre hier wenig wert —
umsortierte Spalten erzeugen Rauschen, und was fachlich passiert ist, sieht man
nicht. Die Basis ist wählbar:

- **PR-Basis** — alle Änderungen des Pull Requests (Merge-Base zum Zielbranch)
- **Abzweig von main** — alle Änderungen dieses Branches
- **HEAD** — nur was noch nicht committet ist

Gibt es Änderungen, erscheint eine Zahl am Tab (auch wenn er zu ist) und im
Panel ein Hinweis. „Vergleichen“ öffnet **Vorher/Nachher nebeneinander**: links
der alte Stand, rechts der neue, zeilengleich — gleiche Spalten stehen auf
gleicher Höhe, fehlende als `—`.

Dargestellt wird als Tabellenkarten, nicht als ER-Diagramm: gefragt sind
Spalten, Typen und Constraints, und die stehen in einem Diagrammkasten entweder
nicht drin oder unleserlich klein. Vor allem aber lässt sich ein Diagramm nicht
zeilenweise vergleichen. Beziehungen zeigen die Fremdschlüssel im Klartext
mitsamt Ziel und `on delete`-Verhalten.

Neu gelesen wird nur, wenn sich am Fingerabdruck der beteiligten Dateien
(mtime/Größe) etwas ändert — der Hintergrund-Abruf alle 10 s kostet damit
nichts.
