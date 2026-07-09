/**
 * Source-level guardrail tests.
 *
 * These tests do NOT exercise behavior at runtime — they read the relevant
 * source files and assert that the *shape* of the code preserves two fixes
 * that have already regressed once before:
 *
 *   1. Terminal links open exactly once and the hover cursor stays a pointer
 *      (PR #5 / commit 92bd9bc, restored in PR #9). The Copilot CLI is the
 *      sole link opener; WebLinksAddon must remain loaded for the hover
 *      decoration but its click handler MUST be a no-op.
 *
 *   2. Letter shortcuts work on non-Latin keyboard layouts (PR #9). Letter
 *      shortcut handlers must resolve the logical key from the physical
 *      `e.code` (via `getShortcutKey`), never compare `e.key` to a Latin
 *      letter directly.
 *
 * If you fail one of these tests, do NOT just edit the test — read the comment
 * on the line being checked first. There is almost certainly a UX bug behind
 * the change.
 */

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = join(__dirname, '..');
const RENDERER_SRC = readFileSync(join(ROOT, 'src', 'renderer.js'), 'utf8');
const SHORTCUTS_SRC = readFileSync(join(ROOT, 'src', 'keyboard-shortcuts.js'), 'utf8');
const MAIN_SRC = readFileSync(join(ROOT, 'src', 'main.js'), 'utf8');
const PRELOAD_SRC = readFileSync(join(ROOT, 'src', 'preload.js'), 'utf8');
const PTY_MANAGER_SRC = readFileSync(join(ROOT, 'src', 'pty-manager.js'), 'utf8');
const STYLES_SRC = readFileSync(join(ROOT, 'src', 'styles.css'), 'utf8');
const INDEX_SRC = readFileSync(join(ROOT, 'src', 'index.html'), 'utf8');
const UPDATE_SERVICE_SRC = readFileSync(join(ROOT, 'src', 'update-service.js'), 'utf8');

// ───────────────────────────────────────────────────────────────────────────
// Terminal link handling — double-open + hover-cursor regression guard
// ───────────────────────────────────────────────────────────────────────────

