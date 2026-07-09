import { describe, it, expect, vi, beforeEach } from 'vitest';
const { createTerminalKeyHandler, getGlobalShortcutAction, getShortcutKey, sanitizePasteText, stripTerminalScrollbar, stripMouseTrackingSequences, isCopyShortcut } = require('../src/keyboard-shortcuts');

/** Build a minimal synthetic keydown event. */
function key(overrides = {}) {
  return {
    type: 'keydown',
    key: '',
    code: '',
    ctrlKey: false,
    metaKey: false,
    shiftKey: false,
    preventDefault: vi.fn(),
    ...overrides,
  };
}

class MockCell {
  constructor(chars) {
    this._chars = chars;
  }

  getChars() {
    return this._chars;
  }

  getWidth() {
    return 1;
  }

  getCode() {
    return this._chars ? this._chars.codePointAt(0) : 0;
  }
}

class MockLine {
  constructor(text, isWrapped = false) {
    this._text = text;
    this.isWrapped = isWrapped;
    this.length = text.length;
  }

  getCell(index) {
    return new MockCell(this._text[index] || ' ');
  }

  translateToString(trimRight) {
    return trimRight ? this._text.replace(/\s+$/, '') : this._text;
  }
}

class MockBuffer {
  constructor(lines, cursorX = 0, cursorY = 0) {
    this._lines = lines.map(line => {
      if (typeof line === 'string') return new MockLine(line);
      return new MockLine(line.text || '', !!line.isWrapped);
    });
    this.length = this._lines.length;
    this.baseY = 0;
    this.cursorY = cursorY;
    this.cursorX = cursorX;
  }

  getLine(index) {
    return this._lines[index];
  }
}

