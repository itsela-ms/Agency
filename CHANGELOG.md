# Changelog

All notable changes to DeepSky are documented here.

## [0.5.3] - 2026-02-19

### Added
- Session state badges — each session shows a colored state pill (Idle / Working / Waiting / Pending / ✓ Done)
- Graceful shutdown — busy sessions stay alive in the background when closing, with a 10-minute timeout
- Close confirmation dialog when AI sessions are still processing

### Changed
- Resource panel toggle button changed from ⊞ to 🔗
- Resource icons (Repo/Wiki/PR/WI) styled as auto-width pill badges to prevent text overlap
- Sidebar session items have improved right padding to prevent badge collision

### Fixed
- Resource panel icon text ("Repo", "Wiki") overlapping with resource label names
- Session resource badges colliding with running indicator dot and delete button

## [0.5.2] - 2026-02-17

### Changed
- Smoother UI — softer borders in dark mode, eased transitions, borderless ghost buttons
- Clean icon glyphs (⚐ ☰ ⚙ ⊞) replace emojis everywhere, labels shown on hover
- Simplified update flow — single "Check for Updates" button, auto-downloads, prompts to restart

### Added
- Session persistence — open tabs and active tab restored on startup
- Session delete — red ✕ on hover in history tab with confirmation dialog
- Middle-click to close terminal tabs
- Running session indicator — green dot with subtle glow

### Fixed
- Horizontal scroll in sidebar active tab
- Inconsistent border colors in dark mode

## [0.5.1] - 2026-02-16

### Changed
- Rebranded from GroundControl to DeepSky — new name, new icon, new identity
- Switched to dark icon variant for better taskbar/tray visibility

### Added
- Session rename — double-click any session title in the sidebar to rename it

## [0.4.0] - 2025-02-15

### Added
- Auto-update via GitHub Releases (electron-updater)
- "Check for Updates" button in Settings with download progress
- "Restart & Update" one-click install for downloaded updates
- About section in Settings showing version and changelog
- Switched from portable `.exe` to NSIS installer (install/uninstall, Start Menu entry)

## [0.3.0] - 2025-02-15

### Added
- Version and changelog visible in Settings panel
- Active sidebar now sorts sessions by last used

### Fixed
- New session not appearing in active list immediately
- Tab title not updating after session gets a title
- Startup crash and close ReferenceError

## [0.2.0] - 2025-02-01

### Added
- Windows portable installer via electron-builder
- Custom DeepSky window icon
- Ctrl+V and Shift+Insert paste support in terminal
- Notification bell and notification panel
- Session tags and resource indexing (PRs, work items)
- Theme switcher (Mocha/Latte)
- Keyboard shortcuts: Ctrl+Tab, Ctrl+W, Ctrl+N, Ctrl+K
- Session search with tag and resource filtering
- Copilot instructions editor

### Fixed
- 34 bugs from QA review
- Notification bell white background in dark mode

### Initial
- Electron-based session manager for GitHub Copilot CLI
- Sidebar with Active/History session views
- Terminal multiplexer with tab management
- PTY management with automatic session eviction
