# Changelog

All notable changes to DeepSky are documented here.

## [Unreleased]

## [1.2.11] - 2026-07-26

### Fixed
- **Terminal wheel scrolling is restored without textbox jumps** - DeepSky now lets xterm handle normal scrollback like earlier stable releases, only forwarding wheel input as terminal mouse reports when the CLI explicitly negotiates mouse tracking.
- **Terminal input stays clean while scrolling** - generated mouse reports are ignored by DeepSky's local prompt tracker while the raw PTY stream remains intact for the terminal session.
- **Status timelines stay focused on useful activity** - assistant-echoed session lifecycle metadata such as session resumes, plan updates, and sub-agent bookkeeping is filtered out of the Session Status timeline.

### Removed
- **Removed fragile terminal wheel fallbacks** - deleted the custom PageUp/PageDown and viewport scroll fallback module that could steal wheel events from native xterm scrollback.

## [1.2.10] - 2026-07-22

### Fixed
- **Copilot CLI transcript scrolling works again** - terminal wheel input now reaches the CLI-owned transcript, with a PageUp/PageDown fallback when mouse tracking is unavailable or missed.
- **Copied terminal text is cleaner** - multiline copy removes rendered terminal chrome such as gutters, tree guides, block dividers, timestamps, command markers, and scrollbar artifacts while preserving normal user content.
- **Status timeline focuses on signal** - the Session Status timeline now hides internal lifecycle metadata such as session resume, plan updates, and sub-agent bookkeeping, keeping user prompts and key assistant results; truncated prompt entries show the full prompt on hover.

### Added
- **Terminal scroll regression tests** - extracted terminal wheel helpers and added unit coverage for mouse reports, paging fallback, coordinate math, wheel deltas, and viewport fallback behavior.

## [1.2.10-beta.1] - 2026-07-21

### Fixed
- **Copilot CLI transcript scrolling works again** - terminal wheel input now reaches the CLI-owned transcript, with a PageUp/PageDown fallback when mouse tracking is unavailable or missed.
- **Copied terminal text is cleaner** - multiline copy removes rendered terminal chrome such as gutters, tree guides, block dividers, timestamps, command markers, and scrollbar artifacts while preserving normal user content.
- **Status timeline focuses on signal** - the Session Status timeline now hides internal lifecycle metadata such as session resume, plan updates, and sub-agent bookkeeping, keeping user prompts and key assistant results.

### Added
- **Terminal scroll regression tests** - extracted terminal wheel helpers and added unit coverage for mouse reports, paging fallback, coordinate math, wheel deltas, and viewport fallback behavior.

## [1.2.9] - 2026-07-20

### Fixed
- **Terminal links open reliably** - OSC-8 hyperlinks and visible terminal URLs now open through DeepSky's safe `http(s)` external-link path instead of xterm's browser warning prompt.
- **Terminal focus recovers when stranded** - clicking terminal space refocuses xterm, and plain typing is forwarded to the active session when focus lands on terminal chrome instead of the hidden helper textarea.
- **Terminal cursor affordance is clearer** - the terminal uses the normal arrow cursor by default, keeps pointer cursors for links, and leaves Tab / Shift+Tab available for regular keyboard navigation.
- **Terminal prompt input stays clean** - xterm mouse report bytes are stripped before reaching the Copilot prompt, preventing intermittent random characters after scrolling or submitting.
- **Copied terminal text drops scrollbar artifacts** - copy-on-select and Ctrl+C remove the terminal scrollbar column without stripping real shell pipes, tables, or box borders.
- **About opens the online brochure** - the About tab now always opens the maintained GitHub Pages brochure instead of preferring a local file that only exists on one machine.

## [1.2.9-beta.2] - 2026-07-19

### Changed
- **Supersedes the first terminal-fixes beta** - reissued the validated 1.2.9 beta as `1.2.9-beta.2` so testers and auto-update users get a clean beta build after the earlier beta.1 validation issues.

## [1.2.9-beta.1] - 2026-07-19

