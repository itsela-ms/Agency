# Agency

Session manager for GitHub Copilot CLI — visual overview, instant switching, and easy resume instead of hunting for session IDs.

![Windows](https://img.shields.io/badge/platform-Windows-blue)
![Electron](https://img.shields.io/badge/Electron-35+-47848F?logo=electron)

## The Problem

Copilot CLI supports `--resume <sessionId>`, but managing sessions means remembering UUIDs, digging through `~/.copilot/session-state/`, and having no way to see what's running. Agency gives you a GUI for all of that.

## Features

- **Session sidebar** — Browse all sessions with auto-generated titles, search by title/tags/resources
- **Active & History tabs** — See what's running vs. completed at a glance
- **Embedded terminal** — Full xterm.js terminal with seamless session switching
- **Concurrent sessions** — Keep multiple sessions alive in background, oldest evicted when limit is reached
- **Smart search** — Find sessions by title, tags, or linked resources (PRs, work items, repos)
- **Resource panel** — Clickable links to PRs, work items, repos, and wiki pages per session
- **Instructions viewer** — Rendered `copilot-instructions.md` with TOC and collapsible sections
- **Catppuccin themes** — Mocha (dark) and Latte (light), persisted
- **Keyboard shortcuts** — `Ctrl+N` new, `Ctrl+Tab` switch, `Ctrl+W` close, `Esc` dismiss panels

## Installation

### From Installer (recommended)

Download the latest `Agency-x.x.x.exe` from [Releases](https://github.com/itsela-ms/Agency/releases) and run it — no installation needed, it's a portable executable.

**Prerequisite:** [GitHub Copilot CLI](https://github.com/github/copilot-cli) — `winget install github.copilot`

### From Source

```bash
git clone https://github.com/itsela-ms/Agency.git
cd Agency
npm install

# Run directly
npm start

# Build Windows installer
npm run dist
```

## Architecture

| File | Role |
|------|------|
| `src/main.js` | Electron main process, IPC handlers |
| `src/renderer.js` | Renderer: sidebar, terminals, panels, settings |
| `src/index.html` | App layout |
| `src/styles.css` | Catppuccin dual-theme CSS |
| `src/pty-manager.js` | Concurrent copilot.exe PTY management with eviction |
| `src/session-service.js` | Reads `~/.copilot/session-state/` |
| `src/tag-indexer.js` | Extracts and caches session tags |
| `src/resource-indexer.js` | Extracts PRs, work items, repos, wikis from events |
| `src/settings-service.js` | Persists settings to `~/.copilot/session-gui-settings.json` |
| `src/preload.js` | Context bridge API |
| `launch.vbs` | Windowless VBS launcher |

## License

MIT
