/**
 * Returns the logical shortcut key for a KeyboardEvent in a layout-independent way.
 *
 * Letter shortcuts (Ctrl+V, Ctrl+T, ...) must work regardless of the active
 * keyboard layout. On non-Latin layouts (e.g. Hebrew, Cyrillic) `e.key` returns
 * the localized character (Ctrl+V → 'ה'), so we resolve letter keys from the
 * physical `e.code` ('KeyV' → 'v') and fall back to `e.key` for everything else.
 *
 * @param {KeyboardEvent} e
 * @returns {string} lowercase Latin letter for letter keys, otherwise lowercased `e.key`.
 */
function getShortcutKey(e) {
  if (e.code && e.code.length === 4 && e.code.startsWith('Key')) {
    return e.code.charAt(3).toLowerCase();
  }
  const k = e.key || '';
  return k.length === 1 ? k.toLowerCase() : k;
}

function getGlobalShortcutAction(e, context = {}) {
  const mod = e.ctrlKey || e.metaKey;
  const key = e.key || '';
  const lowerKey = getShortcutKey(e);
  const activeElement = context.activeElement || null;
  const isXterm = !!activeElement?.classList?.contains('xterm-helper-textarea');
  const isPlainTextInput = !isXterm && (activeElement?.tagName === 'INPUT' || activeElement?.tagName === 'TEXTAREA');

  if (mod && !e.shiftKey && (lowerKey === 'n' || lowerKey === 't')) {
    return { type: 'new-session' };
  }
  if (mod && (key === '=' || key === '+')) {
    return { type: 'zoom', direction: 'in' };
  }
  if (mod && key === '-') {
    return { type: 'zoom', direction: 'out' };
  }
  if (mod && key === '0') {
    return { type: 'zoom', direction: 'reset' };
  }
  if (e.ctrlKey && key === 'Tab') {
    return { type: 'switch-tab', direction: e.shiftKey ? -1 : 1 };
  }
  if (mod && lowerKey === 'w') {
    return isPlainTextInput ? null : { type: 'close-tab' };
  }
  if (mod && e.shiftKey && lowerKey === 't') {
    return { type: 'restore-tab' };
  }
  if (mod && lowerKey === 'i') {
    return { type: 'toggle-status' };
  }
  if (mod && !e.shiftKey && lowerKey === 'f') {
    return { type: context.hasActiveSession ? 'session-search' : 'sidebar-search' };
  }

  return null;
}