### Fixed
- **Terminal links open reliably** - OSC-8 hyperlinks and visible terminal URLs now open through DeepSky's safe `http(s)` external-link path instead of xterm's browser warning prompt.
- **Terminal focus recovers when stranded** - clicking terminal space refocuses xterm, and plain typing is forwarded to the active session when focus lands on terminal chrome instead of the hidden helper textarea.
- **Terminal cursor affordance is clearer** - the terminal uses the normal arrow cursor by default, keeps pointer cursors for links, and leaves Tab / Shift+Tab available for regular keyboard navigation.
- **Terminal prompt input stays clean** - xterm mouse report bytes are stripped before reaching the Copilot prompt, preventing intermittent random characters after scrolling or submitting.
- **Copied terminal text drops scrollbar artifacts** - copy-on-select and Ctrl+C remove the terminal scrollbar column without stripping real shell pipes, tables, or box borders.

## [1.2.8] - 2026-07-13

### Added
- **Active-list launch feedback** - New Session now shows a temporary Starting row immediately while slow Copilot or Agency launchers create the real session.
- **Contact and feedback links** - Settings > About now includes quick actions to email Itay or open a Teams chat for feedback.

### Fixed
- **Terminal wheel scrolling works again** - scrollable Copilot and Agency terminal panes receive SGR wheel events while plain drag selection and copy stay intact.
- **New Session opens immediately** - DeepSky now generates the session ID and launches Copilot/Agency with `--session-id`, avoiding slow and flaky filesystem-diff discovery while the CLI initializes.
- **New Session startup failures are actionable** - session-breaking extra launcher args such as `--mcp gateway` are rejected before spawn, and CLI startup failures now surface the actual CLI error instead of timing out while waiting for a session folder.
- **Work Item context is clearer** - associated Work Items in Session Status now show type plus a truncated title, with the full type and title visible on hover.
- **Resource rendering is safer** - untrusted Work Item titles are escaped safely in text and hover attributes.

## [1.2.8-beta.1] - 2026-07-12

### Added
- **Active-list launch feedback** - New Session now shows a temporary Starting row immediately while slow Copilot or Agency launchers create the real session.
- **Contact and feedback links** - Settings > About now includes quick actions to email Itay or open a Teams chat for feedback.

### Fixed
- **Terminal wheel scrolling works again** - scrollable Copilot and Agency terminal panes receive SGR wheel events while plain drag selection and copy stay intact.
- **New Session startup failures are actionable** - session-breaking extra launcher args such as `--mcp gateway` are rejected before spawn, and CLI startup failures now surface the actual CLI error instead of timing out while waiting for a session folder.
- **Work Item context is clearer** - associated Work Items in Session Status now show type plus a truncated title, with the full type and title visible on hover.
- **Resource rendering is safer** - untrusted Work Item titles are escaped safely in text and hover attributes.

## [1.2.7] - 2026-07-09

### Added
- **One-off New Session options** - the sidebar New Session action now has a `...` menu for starting just one session with a chosen launcher (`copilot` or `agency copilot`) and custom args without changing global settings.

### Fixed
- **Modal shortcuts stay isolated** - New Session Options suppresses global session shortcuts and closed-tab restore while open, so a default session or restored tab cannot appear behind the dialog.
- **Terminal drag selection copies cleanly** - Copilot CLI mouse-tracking sequences are filtered before reaching xterm, restoring plain click-drag selection and copying without the terminal scrollbar glyphs.
- **Windows CI release tests are less flaky** - slow command-path and history-scope tests now have explicit timeouts so release validation does not fail on transient runner slowness.

## [1.2.7-beta.1] - 2026-07-09

### Added
- **One-off New Session options** - the sidebar New Session action now has a `...` menu for starting just one session with a chosen launcher (`copilot` or `agency copilot`) and custom args without changing global settings.

### Fixed
- **Modal shortcuts stay isolated** - New Session Options suppresses global session shortcuts and closed-tab restore while open, so a default session or restored tab cannot appear behind the dialog.
- **Terminal drag selection copies cleanly** - Copilot CLI mouse-tracking sequences are filtered before reaching xterm, restoring plain click-drag selection and copying without the terminal scrollbar glyphs.