describe('terminal link handling — regression guardrails', () => {
  it('keeps WebLinksAddon loaded so URLs are decorated and the hover cursor is a pointer', () => {
    expect(RENDERER_SRC).toMatch(/new WebLinksAddon\(/);
  });

  it('passes a no-op handler to WebLinksAddon so links do not open twice', () => {
    // The Copilot CLI emits OSC 8 hyperlinks and opens links itself on click.
    // Any non-empty handler here re-introduces the double-open regression.
    const noopForms = [
      /new WebLinksAddon\(\s*\(\s*\)\s*=>\s*\{\s*\}\s*\)/,         // () => {}
      /new WebLinksAddon\(\s*\(\s*\)\s*=>\s*undefined\s*\)/,       // () => undefined
      /new WebLinksAddon\(\s*\(\s*_?e?\s*,?\s*_?uri?\s*\)\s*=>\s*\{\s*\}\s*\)/, // (e, uri) => {}
    ];
    const matched = noopForms.some(rx => rx.test(RENDERER_SRC));
    expect(matched, 'WebLinksAddon must be constructed with a no-op handler').toBe(true);
  });

  it('does NOT call openExternal from inside the WebLinksAddon constructor', () => {
    const lines = RENDERER_SRC.split(/\r?\n/);
    const idx = lines.findIndex(l => l.includes('new WebLinksAddon('));
    expect(idx, 'WebLinksAddon registration line not found').toBeGreaterThanOrEqual(0);
    // Inspect the registration line plus the next 5 lines (in case the
    // constructor is split across multiple lines). None of them may reference
    // openExternal — that is the exact pattern that opens every link twice.
    const block = lines.slice(idx, idx + 6).join('\n');
    expect(block).not.toMatch(/openExternal/);
  });

  it('keeps the explanatory comment so future cleanups do not revert the fix', () => {
    // The comment must mention BOTH the consequence ("twice") and the rationale
    // (the "CLI" is the sole opener, the addon stays for "cursor"/"hover").
    const idx = RENDERER_SRC.indexOf('new WebLinksAddon(');
    expect(idx).toBeGreaterThan(0);
    const before = RENDERER_SRC.slice(Math.max(0, idx - 800), idx);
    expect(before, 'expected a comment warning about double-open above WebLinksAddon').toMatch(/twice/i);
    expect(before, 'expected a comment about the cursor/hover affordance above WebLinksAddon').toMatch(/cursor|hover/i);
    expect(before, 'expected a comment naming the CLI as the link opener above WebLinksAddon').toMatch(/CLI/);
  });
});

describe('shell:openExternal IPC — regression guardrails', () => {
  it('only forwards http(s) URLs to shell.openExternal', () => {
    const handler = MAIN_SRC.match(/ipcMain\.handle\(\s*['"]shell:openExternal['"][\s\S]*?\}\s*\)\s*;/);
    expect(handler, 'shell:openExternal IPC handler not found').not.toBeNull();
    const block = handler[0];
    expect(block).toMatch(/http:\/\//);
    expect(block).toMatch(/https:\/\//);
    expect(block).toMatch(/shell\.openExternal/);
  });
});

describe('main process session creation — regression guardrails', () => {
  it('awaits async PtyManager.newSession before persisting metadata', () => {
    const offenders = MAIN_SRC
      .split(/\r?\n/)
      .filter(line => line.includes('ptyManager.newSession('))
      .filter(line => !line.includes('await ptyManager.newSession('));

    expect(
      offenders,
      `PtyManager.newSession returns a Promise; un-awaited callers persist invalid session IDs:\n${offenders.join('\n')}`
    ).toEqual([]);
  });

  it('persists launcher args per session and restores with saved args, not current settings', () => {
    expect(MAIN_SRC).toMatch(/saveLauncherArgs\(claimed\.id,\s*launcherArgs\)/);
    expect(MAIN_SRC).toMatch(/saveLauncherArgs\(sessionId,\s*launcherArgs\)/);
    expect(MAIN_SRC).toMatch(/getLauncherArgs\(sessionId\)/);
    expect(PTY_MANAGER_SRC).toMatch(/openSession\(sessionId, cwd, launcher, launcherArgsText = ''\)/);
  });

  it('invalidates in-flight warm-ups when launcher settings change', () => {
    expect(PTY_MANAGER_SRC).toMatch(/_warmUpGeneration/);
    expect(PTY_MANAGER_SRC).toMatch(/generation !== this\._warmUpGeneration/);
    expect(PTY_MANAGER_SRC).toMatch(/expectedKey !== this\._standbyKey/);
  });

  it('passes captured launcher args into cold new-session spawns', () => {
    expect(MAIN_SRC).toMatch(/ptyManager\.newSession\(cwd \|\| undefined,\s*launcher,\s*\[\],\s*launcherArgs\)/);
    expect(MAIN_SRC).toMatch(/ptyManager\.newSession\(undefined,\s*launcher,\s*\['-i', oneLineCommand\],\s*launcherArgs\)/);
  });

  it('supports one-off new-session launcher args without mutating global settings', () => {
    expect(MAIN_SRC).toMatch(/resolveNewSessionLaunchRequest\(request\)/);
    expect(MAIN_SRC).toMatch(/Object\.prototype\.hasOwnProperty\.call\(request,\s*'launcherArgs'\)/);
    expect(MAIN_SRC).toMatch(/hasOneOffArgs && typeof request\.launcherArgs !== 'string'/);
    expect(MAIN_SRC).toMatch(/parseLauncherArgs\(launcherArgs\)/);
    expect(MAIN_SRC).toMatch(/oneOff \? null : ptyManager\.claimStandby/);
    expect(MAIN_SRC).toMatch(/saveLauncherArgs\(sessionId,\s*launcherArgs\)/);
    expect(RENDERER_SRC).toMatch(/newSession\(\{ launcher,\s*launcherArgs \}\)/);
    expect(RENDERER_SRC).toMatch(/getAnyOneOffLauncherAvailability\(settings\)/);
    expect(RENDERER_SRC).toMatch(/const oneOffAvailability = getAnyOneOffLauncherAvailability\(settings\)/);
    expect(RENDERER_SRC).toMatch(/btnNewOptions\.classList\.toggle\('is-blocked', optionsBlocked\)/);
    expect(RENDERER_SRC).toMatch(/newSessionLauncherCopilotInput\.disabled = !copilotAvailable/);
    expect(RENDERER_SRC).toMatch(/newSessionLauncherAgencyInput\.disabled = !agencyAvailable/);
    expect(RENDERER_SRC).toMatch(/function isBlockingModalOpen\(\)/);
    expect(RENDERER_SRC).toMatch(/window\.api\.onRestoreTabShortcut\(\(\) => \{[\s\S]*?if \(isBlockingModalOpen\(\)\) return;/);
    expect(RENDERER_SRC).toMatch(/if \(isBlockingModalOpen\(\)\) \{[\s\S]*?e\.preventDefault\(\)[\s\S]*?return/);
    expect(RENDERER_SRC).toMatch(/newSessionOptionsOverlay[\s\S]*?e\.key === 'Escape'[\s\S]*?e\.stopPropagation\(\)/);
    expect(RENDERER_SRC).not.toMatch(/updateSettings\(\{\s*copilotArgs:\s*launcherArgs/);
  });

  it('uses an absolute Windows command processor path for .cmd launchers', () => {
    expect(PTY_MANAGER_SRC).toMatch(/this\._cmdPath\s*=\s*options\.cmdPath/);
    expect(PTY_MANAGER_SRC).toMatch(/file:\s*this\._cmdPath/);
    expect(PTY_MANAGER_SRC).not.toMatch(/file:\s*['"]cmd\.exe['"]/);
  });
});

describe('sidebar history search — regression guardrails', () => {
  it('does not call the deep session-content search API from the renderer sidebar', () => {
    expect(RENDERER_SRC).not.toMatch(/window\.api\.searchSessions\(/);
  });
});

describe('closed tab restore — regression guardrails', () => {
  it('restores closed tabs against the all-sessions inventory, not the current sidebar subset', () => {
    expect(RENDERER_SRC).toMatch(/listSessions\(\{\s*scope:\s*'all'\s*\}\)/);
    expect(RENDERER_SRC).toMatch(/restoreMostRecentClosedTab/);
    expect(RENDERER_SRC).toMatch(/allSessions\.map\(session => session\.id\)/);
  });

  it('does not pop a closed tab until reopening succeeds', () => {
    expect(RENDERER_SRC).toMatch(/let restoringClosedTab = false/);
    const body = RENDERER_SRC.match(/async function restoreMostRecentClosedTab\(\) \{([\s\S]*?)\n\}/)?.[1] || '';
    expect(body.indexOf('try {')).toBeLessThan(body.indexOf('await getAllValidSessionIds()'));
    expect(body).toMatch(/peekRestorableClosedSession\(recentlyClosedSessions,\s*validIds\)/);
    expect(RENDERER_SRC).toMatch(/await openSession\(sessionId\)[\s\S]*if \(openTabIds\.has\(sessionId\)\) \{[\s\S]*forgetRestorableClosedSession\(recentlyClosedSessions,\s*sessionId\)/);
  });

  it('handles Ctrl+Shift+T from the Electron input path, not only the renderer keydown path', () => {
    expect(MAIN_SRC).toMatch(/before-input-event/);
    expect(MAIN_SRC).toMatch(/shortcut:restore-tab/);
    expect(MAIN_SRC).toMatch(/accelerator:\s*'CommandOrControl\+Shift\+T'/);
    expect(PRELOAD_SRC).toMatch(/onRestoreTabShortcut/);
    expect(RENDERER_SRC).toMatch(/onRestoreTabShortcut\(\(\)\s*=>\s*\{/);
  });

  it('keeps Active-list session closes restorable through Ctrl+Shift+T', () => {
    expect(RENDERER_SRC).toMatch(/terminateSession\(item\.dataset\.sessionId,\s*\{\s*rememberClosedTab:\s*true\s*\}\)/);
  });
});

describe('active-list group reorder — regression guardrails', () => {
  it('only shows session row drop indicators for session drags', () => {
    expect(RENDERER_SRC).toMatch(/const isSessionDrag = \[\.\.\.e\.dataTransfer\.types\]\.includes\(['"]application\/x-session-id['"]\)/);
    expect(RENDERER_SRC).toMatch(/if \(!isSessionDrag\) \{[\s\S]*?el\.classList\.remove\(['"]drop-above['"],\s*['"]drop-below['"]\)/);
  });

  it('makes group headers draggable and reorders groups on group-header drop', () => {
    expect(RENDERER_SRC).toMatch(/headerEl\.setAttribute\(['"]draggable['"],\s*['"]true['"]\)/);
    expect(RENDERER_SRC).toMatch(/setData\(['"]application\/x-group-id['"],\s*group\.id\)/);
    expect(RENDERER_SRC).toMatch(/getData\(['"]application\/x-group-id['"]\)/);
    expect(RENDERER_SRC).toMatch(/const isGroupDrag = \[\.\.\.e\.dataTransfer\.types\]\.includes\(['"]application\/x-group-id['"]\)/);
    expect(RENDERER_SRC).toMatch(/if \(!isGroupDrag && !isSessionDrag\) \{[\s\S]*?headerEl\.classList\.remove\(['"]drag-over['"],\s*['"]drop-above['"],\s*['"]drop-below['"]\)/);
    expect(RENDERER_SRC).toMatch(/function handleGroupReorder\(draggedGroupId,\s*targetGroupId,\s*insertAbove\)/);
    expect(RENDERER_SRC).toMatch(/handleGroupReorder\(draggedGroupId,\s*group\.id,\s*above\)/);
    expect(RENDERER_SRC).toMatch(/tabGroups\.splice\(insertAbove \? targetIndex : targetIndex \+ 1,\s*0,\s*draggedGroup\)/);
    expect(RENDERER_SRC).toMatch(/function normalizeSessionOrderToActiveList\(\)/);
    expect(RENDERER_SRC).toMatch(/sessionOrder = \[\.\.\.groupedOrder,\s*\.\.\.ungroupedOrder\]/);
    expect(RENDERER_SRC).toMatch(/function handleGroupReorder[\s\S]*normalizeSessionOrderToActiveList\(\)/);
    expect(RENDERER_SRC).toMatch(/function handleGroupReorder[\s\S]*syncTabStripOrder\(\)/);
    expect(STYLES_SRC).toMatch(/\.session-group-header\.drop-above/);
    expect(STYLES_SRC).toMatch(/\.session-group-header\.drop-below/);
  });

  it('keeps group reorder keyboard accessible', () => {
    expect(RENDERER_SRC).toMatch(/headerEl\.setAttribute\(['"]tabindex['"],\s*['"]0['"]\)/);
    expect(RENDERER_SRC).toMatch(/headerEl\.setAttribute\(['"]role['"],\s*['"]button['"]\)/);
    expect(RENDERER_SRC).toMatch(/headerEl\.setAttribute\(['"]aria-expanded['"]/);
    expect(RENDERER_SRC).toMatch(/e\.altKey && e\.key === ['"]ArrowUp['"][\s\S]*moveGroupByOffset\(group\.id,\s*-1\)/);
    expect(RENDERER_SRC).toMatch(/e\.altKey && e\.key === ['"]ArrowDown['"][\s\S]*moveGroupByOffset\(group\.id,\s*1\)/);
    expect(RENDERER_SRC).toMatch(/function moveGroupByOffset\(groupId,\s*offset\)[\s\S]*handleGroupReorder\(groupId,\s*target\.id,\s*offset < 0\)/);
    expect(RENDERER_SRC).toMatch(/function moveGroupByOffset\(groupId,\s*offset\)[\s\S]*\.session-group-header\[data-group-id="\$\{groupId\}"\][\s\S]*\.focus\(\)/);
    expect(RENDERER_SRC).toMatch(/label:\s*['"]Move group up['"][\s\S]*moveGroupByOffset\(groupId,\s*-1\)/);
    expect(RENDERER_SRC).toMatch(/label:\s*['"]Move group down['"][\s\S]*moveGroupByOffset\(groupId,\s*1\)/);
    expect(RENDERER_SRC).toMatch(/menu\.setAttribute\(['"]role['"],\s*['"]menu['"]\)/);
    expect(RENDERER_SRC).toMatch(/wireMenuItem[\s\S]*el\.setAttribute\(['"]role['"],\s*['"]menuitem['"]\)/);
    expect(RENDERER_SRC).toMatch(/function showGroupContextMenu\(e,\s*groupId\)[\s\S]*return showContextMenu\(e\.clientX,\s*e\.clientY,\s*items\)/);
    expect(RENDERER_SRC).toMatch(/menu\?\.querySelector\('\[role="menuitem"\], \[role="menuitemradio"\]'\)\?\.focus\(\)/);
    expect(STYLES_SRC).toMatch(/\.session-group-header:focus-visible/);
  });
});

describe('startup update install — regression guardrails', () => {
  it('keeps the update status listener alive across the startup install gate', () => {
    const initStart = RENDERER_SRC.indexOf('async function init()');
    expect(initStart).toBeGreaterThanOrEqual(0);

    const cleanupIdx = RENDERER_SRC.indexOf('while (ipcCleanups.length) ipcCleanups.pop()();', initStart);
    const updateListenerIdx = RENDERER_SRC.indexOf('window.api.onUpdateStatus(handleUpdateStatus)', initStart);
    const installGateIdx = RENDERER_SRC.indexOf('installPendingUpdateOnStartup()', initStart);

    expect(cleanupIdx, 'existing IPC listeners must be cleared before registering update status').toBeGreaterThan(initStart);
    expect(updateListenerIdx, 'update status listener must be registered during startup').toBeGreaterThan(cleanupIdx);
    expect(installGateIdx, 'startup install gate must run after update status listener registration').toBeGreaterThan(updateListenerIdx);
  });

  it('marks the decorative update badge as hidden from assistive technology', () => {
    expect(RENDERER_SRC).toMatch(/badge\.setAttribute\(\s*['"]aria-hidden['"],\s*['"]true['"]\s*\)/);
  });

  it('clears the startup install flag when install status reports an error', () => {
    const recoveryIdx = RENDERER_SRC.indexOf('function recoverFromStartupInstallError');
    expect(recoveryIdx).toBeGreaterThanOrEqual(0);

    const block = RENDERER_SRC.slice(recoveryIdx, RENDERER_SRC.indexOf('async function init()', recoveryIdx));
    expect(block).toMatch(/startupInstallInProgress\s*=\s*false/);
  });

  it('recovers startup install errors by opening the current version instead of failing startup', () => {
    const errorCaseIdx = RENDERER_SRC.indexOf("case 'error':");
    expect(errorCaseIdx).toBeGreaterThanOrEqual(0);

    const block = RENDERER_SRC.slice(errorCaseIdx, RENDERER_SRC.indexOf("case 'idle':", errorCaseIdx));
    expect(block).toMatch(/recoverFromStartupInstallError\(data\.error\)/);
    expect(block).not.toMatch(/startupLoading\.fail/);
  });

  it('offers an explicit restart action for downloaded updates', () => {
    expect(INDEX_SRC).toMatch(/id="btn-update-install"/);
    expect(STYLES_SRC).toMatch(/\.btn-update\.hidden\s*\{\s*display:\s*none;\s*\}/);
    expect(RENDERER_SRC).toMatch(/function installDownloadedUpdateNow\(\)/);
    expect(RENDERER_SRC).toMatch(/btnUpdateInstall\?\.addEventListener\(['"]click['"]/);
    expect(RENDERER_SRC).toMatch(/Restart now to install/);
    expect(RENDERER_SRC).not.toMatch(/next quit|next time you close DeepSky/i);
  });

  it('recovers visibly if the updater install command does not exit the app', () => {
    expect(UPDATE_SERVICE_SRC).toMatch(/INSTALL_EXIT_WATCHDOG_MS/);
    expect(UPDATE_SERVICE_SRC).toMatch(/DeepSky started the update installer, but the app did not exit/);
    expect(UPDATE_SERVICE_SRC).toMatch(/clearPending:\s*false/);
    expect(UPDATE_SERVICE_SRC).toMatch(/retryable:\s*true/);
    expect(RENDERER_SRC).toMatch(/data\.retryable && data\.info\?\.version && btnUpdateInstall/);
    expect(RENDERER_SRC).toMatch(/Try restart again/);
  });

  it('keeps startup progress usable with reduced motion and forced-colors modes', () => {
    expect(STYLES_SRC).toMatch(/@media\s*\(\s*prefers-reduced-motion:\s*reduce\s*\)/);
    expect(STYLES_SRC).toMatch(/@media\s*\(\s*forced-colors:\s*active\s*\)/);
    expect(STYLES_SRC).toMatch(/startup-loading-progress\.indeterminate\s+\.startup-loading-progress-bar[\s\S]*animation:\s*none/);
    expect(STYLES_SRC).toMatch(/startup-loading-progress-bar[\s\S]*background:\s*Highlight/);
  });
});

// ───────────────────────────────────────────────────────────────────────────
// Keyboard shortcuts — non-Latin layout regression guard
// ───────────────────────────────────────────────────────────────────────────

describe('keyboard shortcuts — non-Latin layout regression guardrails', () => {
  it('renderer.js imports getShortcutKey from keyboard-shortcuts', () => {
    expect(RENDERER_SRC).toMatch(/getShortcutKey\b[\s\S]*require\(['"]\.\/keyboard-shortcuts['"]\)/);
  });

  it('renderer.js routes document shortcut decisions through getGlobalShortcutAction', () => {
    expect(RENDERER_SRC).toMatch(/getGlobalShortcutAction\b[\s\S]*require\(['"]\.\/keyboard-shortcuts['"]\)/);
    expect(RENDERER_SRC).toMatch(/const shortcutAction = getGlobalShortcutAction\(/);
  });

  it('renderer.js does not compare e.key to a single Latin letter (layout-dependent)', () => {
    // Single-letter `e.key === 'x'` checks fail on non-Latin layouts (e.g.
    // Hebrew Ctrl+V produces e.key === 'ה'). Use getShortcutKey(e) instead.
    // Named keys ('Enter', 'Escape', 'Tab', ...) and digits/symbols are fine.
    const offenders = RENDERER_SRC.match(/e\.key\s*===\s*['"][a-zA-Z]['"]/g);
    expect(
      offenders,
      `Found layout-dependent letter comparisons: ${offenders?.join(', ')}`
    ).toBeNull();
  });

  it('keyboard-shortcuts.js only compares lowerKey (not raw key/e.key) to letters', () => {
    // In src/keyboard-shortcuts.js, `lowerKey` is the result of getShortcutKey(e)
    // and is layout-independent. Direct letter comparisons must use it.
    // Allowed:   lowerKey === 'v'
    // Forbidden: key === 'v'   /   e.key === 'v'
    const offenders = SHORTCUTS_SRC.match(/(?<!lower)(?:^|\s)key\s*===\s*['"][a-zA-Z]['"]|e\.key\s*===\s*['"][a-zA-Z]['"]/g);
    expect(
      offenders,
      `Found layout-dependent letter comparisons in keyboard-shortcuts.js: ${offenders?.join(', ')}`
    ).toBeNull();
  });

  it('terminal paste events write clipboard text instead of only suppressing native paste', () => {
    expect(RENDERER_SRC).toMatch(/addEventListener\(['"]paste['"][\s\S]*?e\.preventDefault\(\)/);
    expect(RENDERER_SRC).toMatch(/sanitizePasteText\(e\.clipboardData\?\.getData\(['"]text\/plain['"]\)\)/);
    expect(RENDERER_SRC).toMatch(/terminal\.paste\(pasted\)/);
    expect(RENDERER_SRC).toMatch(/window\.api\.pasteText\(\)\.then\(text =>[\s\S]*?sanitizePasteText\(text\)[\s\S]*?terminal\.paste\(sanitizedText\)/);
  });

  it('getShortcutKey is exported from keyboard-shortcuts.js', () => {
    expect(SHORTCUTS_SRC).toMatch(/module\.exports\s*=\s*\{[^}]*\bgetShortcutKey\b[^}]*\}/);
  });
});