function sanitizePasteText(text) {
  return String(text || '').replace(/\x1b\[(?:200|201)~/g, '');
}

/**
 * True when the event is a copy shortcut (Ctrl/Cmd+C or Ctrl/Cmd+Insert),
 * resolved in a keyboard-layout-independent way.
 *
 * @param {KeyboardEvent} e
 * @returns {boolean}
 */
function isCopyShortcut(e) {
  const mod = e.ctrlKey || e.metaKey;
  if (!mod) return false;
  return getShortcutKey(e) === 'c' || e.key === 'Insert';
}

/**
 * Strips the Copilot CLI's vertical scrollbar from copied terminal text.
 *
 * The embedded CLI paints a scrollbar as a column of U+2503 (BOX DRAWINGS
 * HEAVY VERTICAL, `┃`) glyphs in the rightmost column of the transcript. A
 * multiline / rectangular selection captures that glyph as a trailing
 * character on every line, so copied text ends up peppered with `┃`. We
 * remove a trailing scrollbar glyph — plus the padding whitespace before it —
 * from each line. Anchoring to the end of the line keeps this safe: a `┃`
 * appearing mid-line or in a left gutter is left untouched.
 *
 * @param {string} text - raw selection text from xterm / DOM selection.
 * @returns {string} the selection with the scrollbar column removed.
 */
function stripTerminalScrollbar(text) {
  if (typeof text !== 'string' || !text) return text;
  return text.replace(/[ \t]*\u2503[ \t]*$/gm, '');
}

/**
 * Strips terminal mouse-tracking enable/disable sequences from a PTY data
 * chunk before it reaches xterm.
 *
 * WHY: xterm hands a plain click+drag to the application (instead of creating a
 * text selection) whenever the app has mouse reporting active — see xterm's
 * mousedown gate `areMouseEventsActive && !shouldForceSelection(e)`. The
 * embedded Copilot CLI enables mouse reporting, so without this a plain drag
 * never selects (only Shift+drag does) and copy-on-select / Ctrl+C have nothing
 * to copy. By swallowing the mode-set sequences here, `areMouseEventsActive`
 * stays false, xterm keeps ownership of the mouse, and plain-drag selection +
 * copy work like a normal terminal. Wheel events are forwarded explicitly from
 * the renderer while the CLI has mouse tracking enabled so scrollable CLI panes
 * still work.
 *
 * Only the X10/VT200/button/any-event mouse REPORTING modes (1000–1003) are
 * removed, along with mouse encoding modes (1005/1006/1015/1016). Alt-screen
 * (1049), bracketed paste (2004), cursor keys, etc. are left untouched. Semicolon-combined
 * parameter lists (e.g. `\x1b[?1002;1006h`) are handled by removing only the
 * mouse-reporting members and preserving the rest.
 *
 * @param {string} data - raw chunk written from the PTY toward the terminal.
 * @returns {string} the chunk with mouse-reporting mode-set sequences removed.
 */
const MOUSE_REPORT_MODES = new Set(['1000', '1001', '1002', '1003', '1005', '1006', '1015', '1016']);

function stripMouseTrackingSequences(data) {
  if (typeof data !== 'string' || data.indexOf('\x1b[?') === -1) return data;
  // Matches a private-mode set/reset: ESC [ ? <params> (h|l)
  return data.replace(/\x1b\[\?([0-9;]+)([hl])/g, (match, params, suffix) => {
    const kept = params.split(';').filter(p => p !== '' && !MOUSE_REPORT_MODES.has(p));
    if (kept.length === params.split(';').filter(p => p !== '').length) return match; // nothing removed
    if (kept.length === 0) return '';
    return `\x1b[?${kept.join(';')}${suffix}`;
  });
}

/**
 * Creates the xterm custom key event handler for a terminal session.
 *
 * Returns false  → let the event bubble up to the document-level keydown handler.
 * Returns true   → let xterm consume the event normally (standard terminal input).
 *
 * @param {string} sessionId - Active session identifier.
 * @param {import('@xterm/xterm').Terminal} terminal - The xterm terminal instance.
 * @param {object} api - The preload API bridge (window.api).
 * @param {object} hooks - Optional renderer hooks for local prompt UX.
 */
function createTerminalKeyHandler(sessionId, terminal, api, hooks = {}) {
  return (e) => {
    if (e.type !== 'keydown') return true;
    const mod = e.ctrlKey || e.metaKey;
    const key = e.key || '';
    const lowerKey = getShortcutKey(e);

    // Bubble zoom shortcuts to the document handler
    if (mod && (key === '=' || key === '+' || key === '-' || key === '0')) return false;

    // Bubble Ctrl+T and Ctrl+N to document handler for new session
    if (mod && (lowerKey === 't' || lowerKey === 'n')) return false;

    // Bubble Ctrl+Tab / Ctrl+Shift+Tab for tab switching
    if (e.ctrlKey && key === 'Tab') return false;

    // Bubble Ctrl+W for closing tabs
    if (mod && lowerKey === 'w') return false;

    // Bubble Ctrl+I for status panel toggle
    if (mod && lowerKey === 'i') return false;

    // Bubble Ctrl+F for in-session search
    if (mod && !e.shiftKey && lowerKey === 'f') return false;

    // Ctrl+C with a selection → copy to clipboard instead of sending SIGINT.
    // With mouse-reporting stripped from the PTY stream (see
    // stripMouseTrackingSequences), a plain drag now creates a real xterm model
    // selection, so this single check covers both plain-drag and Shift+drag.
    // Browser-native selection never exists over the terminal (xterm sets
    // `user-select: none` and preventDefaults mousedown), so xterm's own
    // selection model is the sole source of truth here.
    if (mod && lowerKey === 'c' && terminal.hasSelection()) {
      const selection = terminal.getSelection();
      if (selection.trim()) {
        e.preventDefault();
        api.copyText(stripTerminalScrollbar(selection));
        terminal.clearSelection();
        return false;
      }
    }

    // Ctrl+Backspace → delete previous word (sends \x17, equivalent to Ctrl+W in Unix shells)
    if (key === 'Backspace' && mod) {
      e.preventDefault();
      hooks.onInput?.('\x17');
      api.writePty(sessionId, '\x17');
      return false;
    }

    // Shift+Enter → line continuation, matching manual "\" then Enter.
    if (key === 'Enter' && e.shiftKey && !mod) {
      e.preventDefault();
      hooks.onInput?.('\\');
      api.writePty(sessionId, '\\');
      setTimeout(() => {
        hooks.onInput?.('\r');
        api.writePty(sessionId, '\r');
      }, 30);
      return false;
    }

    // Ctrl+V / Shift+Insert → paste from clipboard
    const isPaste = (mod && lowerKey === 'v') || (e.shiftKey && key === 'Insert');
    if (isPaste) {
      e.preventDefault();
      api.pasteText().then(text => {
        if (text) {
          const sanitizedText = sanitizePasteText(text);
          if (!sanitizedText) return;
          if (typeof terminal.paste === 'function') {
            terminal.paste(sanitizedText);
          } else {
            hooks.onInput?.(sanitizedText);
            api.writePty(sessionId, sanitizedText);
          }
        }
      });
      return false;
    }

    return true;
  };
}

module.exports = { createTerminalKeyHandler, getGlobalShortcutAction, getShortcutKey, sanitizePasteText, stripTerminalScrollbar, stripMouseTrackingSequences, isCopyShortcut };