## [1.2.6-beta.1] - 2026-07-06

### Added
- **Status benchmark stress test** - `npm run benchmark:status` now generates large synthetic session histories and reads status with configurable concurrency, defaulting to parallelism 8.

### Fixed
- **Files Changed is session-scoped** - the Session Status panel now shows dirty files touched by that specific session instead of leaking every dirty file from the session's shared repository CWD.
- **Status refreshes after new file mutations** - status caching now accounts for session event and CWD metadata changes, so newly touched files appear without waiting for unrelated session directory updates.
- **Git status parsing is safer** - changed-file detection now uses NUL-delimited git porcelain output, ignores failed mutation events, and handles malformed historical CWD metadata without breaking status reads.

## [1.2.5] - 2026-06-25

### Added
- **Restart now for downloaded updates** — the Updates settings panel now shows a button when an update is downloaded so users can trigger installation immediately instead of closing and reopening manually.

### Fixed
- **Updater install recovery is visible** — if the updater installer does not actually exit DeepSky after being triggered, the app now reports a retryable error and keeps the downloaded update marker so installation can be attempted again instead of leaving invisible/background processes.

## [1.2.5-beta.1] - 2026-06-25

### Added
- **Restart now for downloaded updates** — the Updates settings panel now shows a button when an update is downloaded so users can trigger installation immediately instead of closing and reopening manually.

### Fixed
- **Updater install recovery is visible** — if the updater installer does not actually exit DeepSky after being triggered, the app now reports a retryable error and keeps the downloaded update marker so installation can be attempted again instead of leaving invisible/background processes.

## [1.2.4] - 2026-06-25

### Added
- **macOS installers** — CI now builds macOS `.dmg` / `.zip` artifacts alongside the Windows installer, with packaging support for bundled native modules.
- **Custom launcher arguments** — Settings now has one shared **Extra Copilot args** field for new sessions. The value is passed to `copilot`, or after `agency copilot` when the Agency launcher toggle is enabled, and each session keeps the args it was created with.

### Changed
- **Downloaded updates install on next launch** — auto-downloaded updates are persisted as pending installs, revalidated through the updater cache, and applied before DeepSky opens instead of waiting for a quit-time install path that can be missed.
- **Startup loading now shows update progress** — the loading screen includes progress state for pending update installation and recovers by opening the current version if the installer reports an error.
- **Active-list groups are easier to organize** — group headers can be dragged to reorder entire groups, and the top tab strip stays in the same order.

### Fixed
- **Ctrl+V paste works reliably** — terminal paste now handles both keyboard and browser paste paths, strips unsafe bracketed-paste markers, and preserves local command tracking for pasted `/cwd` and `/rename` commands.
- **Closed tabs reopen again** — `Ctrl+Shift+T` keeps the restore stack intact until the tab actually reopens and recovers cleanly from transient restore failures.
- **Launcher args are guarded** — malformed saved args no longer break session reopen, shell-control characters are rejected, and Windows `.cmd` launches use a hardened absolute command processor path.

## [1.2.4-beta.1] - 2026-06-22

### Added
- **macOS beta installers** — CI now builds macOS `.dmg` / `.zip` artifacts alongside the Windows installer, with packaging support for bundled native modules.
- **Custom launcher arguments** — Settings now has one shared **Extra Copilot args** field for new sessions. The value is passed to `copilot`, or after `agency copilot` when the Agency launcher toggle is enabled, and each session keeps the args it was created with.

### Changed
- **Downloaded updates install on next launch** — auto-downloaded updates are persisted as pending installs, revalidated through the updater cache, and applied before DeepSky opens instead of waiting for a quit-time install path that can be missed.
- **Startup loading now shows update progress** — the loading screen includes progress state for pending update installation and recovers by opening the current version if the installer reports an error.

### Fixed
- **Launcher args are guarded** — malformed saved args no longer break session reopen, shell-control characters are rejected, and Windows `.cmd` launches use a hardened absolute command processor path.

## [1.2.3] - 2026-05-27

