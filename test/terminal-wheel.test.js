import { describe, it, expect, vi } from 'vitest';

const {
  getTerminalMouseCoords,
  getTerminalWheelDeltaLines,
  getTerminalWheelDeltaPixels,
  getTerminalWheelPagingSequence,
  getWheelMouseReport,
  isPointInsideElement,
  scrollTerminalViewport,
  updateTerminalMouseTracking,
} = require('../src/terminal-wheel');

function element(rect, extra = {}) {
  return {
    getBoundingClientRect: () => rect,
    querySelector: vi.fn((selector) => extra[selector] || null),
    ...extra,
  };
}

function terminal({ cols = 120, rows = 40, cellWidth = 10, cellHeight = 20, screenRect, viewport } = {}) {
  const screen = element(screenRect || { left: 100, top: 50, right: 1300, bottom: 850 });
  const root = element({ left: 0, top: 0, right: 1200, bottom: 800 }, {
    '.xterm-screen': screen,
    '.xterm-viewport': viewport || { clientHeight: 800, scrollTop: 0 },
  });
  return {
    cols,
    rows,
    element: root,
    _core: {
      _renderService: {
        dimensions: {
          css: {
            cell: { width: cellWidth, height: cellHeight },
          },
        },
      },
    },
    buffer: { active: { viewportY: 0 } },
    scrollLines: vi.fn(),
  };
}

function wheel(overrides = {}) {
  return {
    clientX: 135,
    clientY: 95,
    deltaMode: 0,
    deltaY: 120,
    shiftKey: false,
    altKey: false,
    ctrlKey: false,
    ...overrides,
  };
}

describe('terminal wheel helpers', () => {
  it('tracks swallowed terminal mouse mode and SGR encoding state', () => {
    const entry = {};

    updateTerminalMouseTracking(entry, '\x1b[?1002;1006h');
    expect(entry.mouseTrackingEnabled).toBe(true);
    expect(entry.sgrMouseEnabled).toBe(true);

    updateTerminalMouseTracking(entry, '\x1b[?1002l');
    expect(entry.mouseTrackingEnabled).toBe(false);
    expect(entry.sgrMouseEnabled).toBe(true);
  });

  it('does not generate wheel mouse reports unless tracked mouse mode is active', () => {
    expect(getWheelMouseReport(wheel(), { terminal: terminal() })).toBe('');
    expect(getWheelMouseReport(wheel(), { mouseTrackingEnabled: true })).toBe('');
  });

  it('encodes SGR wheel up/down reports with terminal coordinates and modifiers', () => {
    const term = terminal();
    const entry = { terminal: term, mouseTrackingEnabled: true, sgrMouseEnabled: true };

    expect(getWheelMouseReport(wheel({ deltaY: -1 }), entry)).toBe('\x1b[<64;4;3M');
    expect(getWheelMouseReport(wheel({ deltaY: 1, shiftKey: true, altKey: true, ctrlKey: true }), entry)).toBe('\x1b[<93;4;3M');
  });

  it('encodes legacy X10 wheel reports when SGR is not active', () => {
    const term = terminal();
    const entry = { terminal: term, mouseTrackingEnabled: true, sgrMouseEnabled: false };

    expect(getWheelMouseReport(wheel({ deltaY: -1 }), entry)).toBe(`\x1b[M${String.fromCharCode(96, 36, 35)}`);
    expect(getWheelMouseReport(wheel({ deltaY: 1 }), entry)).toBe(`\x1b[M${String.fromCharCode(97, 36, 35)}`);
  });

  it('drops legacy X10 reports when coordinates exceed single-byte encoding range', () => {
    const term = terminal({ cols: 300, rows: 40, screenRect: { left: 0, top: 0, right: 3000, bottom: 800 } });
    const entry = { terminal: term, mouseTrackingEnabled: true, sgrMouseEnabled: false };

    expect(getWheelMouseReport(wheel({ clientX: 2999, clientY: 20, deltaY: 1 }), entry)).toBe('');
  });

  it('calculates and clamps terminal mouse coordinates from cell dimensions', () => {
    const term = terminal({ cols: 10, rows: 5, screenRect: { left: 100, top: 50, right: 200, bottom: 150 } });

    expect(getTerminalMouseCoords(wheel({ clientX: 100, clientY: 50 }), term)).toEqual({ col: 1, row: 1 });
    expect(getTerminalMouseCoords(wheel({ clientX: 1000, clientY: 1000 }), term)).toEqual({ col: 10, row: 5 });
  });

  it('converts wheel deltas to lines and fallback PageUp/PageDown sequences', () => {
    const term = terminal({ rows: 33 });

    expect(getTerminalWheelDeltaLines(wheel({ deltaMode: 0, deltaY: 120 }), term)).toBe(3);
    expect(getTerminalWheelDeltaLines(wheel({ deltaMode: 1, deltaY: -4 }), term)).toBe(-4);
    expect(getTerminalWheelDeltaLines(wheel({ deltaMode: 2, deltaY: 1 }), term)).toBe(33);
    expect(getTerminalWheelPagingSequence(-1)).toBe('\x1b[5~');
    expect(getTerminalWheelPagingSequence(1)).toBe('\x1b[6~');
    expect(getTerminalWheelPagingSequence(0)).toBe('');
  });

  it('converts wheel deltas to pixels for viewport fallback', () => {
    const viewport = { clientHeight: 900, scrollTop: 0 };
    const term = terminal({ cellHeight: 18, viewport });

    expect(getTerminalWheelDeltaPixels(wheel({ deltaMode: 0, deltaY: 120 }), term)).toBe(120);
    expect(getTerminalWheelDeltaPixels(wheel({ deltaMode: 1, deltaY: 3 }), term)).toBe(54);
    expect(getTerminalWheelDeltaPixels(wheel({ deltaMode: 2, deltaY: 1 }), term)).toBe(900);
  });

  it('falls back to viewport scrollTop when xterm scrollLines does not move', () => {
    const viewport = { clientHeight: 800, scrollTop: 10 };
    const term = terminal({ viewport });
    const entry = { terminal: term };

    scrollTerminalViewport(entry, 3, 120);

    expect(term.scrollLines).toHaveBeenCalledWith(3);
    expect(viewport.scrollTop).toBe(130);
  });

  it('does not double-scroll the DOM viewport when xterm moved the buffer', () => {
    const viewport = { clientHeight: 800, scrollTop: 10 };
    const term = terminal({ viewport });
    term.scrollLines.mockImplementation(() => {
      term.buffer.active.viewportY = 3;
    });
    const entry = { terminal: term };

    scrollTerminalViewport(entry, 3, 120);

    expect(viewport.scrollTop).toBe(10);
  });

  it('detects whether a wheel point is visually inside an element', () => {
    const target = element({ left: 10, top: 20, right: 110, bottom: 220 });

    expect(isPointInsideElement(wheel({ clientX: 10, clientY: 20 }), target)).toBe(true);
    expect(isPointInsideElement(wheel({ clientX: 111, clientY: 20 }), target)).toBe(false);
    expect(isPointInsideElement(wheel({ clientX: 10, clientY: 221 }), target)).toBe(false);
  });
});