describe('createTerminalKeyHandler', () => {
  const SESSION_ID = 'test-session-1';
  let terminal, api, handler;

  beforeEach(() => {
    terminal = {
      hasSelection: vi.fn().mockReturnValue(false),
      getSelection: vi.fn().mockReturnValue('selected text'),
      clearSelection: vi.fn(),
      select: vi.fn(),
      cols: 120,
      buffer: { active: new MockBuffer(['alpha beta gamma'], 0) }
    };
    api = {
      copyText: vi.fn(),
      writePty: vi.fn(),
      pasteText: vi.fn().mockResolvedValue('pasted'),
    };
    handler = createTerminalKeyHandler(SESSION_ID, terminal, api);
  });

  // ── Passthrough ──────────────────────────────────────────────────────────

  it('passes through non-keydown events unchanged', () => {
    expect(handler({ type: 'keyup', key: 'a', ctrlKey: false, metaKey: false, shiftKey: false })).toBe(true);
    expect(handler({ type: 'keypress', key: 'Enter', ctrlKey: false, metaKey: false, shiftKey: false })).toBe(true);
  });

  it('passes through regular printable keys', () => {
    expect(handler(key({ key: 'a' }))).toBe(true);
    expect(handler(key({ key: 'Z' }))).toBe(true);
    expect(handler(key({ key: ' ' }))).toBe(true);
  });

  it('passes through plain Enter', () => {
    expect(handler(key({ key: 'Enter' }))).toBe(true);
  });

  it('passes through plain Backspace', () => {
    expect(handler(key({ key: 'Backspace' }))).toBe(true);
  });

  // ── Bubble-to-document shortcuts ─────────────────────────────────────────

  it('bubbles Ctrl+= (zoom in)', () => {
    expect(handler(key({ ctrlKey: true, key: '=' }))).toBe(false);
  });

  it('bubbles Ctrl++ (zoom in)', () => {
    expect(handler(key({ ctrlKey: true, key: '+' }))).toBe(false);
  });

  it('bubbles Ctrl+- (zoom out)', () => {
    expect(handler(key({ ctrlKey: true, key: '-' }))).toBe(false);
  });

  it('bubbles Ctrl+0 (zoom reset)', () => {
    expect(handler(key({ ctrlKey: true, key: '0' }))).toBe(false);
  });

  it('bubbles Ctrl+N (new session)', () => {
    expect(handler(key({ ctrlKey: true, key: 'n' }))).toBe(false);
  });

  it('bubbles Ctrl+T (new session)', () => {
    expect(handler(key({ ctrlKey: true, key: 't' }))).toBe(false);
  });

  it('bubbles Ctrl+Tab (next tab)', () => {
    expect(handler(key({ ctrlKey: true, key: 'Tab' }))).toBe(false);
  });

  it('bubbles Ctrl+Shift+Tab (previous tab)', () => {
    expect(handler(key({ ctrlKey: true, shiftKey: true, key: 'Tab' }))).toBe(false);
  });

  it('bubbles Ctrl+W (close tab)', () => {
    expect(handler(key({ ctrlKey: true, key: 'w' }))).toBe(false);
  });

  it('bubbles Ctrl+I (status panel toggle)', () => {
    expect(handler(key({ ctrlKey: true, key: 'i' }))).toBe(false);
  });

  it('bubbles Ctrl+F (session search)', () => {
    expect(handler(key({ ctrlKey: true, key: 'f' }))).toBe(false);
  });

  // ── Ctrl+C copy ───────────────────────────────────────────────────────────

  it('Ctrl+C with selection: copies text and clears selection', () => {
    terminal.hasSelection.mockReturnValue(true);
    const e = key({ ctrlKey: true, key: 'c' });
    const result = handler(e);

    expect(result).toBe(false);
    expect(api.copyText).toHaveBeenCalledWith('selected text');
    expect(terminal.clearSelection).toHaveBeenCalled();
    expect(e.preventDefault).toHaveBeenCalled();
  });

  it('Ctrl+C without selection: passes through as SIGINT', () => {
    terminal.hasSelection.mockReturnValue(false);
    const result = handler(key({ ctrlKey: true, key: 'c' }));

    expect(result).toBe(true);
    expect(api.copyText).not.toHaveBeenCalled();
    expect(terminal.clearSelection).not.toHaveBeenCalled();
  });

  it('Ctrl+C with a whitespace-only selection falls through as SIGINT', () => {
    terminal.hasSelection.mockReturnValue(true);
    terminal.getSelection.mockReturnValue('   \n ');
    const result = handler(key({ ctrlKey: true, key: 'c' }));
    expect(result).toBe(true);
    expect(api.copyText).not.toHaveBeenCalled();
    expect(terminal.clearSelection).not.toHaveBeenCalled();
  });

  // ── Ctrl+Backspace word delete ────────────────────────────────────────────

  it('Ctrl+Backspace: sends word-backward-delete (\\x17) to PTY', () => {
    const e = key({ ctrlKey: true, key: 'Backspace' });
    const result = handler(e);

    expect(result).toBe(false);
    expect(api.writePty).toHaveBeenCalledWith(SESSION_ID, '\x17');
    expect(e.preventDefault).toHaveBeenCalled();
  });

  it('Meta+Backspace (macOS): also sends word-backward-delete (\\x17)', () => {
    const e = key({ metaKey: true, key: 'Backspace' });
    const result = handler(e);

    expect(result).toBe(false);
    expect(api.writePty).toHaveBeenCalledWith(SESSION_ID, '\x17');
  });

  // ── Shift+Enter line continuation ────────────────────────────────────────

  it('Shift+Enter: sends backslash then Enter to PTY', () => {
    vi.useFakeTimers();
    try {
      const e = key({ shiftKey: true, key: 'Enter' });
      const result = handler(e);

      expect(result).toBe(false);
      expect(api.writePty).toHaveBeenNthCalledWith(1, SESSION_ID, '\\');
      expect(e.preventDefault).toHaveBeenCalled();

      vi.advanceTimersByTime(30);
      expect(api.writePty).toHaveBeenNthCalledWith(2, SESSION_ID, '\r');
    } finally {
      vi.useRealTimers();
    }
  });

  it('Shift+Enter: does not trigger paste logic', () => {
    const e = key({ shiftKey: true, key: 'Enter' });
    handler(e);
    expect(api.pasteText).not.toHaveBeenCalled();
  });

  // ── Paste shortcuts ───────────────────────────────────────────────────────

  it('Ctrl+V: calls pasteText and returns false', () => {
    const e = key({ ctrlKey: true, key: 'v' });
    const result = handler(e);

    expect(result).toBe(false);
    expect(api.pasteText).toHaveBeenCalled();
    expect(e.preventDefault).toHaveBeenCalled();
  });

  it('Ctrl+V: writes pasted text to PTY when content is available', async () => {
    api.pasteText.mockResolvedValue('clipboard content');
    handler(key({ ctrlKey: true, key: 'v' }));

    await vi.waitFor(() => {
      expect(api.writePty).toHaveBeenCalledWith(SESSION_ID, 'clipboard content');
    });
  });

  it('Ctrl+V: uses xterm paste transformations when available', async () => {
    terminal.paste = vi.fn();
    api.pasteText.mockResolvedValue('clipboard content');
    handler = createTerminalKeyHandler(SESSION_ID, terminal, api);

    handler(key({ ctrlKey: true, key: 'v' }));

    await vi.waitFor(() => {
      expect(terminal.paste).toHaveBeenCalledWith('clipboard content');
    });
    expect(api.writePty).not.toHaveBeenCalled();
  });

  it('Ctrl+V: strips embedded bracketed-paste markers before xterm paste', async () => {
    terminal.paste = vi.fn();
    api.pasteText.mockResolvedValue('safe\x1b[201~\nunsafe');
    handler = createTerminalKeyHandler(SESSION_ID, terminal, api);

    handler(key({ ctrlKey: true, key: 'v' }));

    await vi.waitFor(() => {
      expect(terminal.paste).toHaveBeenCalledWith('safe\nunsafe');
    });
  });

  it('Ctrl+V: does not write to PTY when clipboard is empty', async () => {
    api.pasteText.mockResolvedValue('');
    handler(key({ ctrlKey: true, key: 'v' }));

    await vi.waitFor(() => {
      expect(api.writePty).not.toHaveBeenCalled();
    });
  });

  it('Shift+Insert: triggers paste (same as Ctrl+V)', () => {
    const e = key({ shiftKey: true, key: 'Insert' });
    const result = handler(e);

    expect(result).toBe(false);
    expect(api.pasteText).toHaveBeenCalled();
  });

  describe('sanitizePasteText', () => {
    it('removes bracketed-paste delimiters from clipboard text', () => {
      expect(sanitizePasteText('\x1b[200~hello\x1b[201~')).toBe('hello');
    });
  });

  describe('stripTerminalScrollbar', () => {
    it('removes a trailing scrollbar glyph and its padding from each line', () => {
      expect(stripTerminalScrollbar('hello        \u2503')).toBe('hello');
      expect(stripTerminalScrollbar('line one   \u2503\nline two \u2503')).toBe('line one\nline two');
    });

    it('collapses a scrollbar-only line to empty', () => {
      expect(stripTerminalScrollbar('   \u2503')).toBe('');
    });

    it('leaves mid-line and left-gutter heavy verticals untouched', () => {
      expect(stripTerminalScrollbar('a \u2503 b')).toBe('a \u2503 b');
      expect(stripTerminalScrollbar('\u2503 gutter kept')).toBe('\u2503 gutter kept');
    });

    it('leaves ordinary text and ascii pipes untouched', () => {
      expect(stripTerminalScrollbar('no bar here')).toBe('no bar here');
      expect(stripTerminalScrollbar('a | b')).toBe('a | b');
    });

    it('is a no-op for empty or non-string input', () => {
      expect(stripTerminalScrollbar('')).toBe('');
      expect(stripTerminalScrollbar(null)).toBe(null);
    });
  });

  // ── Meta (macOS Cmd) equivalents ──────────────────────────────────────────

  it('Meta+= bubbles for zoom (macOS)', () => {
    expect(handler(key({ metaKey: true, key: '=' }))).toBe(false);
  });

  it('Meta+N bubbles for new session (macOS)', () => {
    expect(handler(key({ metaKey: true, key: 'n' }))).toBe(false);
  });

  it('Meta+V triggers paste (macOS)', () => {
    const result = handler(key({ metaKey: true, key: 'v' }));
    expect(result).toBe(false);
    expect(api.pasteText).toHaveBeenCalled();
  });

  it('Meta+F bubbles for session search (macOS)', () => {
    expect(handler(key({ metaKey: true, key: 'f' }))).toBe(false);
  });

  // ── Session ID isolation ──────────────────────────────────────────────────

  it('uses the correct sessionId when writing to PTY', () => {
    const specificHandler = createTerminalKeyHandler('my-unique-session', terminal, api);
    specificHandler(key({ ctrlKey: true, key: 'Backspace' }));
    expect(api.writePty).toHaveBeenCalledWith('my-unique-session', '\x17');
  });

  // ── Non-Latin keyboard layouts (e.g. Hebrew) ─────────────────────────────
  // On a Hebrew layout, pressing the V key produces e.key === 'ה' but
  // e.code === 'KeyV'. Shortcuts must work regardless of layout.

  it('Ctrl+V on Hebrew layout: triggers paste via physical key code', () => {
    const e = key({ ctrlKey: true, key: 'ה', code: 'KeyV' });
    const result = handler(e);

    expect(result).toBe(false);
    expect(api.pasteText).toHaveBeenCalled();
    expect(e.preventDefault).toHaveBeenCalled();
  });

  it('Ctrl+C on Hebrew layout with selection: copies via physical key code', () => {
    terminal.hasSelection.mockReturnValue(true);
    const e = key({ ctrlKey: true, key: 'ב', code: 'KeyC' });
    const result = handler(e);

    expect(result).toBe(false);
    expect(api.copyText).toHaveBeenCalledWith('selected text');
    expect(terminal.clearSelection).toHaveBeenCalled();
  });

  it('Ctrl+T on Hebrew layout: bubbles to document handler', () => {
    expect(handler(key({ ctrlKey: true, key: 'א', code: 'KeyT' }))).toBe(false);
  });

  it('Ctrl+N on Hebrew layout: bubbles to document handler', () => {
    expect(handler(key({ ctrlKey: true, key: 'מ', code: 'KeyN' }))).toBe(false);
  });

  it('Ctrl+W on Hebrew layout: bubbles to document handler', () => {
    expect(handler(key({ ctrlKey: true, key: '׳', code: 'KeyW' }))).toBe(false);
  });

  it('Ctrl+I on Hebrew layout: bubbles to document handler', () => {
    expect(handler(key({ ctrlKey: true, key: 'ן', code: 'KeyI' }))).toBe(false);
  });

  it('Ctrl+F on Hebrew layout: bubbles to document handler', () => {
    expect(handler(key({ ctrlKey: true, key: 'כ', code: 'KeyF' }))).toBe(false);
  });

  it('Meta+V on Hebrew layout (macOS): triggers paste', () => {
    const e = key({ metaKey: true, key: 'ה', code: 'KeyV' });
    const result = handler(e);

    expect(result).toBe(false);
    expect(api.pasteText).toHaveBeenCalled();
  });
});