### Fixed
- **History sessions reopen again** — opening a saved/history session now uses `copilot --session-id <uuid>` instead of `--resume <uuid>`, so DeepSky can reopen local `~/.copilot/session-state` folders even when Copilot CLI's resume index does not recognize the UUID (`No session, task, or name matched ...`).

## [1.2.2] - 2026-05-27

### Added
- **GitHub repository links are first-class resources** — visible GitHub repo links such as `https://github.com/itsela-ms/DeepSky` now appear as Repo resources alongside Azure DevOps repo links, with sentence punctuation trimmed and malformed traversal-shaped paths ignored.

### Changed
- **Related resources are stricter** — the Session Status resource list now auto-indexes only top-level visible user/assistant resource mentions, instead of treating tool arguments, tool output/search results, or sub-agent chatter as related.
- **Active-list directory icon is easier to see** — session cards in the Active list now use an outline-only yellow working-directory icon instead of leaving it as a faint grey affordance.
- **Sidebar and terminal rendering are calmer** — session switches repaint once, idle redraw flicker is suppressed, resize noise no longer keeps cards busy, and collapsed group dots use clearer colors.
- **Sidebar folder icon redesigned** — the prior "📁 + truncated path" row underneath each session title is replaced with a small monochrome folder icon in the bottom-right corner of the card. Click opens the folder picker, same as before.
- **Tab strip mirrors sidebar order** — Ctrl+Tab now cycles in the order the sidebar shows (drag-reorderable and persisted), not in raw resolution order.

### Fixed
- **Ctrl+W actually closes sessions again** — closing a tab now disposes the underlying pty/session as well as the tab UI; sidebar stays in sync.
- **Changing CWD via the folder button no longer crashes the session** — DeepSky now waits for the old PTY to exit before resuming the same session in the new directory, and suppresses the intentional restart exit event.
- **New session is scrollable from the first frame** — fixes a race where the terminal wasn't yet attached when initial output arrived, leaving the scrollback at the bottom with no way to scroll up until `/restart`.
- **`Working` vs `Waiting` badges reflect reality** — Working flips to Waiting within ~2s of the last substantive output from the agent, instead of after the previous ~39s polling decay. The new debounce ignores ambient ANSI noise (cursor blinks, idle redraws) so the badge no longer flickers when nothing is happening.
- **`Pending PR` is now correct** — only fires when the *latest* assistant message contains a PR URL (GitHub `/pull/N` or Azure DevOps `/pullrequest/N`), not whenever any historical PR was ever mentioned in the session.
- **`Ctrl+W` no longer triggers `Uncaught Exception` dialogs** — the per-close `where copilot.exe` shellout now runs without a stdin pipe and is cached for the process lifetime, eliminating the intermittent EPIPE.

## [1.2.2-beta.1] - 2026-05-24

### Fixed
- **Ctrl+W actually closes sessions again** — closing a tab now disposes the underlying pty/session as well as the tab UI; sidebar stays in sync.
- **New session is scrollable from the first frame** — fixes a race where the terminal wasn't yet attached when initial output arrived, leaving the scrollback at the bottom with no way to scroll up until `/restart`.
- **`Working` vs `Waiting` badges reflect reality** — Working flips to Waiting within ~2s of the last substantive output from the agent, instead of after the previous ~39s polling decay. The new debounce ignores ambient ANSI noise (cursor blinks, idle redraws) so the badge no longer flickers when nothing is happening.
- **`Pending PR` is now correct** — only fires when the *latest* assistant message contains a PR URL (GitHub `/pull/N` or Azure DevOps `/pullrequest/N`), not whenever any historical PR was ever mentioned in the session.
- **`Ctrl+W` no longer triggers `Uncaught Exception` dialogs** — the per-close `where copilot.exe` shellout now runs without a stdin pipe and is cached for the process lifetime, eliminating the intermittent EPIPE.

### Changed
- **Sidebar folder icon redesigned** — the prior "📁 + truncated path" row underneath each session title is replaced with a small monochrome folder icon in the bottom-right corner of the card. Click opens the folder picker, same as before.
- **Tab strip mirrors sidebar order** — Ctrl+Tab now cycles in the order the sidebar shows (drag-reorderable and persisted), not in raw resolution order.

