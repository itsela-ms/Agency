# Changelog

All notable changes to GroundControl are documented here.

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
- Custom GroundControl window icon
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