describe('stripMouseTrackingSequences', () => {
  it('removes standalone mouse-reporting mode sets (1000/1002/1003)', () => {
    expect(stripMouseTrackingSequences('\x1b[?1000h')).toBe('');
    expect(stripMouseTrackingSequences('\x1b[?1002h')).toBe('');
    expect(stripMouseTrackingSequences('\x1b[?1003h')).toBe('');
    expect(stripMouseTrackingSequences('\x1b[?1002l')).toBe('');
  });

  it('preserves surrounding output while dropping the mouse sequence', () => {
    expect(stripMouseTrackingSequences('before\x1b[?1002hafter')).toBe('beforeafter');
  });

  it('strips only mouse-reporting members from a combined parameter list', () => {
    expect(stripMouseTrackingSequences('\x1b[?1002;1006h')).toBe('\x1b[?1006h');
    expect(stripMouseTrackingSequences('\x1b[?1006;1002;1015h')).toBe('\x1b[?1006;1015h');
  });

  it('leaves unrelated private modes untouched (alt-screen, bracketed paste, cursor keys)', () => {
    expect(stripMouseTrackingSequences('\x1b[?1049h')).toBe('\x1b[?1049h');
    expect(stripMouseTrackingSequences('\x1b[?2004h')).toBe('\x1b[?2004h');
    expect(stripMouseTrackingSequences('\x1b[?1h')).toBe('\x1b[?1h');
    expect(stripMouseTrackingSequences('\x1b[?25l')).toBe('\x1b[?25l');
  });

  it('leaves SGR encoding mode (1006) alone when standalone', () => {
    expect(stripMouseTrackingSequences('\x1b[?1006h')).toBe('\x1b[?1006h');
  });

  it('is a no-op for chunks without private-mode sequences', () => {
    expect(stripMouseTrackingSequences('plain text\r\n')).toBe('plain text\r\n');
    expect(stripMouseTrackingSequences('')).toBe('');
  });

  it('handles non-string input defensively', () => {
    expect(stripMouseTrackingSequences(null)).toBe(null);
    expect(stripMouseTrackingSequences(undefined)).toBe(undefined);
  });

  it('does not strip a substring like 10002 (exact-token match only)', () => {
    expect(stripMouseTrackingSequences('\x1b[?10002h')).toBe('\x1b[?10002h');
  });
});