## [1.2.1] - 2026-05-19

### Fixed
- **Compatibility with Copilot CLI 1.0.49+** — new sessions and warm-up standbys no longer pass `--resume <unknown-uuid>` to the CLI. The CLI changed in 1.0.49 to strictly reject unknown IDs (`Error: No session, task, or name matched '<uuid>'`), which caused every newly opened tab to die immediately. DeepSky now spawns new sessions without `--resume` and discovers the CLI-assigned session ID by diffing the `~/.copilot/session-state` directory. Existing sessions (resume from sidebar) are unchanged.

## [1.2.0] - 2026-05-18

### Added
- **Readable About release notes** — the About tab now renders recent changelog entries as structured release cards and highlights the current build.
- **Brochure access from About** — the About tab includes an availability-aware **Open brochure** action so local release collateral is one click away.
- **Explicit full-history loading** — the History tab now has a **Show all history** button for intentionally loading older saved sessions beyond the default recent window.
- **Startup loading screen** — DeepSky now shows phase-specific startup progress while settings, sessions, notifications, and workspace state load; startup failures stay visible instead of dropping into a half-loaded UI.

### Changed
- **Tighter status summary layout** — the Session ID now stays on a single truncated line, and the `session` / `files` quick actions stay compact on one row.
- **Split tab state from live-session state** — DeepSky now persists open tabs separately from active sessions so the tab strip, Active list, and startup restore no longer fight each other.
- **History now defaults to a bounded recent view** — the History tab only loads up to 500 sessions from the last 3 months so the default sidebar stays responsive.
- **Sidebar search is metadata-only by default** — title, folder, tags, and resources remain searchable without doing deep transcript scans unless you explicitly ask for it.

### Fixed
- **Non-Latin shortcut support** — keyboard shortcuts now work correctly on non-Latin keyboard layouts.
- **Single-open terminal links** — terminal hyperlinks keep the pointer hover affordance without opening twice on click.
- **Unavailable summary actions** — `session` / `files` quick actions are disabled and greyed out when those directories are unavailable.
- **Tab close no longer stops live sessions** — closing a tab now only removes the tab UI and leaves the active session running.
- **Tab close keeps active-list grouping** — closing a tab no longer drops that session out of its active-list group.
- **Stable group rename focus** — double-click rename on a group header no longer loses focus during background sidebar refreshes.
- **Correct Active-list startup restore** — reopening DeepSky restores the Active list from previously active sessions instead of rebuilding it from open tabs.
- **Closed-tab restore works with scoped History again** — `Ctrl+Shift+T` now restores from the full session inventory instead of only the currently loaded sidebar subset.
- **Closed-tab restore covers Active-list close paths** — `Ctrl+Shift+T` now restores sessions closed from the Active list, including fresh in-memory sessions before sidebar metadata catches up.

## [1.1.0] - 2026-05-04

### Added
- **Enhance Instructions skill** — new "✨ Enhance" button in the Custom Instructions panel. Creates a timestamped backup of `~/.copilot/copilot-instructions.md` and `~/.copilot/playbooks/` to `~/.copilot/instruction-backups/<timestamp>/` **before** anything else, then spawns a new Copilot session with a predefined prompt that researches the latest context-engineering / Skills practices and rewrites your instructions. When the agent finishes it produces a `changes.html` report; a "Review" button surfaces the diff in a sandboxed iframe modal with **Keep changes** or **↩ Rollback** actions. Rollback fully restores the snapshot (including removing playbooks added after the backup).
- **Files Folder quick-action** in the Session Status summary — jump straight to the session's `files/` directory alongside the existing Session Folder action.

### Changed
- **Generalized session-path resolution** — `session-paths.js` now exposes `resolveSessionPath` and `resolveSessionFilesDirectory` so the new Files Folder action and any future per-session subdirectory openers share the same symlink/path-traversal validation.
- **Status summary rendering extracted** to `src/status-summary.js` for testability.
- **Tighter status summary layout** — the Copy ID action now lives as a compact icon inside the Session ID chip, keeping the Session Folder / Files Folder quick actions on a single row.

