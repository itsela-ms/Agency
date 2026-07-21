const DOM_DELTA_LINE = 1;
const DOM_DELTA_PAGE = 2;

const MOUSE_REPORT_MODES = new Set(['1000', '1001', '1002', '1003']);
const SGR_MOUSE_MODE = '1006';

function updateTerminalMouseTracking(entry, data) {
  if (!entry || typeof data !== 'string' || data.indexOf('\x1b[?') === -1) return;
  data.replace(/\x1b\[\?([0-9;]+)([hl])/g, (match, params, suffix) => {
    const modes = params.split(';').filter(Boolean);
    if (modes.some(mode => MOUSE_REPORT_MODES.has(mode))) {
      entry.mouseTrackingEnabled = suffix === 'h';
    }
    if (modes.includes(SGR_MOUSE_MODE)) {
      entry.sgrMouseEnabled = suffix === 'h';
    }
    return match;
  });
}

function getTerminalMouseCoords(event, terminal) {
  const screen = terminal?.element?.querySelector?.('.xterm-screen') || terminal?.element;
  const dimensions = terminal?._core?._renderService?.dimensions?.css?.cell;
  const cellWidth = dimensions?.width || 0;
  const cellHeight = dimensions?.height || 0;
  if (!screen || !cellWidth || !cellHeight) return null;

  const rect = screen.getBoundingClientRect();
  const col = Math.min(Math.max(Math.ceil((event.clientX - rect.left) / cellWidth), 1), terminal.cols);
  const row = Math.min(Math.max(Math.ceil((event.clientY - rect.top) / cellHeight), 1), terminal.rows);
  return { col, row };
}

function getWheelMouseReport(event, entry) {
  if (!entry?.mouseTrackingEnabled || !entry?.terminal) return '';
  const coords = getTerminalMouseCoords(event, entry.terminal);
  if (!coords) return '';

  let buttonCode = event.deltaY < 0 ? 64 : 65;
  if (event.shiftKey) buttonCode += 4;
  if (event.altKey) buttonCode += 8;
  if (event.ctrlKey) buttonCode += 16;

  if (entry.sgrMouseEnabled) {
    return `\x1b[<${buttonCode};${coords.col};${coords.row}M`;
  }

  const params = [buttonCode + 32, coords.col + 32, coords.row + 32];
  if (params.some(value => value > 255)) return '';
  return `\x1b[M${String.fromCharCode(...params)}`;
}

function getTerminalWheelDeltaLines(event, terminal) {
  const rows = Math.max(1, terminal?.rows || 1);
  if (event.deltaMode === DOM_DELTA_PAGE) {
    return event.deltaY * rows;
  }
  if (event.deltaMode === DOM_DELTA_LINE) {
    return event.deltaY;
  }
  return event.deltaY / 40;
}

function getTerminalWheelDeltaPixels(event, terminal) {
  if (event.deltaMode === DOM_DELTA_PAGE) {
    return event.deltaY * Math.max(1, terminal?.element?.querySelector?.('.xterm-viewport')?.clientHeight || 1);
  }
  if (event.deltaMode === DOM_DELTA_LINE) {
    const cellHeight = terminal?._core?._renderService?.dimensions?.css?.cell?.height || 16;
    return event.deltaY * cellHeight;
  }
  return event.deltaY;
}

function getTerminalWheelPagingSequence(deltaLines) {
  if (!deltaLines) return '';
  return deltaLines < 0 ? '\x1b[5~' : '\x1b[6~';
}

function isPointInsideElement(event, element) {
  if (!element || typeof event.clientX !== 'number' || typeof event.clientY !== 'number') return false;
  const rect = element.getBoundingClientRect();
  return event.clientX >= rect.left &&
    event.clientX <= rect.right &&
    event.clientY >= rect.top &&
    event.clientY <= rect.bottom;
}

function scrollTerminalViewport(entry, wholeLines, pixelDelta) {
  const terminal = entry?.terminal;
  const viewport = terminal?.element?.querySelector?.('.xterm-viewport');
  const beforeViewportY = terminal?.buffer?.active?.viewportY;
  const beforeScrollTop = viewport?.scrollTop;

  if (wholeLines) terminal.scrollLines(wholeLines);

  const afterViewportY = terminal?.buffer?.active?.viewportY;
  const afterScrollTop = viewport?.scrollTop;
  if (
    viewport &&
    pixelDelta &&
    beforeViewportY === afterViewportY &&
    beforeScrollTop === afterScrollTop
  ) {
    viewport.scrollTop += pixelDelta;
  }
}

module.exports = {
  DOM_DELTA_LINE,
  DOM_DELTA_PAGE,
  getTerminalMouseCoords,
  getTerminalWheelDeltaLines,
  getTerminalWheelDeltaPixels,
  getTerminalWheelPagingSequence,
  getWheelMouseReport,
  isPointInsideElement,
  scrollTerminalViewport,
  updateTerminalMouseTracking,
};