describe('isCopyShortcut', () => {
  it('matches Ctrl+C', () => {
    expect(isCopyShortcut(key({ ctrlKey: true, key: 'c' }))).toBe(true);
  });
  it('matches Cmd+C (macOS)', () => {
    expect(isCopyShortcut(key({ metaKey: true, key: 'c' }))).toBe(true);
  });
  it('matches Ctrl+C on a Hebrew layout via physical code', () => {
    expect(isCopyShortcut(key({ ctrlKey: true, key: 'ב', code: 'KeyC' }))).toBe(true);
  });
  it('matches Ctrl+Insert', () => {
    expect(isCopyShortcut(key({ ctrlKey: true, key: 'Insert' }))).toBe(true);
  });
  it('does not match a plain C', () => {
    expect(isCopyShortcut(key({ key: 'c' }))).toBe(false);
  });
  it('does not match Ctrl+V', () => {
    expect(isCopyShortcut(key({ ctrlKey: true, key: 'v' }))).toBe(false);
  });
  it('does not match a bare Insert', () => {
    expect(isCopyShortcut(key({ key: 'Insert' }))).toBe(false);
  });
});

describe('getShortcutKey', () => {
  it('returns the Latin letter from physical KeyX code regardless of e.key', () => {
    expect(getShortcutKey({ code: 'KeyV', key: 'ה' })).toBe('v');
    expect(getShortcutKey({ code: 'KeyT', key: 'א' })).toBe('t');
    expect(getShortcutKey({ code: 'KeyA', key: 'ש' })).toBe('a');
  });

  it('returns lowercased letter when only e.key is available', () => {
    expect(getShortcutKey({ key: 'V' })).toBe('v');
    expect(getShortcutKey({ key: 'a' })).toBe('a');
  });

  it('returns named keys verbatim', () => {
    expect(getShortcutKey({ key: 'Enter' })).toBe('Enter');
    expect(getShortcutKey({ key: 'Backspace' })).toBe('Backspace');
    expect(getShortcutKey({ key: 'Escape' })).toBe('Escape');
    expect(getShortcutKey({ key: 'Tab' })).toBe('Tab');
  });

  it('returns punctuation/digits unchanged (lowercased)', () => {
    expect(getShortcutKey({ key: '=' })).toBe('=');
    expect(getShortcutKey({ key: '0' })).toBe('0');
  });

  it('handles missing e.key gracefully', () => {
    expect(getShortcutKey({})).toBe('');
  });

  it('does not treat non-letter codes (e.g. Digit1, F1) as letters', () => {
    expect(getShortcutKey({ code: 'Digit1', key: '1' })).toBe('1');
    expect(getShortcutKey({ code: 'F1', key: 'F1' })).toBe('F1');
  });
});