## [1.0.1-beta.1] - 2026-04-27

### Added
- **Open session directory action** — the Session Status summary now includes an **Open Folder** button so you can jump straight to the current session's directory from the status panel

### Changed
- **Shared session path validation** — session-directory opening and generated-file opening now use the same main-process path validation helpers instead of separate ad-hoc checks

## [1.0.0] - 2026-04-26

### Added
- **Colorized file diff previews** — hover a changed file in the Status panel to keep a real diff popover open, with red/green line styling instead of a plain tooltip

### Changed
- **Unified session metadata storage** — DeepSky now writes rename and working-directory updates into `workspace.yaml`, so the sidebar, tabs, and status panel read the same source of truth
- **Live session refresh** — open sessions refresh their metadata during status polling, which keeps renamed sessions and directory changes in sync without reopening the app
- **Generated file safety** — DeepSky now ignores symlinked generated-file entries and only opens files whose real path stays inside the session `files` directory

### Fixed
- `/rename` now updates the tab strip and sidebar title consistently after Copilot renames a session
- Sidebar hide/show persistence now keeps collapsed-state settings aligned when restoring the UI
- Session metadata writes are serialized per session so rename and working-directory updates do not overwrite each other

## [0.9.1-beta.1] - 2026-04-16

### Added
- **Agency launcher toggle** — choose `agency copilot` for new sessions from General settings when you want to start DeepSky sessions through Agency instead of the default Copilot CLI command

### Changed
- **Per-session launcher persistence** — DeepSky now remembers whether a session was started with Copilot CLI or `agency copilot`, so reopen and working-directory changes keep using the same launcher
- **Standby session matching** — prewarmed sessions now track their launcher choice so DeepSky only reuses standby sessions when both the working directory and launcher match

## [0.9.0] - 2026-03-29

### Added
- **Settings redesigned with tabs** — General, Updates, Shortcuts, About; settings are now logically grouped instead of one long scroll
- **Auto-update toggle** — enable or disable automatic update checking and installation from the Updates tab
- **Beta channel opt-in** — "Early adopter" toggle to receive beta releases before general availability
- **Browse/Clear buttons for default directory** — pick a working directory with a file browser instead of typing the path; clear it with one click
- **Expandable tag overflow** — clicking the "+N" badge on a session card expands all hidden tags (was hover-only)
- **Beta prerelease detection in CI** — builds from a `-beta` branch are automatically marked as prerelease on GitHub

### Changed
- **Settings modal width** increased from 420 to 480px with fixed-header/scrollable-body layout
- **Modern toggle switches** — iOS/macOS-style toggles replace old checkbox-based controls throughout Settings
- **Keyboard shortcuts moved** to a dedicated Shortcuts tab
- **Theme selection moved** under General → Appearance
- **Update service is now settings-driven** — auto-download, auto-install, and prerelease behavior reflect user preferences

### Fixed
- Settings modal header no longer disappears when scrolling through long settings
- Tag expansion now uses explicit state instead of hover, preventing layout shifts

## [0.8.9] - 2026-03-23

### Fixed
- **Critical regression** — v0.8.6–0.8.8 introduced a bug that prevented active sessions from showing in the sidebar on startup; this release reverts to the last stable base (v0.8.5) and republishes as v0.8.9 so auto-update delivers the fix

## [0.8.5] - 2026-03-16

### Added
- **Sidebar collapse** — click the sidebar border to fully collapse (width 0) with an expand strip; drag to icon-mode at smaller widths
- **Info bar** — structural bar below the terminal showing the session title and last prompt
- **Restore closed tab** — `Ctrl+Shift+T` reopens the last closed session tab
- **In-session search** — `Ctrl+F` opens buffer-only search with viewport sync and wrapped-line-aware matching
- **Sidebar content search** — search across all session content from the sidebar search bar
- **Session ID in status panel** — shows session ID with a copy button in the summary section
- **Keyboard shortcuts in Settings** — new section showing all shortcuts with styled keycaps
- **Rename from context menu** — right-click a session in the sidebar to rename it

