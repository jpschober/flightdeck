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