describe('getGlobalShortcutAction', () => {
  const plainInput = { tagName: 'INPUT', classList: { contains: () => false } };
  const plainTextarea = { tagName: 'TEXTAREA', classList: { contains: () => false } };
  const xtermTextarea = { tagName: 'TEXTAREA', classList: { contains: (name) => name === 'xterm-helper-textarea' } };

  it('maps Ctrl+N and Ctrl+T to new-session', () => {
    expect(getGlobalShortcutAction(key({ ctrlKey: true, key: 'n', code: 'KeyN' }))).toEqual({ type: 'new-session' });
    expect(getGlobalShortcutAction(key({ ctrlKey: true, key: 't', code: 'KeyT' }))).toEqual({ type: 'new-session' });
  });

  it('maps zoom shortcuts', () => {
    expect(getGlobalShortcutAction(key({ ctrlKey: true, key: '=' }))).toEqual({ type: 'zoom', direction: 'in' });
    expect(getGlobalShortcutAction(key({ ctrlKey: true, key: '+' }))).toEqual({ type: 'zoom', direction: 'in' });
    expect(getGlobalShortcutAction(key({ ctrlKey: true, key: '-' }))).toEqual({ type: 'zoom', direction: 'out' });
    expect(getGlobalShortcutAction(key({ ctrlKey: true, key: '0' }))).toEqual({ type: 'zoom', direction: 'reset' });
  });

  it('maps Ctrl+Tab and Ctrl+Shift+Tab to tab switching', () => {
    expect(getGlobalShortcutAction(key({ ctrlKey: true, key: 'Tab' }))).toEqual({ type: 'switch-tab', direction: 1 });
    expect(getGlobalShortcutAction(key({ ctrlKey: true, shiftKey: true, key: 'Tab' }))).toEqual({ type: 'switch-tab', direction: -1 });
  });

  it('maps Ctrl+Shift+T to restore-tab', () => {
    expect(getGlobalShortcutAction(key({ ctrlKey: true, shiftKey: true, key: 't', code: 'KeyT' }))).toEqual({ type: 'restore-tab' });
  });

  it('maps Ctrl+I to toggle-status', () => {
    expect(getGlobalShortcutAction(key({ ctrlKey: true, key: 'i', code: 'KeyI' }))).toEqual({ type: 'toggle-status' });
  });

  it('maps Ctrl+F based on active-session presence', () => {
    expect(getGlobalShortcutAction(key({ ctrlKey: true, key: 'f', code: 'KeyF' }), { hasActiveSession: true }))
      .toEqual({ type: 'session-search' });
    expect(getGlobalShortcutAction(key({ ctrlKey: true, key: 'f', code: 'KeyF' }), { hasActiveSession: false }))
      .toEqual({ type: 'sidebar-search' });
  });

  it('ignores Ctrl+W when typing in a plain input or textarea', () => {
    expect(getGlobalShortcutAction(key({ ctrlKey: true, key: 'w', code: 'KeyW' }), { activeElement: plainInput })).toBeNull();
    expect(getGlobalShortcutAction(key({ ctrlKey: true, key: 'w', code: 'KeyW' }), { activeElement: plainTextarea })).toBeNull();
  });

  it('still maps Ctrl+W when focus is in xterm helper textarea', () => {
    expect(getGlobalShortcutAction(key({ ctrlKey: true, key: 'w', code: 'KeyW' }), { activeElement: xtermTextarea }))
      .toEqual({ type: 'close-tab' });
  });

  it('supports Meta shortcuts on macOS', () => {
    expect(getGlobalShortcutAction(key({ metaKey: true, key: 't', code: 'KeyT' }))).toEqual({ type: 'new-session' });
    expect(getGlobalShortcutAction(key({ metaKey: true, shiftKey: true, key: 't', code: 'KeyT' }))).toEqual({ type: 'restore-tab' });
    expect(getGlobalShortcutAction(key({ metaKey: true, key: 'i', code: 'KeyI' }))).toEqual({ type: 'toggle-status' });
  });

  it('supports non-Latin layouts via physical key codes', () => {
    expect(getGlobalShortcutAction(key({ ctrlKey: true, shiftKey: true, key: 'א', code: 'KeyT' })))
      .toEqual({ type: 'restore-tab' });
    expect(getGlobalShortcutAction(key({ ctrlKey: true, key: 'מ', code: 'KeyN' })))
      .toEqual({ type: 'new-session' });
    expect(getGlobalShortcutAction(key({ ctrlKey: true, key: 'כ', code: 'KeyF' }), { hasActiveSession: false }))
      .toEqual({ type: 'sidebar-search' });
  });

  it('returns null for unrelated keys', () => {
    expect(getGlobalShortcutAction(key({ key: 'a' }))).toBeNull();
    expect(getGlobalShortcutAction(key({ ctrlKey: true, key: 'Enter' }))).toBeNull();
  });
});