### Changed
- **Themed scrollbar** — always-visible webkit scrollbar with Catppuccin styling
- **Next steps truncation** — long plan step labels are summarized to 6 words for cleaner status panel display
- **Zoom scroll fix** — terminal scrolls to bottom after zoom refit to prevent getting stuck

### Removed
- **"Check for Updates" button** — auto-update runs silently on startup and every 15 minutes; manual check no longer needed

## [0.8.4] - 2026-03-12

### Fixed
- **Terminal horizontal scroll** — fixed terminal content getting cut off on the left when the status panel is open, caused by stale xterm viewport scroll offset after container resize

## [0.8.3] - 2026-03-12

### Changed
- **Custom notification popups** — replaced Windows native toast notifications with themed Catppuccin popups that slide in from the bottom-right, stack when multiple arrive, auto-dismiss after 6 seconds, and navigate to the relevant session on click

## [0.8.2] - 2026-03-09

### Added
- **Feedback button** — new `✎` button in the toolbar opens a panel with "Report a Bug" and "Request a Feature" options, each pre-filling a GitHub issue with version info and structured templates

### Changed
- **Session timestamps** — sessions older than today now show the date (e.g. "Dec 12 14:30") instead of just the time, making history easier to navigate
- **History list** — removed date group headers ("Today", "Yesterday", etc.) for a cleaner, less cluttered session list
- **History sorting** — history tab now sorts sessions by most recently used first

## [0.8.1] - 2026-03-07

### Fixed
- Auto-update XML parse error when checking for new versions
- Release distribution now correctly serves from itsela-ms/DeepSky (public)

## [0.8.0] - 2026-03-04

### Added
- **Session Status panel** — replaces the Resource panel with a richer, collapsible status view (`Ctrl+I` / `📋` button)
  - Shows current Copilot intent (live pulse indicator)
  - Session summary extracted from session-summary.md or checkpoints
  - Next steps with progress tracking (done/current/pending states)
  - Timeline of session events with color-coded dots
  - Files changed with added/modified badges
  - Collapsible sections with persistent expand/collapse state
- **Status Service** — new backend service that reads session intent, summary, plan, files, and timeline from session state
- **Keyboard shortcut** — `Ctrl+I` toggles the status panel; works even when terminal is focused

### Changed
- **Repository publishing** — DeepSky updates continue to publish from the public `itsela-ms/DeepSky` repository so releases, feedback links, and auto-update all stay aligned.
- **Update badge** — now shows immediately when a download starts (not just after completion); toast notification only fires after download completes
- Resources (PRs, work items, pipelines, repos, links) are now displayed as sections inside the Status panel instead of the old dedicated Resource panel

## [0.7.0] - 2026-02-26

### Added
- **Working directory support** — choose a working directory per session
  - Optional directory picker on new session creation (enable in Settings)
  - Click the cwd path in the sidebar to change a running session's directory
  - Sessions respawn in the new directory; persisted across restarts via `.deepsky-cwd`
  - Default working directory setting in Settings panel
- **Session close button** — `✕` button on active session tabs for quick close (kills the PTY)
- **Resource panel: manual add** — paste any ADO link into the input to pin it to the session
- **Resource panel: remove button** — `×` hover button on each resource row to dismiss it
- **Resource panel: pipeline & release links** — auto-extracted from session events + manually addable
  - Build results (`_build/results?buildId=`), pipeline definitions (`_build?definitionId=`), releases (`_releaseProgress?releaseId=`)
- **Resource panel: generic links** — any non-ADO URL can be added as a generic link
- **Resource deduplication** — resources keyed by `{type}:{id|url}`; duplicates rejected on add and filtered on display

### Changed
- PTY session entry uses direct reference to prevent stale exit handlers after kill+respawn
- PTY spawn falls back to homedir if the specified cwd is invalid
- Resource panel 🔗 toggle button pinned outside the scrollable tab area (no longer disappears on tab overflow)

### Fixed
- Race condition where old PTY exit handler could delete a newly-opened session entry during cwd change

## [0.6.1] - 2026-02-25

### Added
- **PR status tracking** — resource panel and sidebar pills now show active/completed/abandoned state for linked PRs
- **Ctrl+T** shortcut to create a new session (same as Ctrl+N)
- **Ctrl+C copy** — when text is selected in the terminal, Ctrl+C copies to clipboard instead of sending SIGINT
- **Double-click group header** to rename (in addition to the existing context menu option)

### Changed
- Clipboard operations routed through main process IPC (fixes sandboxed preload restrictions)
- "Pending" state only triggers for active PRs (completed/abandoned PRs no longer count)
- Removed `copy` from Electron Edit menu to prevent double-handling with xterm's selection model

### Fixed
- Removed `Shift+Enter` custom handling that interfered with terminal input

## [0.6.0] - 2026-02-23

### Added
- **Session grouping** — Edge-style group management in the Active sidebar
  - Create, rename, and recolor groups via context menu
  - Drag-and-drop to reorder sessions and move them between groups
  - Collapse/expand groups with session count badges
  - Right-click context menus for sessions and group headers (rename, color, ungroup, close all)
  - 8 Catppuccin-themed preset group colors
- **Manual session ordering** — drag to reorder sessions freely; order persisted across restarts
- **Drop indicators** — top/bottom highlight when reordering via drag-and-drop
- **Input validation** — group names capped at 50 chars; corrupted group state gracefully restored

### Changed
- **Silent auto-updates** — updates download in the background and install on quit; no restart prompts
- Background update check every 15 minutes
- Green badge on settings gear when an update is pending
- Removed keyboard shortcuts section from README

## [0.5.5] - 2026-02-23

### Added
- CI workflow for Windows builds (GitHub Actions)
- Tab scroll indicators — left/right arrows appear when tabs overflow the tab bar
- SQL/SQLite/database tag recognition for sessions
- Pending sessions now surface on the active tab (not just running ones)

### Changed
- Removed macOS support (Windows-only for now)
- Replaced session dashboard with minimal empty state
- Cross-platform path handling (`os.homedir`), platform-aware binary discovery
- Tabs shrink instead of always overflowing (`flex-shrink: 1`, `min-width: 80px`)
- App icon upscaled to 512×512 for electron-builder

### Fixed
- Copilot CLI `.cmd` shim not found on Windows npm installs — now searches both `.exe` and `.cmd`, spawns via `cmd.exe /c`
- Titlebar buttons unclickable on Electron 35 — Windows `titleBarOverlay` intercepted clicks; fixed with explicit `app-region: no-drag`
- Horizontal scrollbar overflow in terminal area — flex `min-width: auto` prevented shrinking
- "Working" badge on startup lasting ~30s — `lastDataAt` was initialized to `Date.now()`
- "Pending" state never showing for sessions with PRs
- Session state priority reworked — Pending now overrides all states; updated tips for Working/Waiting/Idle
- Memory leaks — IPC listeners not cleaned up, xterm terminals not disposed on pty exit, dead pty entries accumulating in Map
- Unbounded memory — notification `processedFiles` Set uncapped, `sessionLastUsed`/`sessionAliveState`/`sessionIdleCount` not cleaned on close
- Event handling — replaced per-item `addEventListener` with event delegation; fixed title click race condition

## [0.5.4] - 2026-02-22

### Added
- Session dashboard view when no tabs are open
- Live session status polling — badges update every 3s based on actual pty output
- Session state now uses `isBusy` (recent output) instead of focused-session heuristic
- Graceful shutdown — busy sessions stay alive in background when closing (10-min timeout)
- Close confirmation dialog when AI sessions are still processing
- Unit test infrastructure (Vitest) with 27 tests for session-state and pty-manager
- Extracted `session-state.js` — pure function for state derivation

### Changed
- "Working" state now means AI is actively outputting (green), "Waiting" means idle terminal (yellow)
- `pty-manager` tracks `lastDataAt` per session and exposes it via `getActiveSessions()`
- `pty-manager` accepts injectable pty module for testability

### Fixed
- Notification click not focusing the target session (rAF race condition)
- Session state badges going stale between discrete UI events

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
