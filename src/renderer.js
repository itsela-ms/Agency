const { Terminal } = require('@xterm/xterm');
const { FitAddon } = require('@xterm/addon-fit');
const { WebLinksAddon } = require('@xterm/addon-web-links');
const { deriveSessionState, getNewSessionAvailability, filterSessionsForSidebar } = require('./session-state');
const { createTerminalKeyHandler, getGlobalShortcutAction, getShortcutKey, sanitizePasteText, stripTerminalScrollbar, stripMouseTrackingSequences, stripTerminalMouseInputReports, isCopyShortcut } = require('./keyboard-shortcuts');
const { collectTerminalSearchMatches } = require('./terminal-search');
const { resolveSidebarDragWidth } = require('./sidebar-resize');
const { rememberRestorableClosedSession, peekRestorableClosedSession, forgetRestorableClosedSession } = require('./recently-closed');
const { pruneSessionFromGroups } = require('./tab-groups');
const { shouldApplyStatusPanelUpdate } = require('./status-panel-state');
const { getInitialSidebarState, getNextSidebarVisibilityState } = require('./sidebar-preferences');
const { processSessionInput, isMetadataRefreshCommand, extractMetadataCommand } = require('./session-input-tracker');
const { trapFocusWithin, isBackdropClickTarget } = require('./modal-utils');
const { renderDiffPreviewHtml } = require('./status-diff-preview');
const { renderStatusSummaryMetaHtml } = require('./status-summary');
const {
  getHistoryEmptyState,
  getHistoryScopeActionLabel,
  getHistoryScopeStatusNotice,
} = require('./history-limit');
const { getRecentChangelogReleases } = require('./changelog-utils');
const { createStartupLoadingController } = require('./startup-loading');
const {
  getTerminalWheelDeltaLines,
  getTerminalWheelDeltaPixels,
  getTerminalWheelPagingSequence,
  getWheelMouseReport,
  isPointInsideElement,
  scrollTerminalViewport,
  updateTerminalMouseTracking,
} = require('./terminal-wheel');

// State
const terminals = new Map();
const sessionBusyState = new Map(); // sessionId → boolean (has recent pty output)
const sessionBusyTimers = new Map(); // sessionId → debounce timeout id (Working → Waiting)
const sessionAliveState = new Set(); // sessionIds with live pty processes
const pendingSessionStarts = new Map(); // temporary ids shown while slow launchers create the real session
const openTabIds = new Set(); // sessionIds currently shown in the tab strip
let activeSessionId = null;
let allSessions = [];
let searchQuery = '';
let currentSidebarTab = 'active';
let originalInstructions = '';
let currentInstructions = '';
let currentTheme = 'mocha';
const openingSession = new Set();
const cwdChangingSessions = new Set(); // sessions undergoing cwd change (suppress exit handling)
const recentlyClosedSessions = []; // stack of session IDs closed by the user
let restoringClosedTab = false;
const sessionLastUsed = new Map();
let creatingSession = false;
const ipcCleanups = []; // unsubscribe fns for IPC listeners
let sessionListRenderSeq = 0;
let activeSessionRenameId = null;
let activeGroupRenameId = null;
let pendingSessionListRender = false;
// Fingerprint of the last rendered sidebar state. Used by renderSessionList() to
// skip the destructive innerHTML='' + rebuild when nothing visible has changed —
// pollSessionStatus runs every 3s and was forcing a full rebuild on every tick,
// causing visible "blink" / mini re-renders. Status badge changes (Working /
// Waiting / Pending PR / .running / active highlight) are still patched in-place
// after the early-return below.
let _lastSidebarFingerprint = null;
let sidebarCollapsed = false;
let sidebarHidden = false;
let sidebarCollapsedBeforeHidden = false;
let lastExpandedSidebarWidth = 280;
let statusPanelRequestSeq = 0;
let lastFocusedElementBeforeSettings = null;
let lastFocusedElementBeforeNewSessionOptions = null;
const sessionPromptGhostState = new Map();
let statusDiffPopover = null;
let statusDiffHideTimer = null;
let historyShowsAll = false;
let startupInstallInProgress = false;
let startupInstallRecoveryPromise = null;
let nextPendingSessionStartId = 1;

const SIDEBAR_MIN_WIDTH = 200;
const SIDEBAR_MAX_WIDTH = 450;
const SIDEBAR_COLLAPSED_WIDTH = 68;

// Tab group state
let tabGroups = []; // Array of { id, name, color, collapsed, tabIds }
let sessionOrder = []; // Manual ordering of active session IDs in sidebar
const ABOUT_CHANGELOG_URL = 'https://github.com/itsela-ms/DeepSky/blob/main/CHANGELOG.md';
const CONTACT_EMAIL = 'itsela@microsoft.com';
const CONTACT_EMAIL_URL = `https://outlook.office.com/mail/deeplink/compose?to=${encodeURIComponent(CONTACT_EMAIL)}&subject=${encodeURIComponent('DeepSky feedback')}`;
const CONTACT_TEAMS_URL = `https://teams.microsoft.com/l/chat/0/0?users=${encodeURIComponent(CONTACT_EMAIL)}`;
const ABOUT_CHANGELOG_RELEASE_LIMIT = 3;
const GROUP_COLORS = [
  { name: 'Grey', value: '#585b70' },
  { name: 'Blue', value: '#89b4fa' },
  { name: 'Red', value: '#f38ba8' },
  { name: 'Yellow', value: '#f9e2af' },
  { name: 'Green', value: '#a6e3a1' },
  { name: 'Pink', value: '#f5c2e7' },
  { name: 'Purple', value: '#cba6f7' },
  { name: 'Cyan', value: '#94e2d5' },
];
let nextGroupColorIdx = 0;

function saveTabState() {
  const openTabs = [...openTabIds];
  const activeSessions = [...sessionAliveState];
  const persistedSessionOrder = sessionOrder.filter(id => !pendingSessionStarts.has(id));
  window.api.updateSettings({ openTabs, activeSessions, activeTab: activeSessionId, tabGroups, sessionOrder: persistedSessionOrder });
}

function getActiveSidebarIds() {
  return new Set([...sessionAliveState, ...pendingSessionStarts.keys()]);
}

function isSessionListRenderLocked() {
  return !!(activeSessionRenameId || activeGroupRenameId);
}

// Theme palettes for xterm.js
const XTERM_THEMES = {
  mocha: {
    background: '#1e1e2e', foreground: '#cdd6f4', cursor: '#f5e0dc', cursorAccent: '#1e1e2e',
    selectionBackground: '#585b70', selectionForeground: '#cdd6f4',
    black: '#45475a', red: '#f38ba8', green: '#a6e3a1', yellow: '#f9e2af',
    blue: '#89b4fa', magenta: '#f5c2e7', cyan: '#94e2d5', white: '#bac2de',
    brightBlack: '#585b70', brightRed: '#f38ba8', brightGreen: '#a6e3a1', brightYellow: '#f9e2af',
    brightBlue: '#89b4fa', brightMagenta: '#f5c2e7', brightCyan: '#94e2d5', brightWhite: '#a6adc8'
  },
  latte: {
    background: '#eff1f5', foreground: '#4c4f69', cursor: '#dc8a78', cursorAccent: '#eff1f5',
    selectionBackground: '#8c8fa1', selectionForeground: '#4c4f69',
    black: '#5c5f77', red: '#d20f39', green: '#40a02b', yellow: '#df8e1d',
    blue: '#1e66f5', magenta: '#ea76cb', cyan: '#179299', white: '#acb0be',
    brightBlack: '#6c6f85', brightRed: '#d20f39', brightGreen: '#40a02b', brightYellow: '#df8e1d',
    brightBlue: '#1e66f5', brightMagenta: '#ea76cb', brightCyan: '#179299', brightWhite: '#bcc0cc'
  }
};

function forwardTrackedMouseWheel(sessionId, entry, event) {
  const report = getWheelMouseReport(event, entry);
  if (!report) return false;
  event.preventDefault();
  event.stopPropagation();
  window.api.writePty(sessionId, report);
  return true;
}

function shouldRouteTerminalWheel(event) {
  if (isBlockingModalOpen()) return false;
  if (!activeSessionId || !terminals.has(activeSessionId)) return false;
  if (terminalArea?.style?.display === 'none') return false;
  if (sessionSearch?.contains(event.target)) return false;
  return terminalColumn?.contains(event.target) || isPointInsideElement(event, terminalColumn);
}

function handleTerminalScrollbackWheel(event, entry) {
  const terminal = entry?.terminal;
  if (!terminal) return;
  if (event.ctrlKey || event.metaKey) {
    event.preventDefault();
    event.stopPropagation();
    applyZoom(event.deltaY < 0 ? 'in' : 'out');
    return;
  }
  if (forwardTrackedMouseWheel(activeSessionId, entry, event)) return;
  const deltaLines = getTerminalWheelDeltaLines(event, terminal);
  if (!deltaLines) return;

  event.preventDefault();
  event.stopPropagation();

  // Copilot CLI owns most of the visible screen. When it doesn't advertise
  // mouse tracking (or the enable sequence was missed during renderer attach),
  // xterm scrollback is usually inert; send terminal paging keys so the CLI
  // scrolls its own transcript instead of doing nothing.
  window.api.writePty(activeSessionId, getTerminalWheelPagingSequence(deltaLines));

  const accumulatedLines = (entry.wheelScrollRemainder || 0) + deltaLines;
  const wholeLines = accumulatedLines > 0
    ? Math.floor(accumulatedLines)
    : Math.ceil(accumulatedLines);
  entry.wheelScrollRemainder = accumulatedLines - wholeLines;
  scrollTerminalViewport(entry, wholeLines, getTerminalWheelDeltaPixels(event, terminal));
}

// DOM elements
const sessionList = document.getElementById('session-list');
const searchInput = document.getElementById('search');
const searchClear = document.getElementById('search-clear');
const sidebarSearchToggle = document.getElementById('sidebar-search-toggle');
const terminalContainer = document.getElementById('terminal-container');
const terminalPromptGhost = document.getElementById('terminal-prompt-ghost');
const sessionSearch = document.getElementById('session-search');
const sessionSearchInput = document.getElementById('session-search-input');
const sessionSearchCount = document.getElementById('session-search-count');
const sessionSearchPrev = document.getElementById('session-search-prev');
const sessionSearchNext = document.getElementById('session-search-next');
const sessionSearchClose = document.getElementById('session-search-close');
const terminalTabs = document.getElementById('terminal-tabs');
const terminalColumn = document.getElementById('terminal-column');
const tabsScrollArea = terminalTabs.querySelector('.tabs-scroll-area');
const tabScrollLeft = terminalTabs.querySelector('.tab-scroll-left');
const tabScrollRight = terminalTabs.querySelector('.tab-scroll-right');
const emptyState = document.getElementById('empty-state');
const btnNew = document.getElementById('btn-new');
const btnNewOptions = document.getElementById('btn-new-options');
const btnNewCenter = document.getElementById('btn-new-center');
const maxConcurrentInput = document.getElementById('max-concurrent');
const useAgencyCopilotInput = document.getElementById('use-agency-copilot');
const copilotArgsInput = document.getElementById('copilot-args');
const promptWorkdirInput = document.getElementById('prompt-workdir');
const defaultWorkdirInput = document.getElementById('default-workdir');
const btnPickDefaultWorkdir = document.getElementById('btn-pick-default-workdir');
const btnClearDefaultWorkdir = document.getElementById('btn-clear-default-workdir');
const instructionsPanel = document.getElementById('instructions-panel');
const instructionsRendered = document.getElementById('instructions-rendered');
const btnInstructions = document.getElementById('btn-instructions');
const btnCloseInstructions = document.getElementById('btn-close-instructions');
const terminalArea = document.getElementById('terminal-area');
const settingsOverlay = document.getElementById('settings-overlay');
const newSessionOptionsOverlay = document.getElementById('new-session-options-overlay');
const btnNewSessionOptionsClose = document.getElementById('btn-new-session-options-close');
const btnNewSessionOptionsCancel = document.getElementById('btn-new-session-options-cancel');
const btnNewSessionOptionsStart = document.getElementById('btn-new-session-options-start');
const newSessionArgsInput = document.getElementById('new-session-args');
const newSessionLauncherCopilotInput = document.getElementById('new-session-launcher-copilot');
const newSessionLauncherCopilotRow = document.getElementById('new-session-launcher-copilot-row');
const newSessionLauncherCopilotDesc = document.getElementById('new-session-launcher-copilot-desc');
const newSessionLauncherAgencyInput = document.getElementById('new-session-launcher-agency');
const newSessionLauncherAgencyRow = document.getElementById('new-session-launcher-agency-row');
const newSessionLauncherAgencyDesc = document.getElementById('new-session-launcher-agency-desc');
const btnSettings = document.getElementById('btn-settings');
const statusPanel = document.getElementById('status-panel');
const statusPanelBody = document.getElementById('status-panel-body');
const btnToggleStatus = document.getElementById('btn-toggle-status');
const notificationBadge = document.getElementById('notification-badge');
const notificationPanel = document.getElementById('notification-panel');
const notificationListEl = document.getElementById('notification-list');
const aboutVersionEl = document.getElementById('about-version');
const aboutVersionTabEl = document.getElementById('about-version-tab');
const aboutReleaseMetaEl = document.getElementById('about-release-meta');
const aboutChangelogEl = document.getElementById('about-changelog');
const aboutOpenBrochureBtn = document.getElementById('about-open-brochure');
const aboutOpenChangelogBtn = document.getElementById('about-open-changelog');
const aboutContactEmailBtn = document.getElementById('about-contact-email');
const aboutContactTeamsBtn = document.getElementById('about-contact-teams');
const feedbackPanel = document.getElementById('feedback-panel');
const toastContainer = document.getElementById('toast-container');
const notificationLiveRegion = document.getElementById('notification-live-region');
const startupLoading = createStartupLoadingController({
  screen: document.getElementById('startup-loading-screen'),
  title: document.getElementById('startup-loading-title'),
  message: document.getElementById('startup-loading-message'),
  progress: document.getElementById('startup-loading-progress'),
  progressBar: document.getElementById('startup-loading-progress-bar'),
  progressLabel: document.getElementById('startup-loading-progress-label'),
});
const autoUpdateToggle = document.getElementById('auto-update-enabled');
const copyOnSelectToggle = document.getElementById('copy-on-select');
const betaChannelToggle = document.getElementById('beta-channel');
const betaChannelLabel = document.getElementById('beta-channel-label');
const betaChannelRow = document.getElementById('beta-channel-row');
const btnUpdateInstall = document.getElementById('btn-update-install');
const agencyLauncherRow = document.getElementById('agency-launcher-row');
const agencyLauncherDesc = document.getElementById('agency-launcher-desc');

const titlebar = document.getElementById('titlebar');
const NOTIF_ICONS = { 'task-done': '✓', 'needs-input': '◌', 'error': '!', 'info': '·' };

const OVERLAY_BASE_PX = 140;
const DEFAULT_AGENCY_LAUNCHER_TEXT = 'Launch new sessions with agency copilot instead of the default Copilot CLI command';
const DEFAULT_NEW_SESSION_TITLE = 'New Session (Ctrl+N)';
const DEFAULT_NEW_SESSION_CENTER_TITLE = 'New Session (Ctrl+N)';
const DEFAULT_NEW_SESSION_OPTIONS_TITLE = 'New Session with custom launcher args';

function updateNewSessionAvailabilityState(settings = {}) {
  const availability = getNewSessionAvailability(settings);
  const blocked = !availability.available;
  const oneOffAvailability = getAnyOneOffLauncherAvailability(settings);
  const optionsBlocked = !oneOffAvailability.available;
  const title = blocked ? availability.reason : DEFAULT_NEW_SESSION_TITLE;
  const centerTitle = blocked ? availability.reason : DEFAULT_NEW_SESSION_CENTER_TITLE;
  const optionsTitle = optionsBlocked ? oneOffAvailability.reason : DEFAULT_NEW_SESSION_OPTIONS_TITLE;

  for (const button of [btnNew, btnNewCenter]) {
    if (!button) continue;
    button.classList.toggle('is-blocked', blocked);
    button.setAttribute('aria-disabled', blocked ? 'true' : 'false');
  }

  if (btnNewOptions) {
    btnNewOptions.classList.toggle('is-blocked', optionsBlocked);
    btnNewOptions.setAttribute('aria-disabled', optionsBlocked ? 'true' : 'false');
  }

  btnNew.title = title;
  btnNewCenter.title = centerTitle;
  if (btnNewOptions) btnNewOptions.title = optionsTitle;

  return availability;
}

function getOneOffLauncherAvailability(settings = {}, launcher = 'copilot') {
  if (launcher === 'agency') {
    return settings.agencyAvailable === false
      ? { available: false, launcher: 'agency', reason: 'Agency is not installed on this machine.' }
      : { available: true, launcher: 'agency', reason: '' };
  }

  return settings.copilotAvailable === false
    ? { available: false, launcher: 'copilot', reason: 'GitHub Copilot CLI is not installed.' }
    : { available: true, launcher: 'copilot', reason: '' };
}

function getAnyOneOffLauncherAvailability(settings = {}) {
  const copilot = getOneOffLauncherAvailability(settings, 'copilot');
  const agency = getOneOffLauncherAvailability(settings, 'agency');
  return {
    available: copilot.available || agency.available,
    launcher: copilot.available ? 'copilot' : 'agency',
    reason: copilot.available || agency.available
      ? ''
      : 'New sessions are unavailable because neither GitHub Copilot CLI nor Agency is installed.',
  };
}

function updateOneOffLauncherChoices(settings = {}) {
  const copilotAvailable = settings.copilotAvailable !== false;
  const agencyAvailable = settings.agencyAvailable !== false;
  newSessionLauncherCopilotInput.disabled = !copilotAvailable;
  newSessionLauncherCopilotRow?.classList.toggle('disabled', !copilotAvailable);
  if (newSessionLauncherCopilotDesc) {
    newSessionLauncherCopilotDesc.textContent = copilotAvailable
      ? 'Run copilot for this session only'
      : 'GitHub Copilot CLI is not installed on this machine.';
  }
  newSessionLauncherAgencyInput.disabled = !agencyAvailable;
  newSessionLauncherAgencyRow?.classList.toggle('disabled', !agencyAvailable);
  if (newSessionLauncherAgencyDesc) {
    newSessionLauncherAgencyDesc.textContent = agencyAvailable
      ? 'Run agency copilot for this session only'
      : 'Agency is not installed on this machine.';
  }
}

async function syncTitlebarPadding() {
  const zoom = await window.api.getZoom();
  titlebar.style.paddingRight = `${Math.ceil(OVERLAY_BASE_PX / zoom)}px`;
}
syncTitlebarPadding();

let sessionSearchMatches = [];
let sessionSearchIndex = -1;

function announceLiveMessage(message) {
  if (!notificationLiveRegion) return;
  notificationLiveRegion.textContent = '';
  setTimeout(() => {
    notificationLiveRegion.textContent = message;
  }, 0);
}

function isBlockingModalOpen() {
  return !newSessionOptionsOverlay.classList.contains('hidden') ||
    !settingsOverlay.classList.contains('hidden');
}

function elementAcceptsTextInput(element) {
  if (!element) return false;
  if (element.isContentEditable) return true;
  if (element.classList?.contains('xterm-helper-textarea')) return true;
  return ['INPUT', 'TEXTAREA', 'SELECT'].includes(element.tagName);
}

function isStrandedTerminalFocusTarget(element) {
  if (!element || element === document.body || element === document.documentElement) return false;
  return element === terminalArea ||
    element === terminalContainer ||
    element.id === 'terminal-column' ||
    element.id === 'terminal-main-row' ||
    element.classList?.contains('terminal-wrapper') ||
    element.classList?.contains('terminal-prompt-ghost');
}

function writePlainKeyToActiveTerminal(e) {
  if (!activeSessionId || !terminals.has(activeSessionId)) return false;
  if (isBlockingModalOpen()) return false;
  if (e.ctrlKey || e.metaKey || e.altKey) return false;
  if (elementAcceptsTextInput(document.activeElement)) return false;
  if (!isStrandedTerminalFocusTarget(document.activeElement)) return false;
  if (e.key === 'Tab') return false;
  if (e.key === 'Shift') return false;

  const entry = terminals.get(activeSessionId);
  entry.terminal.focus();

  let data = '';
  if (e.key && e.key.length === 1) data = e.key;
  else if (e.key === 'Enter') data = '\r';
  else if (e.key === 'Backspace') data = '\x7f';
  else return false;

  e.preventDefault();
  const sanitizedData = stripTerminalMouseInputReports(data);
  if (!sanitizedData) return true;
  handleSessionPromptInput(activeSessionId, sanitizedData);
  window.api.writePty(activeSessionId, sanitizedData);
  return true;
}

function getFocusableElements(root) {
  if (!root) return [];
  return [...root.querySelectorAll(
    'button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])'
  )].filter((el) => !el.closest('.hidden') && el.offsetParent !== null);
}

function updateAgencyAvailabilityState(agencyAvailable, requestedValue = false) {
  const available = agencyAvailable !== false;
  useAgencyCopilotInput.disabled = !available;
  useAgencyCopilotInput.checked = available && !!requestedValue;
  if (agencyLauncherRow) {
    agencyLauncherRow.classList.toggle('disabled', !available);
  }
  if (agencyLauncherDesc) {
    agencyLauncherDesc.textContent = available
      ? DEFAULT_AGENCY_LAUNCHER_TEXT
      : 'Agency is not installed on this machine, so DeepSky will keep using the default Copilot CLI command.';
  }
}

async function restoreMostRecentClosedTab() {
  if (restoringClosedTab) return;
  restoringClosedTab = true;
  try {
    const validIds = await getAllValidSessionIds();
    const sessionId = peekRestorableClosedSession(recentlyClosedSessions, validIds);
    if (!sessionId) return;
    await openSession(sessionId);
    if (openTabIds.has(sessionId)) {
      forgetRestorableClosedSession(recentlyClosedSessions, sessionId);
    }
  } finally {
    restoringClosedTab = false;
  }
}

function applySettingsToControls(settings, { includeSidebar = false } = {}) {
  window._cachedSettings = { ...(window._cachedSettings || {}), ...settings };
  maxConcurrentInput.value = settings.maxConcurrent;
  if (copilotArgsInput) copilotArgsInput.value = settings.copilotArgs || '';
  promptWorkdirInput.checked = !!settings.promptForWorkdir;
  defaultWorkdirInput.value = settings.defaultWorkdir || '';
  autoUpdateToggle.checked = settings.autoUpdateEnabled !== false;
  copyOnSelectToggle.checked = settings.copyOnSelect !== false;
  betaChannelToggle.checked = settings.updateChannel === 'beta';
  betaChannelRow.classList.toggle('disabled', !autoUpdateToggle.checked);
  betaChannelToggle.disabled = !autoUpdateToggle.checked;
  updateAgencyAvailabilityState(settings.agencyAvailable, settings.useAgencyCopilot);
  updateNewSessionAvailabilityState(window._cachedSettings);
  applyTheme(settings.theme || 'mocha');

  if (includeSidebar) {
    const sidebarState = getInitialSidebarState(settings);
    lastExpandedSidebarWidth = sidebarState.lastExpandedSidebarWidth;
    sidebarCollapsed = sidebarState.sidebarCollapsed;
    sidebarHidden = sidebarState.sidebarHidden;
    sidebarCollapsedBeforeHidden = sidebarState.sidebarCollapsed;
    syncSidebarCollapsedUi();
  }
}

function getUpdateVersionLabel(info) {
  return info?.version ? `v${info.version}` : 'the downloaded update';
}

function showStartupUpdateInstallStatus(data, progressPercent = 12) {
  const versionLabel = getUpdateVersionLabel(data?.info);
  startupLoading.setStatus({
    titleText: 'Installing DeepSky update...',
    messageText: `Applying ${versionLabel}. DeepSky will reopen when installation completes.`,
    progressPercent,
    progressText: 'Preparing installer...',
    indeterminate: true,
  });
}

async function installPendingUpdateOnStartup() {
  const updateData = await window.api.getUpdateStatus();
  if (updateData?.status !== 'pending-install') return false;

  startupInstallInProgress = true;
  showStartupUpdateInstallStatus(updateData);
  const installResult = await window.api.installUpdate();
  if (!startupInstallInProgress || installResult?.status === 'error') return false;
  showStartupUpdateInstallStatus(updateData, 35);
  return true;
}

async function installDownloadedUpdateNow() {
  const updateData = await window.api.getUpdateStatus();
  const canInstall = updateData?.status === 'downloaded' ||
    updateData?.status === 'pending-install' ||
    (updateData?.status === 'error' && updateData?.info?.version);
  if (!canInstall) return;

  startupInstallInProgress = true;
  closeSettings();
  showStartupUpdateInstallStatus(updateData, updateData.status === 'pending-install' ? 12 : 20);
  const installResult = await window.api.installUpdate();
  if (!startupInstallInProgress || installResult?.status === 'error') return;
  showStartupUpdateInstallStatus(installResult, 35);
}

function waitForStartupPaint() {
  return new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
}

async function completeStartupLoading(startupResult) {
  if (startupResult === 'installing-update' || startupInstallInProgress) return;
  await waitForStartupPaint();
  startupLoading.complete();
}

function recoverFromStartupInstallError(errorMessage) {
  if (startupInstallRecoveryPromise) return;
  startupInstallInProgress = false;
  startupLoading.setStatus({
    titleText: 'Opening current DeepSky version...',
    messageText: errorMessage
      ? `Update installation failed: ${errorMessage}`
      : 'Update installation failed. Opening the current version instead.',
  });

  startupInstallRecoveryPromise = Promise.resolve()
    .then(() => init())
    .then(completeStartupLoading)
    .catch((error) => {
      console.error('DeepSky startup failed after update install error', error);
      startupLoading.fail(error);
    });
}

function getActiveTerminalEntry() {
  return activeSessionId ? terminals.get(activeSessionId) : null;
}

function updateSessionSearchUi() {
  const hasQuery = !!sessionSearchInput.value.trim();
  const hasMatches = sessionSearchMatches.length > 0;
  if (!hasQuery) {
    sessionSearchCount.textContent = '';
  } else {
    sessionSearchCount.textContent = hasMatches ? `${sessionSearchIndex + 1}/${sessionSearchMatches.length}` : '0/0';
  }
  sessionSearchPrev.disabled = !hasMatches;
  sessionSearchNext.disabled = !hasMatches;
}

function clearActiveTerminalSelection() {
  const entry = getActiveTerminalEntry();
  if (entry) entry.terminal.clearSelection();
}

function syncTerminalViewport(sessionId, { refreshSearch = false } = {}) {
  const entry = terminals.get(sessionId);
  if (!entry || entry.isSyncingViewport) return;

  entry.isSyncingViewport = true;
  try {
    entry.terminal._core?.viewport?.syncScrollArea(true);

    if (
      refreshSearch &&
      sessionId === activeSessionId &&
      !sessionSearch.classList.contains('hidden') &&
      sessionSearchInput.value.trim()
    ) {
      refreshSessionSearch(true);
    }
  } finally {
    entry.isSyncingViewport = false;
  }
}

function scheduleTerminalViewportSync(sessionId, { refreshSearch = false } = {}) {
  const entry = terminals.get(sessionId);
  if (!entry) return;

  entry.pendingViewportRefreshSearch = entry.pendingViewportRefreshSearch || refreshSearch;
  if (entry.viewportSyncTimer) clearTimeout(entry.viewportSyncTimer);
  entry.viewportSyncTimer = setTimeout(() => {
    entry.viewportSyncTimer = null;
    const currentEntry = terminals.get(sessionId);
    if (!currentEntry) return;
    const shouldRefreshSearch = !!currentEntry.pendingViewportRefreshSearch;
    currentEntry.pendingViewportRefreshSearch = false;

    requestAnimationFrame(() => {
      syncTerminalViewport(sessionId, { refreshSearch: shouldRefreshSearch });
    });
  }, 20);
}

function collectSessionSearchMatches(query) {
  const entry = getActiveTerminalEntry();
  if (!entry || !query) return [];
  return collectTerminalSearchMatches(entry.terminal.buffer.active, entry.terminal.cols, query);
}

function revealSessionSearchMatch(index, keepSearchFocus = false) {
  if (index < 0 || index >= sessionSearchMatches.length) return false;
  const entry = getActiveTerminalEntry();
  const match = sessionSearchMatches[index];
  if (!entry || !match) return false;
  const matchSessionId = activeSessionId;

  sessionSearchIndex = index;
  updateSessionSearchUi();

  const targetViewportY = Math.max(0, match.row - Math.floor(entry.terminal.rows / 2));
  syncTerminalViewport(matchSessionId);
  entry.terminal.scrollToLine(targetViewportY);

  requestAnimationFrame(() => {
    requestAnimationFrame(() => {
      if (activeSessionId !== matchSessionId) return;
      const currentEntry = terminals.get(matchSessionId);
      if (!currentEntry) return;
      syncTerminalViewport(matchSessionId);
      currentEntry.terminal.clearSelection();
      currentEntry.terminal.select(match.col, match.row, match.length);
      if (keepSearchFocus) sessionSearchInput.focus();
      else currentEntry.terminal.focus();
    });
  });

  return true;
}

function refreshSessionSearch(preserveIndex = false) {
  const trimmed = sessionSearchInput.value.trim();
  if (!trimmed || !activeSessionId) {
    sessionSearchMatches = [];
    sessionSearchIndex = -1;
    clearActiveTerminalSelection();
    updateSessionSearchUi();
    return;
  }

  const previousIndex = preserveIndex ? sessionSearchIndex : -1;
  sessionSearchMatches = collectSessionSearchMatches(trimmed);
  if (!sessionSearchMatches.length) {
    sessionSearchIndex = -1;
    clearActiveTerminalSelection();
    updateSessionSearchUi();
    return;
  }

  const nextIndex = previousIndex >= 0
    ? Math.min(previousIndex, sessionSearchMatches.length - 1)
    : 0;
  revealSessionSearchMatch(nextIndex, true);
}

function stepSessionSearch(direction) {
  if (!sessionSearchMatches.length) {
    refreshSessionSearch(false);
    return;
  }
  const nextIndex = sessionSearchIndex < 0
    ? 0
    : (sessionSearchIndex + direction + sessionSearchMatches.length) % sessionSearchMatches.length;
  revealSessionSearchMatch(nextIndex, true);
}

function openSessionSearch() {
  if (!activeSessionId || !terminals.has(activeSessionId)) {
    focusSidebarSearch();
    return;
  }

  sessionSearch.classList.remove('hidden');
  updateSessionSearchUi();
  refreshSessionSearch(true);
  requestAnimationFrame(() => {
    sessionSearchInput.focus();
    sessionSearchInput.select();
  });
}

function closeSessionSearch({ restoreTerminalFocus = true } = {}) {
  sessionSearch.classList.add('hidden');
  sessionSearchInput.value = '';
  sessionSearchMatches = [];
  sessionSearchIndex = -1;
  clearActiveTerminalSelection();
  updateSessionSearchUi();

  if (restoreTerminalFocus) {
    const entry = getActiveTerminalEntry();
    if (entry) entry.terminal.focus();
  }
}

function getSessionPromptGhost(sessionId) {
  if (!sessionPromptGhostState.has(sessionId)) {
    sessionPromptGhostState.set(sessionId, {
      lastPrompt: '',
      isTyping: false,
      requestSeq: 0,
      pendingCommandLine: ''
    });
  }
  return sessionPromptGhostState.get(sessionId);
}

function updateSessionPromptGhost(sessionId) {
  if (!terminalPromptGhost) return;

  if (!sessionId || sessionId !== activeSessionId) {
    terminalPromptGhost.innerHTML = '';
    terminalPromptGhost.classList.add('empty');
    return;
  }

  const session = allSessions.find(s => s.id === sessionId);
  const title = session?.title || 'New Session';
  const state = getSessionPromptGhost(sessionId);
  const lastPrompt = state.lastPrompt || '';

  const esc = (s) => { const d = document.createElement('span'); d.textContent = s; return d.innerHTML; };

  let html = `<span class="info-badge">Session Context</span><span class="info-title">${esc(title)}</span>`;
  if (lastPrompt) {
    html += `<span class="info-divider">│</span>`;
    html += `<span class="info-prompt" title="${esc(lastPrompt)}">💬 ${esc(lastPrompt)}</span>`;
  }

  terminalPromptGhost.innerHTML = html;
  terminalPromptGhost.classList.remove('empty');
}

function scheduleSessionMetadataRefresh(sessionId, delays = [500, 1500, 4000]) {
  for (const delay of delays) {
    setTimeout(() => {
      if (terminals.has(sessionId)) refreshSessionList();
    }, delay);
  }
}

function scheduleSessionPromptGhostRefresh(sessionId, delays = [0, 400, 1200]) {
  const state = getSessionPromptGhost(sessionId);
  const requestId = ++state.requestSeq;
  const runRefresh = async () => {
    try {
      const lastPrompt = await window.api.getLastUserPrompt(sessionId);
      const currentState = getSessionPromptGhost(sessionId);
      if (currentState.requestSeq !== requestId) return;
      currentState.lastPrompt = lastPrompt || '';
      updateSessionPromptGhost(sessionId);
    } catch {
      // Ignore transient transcript-read failures.
    }
  };

  for (const delay of delays) {
    setTimeout(runRefresh, delay);
  }
}

function handleSessionPromptInput(sessionId, data) {
  const state = getSessionPromptGhost(sessionId);
  if (!data) return;

  const nextCommandState = processSessionInput({ line: state.pendingCommandLine }, data, (command) => {
    if (isMetadataRefreshCommand(command)) {
      const metadataCommand = extractMetadataCommand(command);
      if (metadataCommand?.type === 'cwd') {
        window.api.updateSessionCwdMetadata(sessionId, metadataCommand.value)
          .then(() => {
            const session = allSessions.find(s => s.id === sessionId);
            if (session) session.cwd = metadataCommand.value;
            scheduleRenderSessionList();
            if (sessionId === activeSessionId) {
              updateStatusPanel(sessionId);
            }
          })
          .catch(() => {
            showToast({
              type: 'error',
              title: 'Could not update working directory',
              body: metadataCommand.value,
            });
          });
      }
      scheduleSessionMetadataRefresh(sessionId);
    }
  });
  state.pendingCommandLine = nextCommandState.line;

  if (data.includes('\r') || data.includes('\n')) {
    state.isTyping = false;
    // Transcript takes time to be written after send — use longer delays
    scheduleSessionPromptGhostRefresh(sessionId, [800, 2000, 5000]);
    return;
  }

  state.isTyping = true;
}

function matchesSidebarMetadata(session, queryLower) {
  if (session.title.toLowerCase().includes(queryLower)) return true;
  if (session.cwd && session.cwd.toLowerCase().includes(queryLower)) return true;
  if (session.tags && session.tags.some(tag => tag.toLowerCase().includes(queryLower))) return true;
  if (session.resources && session.resources.some(resource =>
    String(resource.id || '').toLowerCase().includes(queryLower) ||
    String(resource.url || '').toLowerCase().includes(queryLower) ||
    String(resource.name || '').toLowerCase().includes(queryLower) ||
    String(resource.repo || '').toLowerCase().includes(queryLower)
  )) {
    return true;
  }
  return false;
}

function ensureSessionPlaceholder(sessionId, fallback = {}) {
  let session = allSessions.find(existing => existing.id === sessionId);
  if (session) return session;

  session = {
    id: sessionId,
    title: fallback.title || sessionId.substring(0, 8),
    cwd: fallback.cwd || '',
    updatedAt: new Date().toISOString(),
    tags: [],
    resources: []
  };
  allSessions.unshift(session);
  return session;
}

function createPendingSessionStart({ launcher = 'copilot', cwd = '' } = {}) {
  const id = `pending-new-session-${Date.now()}-${nextPendingSessionStartId++}`;
  const launcherLabel = launcher === 'agency' ? 'Agency' : 'Copilot';
  const session = {
    id,
    title: `Starting ${launcherLabel} session...`,
    cwd: cwd || '',
    updatedAt: new Date().toISOString(),
    tags: [],
    resources: [],
  };
  pendingSessionStarts.set(id, session);
  allSessions.unshift(session);
  return id;
}

function removePendingSessionStart(id) {
  if (!id) return;
  pendingSessionStarts.delete(id);
  allSessions = allSessions.filter(session => session.id !== id);
  sessionOrder = sessionOrder.filter(sessionId => sessionId !== id);
}

function mergePendingSessionStarts() {
  for (const [id, session] of pendingSessionStarts) {
    if (!allSessions.some(existing => existing.id === id)) {
      allSessions.unshift(session);
    }
  }
}

function showActiveSidebar() {
  currentSidebarTab = 'active';
  document.querySelectorAll('.sidebar-tab').forEach(t =>
    t.classList.toggle('active', t.dataset.tab === 'active')
  );
}

function appendHistoryScopeNotice() {
  if (currentSidebarTab !== 'history' || sidebarCollapsed) return;
  const noticeEl = document.createElement('div');
  noticeEl.className = 'history-scope-note';

  const copyEl = document.createElement('div');
  copyEl.className = 'history-scope-note-copy';
  copyEl.textContent = getHistoryScopeStatusNotice(historyShowsAll);

  const actionEl = document.createElement('button');
  actionEl.type = 'button';
  actionEl.className = 'history-scope-action';
  actionEl.textContent = getHistoryScopeActionLabel(historyShowsAll);

  noticeEl.appendChild(copyEl);
  noticeEl.appendChild(actionEl);
  sessionList.appendChild(noticeEl);
}

function getSidebarSessionScope() {
  if (currentSidebarTab === 'history') {
    return historyShowsAll ? 'all' : 'history';
  }
  return currentSidebarTab;
}

function syncSidebarCollapsedUi() {
  lastExpandedSidebarWidth = Math.max(SIDEBAR_MIN_WIDTH, Math.min(SIDEBAR_MAX_WIDTH, lastExpandedSidebarWidth));
  sidebar.classList.toggle('collapsed', sidebarCollapsed && !sidebarHidden);
  sidebar.classList.toggle('hidden-full', sidebarHidden);
  resizeHandle.classList.toggle('collapsed', sidebarCollapsed || sidebarHidden);
  resizeHandle.classList.toggle('sidebar-hidden', sidebarHidden);
  if (sidebarHidden) {
    sidebar.style.width = '0px';
  } else {
    sidebar.style.width = `${sidebarCollapsed ? SIDEBAR_COLLAPSED_WIDTH : lastExpandedSidebarWidth}px`;
  }
}

function setSidebarCollapsed(collapsed, { persist = true } = {}) {
  if (collapsed === sidebarCollapsed && sidebar.style.width) {
    syncSidebarCollapsedUi();
    return;
  }

  if (collapsed) {
    const currentWidth = parseInt(sidebar.style.width, 10) || Math.round(sidebar.getBoundingClientRect().width) || lastExpandedSidebarWidth;
    if (currentWidth >= SIDEBAR_MIN_WIDTH) lastExpandedSidebarWidth = currentWidth;
  }

  sidebarCollapsed = collapsed;
  if (!sidebarHidden) sidebarCollapsedBeforeHidden = collapsed;
  syncSidebarCollapsedUi();

  if (window._cachedSettings) {
    window._cachedSettings.sidebarCollapsed = collapsed;
    window._cachedSettings.sidebarWidth = lastExpandedSidebarWidth;
  }

  if (persist) window.api.updateSettings({ sidebarCollapsed: collapsed });
  renderSessionList();
  fitActiveTerminal();
}

function setSidebarHidden(hidden, { persist = true } = {}) {
  const nextState = getNextSidebarVisibilityState({
    sidebarCollapsed,
    sidebarCollapsedBeforeHidden,
  }, hidden);
  sidebarHidden = nextState.sidebarHidden;
  sidebarCollapsed = nextState.sidebarCollapsed;
  sidebarCollapsedBeforeHidden = nextState.sidebarCollapsedBeforeHidden;
  syncSidebarCollapsedUi();

  if (window._cachedSettings) {
    window._cachedSettings.sidebarHidden = sidebarHidden;
    window._cachedSettings.sidebarCollapsed = sidebarCollapsed;
  }

  if (persist) {
    window.api.updateSettings({
      sidebarHidden,
      sidebarCollapsed,
    });
  }
  renderSessionList();
  fitActiveTerminal();
}

function persistSidebarWidth(width) {
  lastExpandedSidebarWidth = Math.max(SIDEBAR_MIN_WIDTH, Math.min(SIDEBAR_MAX_WIDTH, width));
  if (window._cachedSettings) window._cachedSettings.sidebarWidth = lastExpandedSidebarWidth;
  window.api.updateSettings({ sidebarWidth: lastExpandedSidebarWidth });
}

function focusSidebarSearch() {
  if (sidebarHidden) setSidebarHidden(false);
  if (sidebarCollapsed) setSidebarCollapsed(false);
  requestAnimationFrame(() => {
    searchInput.focus();
    searchInput.select();
    document.getElementById('search-wrapper').classList.add('search-active');
  });
}

// Delegated event handling for session list items (avoids per-item listener churn)
let _titleClickTimeout = null;
let _titleClickSessionId = null;
sessionList.addEventListener('click', (e) => {
  const historyScopeAction = e.target.closest('.history-scope-action');
  if (historyScopeAction) {
    e.stopPropagation();
    historyShowsAll = !historyShowsAll;
    void refreshSessionList();
    return;
  }
  const closeBtn = e.target.closest('.session-close');
  if (closeBtn) {
    e.stopPropagation();
    const item = closeBtn.closest('.session-item');
    if (item) terminateSession(item.dataset.sessionId, { rememberClosedTab: true });
    return;
  }
  const deleteBtn = e.target.closest('.session-delete');
  if (deleteBtn) {
    e.stopPropagation();
    const item = deleteBtn.closest('.session-item');
    if (item) {
      const session = allSessions.find(s => s.id === item.dataset.sessionId);
      if (session) confirmDeleteSession(session.id, session.title);
    }
    return;
  }
  // Cwd click → pick new directory
  const cwdEl = e.target.closest('.session-cwd');
  if (cwdEl) {
    e.stopPropagation();
    const sid = cwdEl.dataset.sessionId;
    if (sid && !pendingSessionStarts.has(sid)) handleCwdClick(sid);
    return;
  }
  // Tag overflow click → expand hidden tags
  const overflowTag = e.target.closest('.tag-overflow');
  if (overflowTag) {
    e.stopPropagation();
    overflowTag.classList.add('expanded');
    const hidden = overflowTag.parentElement.querySelector('.tags-hidden');
    if (hidden) hidden.classList.add('expanded');
    return;
  }
  const titleEl = e.target.closest('.session-title');
  if (titleEl) {
    e.stopPropagation();
    const item = titleEl.closest('.session-item');
    const sid = item?.dataset.sessionId;
    if (!sid) return;
    if (pendingSessionStarts.has(sid)) return;
    if (_titleClickTimeout && _titleClickSessionId === sid) {
      clearTimeout(_titleClickTimeout);
      _titleClickTimeout = null;
      _titleClickSessionId = null;
      return; // dblclick handler will fire
    }
    // Clear any pending timeout for a different session
    if (_titleClickTimeout) clearTimeout(_titleClickTimeout);
    _titleClickSessionId = sid;
    _titleClickTimeout = setTimeout(() => { _titleClickTimeout = null; _titleClickSessionId = null; openSession(sid); }, 250);
    return;
  }
  const item = e.target.closest('.session-item');
  if (item && !pendingSessionStarts.has(item.dataset.sessionId)) openSession(item.dataset.sessionId);
});
sessionList.addEventListener('dblclick', (e) => {
  const titleEl = e.target.closest('.session-title');
  if (!titleEl) return;
  e.stopPropagation();
  if (_titleClickTimeout) { clearTimeout(_titleClickTimeout); _titleClickTimeout = null; _titleClickSessionId = null; }
  const item = titleEl.closest('.session-item');
  if (item && !pendingSessionStarts.has(item.dataset.sessionId)) startRenameSession(item.dataset.sessionId, titleEl);
});
sessionList.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' || e.key === ' ') {
    const cwdEl = e.target.closest('.session-cwd');
    if (cwdEl) {
      e.preventDefault();
      e.stopPropagation();
      const sid = cwdEl.dataset.sessionId;
      if (sid && !pendingSessionStarts.has(sid)) handleCwdClick(sid);
      return;
    }
  }
  if (e.key !== 'Enter') return;
  const item = e.target.closest('.session-item');
  if (item && !pendingSessionStarts.has(item.dataset.sessionId)) openSession(item.dataset.sessionId);
});

// Initialize
async function init() {
  startupLoading.setStatus({
    titleText: 'Starting DeepSky...',
    messageText: 'Loading settings...',
  });
  const settings = await window.api.getSettings();
  applySettingsToControls(settings, { includeSidebar: true });

  // Clean up any previous IPC listeners (guards against double-init on reload)
  while (ipcCleanups.length) ipcCleanups.pop()();

  // Register before the startup install gate so installer errors can surface on the loading screen.
  ipcCleanups.push(window.api.onUpdateStatus(handleUpdateStatus));
  if (await installPendingUpdateOnStartup()) {
    return 'installing-update';
  }

  // Restore last sidebar tab — must be set BEFORE refreshSessionList
  if (settings.lastActiveTab) {
    currentSidebarTab = settings.lastActiveTab;
    document.querySelectorAll('.sidebar-tab').forEach(t => {
      t.classList.toggle('active', t.dataset.tab === currentSidebarTab);
    });
  }

  startupLoading.setStatus({
    titleText: 'Loading sessions...',
    messageText: 'Preparing your sidebar and saved session history...',
  });
  await refreshSessionList();

  ipcCleanups.push(window.api.onPtyData((sessionId, data) => {
    const entry = terminals.get(sessionId);
    if (entry) {
      updateTerminalMouseTracking(entry, data);
      // Strip the CLI's mouse-reporting mode-set sequences so xterm keeps
      // ownership of the mouse and plain-drag text selection / copy work.
      entry.terminal.write(stripMouseTrackingSequences(data), () => {
        scheduleTerminalViewportSync(sessionId, { refreshSearch: true });
      });
    }
    // Track alive transitions so we only repaint the badge when something
    // visible actually changed. Prior to this guard we scheduled a badge
    // patch on EVERY pty chunk, queuing rAF DOM work many times per second
    // per active session — a real source of UI lag during heavy streaming.
    const wasAlive = sessionAliveState.has(sessionId);
    if (!wasAlive) sessionAliveState.add(sessionId);
    // Only treat the chunk as "agent thinking" if it carries real printable
    // content. Filters out cursor blinks, spinner-only frames without any
    // status text, and idle redraws that would otherwise flicker the
    // Working badge once per second. markSessionBusy() is internally
    // idempotent and only schedules a badge repaint on actual state
    // transitions (see anti-flicker design comment there).
    if (chunkLooksLikeAgentActivity(data)) {
      markSessionBusy(sessionId);
    }
    if (!wasAlive) schedulePatchSessionStateBadges(sessionId);
  }));
  ipcCleanups.push(window.api.onRestoreTabShortcut(() => {
    if (isBlockingModalOpen()) return;
    void restoreMostRecentClosedTab();
  }));

  ipcCleanups.push(window.api.onPtyExit((sessionId, exitCode) => {
    // Skip disposal if session is changing cwd (will be respawned)
    if (cwdChangingSessions.has(sessionId)) return;

    const entry = terminals.get(sessionId);
    if (entry) {
      entry.exited = true;
      entry.terminal.write(`\r\n\x1b[90m[Session ended with code ${exitCode}]\x1b[0m\r\n`, () => {
        scheduleTerminalViewportSync(sessionId, { refreshSearch: true });
      });
      // Dispose terminal after a short delay so the exit message is visible
      entry.exitTimeout = setTimeout(() => {
        const e = terminals.get(sessionId);
        if (e && e.exited) {
          if (e.titlePoll) clearInterval(e.titlePoll);
          e.terminal.dispose();
          e.wrapper.remove();
          terminals.delete(sessionId);
          removeTabUi(sessionId);
          if (activeSessionId === sessionId) {
            activeSessionId = null;
            updateSessionPromptGhost(null);
            const remaining = document.querySelectorAll('.tab');
            if (remaining.length > 0) switchToSession(remaining[remaining.length - 1].dataset.sessionId);
            else { emptyState.classList.remove('hidden'); updateStatusPanel(null); }
          }
          saveTabState();
          scheduleRenderSessionList();
        }
      }, 3000);
    }
    sessionAliveState.delete(sessionId);
    ensureSessionOrder();
    clearSessionBusy(sessionId);
    cwdChangingSessions.delete(sessionId);
    updateTabStatus(sessionId, false);
    schedulePatchSessionStateBadges(sessionId);
  }));

  const evictedUnsub = window.api.onPtyEvicted?.((sessionId) => {
    sessionAliveState.delete(sessionId);
    ensureSessionOrder();
    clearSessionBusy(sessionId);
    cwdChangingSessions.delete(sessionId);
    const entry = terminals.get(sessionId);
    if (entry) {
      if (entry.titlePoll) clearInterval(entry.titlePoll);
      entry.terminal.write('\r\n\x1b[90m[Session evicted to free capacity]\x1b[0m\r\n');
      entry.terminal.dispose();
      entry.wrapper.remove();
      terminals.delete(sessionId);
    }
    removeTabUi(sessionId);
    if (activeSessionId === sessionId) {
      activeSessionId = null;
      updateSessionPromptGhost(null);
      const remaining = document.querySelectorAll('.tab');
      if (remaining.length > 0) switchToSession(remaining[remaining.length - 1].dataset.sessionId);
      else { emptyState.classList.remove('hidden'); updateStatusPanel(null); }
    }
    renderSessionList();
    saveTabState();
  });
  if (evictedUnsub) ipcCleanups.push(evictedUnsub);

  let resizeTimer = null;
  const resizeObserver = new ResizeObserver(() => {
    if (resizeTimer) clearTimeout(resizeTimer);
    resizeTimer = setTimeout(() => {
      resizeTimer = null;
      fitActiveTerminal();
    }, 50);
  });
  resizeObserver.observe(terminalContainer);

  // Sidebar tab switching
  document.querySelectorAll('.sidebar-tab').forEach(tab => {
    tab.addEventListener('click', () => {
      currentSidebarTab = tab.dataset.tab;
      document.querySelectorAll('.sidebar-tab').forEach(t => t.classList.remove('active'));
      tab.classList.add('active');
      void refreshSessionList();
      window.api.updateSettings({ lastActiveTab: currentSidebarTab });
    });
  });

  // Settings modal
  btnSettings.addEventListener('click', () => { void openSettings(); });
  btnNewOptions?.addEventListener('click', (e) => {
    e.stopPropagation();
    void openNewSessionOptions();
  });
  btnNewSessionOptionsClose?.addEventListener('click', closeNewSessionOptions);
  btnNewSessionOptionsCancel?.addEventListener('click', closeNewSessionOptions);
  btnNewSessionOptionsStart?.addEventListener('click', () => {
    startNewSessionFromOptions().catch((err) => {
      showToast({ type: 'error', title: 'Could not start new session', body: String(err?.message || err) });
    });
  });
  newSessionOptionsOverlay?.addEventListener('click', (e) => { if (e.target === newSessionOptionsOverlay) closeNewSessionOptions(); });
  newSessionOptionsOverlay?.addEventListener('keydown', (e) => {
    if (newSessionOptionsOverlay.classList.contains('hidden')) return;
    if (e.key === 'Escape') {
      e.preventDefault();
      e.stopPropagation();
      closeNewSessionOptions();
      return;
    }
    if (e.key !== 'Tab') return;
    const focusable = getFocusableElements(newSessionOptionsOverlay);
    if (focusable.length === 0) return;
    const first = focusable[0];
    const last = focusable[focusable.length - 1];
    if (e.shiftKey && document.activeElement === first) {
      e.preventDefault();
      e.stopPropagation();
      last.focus();
    } else if (!e.shiftKey && document.activeElement === last) {
      e.preventDefault();
      e.stopPropagation();
      first.focus();
    }
  });

  // Home link — deselect active session
  document.getElementById('titlebar-home').addEventListener('click', showHome);
  settingsOverlay.querySelector('.settings-close').addEventListener('click', closeSettings);
  settingsOverlay.addEventListener('click', (e) => { if (e.target === settingsOverlay) closeSettings(); });
  settingsOverlay.addEventListener('keydown', (e) => {
    if (settingsOverlay.classList.contains('hidden')) return;
    if (e.key === 'Escape') {
      e.preventDefault();
      e.stopPropagation();
      closeSettings();
      return;
    }
    if (e.key !== 'Tab') return;
    const focusable = getFocusableElements(settingsOverlay);
    if (focusable.length === 0) return;
    const first = focusable[0];
    const last = focusable[focusable.length - 1];
    if (e.shiftKey && document.activeElement === first) {
      e.preventDefault();
      e.stopPropagation();
      last.focus();
    } else if (!e.shiftKey && document.activeElement === last) {
      e.preventDefault();
      e.stopPropagation();
      first.focus();
    }
  });

  // Theme switcher
  settingsOverlay.querySelectorAll('.theme-option').forEach(btn => {
    btn.addEventListener('click', () => {
      const theme = btn.dataset.theme;
      applyTheme(theme);
      window.api.updateSettings({ theme });
      settingsOverlay.querySelectorAll('.theme-option').forEach(b => b.classList.toggle('active', b.dataset.theme === theme));
    });
  });

  // Status panel
  btnToggleStatus.addEventListener('click', toggleStatusPanel);
  statusPanel.querySelector('.status-panel-close').addEventListener('click', () => {
    statusPanel.classList.add('collapsed');
    btnToggleStatus.classList.remove('active');
    fitActiveTerminal();
  });
  statusPanelBody.addEventListener('click', async (event) => {
    const copyButton = event.target.closest('.status-copy-session-id');
    if (copyButton) {
      const sessionId = copyButton.dataset.sessionId;
      if (!sessionId) return;

      try {
        await window.api.copyText(sessionId);
        showToast({ type: 'success', title: 'Session ID copied', body: sessionId });
      } catch {
        showToast({ type: 'error', title: 'Copy failed', body: 'Could not copy the session ID.' });
      }
      return;
    }

    const openDirectoryButton = event.target.closest('.status-open-session-directory');
    if (openDirectoryButton) {
      const sessionId = openDirectoryButton.dataset.sessionId;
      if (!sessionId) return;

      const result = await window.api.openSessionDirectory(sessionId);
      if (!result?.ok) {
        showToast({
          type: 'error',
          title: 'Could not open session directory',
          body: result?.error || sessionId,
        });
      }
      return;
    }

    const openFilesDirectoryButton = event.target.closest('.status-open-session-files-directory');
    if (openFilesDirectoryButton) {
      const sessionId = openFilesDirectoryButton.dataset.sessionId;
      if (!sessionId) return;

      const result = await window.api.openSessionFilesDirectory(sessionId);
      if (!result?.ok) {
        showToast({
          type: 'error',
          title: 'Could not open files folder',
          body: result?.error || sessionId,
        });
      }
      return;
    }
  });
  statusPanelBody.addEventListener('mouseover', (event) => {
    const fileItem = event.target.closest('.status-file-item[data-diff]');
    if (!fileItem || !statusPanelBody.contains(fileItem)) return;
    const diff = decodeURIComponent(fileItem.dataset.diff || '');
    if (!diff) return;
    showStatusDiffPopover(fileItem, diff);
  });
  statusPanelBody.addEventListener('mouseout', (event) => {
    const fileItem = event.target.closest('.status-file-item[data-diff]');
    if (!fileItem) return;
    const next = event.relatedTarget;
    if (fileItem.contains(next) || statusDiffPopover?.contains(next)) return;
    scheduleHideStatusDiffPopover();
  });

  // Tab scroll buttons
  tabScrollLeft.addEventListener('click', () => {
    tabsScrollArea.scrollBy({ left: -200, behavior: 'smooth' });
  });
  tabScrollRight.addEventListener('click', () => {
    tabsScrollArea.scrollBy({ left: 200, behavior: 'smooth' });
  });
  tabsScrollArea.addEventListener('scroll', updateTabScrollButtons);
  new ResizeObserver(updateTabScrollButtons).observe(tabsScrollArea);

  // Notifications
  document.getElementById('btn-notifications').addEventListener('click', toggleNotificationPanel);
  document.getElementById('btn-close-notifications').addEventListener('click', () => notificationPanel.classList.add('hidden'));
  document.getElementById('btn-clear-notifications').addEventListener('click', async () => {
    await window.api.clearAllNotifications();
    await refreshNotifications();
  });

  document.addEventListener('click', (e) => {
    if (!notificationPanel.classList.contains('hidden') &&
        !notificationPanel.contains(e.target) &&
        !e.target.closest('#btn-notifications')) {
      notificationPanel.classList.add('hidden');
    }
    if (!feedbackPanel.classList.contains('hidden') &&
        !feedbackPanel.contains(e.target) &&
        !e.target.closest('#btn-feedback')) {
      feedbackPanel.classList.add('hidden');
    }
  });

  // Feedback
  document.getElementById('btn-feedback').addEventListener('click', toggleFeedbackPanel);
  document.getElementById('btn-close-feedback').addEventListener('click', () => feedbackPanel.classList.add('hidden'));
  document.getElementById('btn-report-bug').addEventListener('click', () => openFeedbackIssue('bug'));
  document.getElementById('btn-request-feature').addEventListener('click', () => openFeedbackIssue('feature'));

  ipcCleanups.push(window.api.onNotification((notification) => {
    showToast(notification);
    refreshNotifications();
  }));

  ipcCleanups.push(window.api.onNotificationClick(async (notification) => {
    if (notification.sessionId) {
      await openSession(notification.sessionId);
    }
  }));

  startupLoading.setStatus({
    titleText: 'Loading notifications...',
    messageText: 'Syncing alerts and startup status...',
  });
  await refreshNotifications();

  startupLoading.setStatus({
    titleText: 'Restoring workspace...',
    messageText: 'Reopening live sessions and previously open tabs...',
  });
  const validIds = await getAllValidSessionIds();

  // Restore previously active sessions without forcing them into tabs.
  if (Array.isArray(settings.activeSessions) && settings.activeSessions.length > 0) {
    const activeSessionsToRestore = settings.activeSessions.filter(id => validIds.has(id));
    await Promise.allSettled(activeSessionsToRestore.map(id => window.api.openSession(id)));
    await updateSessionBusyStates();
  }

  // Restore previously open tabs
  if (settings.openTabs && settings.openTabs.length > 0) {
    const tabsToRestore = settings.openTabs.filter(id => validIds.has(id));
    await Promise.allSettled(tabsToRestore.map(id => openSession(id)));

    // Restore tab groups (with validation)
    if (Array.isArray(settings.tabGroups) && settings.tabGroups.length > 0) {
      tabGroups = settings.tabGroups.filter(g =>
        g && typeof g.id === 'string' && typeof g.name === 'string' &&
        Array.isArray(g.tabIds) && g.tabIds.some(id => openTabIds.has(id))
      ).map(g => ({
        id: g.id,
        name: (g.name || 'Group').substring(0, 50),
        color: g.color || GROUP_COLORS[0].value,
        collapsed: !!g.collapsed,
        tabIds: g.tabIds.filter(id => openTabIds.has(id)),
      }));
    }

    // Restore session order
    if (Array.isArray(settings.sessionOrder) && settings.sessionOrder.length > 0) {
      sessionOrder = settings.sessionOrder.filter(id => sessionAliveState.has(id));
    }

    normalizeSessionOrderToActiveList();
    // Tabs were appended in openSession resolution order (which can differ
    // from saved sessionOrder due to Promise.allSettled). Realign now that
    // the canonical order is loaded so Ctrl+Tab and visual order agree.
    syncTabStripOrder();

    renderSessionList();

    // Switch to the previously active tab
    if (settings.activeTab && openTabIds.has(settings.activeTab)) {
      switchToSession(settings.activeTab);
    }
  } else {
    renderSessionList();
  }

  startupLoading.setStatus({
    titleText: 'Finishing startup...',
    messageText: 'DeepSky is almost ready.',
  });
}

function applyTheme(theme) {
  currentTheme = theme;
  document.documentElement.setAttribute('data-theme', theme);

  // Update existing terminals
  const xtermTheme = XTERM_THEMES[theme];
  for (const [, entry] of terminals) {
    entry.terminal.options.theme = xtermTheme;
  }

  // Update settings modal active state
  settingsOverlay.querySelectorAll('.theme-option').forEach(b => b.classList.toggle('active', b.dataset.theme === theme));
}

async function openSettings() {
  lastFocusedElementBeforeSettings = document.activeElement;
  const settings = await window.api.getSettings();
  applySettingsToControls(settings);
  settingsOverlay.classList.remove('hidden');
  settingsOverlay.setAttribute('aria-hidden', 'false');
  populateAboutSection();
  requestAnimationFrame(() => {
    (settingsOverlay.querySelector('.settings-tab.active') || settingsOverlay.querySelector('.settings-close'))?.focus();
  });
}

async function openNewSessionOptions() {
  const settings = await window.api.getSettings();
  applySettingsToControls(settings);
  const availability = getAnyOneOffLauncherAvailability(settings);
  if (!availability.available) {
    showToast({ type: 'error', title: 'New session unavailable', body: availability.reason });
    return;
  }
  updateOneOffLauncherChoices(settings);
  lastFocusedElementBeforeNewSessionOptions = document.activeElement;

  const defaultLauncher = settings.useAgencyCopilot && settings.agencyAvailable !== false
    ? 'agency'
    : availability.launcher;
  newSessionLauncherCopilotInput.checked = defaultLauncher === 'copilot';
  newSessionLauncherAgencyInput.checked = defaultLauncher === 'agency';
  newSessionArgsInput.value = settings.copilotArgs || '';

  newSessionOptionsOverlay.classList.remove('hidden');
  newSessionOptionsOverlay.setAttribute('aria-hidden', 'false');
  requestAnimationFrame(() => {
    (newSessionArgsInput || btnNewSessionOptionsStart)?.focus();
  });
}

function closeNewSessionOptions() {
  newSessionOptionsOverlay.classList.add('hidden');
  newSessionOptionsOverlay.setAttribute('aria-hidden', 'true');
  lastFocusedElementBeforeNewSessionOptions?.focus?.();
  lastFocusedElementBeforeNewSessionOptions = null;
}

async function startNewSessionFromOptions() {
  const launcher = newSessionLauncherAgencyInput.checked ? 'agency' : 'copilot';
  const settings = window._cachedSettings || await window.api.getSettings();
  const availability = getOneOffLauncherAvailability(settings, launcher);
  if (!availability.available) {
    showToast({ type: 'error', title: 'New session unavailable', body: availability.reason });
    return;
  }
  const launcherArgs = newSessionArgsInput.value.trim();
  closeNewSessionOptions();
  await newSession({ launcher, launcherArgs });
}

// Settings tab switching
settingsOverlay.querySelectorAll('.settings-tab').forEach(tab => {
  tab.addEventListener('click', () => {
    const target = tab.dataset.settingsTab;
    settingsOverlay.querySelectorAll('.settings-tab').forEach(t => t.classList.toggle('active', t.dataset.settingsTab === target));
    settingsOverlay.querySelectorAll('.settings-tab-panel').forEach(p => p.classList.toggle('active', p.dataset.settingsPanel === target));
  });
});

aboutOpenChangelogBtn?.addEventListener('click', () => {
  window.api.openExternal(ABOUT_CHANGELOG_URL);
});

aboutContactEmailBtn?.addEventListener('click', () => {
  window.api.openExternal(CONTACT_EMAIL_URL);
});

aboutContactTeamsBtn?.addEventListener('click', () => {
  window.api.openExternal(CONTACT_TEAMS_URL);
});

aboutOpenBrochureBtn?.addEventListener('click', async () => {
  const result = await window.api.openBrochure();
  if (!result?.ok) {
    showToast({
      type: 'error',
      title: 'Could not open brochure',
      body: result?.error || 'Could not open the online DeepSky brochure.',
    });
  }
});

function appendInlineMarkdown(target, text) {
  const tokens = String(text || '')
    .split(/(\*\*[^*]+\*\*|`[^`]+`|\[[^\]]+\]\([^)]+\))/g)
    .filter(Boolean);

  if (!tokens.length) {
    target.textContent = text || '';
    return;
  }

  for (const token of tokens) {
    const strongMatch = token.match(/^\*\*(.+)\*\*$/);
    if (strongMatch) {
      const strong = document.createElement('strong');
      strong.textContent = strongMatch[1];
      target.appendChild(strong);
      continue;
    }

    const codeMatch = token.match(/^`(.+)`$/);
    if (codeMatch) {
      const code = document.createElement('code');
      code.textContent = codeMatch[1];
      target.appendChild(code);
      continue;
    }

    const linkMatch = token.match(/^\[([^\]]+)\]\([^)]+\)$/);
    target.appendChild(document.createTextNode(linkMatch ? linkMatch[1] : token));
  }
}

function createAboutReleaseCard(release, currentVersion) {
  const isCurrentBuild = release.version === currentVersion;
  const card = document.createElement('section');
  card.className = 'about-release-card';
  if (isCurrentBuild) {
    card.classList.add('current');
  }

  const header = document.createElement('div');
  header.className = 'about-release-header';

  const titleRow = document.createElement('div');
  titleRow.className = 'about-release-title-row';

  const versionEl = document.createElement('div');
  versionEl.className = 'about-release-version';
  versionEl.textContent = release.version;
  titleRow.appendChild(versionEl);

  if (isCurrentBuild) {
    const badge = document.createElement('span');
    badge.className = 'about-release-badge';
    badge.textContent = 'Current build';
    titleRow.appendChild(badge);
  }

  const dateEl = document.createElement('div');
  dateEl.className = 'about-release-date';
  dateEl.textContent = release.date;

  header.appendChild(titleRow);
  header.appendChild(dateEl);
  card.appendChild(header);

  for (const section of release.sections) {
    if (!section.items.length) {
      continue;
    }

    const sectionEl = document.createElement('div');
    sectionEl.className = 'about-release-section';

    const sectionTitle = document.createElement('div');
    sectionTitle.className = 'about-release-section-title';
    sectionTitle.textContent = section.title;
    sectionEl.appendChild(sectionTitle);

    const list = document.createElement('ul');
    list.className = 'about-release-list';

    for (const item of section.items) {
      const listItem = document.createElement('li');
      appendInlineMarkdown(listItem, item);
      list.appendChild(listItem);
    }

    sectionEl.appendChild(list);
    card.appendChild(sectionEl);
  }

  return card;
}

function renderAboutChangelog(changelog, version) {
  if (!aboutChangelogEl) {
    return;
  }

  aboutChangelogEl.replaceChildren();
  const releases = getRecentChangelogReleases(changelog, ABOUT_CHANGELOG_RELEASE_LIMIT, { currentVersion: version });

  if (aboutReleaseMetaEl) {
    if (!releases.length) {
      aboutReleaseMetaEl.textContent = `App version v${version}`;
    } else {
      aboutReleaseMetaEl.textContent =
        `App version v${version} - showing the latest ${releases.length} changelog entr${releases.length === 1 ? 'y' : 'ies'}.`;
    }
  }

  if (!releases.length) {
    const emptyState = document.createElement('div');
    emptyState.className = 'about-changelog-empty';
    emptyState.textContent = 'No changelog available.';
    aboutChangelogEl.appendChild(emptyState);
    return;
  }

  for (const release of releases) {
    aboutChangelogEl.appendChild(createAboutReleaseCard(release, version));
  }
}

async function populateAboutSection() {
  const version = await window.api.getVersion();
  const changelog = await window.api.getChangelog();
  const brochureAvailability = await window.api.getBrochureAvailability();
  if (aboutVersionEl) aboutVersionEl.textContent = `v${version}`;
  if (aboutVersionTabEl) aboutVersionTabEl.textContent = `DeepSky v${version}`;
  if (aboutOpenBrochureBtn) {
    aboutOpenBrochureBtn.disabled = false;
    aboutOpenBrochureBtn.title = 'Open the online DeepSky brochure';
  }
  renderAboutChangelog(changelog, version);

  // Restore current update status
  const updateData = await window.api.getUpdateStatus();
  if (updateData) handleUpdateStatus(updateData);
}

function handleUpdateStatus(data) {
  const statusEl = document.getElementById('update-status');
  const progressEl = document.getElementById('update-progress');
  const progressBar = document.getElementById('update-progress-bar');
  if (!statusEl || !progressEl || !progressBar) return;

  statusEl.classList.remove('hidden');
  progressEl.classList.add('hidden');
  if (btnUpdateInstall) {
    btnUpdateInstall.classList.add('hidden');
    btnUpdateInstall.disabled = false;
  }

  switch (data.status) {
    case 'checking':
      statusEl.textContent = 'Checking for updates…';
      break;
    case 'available':
      statusEl.textContent = `Downloading ${getUpdateVersionLabel(data.info)}…`;
      statusEl.className = 'update-status';
      setUpdateBadge(true, data.info?.version, false);
      break;
    case 'not-available':
      statusEl.textContent = 'You\'re on the latest version.';
      statusEl.className = 'update-status';
      setUpdateBadge(false);
      break;
    case 'downloading':
      statusEl.textContent = `Downloading… ${Math.round(data.progress?.percent || 0)}%`;
      progressEl.classList.remove('hidden');
      progressBar.style.width = `${data.progress?.percent || 0}%`;
      break;
    case 'downloaded':
      statusEl.textContent = `${getUpdateVersionLabel(data.info)} is downloaded and ready to install.`;
      statusEl.className = 'update-status update-available';
      if (btnUpdateInstall) {
        btnUpdateInstall.textContent = `Restart now to install ${getUpdateVersionLabel(data.info)}`;
        btnUpdateInstall.classList.remove('hidden');
      }
      setUpdateBadge(true, data.info?.version, true);
      break;
    case 'pending-install':
      statusEl.textContent = `${getUpdateVersionLabel(data.info)} is ready to install.`;
      statusEl.className = 'update-status update-available';
      if (btnUpdateInstall) {
        btnUpdateInstall.textContent = `Restart now to install ${getUpdateVersionLabel(data.info)}`;
        btnUpdateInstall.classList.remove('hidden');
      }
      setUpdateBadge(true, data.info?.version, false);
      break;
    case 'installing':
      statusEl.textContent = `Installing ${getUpdateVersionLabel(data.info)}…`;
      statusEl.className = 'update-status update-available';
      progressEl.classList.remove('hidden');
      progressBar.style.width = '35%';
      if (btnUpdateInstall) {
        btnUpdateInstall.textContent = 'Restarting...';
        btnUpdateInstall.disabled = true;
        btnUpdateInstall.classList.remove('hidden');
      }
      if (startupInstallInProgress) showStartupUpdateInstallStatus(data, 35);
      break;
    case 'error':
      statusEl.textContent = `Update error: ${data.error}`;
      statusEl.className = 'update-status update-error';
      if (data.retryable && data.info?.version && btnUpdateInstall) {
        btnUpdateInstall.textContent = `Try restart again for ${getUpdateVersionLabel(data.info)}`;
        btnUpdateInstall.disabled = false;
        btnUpdateInstall.classList.remove('hidden');
      }
      if (startupInstallInProgress) {
        recoverFromStartupInstallError(data.error);
      }
      break;
    case 'idle':
      statusEl.classList.add('hidden');
      break;
  }
}

function setUpdateBadge(show, version, notify) {
  let badge = document.getElementById('update-badge');
  if (show) {
    if (!badge) {
      badge = document.createElement('span');
      badge.id = 'update-badge';
      badge.className = 'update-badge';
      badge.setAttribute('aria-hidden', 'true');
      btnSettings.appendChild(badge);
    }
    badge.textContent = '↑';
    badge.title = version ? `v${version} available` : 'Update available';
    badge.classList.remove('hidden');
    if (notify) {
      showToast({ type: 'info', title: 'Update ready', body: `${getUpdateVersionLabel({ version })} downloaded — will apply before DeepSky opens on next launch.` });
    }
  } else if (badge) {
    badge.classList.add('hidden');
    badge.setAttribute('aria-hidden', 'true');
  }
}

function closeSettings() {
  settingsOverlay.classList.add('hidden');
  settingsOverlay.setAttribute('aria-hidden', 'true');
  lastFocusedElementBeforeSettings?.focus?.();
  lastFocusedElementBeforeSettings = null;
}

function ensureStatusDiffPopover() {
  if (statusDiffPopover) return statusDiffPopover;
  statusDiffPopover = document.createElement('div');
  statusDiffPopover.className = 'status-diff-popover hidden';
  statusDiffPopover.addEventListener('mouseenter', () => {
    if (statusDiffHideTimer) {
      clearTimeout(statusDiffHideTimer);
      statusDiffHideTimer = null;
    }
  });
  statusDiffPopover.addEventListener('mouseleave', () => {
    scheduleHideStatusDiffPopover();
  });
  document.body.appendChild(statusDiffPopover);
  return statusDiffPopover;
}

function scheduleHideStatusDiffPopover() {
  if (statusDiffHideTimer) clearTimeout(statusDiffHideTimer);
  statusDiffHideTimer = setTimeout(() => {
    statusDiffPopover?.classList.add('hidden');
    statusDiffHideTimer = null;
  }, 120);
}

function hideStatusDiffPopover() {
  if (statusDiffHideTimer) {
    clearTimeout(statusDiffHideTimer);
    statusDiffHideTimer = null;
  }
  statusDiffPopover?.classList.add('hidden');
}

function showStatusDiffPopover(anchorEl, diffText) {
  if (!anchorEl || !diffText) return;
  const popover = ensureStatusDiffPopover();
  if (statusDiffHideTimer) {
    clearTimeout(statusDiffHideTimer);
    statusDiffHideTimer = null;
  }

  popover.innerHTML = `
    <div class="status-diff-popover-header">Git diff preview</div>
    <div class="status-diff-popover-body">${renderDiffPreviewHtml(diffText)}</div>
  `;
  popover.classList.remove('hidden');

  const rect = anchorEl.getBoundingClientRect();
  const popRect = popover.getBoundingClientRect();
  let left = rect.right + 12;
  if (left + popRect.width > window.innerWidth - 12) {
    left = Math.max(12, rect.left - popRect.width - 12);
  }
  let top = rect.top;
  if (top + popRect.height > window.innerHeight - 12) {
    top = Math.max(12, window.innerHeight - popRect.height - 12);
  }
  popover.style.left = `${left}px`;
  popover.style.top = `${top}px`;
}

async function refreshSessionList() {
  allSessions = await window.api.listSessions({ scope: getSidebarSessionScope() });
  mergePendingSessionStarts();
  const validIds = new Set([...allSessions.map(s => s.id), ...terminals.keys(), ...pendingSessionStarts.keys()]);
  for (const session of allSessions) {
    if (terminals.has(session.id)) {
      updateTabTitle(session.id, session.title);
    }
  }
  // Prune stale entries from tracking maps
  for (const id of sessionLastUsed.keys()) {
    if (!validIds.has(id)) sessionLastUsed.delete(id);
  }
  await updateSessionBusyStates();
  scheduleRenderSessionList();
  updateSessionPromptGhost(activeSessionId);
  if (!activeSessionId) emptyState.classList.remove('hidden');
}

// Compact, stable fingerprint of everything that affects the sidebar DOM
// structure (NOT badges or active highlight — those are patched in place).
// If two consecutive calls produce the same string, renderSessionList() can
// safely skip the destructive innerHTML='' + rebuild.
function computeSidebarFingerprint(displayed) {
  const parts = [
    currentSidebarTab,
    searchQuery || '',
    sidebarCollapsed ? '1' : '0',
    typeof historyShowsAll !== 'undefined' && historyShowsAll ? 'a' : 'r',
    Array.isArray(tabGroups)
      ? tabGroups
          .map(g =>
            `${g.id}:${g.collapsed ? 1 : 0}:${g.color || ''}:${g.name || ''}:${(g.tabIds || []).join(',')}`
          )
          .join('|')
      : '',
    // displayed is already in render order; encode minimal per-item visual state
    displayed
      .map(s => {
        const tags = Array.isArray(s.tags) ? s.tags.join(',') : '';
        const res = Array.isArray(s.resources)
          ? s.resources.map(r => `${r.type || ''}:${r.id || ''}`).join(',')
          : '';
        return `${s.id}|${s.title || ''}|${s.lastAssistantHasPR ? 1 : 0}|${tags}|${res}`;
      })
      .join(';'),
  ];
  return parts.join('§');
}

async function getAllValidSessionIds() {
  const sessions = await window.api.listSessions({ scope: 'all' });
  return new Set([
    ...sessions.map(session => session.id),
    ...allSessions.map(session => session.id),
    ...terminals.keys(),
  ]);
}

const BUSY_THRESHOLD_MS = 1500;
// Background poll that reconciles renderer state with the main process.
// Bumped from 3000 → 5000 ms to reduce IPC chatter / DOM work; the
// per-session debounce timer is the primary source of truth so this poll
// is just a safety-net for renderer-attach-after-spawn cases.
const STATUS_POLL_MS = 5000;
// Consecutive idle polls required before transitioning Working → Waiting.
// The primary "go to Waiting" path is the per-session debounce timer (see
// markSessionBusy + sessionBusyTimers). This poll-based decay is just a
// fallback for situations where the debounce timer never fired (e.g. session
// was already busy before the renderer attached). Keep it at 1 so the
// fallback also flips within ~3s instead of the previous ~39s.
const IDLE_GRACE_POLLS = 1;
// Time (ms) of pty silence after which a session flips from Working to
// Waiting. Bumped 3500 → 6000 so the natural multi-second pauses inside a
// single agent response (tool calls, file IO, model "thinking" gaps) don't
// flap the badge mid-response. The user only sees Waiting after a real
// 6-second lull, which empirically corresponds to "the agent is done".
const BUSY_DEBOUNCE_MS = 6000;
// Anti-flicker hysteresis: minimum dwell time in the Waiting state. After
// any Working → Waiting transition, the badge stays Waiting for at least
// this many ms — any single new "activity" chunk inside the window resets
// the debounce timer but does NOT promote back to Working. Sustained
// activity past the window still wins. Bumped 1200 → 2500 because shorter
// holds still let bursts flash green for a frame.
const BUSY_HOLD_AFTER_WAITING_MS = 2500;
// Mirror of the above for the opposite direction: after a Waiting →
// Working transition, the badge stays Working for at least this many ms
// before the debounce timer is allowed to flip it back to Waiting. Without
// this, a single isolated activity chunk would paint the dot green and the
// debounce-fired Waiting could land within ~6s, producing a visible
// green-yellow flicker on what should have been a stable Waiting badge.
const BUSY_HOLD_AFTER_WORKING_MS = 2000;
// Copilot CLI emits ambient pty:data chunks while *idle* — cursor blinks,
// input-area redraws, hint text refreshes — that are mostly ANSI escape
// sequences with little or no printable content. If every chunk reset the
// busy debounce timer, the Working badge would re-arm on every cursor blink
// and flicker between Working/Waiting forever. We strip ANSI and require a
// minimum amount of *real* printable content before treating a chunk as
// agent activity. Real model output streams many characters per chunk; the
// spinner with a status line (e.g. "⠋ Reasoning...") still easily exceeds
// this threshold. A solitary keystroke echo (1-2 chars) does not.
const BUSY_MIN_PRINTABLE_CHARS = 6;
const ANSI_ESCAPE_RE = /\x1b(?:\[[0-?]*[ -/]*[@-~]|\][^\x07]*(?:\x07|\x1b\\)|[@-_])/g;
const sessionIdleCount = new Map();

// Window (ms) after a `resizePty` call during which incoming pty:data
// chunks are NOT allowed to promote a session to Working. The CLI process
// receives SIGWINCH-equivalent and redraws its prompt/status line in
// response to the resize, producing chunks that look identical to live
// agent output. This is the #1 cause of "switching to a session paints
// the badge WORKING even though the agent is idle" flicker the user
// reported. Sustained activity past this window still wins normally.
const BUSY_RESIZE_SUPPRESS_MS = 1500;
// Wall-clock timestamp (ms) of the last `resizePty` call per session.
// markSessionBusy() consults this to skip the Waiting → Working promotion
// path while the CLI is mid-redraw from a resize event.
const sessionResizeAt = new Map();

// Forwards a resize to main and stamps the session's resize-suppression
// window. Must be used in place of the underlying IPC resize api from every
// renderer call site so the busy-state machine knows to ignore the
// downstream prompt-redraw chunks.
function trackedResizePty(sessionId, cols, rows) {
  if (sessionId) sessionResizeAt.set(sessionId, Date.now());
  try { window.api.resizePty(sessionId, cols, rows); } catch (_) { /* noop */ }
}

function chunkLooksLikeAgentActivity(data) {
  let text = data;
  if (typeof text !== 'string') {
    if (text && typeof text.toString === 'function') text = text.toString('utf8');
    else return false;
  }
  if (!text) return false;
  const stripped = text.replace(ANSI_ESCAPE_RE, '');
  let printable = 0;
  for (let i = 0; i < stripped.length; i++) {
    const code = stripped.charCodeAt(i);
    // Skip ASCII control chars (0x00–0x1F including \r \n \t) and DEL.
    if (code <= 0x20 || code === 0x7f) continue;
    printable++;
    if (printable >= BUSY_MIN_PRINTABLE_CHARS) return true;
  }
  return false;
}

// Tracks the wall-clock time of the last Working↔Waiting transition per
// session. markSessionBusy() reads this to enforce
// BUSY_HOLD_AFTER_WAITING_MS hysteresis so a single stray chunk arriving
// right after the badge flipped to Waiting can't flash it green again.
const sessionBusyStateChangedAt = new Map();

// Centralized cleanup so every "session is gone / not busy anymore" code
// path stays in sync (timer + busy flag + idle counter). The previous
// scattered `sessionBusyState.delete` / `sessionIdleCount.delete` pairs
// were prone to leaking the new debounce timer.
function clearSessionBusy(sessionId) {
  const timer = sessionBusyTimers.get(sessionId);
  if (timer !== undefined) {
    clearTimeout(timer);
    sessionBusyTimers.delete(sessionId);
  }
  sessionBusyState.delete(sessionId);
  sessionIdleCount.delete(sessionId);
  sessionBusyStateChangedAt.delete(sessionId);
  sessionResizeAt.delete(sessionId);
}

// Mark a session as Working *now* and schedule an automatic flip back to
// Waiting after BUSY_DEBOUNCE_MS of silence. Called from the pty:data
// listener — every chunk resets the timer.
//
// Anti-flicker design:
//   1. If the session is already Working, we just bump the silence timer.
//      No badge work happens — the rAF schedulePatch is skipped because the
//      visual state hasn't changed.
//   2. If the session is currently Waiting but flipped to Waiting very
//      recently (within BUSY_HOLD_AFTER_WAITING_MS), we do NOT promote it
//      back to Working on a single chunk. We still extend the timer so a
//      sustained stream eventually wins, but a one-off CLI status line
//      can't paint the dot green for half a second.
//   3. Only on a real Waiting → Working transition do we touch the badge.
//   4. Resize-suppression: if the session was resized within the last
//      BUSY_RESIZE_SUPPRESS_MS, refuse promotion entirely — those chunks
//      are the CLI redrawing its prompt in response to SIGWINCH, NOT real
//      agent activity. Switching to a session must not paint WORKING just
//      because the terminal got resized.
function markSessionBusy(sessionId) {
  const wasBusy = sessionBusyState.get(sessionId) === true;
  const now = Date.now();

  // Re-arm the silence timer regardless of whether we flip state below.
  const existing = sessionBusyTimers.get(sessionId);
  if (existing !== undefined) clearTimeout(existing);
  const timer = setTimeout(() => {
    sessionBusyTimers.delete(sessionId);
    if (!sessionBusyState.get(sessionId)) return;
    // Minimum-Working-dwell hysteresis: don't flip back to Waiting if we
    // just transitioned to Working within BUSY_HOLD_AFTER_WORKING_MS ago.
    // Without this, a single isolated activity chunk during a long quiet
    // period could promote → debounce-fire → flicker green-yellow.
    const lastTransition = sessionBusyStateChangedAt.get(sessionId);
    const tNow = Date.now();
    if (lastTransition !== undefined && (tNow - lastTransition) < BUSY_HOLD_AFTER_WORKING_MS) {
      // Re-arm for the remaining hold time so we still flip once the
      // dwell window has expired (assuming no new activity in the meantime).
      const remaining = BUSY_HOLD_AFTER_WORKING_MS - (tNow - lastTransition);
      const reTimer = setTimeout(() => {
        sessionBusyTimers.delete(sessionId);
        if (sessionBusyState.get(sessionId)) {
          sessionBusyState.set(sessionId, false);
          sessionBusyStateChangedAt.set(sessionId, Date.now());
          schedulePatchSessionStateBadges(sessionId);
        }
      }, remaining);
      sessionBusyTimers.set(sessionId, reTimer);
      return;
    }
    sessionBusyState.set(sessionId, false);
    sessionBusyStateChangedAt.set(sessionId, tNow);
    schedulePatchSessionStateBadges(sessionId);
  }, BUSY_DEBOUNCE_MS);
  sessionBusyTimers.set(sessionId, timer);

  if (wasBusy) {
    // Already Working — timer reset above is the only state change. Skip
    // badge patch (visual state unchanged) so streaming output doesn't
    // queue per-chunk DOM work.
    sessionIdleCount.delete(sessionId);
    return;
  }

  // Resize-suppression: chunks arriving in the wake of a SIGWINCH-equiv
  // are CLI prompt redraws, NOT live agent activity. Don't promote.
  const lastResize = sessionResizeAt.get(sessionId);
  if (lastResize !== undefined && (now - lastResize) < BUSY_RESIZE_SUPPRESS_MS) {
    return;
  }

  const lastChange = sessionBusyStateChangedAt.get(sessionId);
  if (lastChange !== undefined && (now - lastChange) < BUSY_HOLD_AFTER_WAITING_MS) {
    // Hold-window hysteresis: ignore this lone "activity" chunk for badge
    // purposes. Timer is reset above so future chunks can still promote us
    // once the window expires.
    return;
  }

  sessionBusyState.set(sessionId, true);
  sessionBusyStateChangedAt.set(sessionId, now);
  sessionIdleCount.delete(sessionId);
  schedulePatchSessionStateBadges(sessionId);
}

async function updateSessionBusyStates() {
  try {
    const activeSessions = await window.api.getActiveSessions();
    const now = Date.now();
    const newAlive = new Set();
    for (const s of activeSessions) {
      newAlive.add(s.id);
      // Skip sessions that have an active debounce timer — the timer is
      // the source of truth in that case and we don't want the poll to
      // race with it (would cause Working badge to flicker).
      if (sessionBusyTimers.has(s.id)) continue;
      const recentOutput = s.lastDataAt && (now - s.lastDataAt) < BUSY_THRESHOLD_MS;
      const wasBusy = sessionBusyState.get(s.id) === true;
      const wasKnown = sessionBusyState.has(s.id);
      if (wasBusy) {
        // Decay only — the per-session debounce timer (markSessionBusy) is
        // the only path that *establishes* busy=true. Without this, every
        // ambient pty chunk recorded by main.js (cursor blinks, etc.) would
        // re-flip the badge here and cause Working/Waiting flicker.
        if (recentOutput) {
          sessionIdleCount.delete(s.id);
        } else {
          const count = (sessionIdleCount.get(s.id) || 0) + 1;
          sessionIdleCount.set(s.id, count);
          if (count >= IDLE_GRACE_POLLS) {
            // Respect Working-dwell hysteresis even on poll-driven decay so
            // a short Working flash from a stale poll cycle can't immediately
            // flip back. Stamp the transition timestamp so the next
            // markSessionBusy() applies BUSY_HOLD_AFTER_WAITING_MS correctly.
            const lastChange = sessionBusyStateChangedAt.get(s.id);
            if (lastChange !== undefined && (now - lastChange) < BUSY_HOLD_AFTER_WORKING_MS) {
              // Skip this decay tick; try again next poll.
              continue;
            }
            sessionBusyState.set(s.id, false);
            sessionBusyStateChangedAt.set(s.id, now);
            sessionIdleCount.delete(s.id);
          }
        }
      } else if (!wasKnown && recentOutput) {
        // Bootstrap: renderer attached after the session was already
        // producing output, so the debounce timer never fired for it.
        sessionBusyState.set(s.id, true);
        sessionBusyStateChangedAt.set(s.id, now);
      } else if (!wasKnown) {
        sessionBusyState.set(s.id, false);
        // No timestamp stamp here — this is the initial "nothing happened
        // yet" state, not a real transition. Leaving lastChange undefined
        // means the next markSessionBusy() will promote immediately, which
        // is the correct behaviour for a freshly-attached idle session.
      }
    }
    // Sync alive state from main process
    sessionAliveState.clear();
    for (const id of newAlive) sessionAliveState.add(id);
    // Clear stale entries
    for (const id of [...sessionBusyState.keys(), ...sessionBusyTimers.keys()]) {
      if (!newAlive.has(id)) clearSessionBusy(id);
    }
  } catch {}
}

function patchSessionStateBadges() {
  document.querySelectorAll('.session-item[data-session-id]').forEach(el => {
    const sessionId = el.dataset.sessionId;
    const session = allSessions.find(s => s.id === sessionId);
    if (!session) return;

    const isRunning = sessionAliveState.has(sessionId);
    const isBusy = sessionBusyState.get(sessionId) || false;
    const hasPR = session.lastAssistantHasPR === true;
    const isStarting = pendingSessionStarts.has(sessionId);
    const { label, cls, tip } = deriveSessionState({
      isRunning,
      isActive: sessionId === activeSessionId,
      hasPR,
      isHistory: currentSidebarTab === 'history',
      isBusy,
      isStarting
    });

    // Keep the .running class in sync with sessionAliveState so the side
    // dot (CSS ::after) appears/disappears immediately. The fingerprint
    // guard in renderSessionList() no longer triggers a full rebuild when
    // only the alive flag changes, so we must patch it here.
    if (isRunning && !el.classList.contains('running')) {
      el.classList.add('running');
    } else if (!isRunning && el.classList.contains('running')) {
      el.classList.remove('running');
    }
    // .busy mirrors WORKING (true) vs WAITING (false) so the side dot
    // shows green when actively reasoning, yellow when idle.
    if (isRunning && isBusy && !el.classList.contains('busy')) {
      el.classList.add('busy');
    } else if ((!isRunning || !isBusy) && el.classList.contains('busy')) {
      el.classList.remove('busy');
    }

    const badge = el.querySelector('.session-state');
    if (badge && (badge.textContent !== label || !badge.classList.contains(cls))) {
      badge.className = 'session-state ' + cls;
      badge.textContent = label;
      badge.title = tip;
    }
  });
}

// Patch a single session's badge without scanning the entire sidebar.
// Used by schedulePatchSessionStateBadges to keep per-chunk pty:data updates
// cheap (O(1) per session instead of O(N) DOM scans on every chunk).
function patchSessionStateBadgeForId(sessionId) {
  if (!sessionId) return;
  let el = null;
  try {
    el = sessionList.querySelector(`.session-item[data-session-id="${CSS.escape(sessionId)}"]`);
  } catch {
    return;
  }
  if (!el) return;
  const session = allSessions.find(s => s.id === sessionId);
  if (!session) return;

  const isRunning = sessionAliveState.has(sessionId);
  const isBusy = sessionBusyState.get(sessionId) || false;
  const hasPR = session.lastAssistantHasPR === true;
  const { label, cls, tip } = deriveSessionState({
    isRunning,
    isActive: sessionId === activeSessionId,
    hasPR,
    isHistory: currentSidebarTab === 'history',
    isBusy
  });

  // See patchSessionStateBadges() for why .running and .busy are patched here too.
  if (isRunning && !el.classList.contains('running')) {
    el.classList.add('running');
  } else if (!isRunning && el.classList.contains('running')) {
    el.classList.remove('running');
  }
  if (isRunning && isBusy && !el.classList.contains('busy')) {
    el.classList.add('busy');
  } else if ((!isRunning || !isBusy) && el.classList.contains('busy')) {
    el.classList.remove('busy');
  }

  const badge = el.querySelector('.session-state');
  if (badge && (badge.textContent !== label || !badge.classList.contains(cls))) {
    badge.className = 'session-state ' + cls;
    badge.textContent = label;
    badge.title = tip;
  }
}

// Coalesce badge updates into a single requestAnimationFrame tick.
// - schedulePatchSessionStateBadges()        → full sidebar scan next frame
// - schedulePatchSessionStateBadges(id)      → patch only that session next frame
// Without this, patchSessionStateBadges() runs on every 16ms-batched pty chunk
// (≈60×/sec per active session), each doing a full document-wide DOM scan.
let _badgeRafToken = null;
let _badgeFullSyncScheduled = false;
const _badgePendingSessionIds = new Set();
function schedulePatchSessionStateBadges(sessionId = null) {
  if (sessionId) {
    _badgePendingSessionIds.add(sessionId);
  } else {
    _badgeFullSyncScheduled = true;
  }
  if (_badgeRafToken !== null) return;
  _badgeRafToken = requestAnimationFrame(() => {
    _badgeRafToken = null;
    if (_badgeFullSyncScheduled) {
      _badgeFullSyncScheduled = false;
      _badgePendingSessionIds.clear();
      patchSessionStateBadges();
      return;
    }
    if (_badgePendingSessionIds.size > 0) {
      const ids = [..._badgePendingSessionIds];
      _badgePendingSessionIds.clear();
      for (const id of ids) patchSessionStateBadgeForId(id);
    }
  });
}

async function pollSessionStatus() {
  if (terminals.size > 0) {
    await refreshSessionList();
  } else {
    await updateSessionBusyStates();
  }
  patchSessionStateBadges();
}

setInterval(pollSessionStatus, STATUS_POLL_MS);

let _renderScheduled = false;
function scheduleRenderSessionList() {
  if (isSessionListRenderLocked()) {
    pendingSessionListRender = true;
    return;
  }
  if (_renderScheduled) return;
  _renderScheduled = true;
  requestAnimationFrame(() => {
    _renderScheduled = false;
    if (isSessionListRenderLocked()) {
      pendingSessionListRender = true;
      return;
    }
    renderSessionList();
  });
}

function createSessionItem(session, group, index) {
  const el = document.createElement('div');
  el.className = 'session-item';
  el.dataset.sessionId = session.id;
  if (currentSidebarTab === 'active') el.classList.add('active-list-item');
  const isStarting = pendingSessionStarts.has(session.id);
  if (isStarting) {
    el.classList.add('starting');
    el.setAttribute('aria-disabled', 'true');
  }
  if (session.id === activeSessionId) el.classList.add('active');
  if (sessionAliveState.has(session.id)) {
    el.classList.add('running');
    // .busy mirrors the WORKING/WAITING badge state so the side dot is
    // green when actively reasoning and yellow when idle. patchSessionStateBadges*
    // keeps it in sync on subsequent updates.
    if (sessionBusyState.get(session.id) === true) el.classList.add('busy');
  }
  if (group) {
    el.classList.add('grouped');
  }

  const lastUsedTime = sessionLastUsed.get(session.id);
  const lastUsedDate = new Date(lastUsedTime || session.updatedAt);
  const isToday = lastUsedDate.toDateString() === new Date().toDateString();
  const timeStr = isToday
    ? lastUsedDate.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', hour12: false })
    : lastUsedDate.toLocaleDateString([], { month: 'short', day: 'numeric' }) + ' ' + lastUsedDate.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', hour12: false });

  let tagsHtml = '';
  const allPills = [];
  if (session.resources && session.resources.length > 0) {
    const prs = session.resources.filter(r => r.type === 'pr');
    const wis = session.resources.filter(r => r.type === 'workitem');
    if (prs.length > 0) allPills.push(`<span class="tag tag-pr" title="${escapeHtml(prs.map(p => 'PR ' + p.id + (p.repo ? ' (' + p.repo + ')' : '') + (p.state ? ' [' + p.state + ']' : '')).join('\n'))}">PR ${prs.map(p => p.id).join(', ')}</span>`);
    if (wis.length > 0) allPills.push(`<span class="tag tag-wi" title="${escapeHtml(wis.map(w => 'WI ' + w.id + (w.workItemType ? ' [' + w.workItemType + ']' : '') + (w.title || w.name ? ' - ' + (w.title || w.name) : '')).join('\n'))}">WI ${wis.map(w => w.id).join(', ')}</span>`);
  }
  if (session.tags && session.tags.length > 0) {
    const repos = session.tags.filter(t => t.startsWith('repo:'));
    const rest = session.tags.filter(t => !t.startsWith('repo:'));
    for (const t of [...repos, ...rest]) {
      const cls = t.startsWith('repo:') ? 'tag tag-repo' : 'tag';
      const label = t.replace(/^(repo|tool):/, '');
      allPills.push(`<span class="${cls}">${escapeHtml(label)}</span>`);
    }
  }
  if (allPills.length > 0) {
    const MAX_VISIBLE = 3;
    const visible = allPills.slice(0, MAX_VISIBLE).join('');
    const hiddenCount = allPills.length - MAX_VISIBLE;
    const hidden = hiddenCount > 0
      ? `<span class="tag tag-overflow">+${hiddenCount}</span><span class="tags-hidden">${allPills.slice(MAX_VISIBLE).join('')}</span>`
      : '';
    tagsHtml = `<div class="session-tags">${visible}${hidden}</div>`;
  }

  const isRunning = sessionAliveState.has(session.id);
  const hasPR = session.lastAssistantHasPR === true;
  const { label: stateLabel, cls: stateCls, tip: stateTip } = deriveSessionState({
    isRunning,
    isActive: session.id === activeSessionId,
    hasPR,
    isHistory: currentSidebarTab === 'history',
    isBusy: sessionBusyState.get(session.id) || false,
    isStarting
  });

  // Folder picker as a positioned icon button at the bottom-right of the
  // session card (replaces the old "📂 <truncated path>" meta line). The
  // full path is exposed via the tooltip on hover.
  let cwdHtml = '';
  if (session.cwd && !isStarting) {
    cwdHtml = `<button class="session-cwd" type="button" tabindex="0" data-session-id="${session.id}" title="${escapeHtml(session.cwd)}" aria-label="Change working directory: ${escapeHtml(session.cwd)}"><svg class="session-cwd-icon" viewBox="0 0 24 24" aria-hidden="true" focusable="false"><path d="M3 7v11a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2V9a2 2 0 0 0-2-2h-8l-2-2H5a2 2 0 0 0-2 2z" fill="none" stroke="currentColor" stroke-width="2" stroke-linejoin="round"/></svg></button>`;
  }

  el.innerHTML = `
    <div class="session-collapsed-index" title="${escapeHtml(`Session ${index + 1}`)}">${index + 1}</div>
    <div class="session-header-row">
      <div class="session-title" data-title="${escapeHtml(session.title)}">${escapeHtml(session.title)}</div>
      <span class="session-state ${stateCls}" title="${escapeHtml(stateTip)}">${stateLabel}</span>
    </div>
    <div class="session-meta"><span>${timeStr}</span></div>
    ${tagsHtml}
    ${cwdHtml}
    ${currentSidebarTab === 'history' ? '<button class="session-delete" title="Delete session">✕</button>' : ''}
    ${currentSidebarTab === 'active' && isRunning && !isStarting ? '<button class="session-close" tabindex="-1" title="Close session">✕</button>' : ''}
  `;

  el.setAttribute('tabindex', '0');
  el.setAttribute('role', 'button');
  el.title = session.title;

  // Drag-and-drop + context menu for active sessions
  if (currentSidebarTab === 'active' && !isStarting) {
    el.setAttribute('draggable', 'true');
    el.addEventListener('dragstart', (e) => {
      e.dataTransfer.setData('application/x-session-id', session.id);
      e.dataTransfer.effectAllowed = 'move';
      el.classList.add('dragging');
    });
    el.addEventListener('dragend', () => {
      el.classList.remove('dragging');
      sessionList.querySelectorAll('.drop-above, .drop-below').forEach(x => x.classList.remove('drop-above', 'drop-below'));
    });
    el.addEventListener('dragover', (e) => {
      const isSessionDrag = [...e.dataTransfer.types].includes('application/x-session-id');
      if (!isSessionDrag) {
        el.classList.remove('drop-above', 'drop-below');
        return;
      }
      e.preventDefault();
      e.dataTransfer.dropEffect = 'move';
      const rect = el.getBoundingClientRect();
      const above = e.clientY < rect.top + rect.height / 2;
      el.classList.toggle('drop-above', above);
      el.classList.toggle('drop-below', !above);
    });
    el.addEventListener('dragleave', () => {
      el.classList.remove('drop-above', 'drop-below');
    });
    el.addEventListener('drop', (e) => {
      el.classList.remove('drop-above', 'drop-below');
      const draggedId = e.dataTransfer.getData('application/x-session-id');
      if (!draggedId || draggedId === session.id) return;
      e.preventDefault();
      const rect = el.getBoundingClientRect();
      const above = e.clientY < rect.top + rect.height / 2;
      handleSessionReorder(draggedId, session.id, above, group);
    });
    el.addEventListener('contextmenu', (e) => {
      e.preventDefault();
      e.stopPropagation();
      showSessionContextMenu(e, session.id);
    });
  }

  return el;
}

function renderSessionList() {
  if (isSessionListRenderLocked()) {
    pendingSessionListRender = true;
    return;
  }
  pendingSessionListRender = false;
  const renderSeq = ++sessionListRenderSeq;
  const activeIds = getActiveSidebarIds();

  let displayed;
  if (currentSidebarTab === 'active') {
    displayed = filterSessionsForSidebar({
      sessions: allSessions,
      activeSessionIds: activeIds,
      currentSidebarTab
    });
    // Active list is ordered strictly by user placement. New live sessions are
    // appended to sessionOrder in creation order; ended sessions are pruned.
    ensureSessionOrder();
    const orderMap = new Map(sessionOrder.map((id, i) => [id, i]));
    displayed.sort((a, b) => {
      const oa = orderMap.has(a.id) ? orderMap.get(a.id) : Number.MAX_SAFE_INTEGER;
      const ob = orderMap.has(b.id) ? orderMap.get(b.id) : Number.MAX_SAFE_INTEGER;
      return oa - ob;
    });
  } else {
    displayed = filterSessionsForSidebar({
      sessions: allSessions,
      activeSessionIds: activeIds,
      currentSidebarTab
    });
    displayed.sort((a, b) => (sessionLastUsed.get(b.id) || 0) - (sessionLastUsed.get(a.id) || 0));
  }

  // Filter by search (title + tags + resources)
  if (searchQuery) {
    const q = searchQuery.toLowerCase();
    displayed = displayed.filter(s => matchesSidebarMetadata(s, q));
  }

  // Cheap-path: if visible state hasn't changed since last render, skip the
  // destructive innerHTML='' + rebuild. Status badges and active highlight are
  // still patched in place by patchSessionStateBadges()/patchActiveHighlight()
  // (called from pollSessionStatus, switchToSession, onPtyData, etc.) so they
  // remain real-time. Only triggered when the sidebar has already been rendered
  // at least once and the DOM is non-empty.
  const fingerprint = computeSidebarFingerprint(displayed);
  if (
    _lastSidebarFingerprint !== null &&
    fingerprint === _lastSidebarFingerprint &&
    sessionList.children.length > 0
  ) {
    try { patchActiveHighlight && patchActiveHighlight(); } catch (_) { /* noop */ }
    try { patchSessionStateBadges && patchSessionStateBadges(); } catch (_) { /* noop */ }
    return;
  }
  _lastSidebarFingerprint = fingerprint;

  sessionList.innerHTML = '';
  appendHistoryScopeNotice();

  if (displayed.length === 0) {
    const emptyEl = document.createElement('div');
    emptyEl.className = 'empty-list';
      emptyEl.textContent = currentSidebarTab === 'active'
        ? 'No active sessions. Click a session in History or start a new one.'
        : searchQuery ? 'No sessions match your search.' : getHistoryEmptyState(historyShowsAll);
    sessionList.appendChild(emptyEl);
    return;
  }

  let displayIndex = 0;
  const appendSessionItem = (session, group = null) => {
    const el = createSessionItem(session, group, displayIndex);
    displayIndex += 1;
    sessionList.appendChild(el);
  };

  if (currentSidebarTab === 'active' && tabGroups.length > 0 && !searchQuery && !sidebarCollapsed) {
    // Render grouped sessions
    const displayedIds = new Set(displayed.map(s => s.id));

    for (const group of tabGroups) {
      const groupSessions = group.tabIds
        .filter(id => displayedIds.has(id))
        .map(id => displayed.find(s => s.id === id))
        .filter(Boolean);

      if (groupSessions.length === 0) continue;

      // Group header
      const headerEl = document.createElement('div');
      headerEl.className = 'session-group-header' + (group.collapsed ? ' collapsed' : '');
      headerEl.dataset.groupId = group.id;
      headerEl.setAttribute('draggable', 'true');
      headerEl.setAttribute('tabindex', '0');
      headerEl.setAttribute('role', 'button');
      headerEl.setAttribute('aria-expanded', group.collapsed ? 'false' : 'true');
      headerEl.setAttribute('aria-label', `${group.name}, ${groupSessions.length} sessions. Press Enter to ${group.collapsed ? 'expand' : 'collapse'}, Alt+ArrowUp or Alt+ArrowDown to reorder.`);
      headerEl.innerHTML = `
        <span class="session-group-chevron">${group.collapsed ? '▸' : '▾'}</span>
        <span class="session-group-dot" style="background: ${group.color}"></span>
        <span class="session-group-name">${escapeHtml(group.name)}</span>
        <span class="session-group-count">${groupSessions.length}</span>
      `;
      headerEl.addEventListener('click', (e) => {
        if (e.target.getAttribute('contenteditable') === 'true') return;
        group.collapsed = !group.collapsed;
        renderSessionList();
        saveTabState();
      });
      headerEl.addEventListener('keydown', (e) => {
        if (e.target.getAttribute('contenteditable') === 'true') return;
        if (e.altKey && e.key === 'ArrowUp') {
          e.preventDefault();
          moveGroupByOffset(group.id, -1);
          return;
        }
        if (e.altKey && e.key === 'ArrowDown') {
          e.preventDefault();
          moveGroupByOffset(group.id, 1);
          return;
        }
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          group.collapsed = !group.collapsed;
          renderSessionList();
          saveTabState();
          return;
        }
        if (e.key === 'ContextMenu' || (e.shiftKey && e.key === 'F10')) {
          e.preventDefault();
          const rect = headerEl.getBoundingClientRect();
          const menu = showGroupContextMenu({ clientX: rect.left + 12, clientY: rect.bottom, preventDefault() {} }, group.id);
          menu?.querySelector('[role="menuitem"], [role="menuitemradio"]')?.focus();
        }
      });
      headerEl.addEventListener('dblclick', (e) => {
        e.stopPropagation();
        startGroupRename(group);
      });
      headerEl.addEventListener('contextmenu', (e) => {
        e.preventDefault();
        showGroupContextMenu(e, group.id);
      });
      headerEl.addEventListener('dragstart', (e) => {
        e.dataTransfer.effectAllowed = 'move';
        e.dataTransfer.setData('application/x-group-id', group.id);
        headerEl.classList.add('dragging');
      });
      headerEl.addEventListener('dragend', () => {
        headerEl.classList.remove('dragging');
        sessionList.querySelectorAll('.drag-over, .drop-above, .drop-below').forEach(x => x.classList.remove('drag-over', 'drop-above', 'drop-below'));
      });

      // Make group header a drop target
      headerEl.addEventListener('dragover', (e) => {
        const isGroupDrag = [...e.dataTransfer.types].includes('application/x-group-id');
        const isSessionDrag = [...e.dataTransfer.types].includes('application/x-session-id');
        if (!isGroupDrag && !isSessionDrag) {
          headerEl.classList.remove('drag-over', 'drop-above', 'drop-below');
          return;
        }
        e.preventDefault();
        e.dataTransfer.dropEffect = 'move';
        headerEl.classList.add('drag-over');
        if (isGroupDrag) {
          const rect = headerEl.getBoundingClientRect();
          const above = e.clientY < rect.top + rect.height / 2;
          headerEl.classList.toggle('drop-above', above);
          headerEl.classList.toggle('drop-below', !above);
        } else {
          headerEl.classList.remove('drop-above', 'drop-below');
        }
      });
      headerEl.addEventListener('dragleave', () => headerEl.classList.remove('drag-over', 'drop-above', 'drop-below'));
      headerEl.addEventListener('drop', (e) => {
        const isGroupDrag = [...e.dataTransfer.types].includes('application/x-group-id');
        const isSessionDrag = [...e.dataTransfer.types].includes('application/x-session-id');
        if (!isGroupDrag && !isSessionDrag) return;
        e.preventDefault();
        const rect = headerEl.getBoundingClientRect();
        const above = e.clientY < rect.top + rect.height / 2;
        headerEl.classList.remove('drag-over', 'drop-above', 'drop-below');
        const draggedGroupId = e.dataTransfer.getData('application/x-group-id');
        if (draggedGroupId) {
          handleGroupReorder(draggedGroupId, group.id, above);
          return;
        }
        const draggedId = e.dataTransfer.getData('application/x-session-id');
        if (draggedId) addTabToGroup(draggedId, group.id);
      });

      const groupEl = document.createElement('div');
      groupEl.className = 'session-group';
      if (group.collapsed) groupEl.classList.add('collapsed');
      groupEl.style.setProperty('--group-color', group.color);
      groupEl.appendChild(headerEl);

      // Group sessions (if not collapsed)
      if (!group.collapsed) {
        for (const session of groupSessions) {
          const el = createSessionItem(session, group, displayIndex);
          displayIndex += 1;
          groupEl.appendChild(el);
        }
      }

      sessionList.appendChild(groupEl);
    }

    // Ungrouped sessions
    const groupedIds = new Set(tabGroups.flatMap(g => g.tabIds));
    const ungrouped = displayed.filter(s => !groupedIds.has(s.id));
    for (const session of ungrouped) {
      appendSessionItem(session);
    }
  } else {
    // Original rendering (history tab or search active)
    for (const session of displayed) {
      appendSessionItem(session);
    }
  }

  // NOTE: per-session unread notification badge was removed (it was noisy —
  // every session-exit added a permanent red counter that stayed until the
  // user manually opened the notification panel and clicked "mark all read").
  // The global notification badge on the gear icon still tracks total unread,
  // and the notification panel still has full per-session history.
  // Keep `renderSeq` reference so the variable is intentionally consumed if
  // future async work needs to be guarded against stale renders.
  void renderSeq;
}

function startRenameSession(sessionId, titleEl) {
  if (activeSessionRenameId && activeSessionRenameId !== sessionId) return;
  const currentTitle = titleEl.dataset.title || titleEl.textContent;
  const input = document.createElement('input');
  input.type = 'text';
  input.className = 'session-rename-input';
  input.value = currentTitle;
  activeSessionRenameId = sessionId;

  titleEl.textContent = '';
  titleEl.appendChild(input);
  input.focus();
  input.select();

  let committed = false;
  const finishRename = () => {
    if (activeSessionRenameId === sessionId) {
      activeSessionRenameId = null;
    }
    if (pendingSessionListRender) {
      renderSessionList();
    }
  };

  const commit = async () => {
    if (committed) return;
    committed = true;
    const newTitle = input.value.trim();
    try {
      if (newTitle && newTitle !== currentTitle) {
        await window.api.renameSession(sessionId, newTitle);
        await refreshSessionList();
      } else {
        titleEl.textContent = currentTitle;
      }
    } finally {
      finishRename();
    }
  };

  const cancel = () => {
    if (committed) return;
    committed = true;
    input.value = currentTitle;
    if (titleEl.contains(input)) {
      titleEl.textContent = currentTitle;
    }
    finishRename();
  };

  input.addEventListener('blur', commit);
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { e.preventDefault(); input.blur(); }
    if (e.key === 'Escape') { e.preventDefault(); cancel(); }
    e.stopPropagation();
  });
  input.addEventListener('click', (e) => e.stopPropagation());
}

const cwdPickerActive = new Set();

async function handleCwdClick(sessionId) {
  if (pendingSessionStarts.has(sessionId)) return;
  if (cwdPickerActive.has(sessionId)) return;
  cwdPickerActive.add(sessionId);

  try {
    const session = allSessions.find(s => s.id === sessionId);
    const defaultPath = session?.cwd || undefined;
    const picked = await window.api.pickDirectory(defaultPath);
    if (!picked) return;

    const isAlive = sessionAliveState.has(sessionId);
    if (isAlive) {
      const entry = terminals.get(sessionId);
      if (entry) {
        entry.terminal.write('\r\n\x1b[90m[Changing working directory…]\x1b[0m\r\n', () => {
          scheduleTerminalViewportSync(sessionId, { refreshSearch: true });
        });
      }
      cwdChangingSessions.add(sessionId);
      try {
        const restartedSessionId = await window.api.changeCwd(sessionId, picked);
        if (restartedSessionId === null) {
          await refreshSessionList();
          return;
        }
        sessionAliveState.add(sessionId);
      } catch (error) {
        showToast({
          type: 'error',
          title: 'Could not change working directory',
          body: error?.message || picked,
        });
        await refreshSessionList();
        return;
      } finally {
        cwdChangingSessions.delete(sessionId);
      }
    } else {
      try {
        await window.api.changeCwd(sessionId, picked);
      } catch (error) {
        showToast({
          type: 'error',
          title: 'Could not change working directory',
          body: error?.message || picked,
        });
        await refreshSessionList();
        return;
      }
    }

    // Update local state
    if (session) session.cwd = picked;
    await refreshSessionList();
  } finally {
    cwdPickerActive.delete(sessionId);
  }
}

function confirmDeleteSession(sessionId, title) {
  const overlay = document.createElement('div');
  overlay.className = 'confirm-overlay';
  overlay.innerHTML = `
    <div class="confirm-dialog">
      <h3>Delete session?</h3>
      <p>This will permanently delete "<strong>${escapeHtml(title)}</strong>" and all its data. This cannot be undone.</p>
      <div class="confirm-actions">
        <button class="btn-secondary confirm-cancel">Cancel</button>
        <button class="btn-danger confirm-delete">Delete</button>
      </div>
    </div>`;

  document.body.appendChild(overlay);

  const cleanup = () => overlay.remove();
  overlay.querySelector('.confirm-cancel').addEventListener('click', cleanup);
  overlay.addEventListener('click', (e) => { if (e.target === overlay) cleanup(); });

  overlay.querySelector('.confirm-delete').addEventListener('click', async () => {
    cleanup();
    // Close tab if open
    if (terminals.has(sessionId)) {
      await terminateSession(sessionId);
    }
    await window.api.deleteSession(sessionId);
    await refreshSessionList();
  });

  // Esc to cancel
  const onKey = (e) => { if (e.key === 'Escape') { cleanup(); document.removeEventListener('keydown', onKey); } };
  document.addEventListener('keydown', onKey);
}

async function openSession(sessionId) {
  const existing = terminals.get(sessionId);
  if (existing && !existing.exited) {
    if (!openTabIds.has(sessionId)) {
      const session = allSessions.find(s => s.id === sessionId);
      addTab(sessionId, session?.title || sessionId.substring(0, 8));
    }
    switchToSession(sessionId);
    await new Promise(resolve => requestAnimationFrame(resolve));
    return;
  }
  // Clean up dead terminal from exit delay if present
  if (existing && existing.exited) {
    if (existing.exitTimeout) clearTimeout(existing.exitTimeout);
    if (existing.titlePoll) clearInterval(existing.titlePoll);
    existing.terminal.dispose();
    existing.wrapper.remove();
    terminals.delete(sessionId);
    openTabIds.delete(sessionId);
    const tab = document.querySelector(`.tab[data-session-id="${sessionId}"]`);
    if (tab) tab.remove();
  }
  if (openingSession.has(sessionId)) return;
  openingSession.add(sessionId);

  try {
    await window.api.openSession(sessionId);
    sessionAliveState.add(sessionId);
    createTerminal(sessionId);
    switchToSession(sessionId);

    const session = ensureSessionPlaceholder(sessionId);
    addTab(sessionId, session?.title || sessionId.substring(0, 8));
    renderSessionList();
    saveTabState();
    // Wait for rAF focus to complete
    await new Promise(resolve => requestAnimationFrame(resolve));
  } finally {
    openingSession.delete(sessionId);
  }
}

async function newSession(launchOverrides = null) {
  if (creatingSession) return;
  let pendingStartId = null;
  const overrides = launchOverrides && typeof launchOverrides === 'object' &&
    (launchOverrides.launcher === 'copilot' ||
      launchOverrides.launcher === 'agency' ||
      Object.prototype.hasOwnProperty.call(launchOverrides, 'launcherArgs'))
    ? launchOverrides
    : null;

  const settings = await window.api.getSettings();
  applySettingsToControls(settings);

  const oneOffLauncher = overrides?.launcher;
  const availability = oneOffLauncher
    ? getOneOffLauncherAvailability(settings, oneOffLauncher)
    : getNewSessionAvailability(settings);
  if (!availability.available) {
    showToast({ type: 'error', title: 'New session unavailable', body: availability.reason });
    return;
  }

  creatingSession = true;

  try {
    // Prompt for working directory if enabled
    let cwd = undefined;
    if (settings.promptForWorkdir) {
      const picked = await window.api.pickDirectory(settings.defaultWorkdir || undefined);
      if (picked === null) return;
      cwd = picked;
    } else if (settings.defaultWorkdir) {
      cwd = settings.defaultWorkdir;
    }

    const request = overrides
      ? { cwd, launcher: overrides.launcher, launcherArgs: overrides.launcherArgs || '' }
      : cwd;

    pendingStartId = createPendingSessionStart({ launcher: availability.launcher, cwd });
    showActiveSidebar();
    renderSessionList();

    const result = await window.api.newSession(request);
    // session:new now returns { sessionId, bufferedData } so we can write the
    // pre-warm CLI output AFTER createTerminal, avoiding the race where a
    // 'pty:data' event arrived before terminals.get(sessionId) was defined
    // and was silently dropped (which left the terminal in alt-buffer mode
    // with empty scrollback, appearing "non-scrollable" until /restart).
    const sessionId = typeof result === 'string' ? result : result?.sessionId;
    const bufferedData = typeof result === 'string' ? '' : (result?.bufferedData || '');
    const bufferedExitCode = typeof result === 'string' ? null : result?.exitCode;
    if (!sessionId) throw new Error('Failed to start session.');
    removePendingSessionStart(pendingStartId);
    pendingStartId = null;
    sessionAliveState.add(sessionId);
    createTerminal(sessionId);
    if (bufferedData) {
      const termEntry = terminals.get(sessionId);
      if (termEntry) {
        updateTerminalMouseTracking(termEntry, bufferedData);
        termEntry.terminal.write(stripMouseTrackingSequences(bufferedData), () => {
          scheduleTerminalViewportSync(sessionId, { refreshSearch: true });
        });
      }
    }
    switchToSession(sessionId);
    addTab(sessionId, 'New Session');
    if (Number.isInteger(bufferedExitCode)) {
      const termEntry = terminals.get(sessionId);
      if (termEntry) {
        termEntry.exited = true;
        termEntry.terminal.write(`\r\n\x1b[90m[Session ended with code ${bufferedExitCode}]\x1b[0m\r\n`, () => {
          scheduleTerminalViewportSync(sessionId, { refreshSearch: true });
        });
        termEntry.exitTimeout = setTimeout(() => {
          const entry = terminals.get(sessionId);
          if (entry && entry.exited) {
            if (entry.titlePoll) clearInterval(entry.titlePoll);
            entry.terminal.dispose();
            entry.wrapper.remove();
            terminals.delete(sessionId);
            removeTabUi(sessionId);
            if (activeSessionId === sessionId) {
              activeSessionId = null;
              updateSessionPromptGhost(null);
              const remaining = document.querySelectorAll('.tab');
              if (remaining.length > 0) switchToSession(remaining[remaining.length - 1].dataset.sessionId);
              else { emptyState.classList.remove('hidden'); updateStatusPanel(null); }
            }
            saveTabState();
            scheduleRenderSessionList();
          }
        }, 3000);
      }
      sessionAliveState.delete(sessionId);
      ensureSessionOrder();
      clearSessionBusy(sessionId);
      cwdChangingSessions.delete(sessionId);
      updateTabStatus(sessionId, false);
      schedulePatchSessionStateBadges(sessionId);
    }

    // Inject placeholder so the active list renders immediately
    ensureSessionPlaceholder(sessionId, { title: 'New Session', cwd: cwd || '' });

    showActiveSidebar();
    renderSessionList();

    // Retry refresh to pick up real metadata once the CLI writes it
    for (const delay of [3000, 8000, 15000]) {
      setTimeout(() => {
        if (terminals.has(sessionId)) refreshSessionList();
      }, delay);
    }
    // Continue polling every 15s until title is no longer "New Session"
    const titlePoll = setInterval(() => {
      if (!terminals.has(sessionId)) { clearInterval(titlePoll); return; }
      const session = allSessions.find(s => s.id === sessionId);
      if (session && session.title !== 'New Session') { clearInterval(titlePoll); return; }
      refreshSessionList();
    }, 15000);
    // Store on terminal entry so it can be cleared on close/exit/eviction
    const termEntry = terminals.get(sessionId);
    if (termEntry) termEntry.titlePoll = titlePoll;
    saveTabState();
  } catch (err) {
    removePendingSessionStart(pendingStartId);
    renderSessionList();
    showToast({ type: 'error', title: 'Could not start new session', body: String(err?.message || err) });
  } finally {
    creatingSession = false;
  }
}

function createTerminal(sessionId) {
  const isPrimaryMouseButton = (event) => event?.button === undefined || event.button === 0;

  const terminal = new Terminal({
    theme: XTERM_THEMES[currentTheme],
    fontFamily: "'Cascadia Code', 'Consolas', 'Courier New', monospace",
    fontSize: 14,
    lineHeight: 1.2,
    cursorBlink: true,
    cursorStyle: 'bar',
    scrollback: 10000,
    allowProposedApi: true,
    scrollOnOutput: true,
    linkHandler: {
      activate: (event, uri) => {
        if (!isPrimaryMouseButton(event)) return;
        if (terminal.hasSelection()) return;
        event?.preventDefault?.();
        event?.stopPropagation?.();
        terminal.clearSelection();
        window.api.openExternal(uri);
      },
      allowNonHttpProtocols: false
    }
  });

  const fitAddon = new FitAddon();
  terminal.loadAddon(fitAddon);
  // IMPORTANT — terminal link opening is owned by DeepSky, not xterm's
  // default browser-confirm fallback. xterm's default OSC-8 handler shows
  // "might be dangerous" and then does not reliably open external browsers
  // from Electron. We route both OSC-8 links and visible URL links through
  // main-process shell.openExternal, which allows only http(s) URLs.
  //
  // Keep WebLinksAddon loaded so non-OSC visible URLs are decorated and have
  // the same open behavior as OSC-8 hyperlinks.
  terminal.loadAddon(new WebLinksAddon((event, uri) => {
    if (!isPrimaryMouseButton(event)) return;
    if (terminal.hasSelection()) return;
    event?.preventDefault?.();
    event?.stopPropagation?.();
    terminal.clearSelection();
    window.api.openExternal(uri);
  }));

  const wrapper = document.createElement('div');
  wrapper.className = 'terminal-wrapper';
  wrapper.id = `term-${sessionId}`;
  terminalContainer.appendChild(wrapper);

  terminal.open(wrapper);
  fitAddon.fit();

  wrapper.addEventListener('pointerdown', () => {
    requestAnimationFrame(() => {
      if (activeSessionId === sessionId && terminals.has(sessionId)) {
        terminal.focus();
      }
    });
  });

  terminal.onData((data) => {
    const sanitizedData = stripTerminalMouseInputReports(data);
    if (!sanitizedData) return;
    handleSessionPromptInput(sessionId, sanitizedData);
    window.api.writePty(sessionId, sanitizedData);
  });
  terminal.onResize(({ cols, rows }) => {
    trackedResizePty(sessionId, cols, rows);
    scheduleTerminalViewportSync(sessionId, { refreshSearch: true });
  });
  terminal.onScroll(() => {
    const currentEntry = terminals.get(sessionId);
    if (!currentEntry || currentEntry.isSyncingViewport) return;
    scheduleTerminalViewportSync(sessionId);
  });
  terminal.attachCustomWheelEventHandler((event) => {
    const currentEntry = terminals.get(sessionId);
    return !forwardTrackedMouseWheel(sessionId, currentEntry, event);
  });

  // Copy-on-select: mirror xterm's selection to the clipboard, matching
  // PuTTY/Windows Terminal behavior. Because we strip the CLI's mouse-reporting
  // sequences (see stripMouseTrackingSequences), xterm keeps mouse ownership and
  // a plain click+drag now produces a real xterm model selection here — no DOM
  // selection fallback is needed (xterm sets `user-select: none`, so a browser
  // selection never exists over the terminal). Gated on the setting; skips empty
  // selections so a plain click doesn't clobber the clipboard.
  const copySelectionToClipboard = () => {
    if (window._cachedSettings?.copyOnSelect === false) return;
    if (!terminal.hasSelection()) return;
    const selection = terminal.getSelection();
    if (!selection || !selection.trim()) return;
    const cleanedSelection = stripTerminalScrollbar(selection, terminal.cols);
    if (cleanedSelection.trim()) window.api.copyText(cleanedSelection);
  };
  // onSelectionChange covers keyboard/Shift selection changes. A mouseup handler
  // is the reliable trigger for a plain click+drag: xterm finalizes the model
  // selection on mouseup, and reading it here mirrors the (working) Ctrl+C path
  // exactly, so copy-on-select lands even if onSelectionChange doesn't fire a
  // final event for the drag.
  terminal.onSelectionChange(copySelectionToClipboard);
  wrapper.addEventListener('mouseup', () => {
    // Defer one tick so xterm's SelectionService has committed the selection
    // for this mouseup before we read it.
    setTimeout(copySelectionToClipboard, 0);
  });
  // Defense-in-depth: own browser-level paste events too. Electron/Chromium can
  // deliver Ctrl+V as a paste event instead of the xterm keydown path; suppress
  // xterm's native handler, then write the clipboard text through the same PTY
  // path as our keyboard shortcut.
  if (terminal.textarea) {
    terminal.textarea.addEventListener('paste', (e) => {
      e.preventDefault();
      e.stopImmediatePropagation();
      const pasted = sanitizePasteText(e.clipboardData?.getData('text/plain'));
      if (pasted) {
        terminal.paste(pasted);
        return;
      }
      window.api.pasteText().then(text => {
        const sanitizedText = sanitizePasteText(text);
        if (sanitizedText) {
          terminal.paste(sanitizedText);
        }
      });
    }, true);
  }

  // Intercept terminal shortcuts via the shared helper so local behavior layers on
  // top of main's current shortcut plumbing instead of replacing it.
  terminal.attachCustomKeyEventHandler(createTerminalKeyHandler(sessionId, terminal, window.api, {
    onInput: (data) => handleSessionPromptInput(sessionId, data)
  }));

  terminals.set(sessionId, {
    terminal,
    fitAddon,
    wrapper,
    isSyncingViewport: false,
    pendingViewportRefreshSearch: false,
    mouseTrackingEnabled: false,
    sgrMouseEnabled: false
  });
  scheduleTerminalViewportSync(sessionId);
  scheduleSessionPromptGhostRefresh(sessionId, [0, 400]);
}

function switchToSession(sessionId) {
  hideInstructions();

  if (activeSessionId && terminals.has(activeSessionId)) {
    terminals.get(activeSessionId).wrapper.classList.remove('visible');
    updateSessionPromptGhost(activeSessionId);
  }

  activeSessionId = sessionId;
  sessionLastUsed.set(sessionId, Date.now());

  // Ensure sidebar shows the active tab when switching to a session
  if (currentSidebarTab !== 'active') {
    currentSidebarTab = 'active';
    document.querySelectorAll('.sidebar-tab').forEach(t => t.classList.toggle('active', t.dataset.tab === 'active'));
    void refreshSessionList();
  }

  const entry = terminals.get(sessionId);
  if (entry) {
    entry.wrapper.classList.add('visible');
    updateSessionPromptGhost(sessionId);
    scheduleSessionPromptGhostRefresh(sessionId);
    emptyState.classList.add('hidden');
    const currentId = sessionId;
    requestAnimationFrame(() => {
      if (activeSessionId !== currentId) return;
      entry.fitAddon.fit();
      entry.terminal.focus();
      trackedResizePty(currentId, entry.terminal.cols, entry.terminal.rows);
      // Single viewport sync — previously we ran syncTerminalViewport()
      // synchronously here AND scheduled another one 20ms later, which caused
      // a visible double-paint flicker on session switch. The scheduled one
      // handles everything (search refresh, scroll position) and runs in the
      // next animation frame so the user only sees one repaint.
      scheduleTerminalViewportSync(currentId, { refreshSearch: true });
      if (!sessionSearch.classList.contains('hidden')) refreshSessionSearch(true);
    });
  }

  document.querySelectorAll('.tab').forEach(tab => {
    tab.classList.toggle('active', tab.dataset.sessionId === sessionId);
  });

  // Scroll the active tab into view
  const activeTab = document.querySelector(`.tab[data-session-id="${sessionId}"]`);
  if (activeTab) activeTab.scrollIntoView({ block: 'nearest', inline: 'nearest', behavior: 'smooth' });

  updateStatusPanel(sessionId);
  patchActiveHighlight();
  patchSessionStateBadges();
  saveTabState();
}

// Lightweight: just toggles .active class on session items without rebuilding DOM
function patchActiveHighlight() {
  document.querySelectorAll('.session-item').forEach(el => {
    el.classList.toggle('active', el.dataset.sessionId === activeSessionId);
  });
}

function showHome() {
  if (activeSessionId && terminals.has(activeSessionId)) {
    terminals.get(activeSessionId).wrapper.classList.remove('visible');
    updateSessionPromptGhost(activeSessionId);
  }
  closeSessionSearch({ restoreTerminalFocus: false });
  activeSessionId = null;
  updateSessionPromptGhost(null);
  document.querySelectorAll('.tab').forEach(t => t.classList.remove('active'));
  emptyState.classList.remove('hidden');
  updateStatusPanel(null);
}

function addTab(sessionId, title) {
  if (document.querySelector(`.tab[data-session-id="${sessionId}"]`)) return;
  openTabIds.add(sessionId);

  const tab = document.createElement('div');
  tab.className = 'tab active';
  tab.dataset.sessionId = sessionId;
  tab.setAttribute('tabindex', '0');
  tab.setAttribute('role', 'tab');

  const titleSpan = document.createElement('span');
  titleSpan.className = 'tab-title';
  titleSpan.textContent = title.length > 25 ? title.substring(0, 22) + '...' : title;
  titleSpan.title = title;

  const closeBtn = document.createElement('button');
  closeBtn.type = 'button';
  closeBtn.className = 'tab-close';
  closeBtn.textContent = '×';
  closeBtn.title = 'Close session';
  closeBtn.setAttribute('aria-label', `Close session: ${title}`);
  closeBtn.addEventListener('click', (e) => { e.stopPropagation(); terminateSession(sessionId, { rememberClosedTab: true }); });

  tab.appendChild(titleSpan);
  tab.appendChild(closeBtn);
  tab.addEventListener('click', () => switchToSession(sessionId));
  tab.addEventListener('mousedown', (e) => {
    if (e.button === 1) { // Middle mouse button
      e.preventDefault();
      terminateSession(sessionId, { rememberClosedTab: true });
    }
  });

  tabsScrollArea.appendChild(tab);
  // Keep the top tab strip in the same order as the sidebar so Ctrl+Tab and
  // visual neighbor relationships match what the user reordered. New tabs
  // land at the end of sessionOrder via ensureSessionOrder, so this is
  // typically a no-op for the new tab but corrects any prior drift.
  syncTabStripOrder();
  updateTabScrollButtons();
}

function updateTabTitle(sessionId, title) {
  const tab = document.querySelector(`.tab[data-session-id="${sessionId}"] .tab-title`);
  if (!tab) return;
  const display = title.length > 25 ? title.substring(0, 22) + '...' : title;
  if (tab.textContent !== display) {
    tab.textContent = display;
    tab.title = title;
  }
}

function updateTabScrollButtons() {
  const el = tabsScrollArea;
  const overflows = el.scrollWidth > el.clientWidth;
  tabScrollLeft.classList.toggle('visible', overflows && el.scrollLeft > 0);
  tabScrollRight.classList.toggle('visible', overflows && el.scrollLeft + el.clientWidth < el.scrollWidth - 1);
}

function removeTabUi(sessionId) {
  openTabIds.delete(sessionId);
  const tab = document.querySelector(`.tab[data-session-id="${sessionId}"]`);
  if (tab) tab.remove();
  updateTabScrollButtons();
}

async function closeTab(sessionId, { remember = true } = {}) {
  // Remember for Ctrl+Shift+T restore
  if (remember) rememberRestorableClosedSession(recentlyClosedSessions, sessionId);
  removeTabUi(sessionId);

  if (activeSessionId === sessionId) {
    const entry = terminals.get(sessionId);
    if (entry) entry.wrapper.classList.remove('visible');
    activeSessionId = null;
    updateSessionPromptGhost(null);
    const remainingTabs = [...document.querySelectorAll('.tab')];
    if (remainingTabs.length > 0) {
      switchToSession(remainingTabs[remainingTabs.length - 1].dataset.sessionId);
    } else {
      closeSessionSearch({ restoreTerminalFocus: false });
      emptyState.classList.remove('hidden');
      updateStatusPanel(null);
    }
  }

  renderSessionList();
  saveTabState();
}

async function terminateSession(sessionId, { rememberClosedTab = false } = {}) {
  if (rememberClosedTab && openTabIds.has(sessionId)) {
    ensureSessionPlaceholder(sessionId);
    rememberRestorableClosedSession(recentlyClosedSessions, sessionId);
  }

  await window.api.killSession(sessionId);

  const entry = terminals.get(sessionId);
  if (entry) {
    if (entry.exitTimeout) clearTimeout(entry.exitTimeout);
    if (entry.titlePoll) clearInterval(entry.titlePoll);
    entry.terminal.dispose();
    entry.wrapper.remove();
    terminals.delete(sessionId);
  }

  removeTabUi(sessionId);
  tabGroups = pruneSessionFromGroups(tabGroups, sessionId);
  sessionAliveState.delete(sessionId);
  ensureSessionOrder();
  clearSessionBusy(sessionId);
  cwdChangingSessions.delete(sessionId);

  if (activeSessionId === sessionId) {
    activeSessionId = null;
    updateSessionPromptGhost(null);
    const remainingTabs = [...document.querySelectorAll('.tab')];
    if (remainingTabs.length > 0) {
      switchToSession(remainingTabs[remainingTabs.length - 1].dataset.sessionId);
    } else {
      closeSessionSearch({ restoreTerminalFocus: false });
      emptyState.classList.remove('hidden');
      updateStatusPanel(null);
    }
  }

  renderSessionList();
  saveTabState();
}

function updateTabStatus(sessionId, alive) {
  const tab = document.querySelector(`.tab[data-session-id="${sessionId}"]`);
  if (tab) tab.style.opacity = alive ? '1' : '0.5';
}

// ───────────── Session Reordering ─────────────

function ensureSessionOrder() {
  // Build sessionOrder from current active sessions if it's empty or stale
  const activeIds = getActiveSidebarIds();
  // Add any active sessions not yet in sessionOrder
  for (const id of activeIds) {
    if (!sessionOrder.includes(id)) sessionOrder.push(id);
  }
  // Remove closed sessions
  sessionOrder = sessionOrder.filter(id => activeIds.has(id));
}

// Reorder the DOM children of the top tab strip to match sessionOrder so the
// strip, the sidebar, and Ctrl+Tab cycling all agree on a single ordering.
// Tabs whose sessionId isn't in sessionOrder (e.g., transient/special UI
// tabs) keep their relative position at the end and are not dropped.
function syncTabStripOrder() {
  if (!tabsScrollArea) return;
  ensureSessionOrder();
  const tabs = [...tabsScrollArea.querySelectorAll(':scope > .tab')];
  if (tabs.length < 2) return;
  const orderIndex = new Map(sessionOrder.map((id, i) => [id, i]));
  const sorted = [...tabs].sort((a, b) => {
    const ai = orderIndex.has(a.dataset.sessionId) ? orderIndex.get(a.dataset.sessionId) : Number.MAX_SAFE_INTEGER;
    const bi = orderIndex.has(b.dataset.sessionId) ? orderIndex.get(b.dataset.sessionId) : Number.MAX_SAFE_INTEGER;
    if (ai !== bi) return ai - bi;
    // Stable fallback for tabs not tracked by sessionOrder: preserve their
    // existing relative order so nothing visibly jumps around.
    return tabs.indexOf(a) - tabs.indexOf(b);
  });
  let changed = false;
  for (let i = 0; i < sorted.length; i++) {
    if (sorted[i] !== tabs[i]) { changed = true; break; }
  }
  if (!changed) return;
  // appendChild on an existing child moves it; doing this for each tab in
  // sorted order reorders them without cloning or losing event listeners.
  for (const t of sorted) tabsScrollArea.appendChild(t);
}

function normalizeSessionOrderToActiveList() {
  ensureSessionOrder();
  if (tabGroups.length === 0) return;

  const activeIds = new Set(sessionAliveState);
  const groupedIds = new Set();
  const groupedOrder = [];
  for (const group of tabGroups) {
    if (!Array.isArray(group.tabIds)) continue;
    for (const id of group.tabIds) {
      if (!activeIds.has(id) || groupedIds.has(id)) continue;
      groupedIds.add(id);
      groupedOrder.push(id);
    }
  }

  const ungroupedOrder = sessionOrder.filter(id => activeIds.has(id) && !groupedIds.has(id));
  sessionOrder = [...groupedOrder, ...ungroupedOrder];
}

function handleSessionReorder(draggedId, targetId, insertAbove, targetGroup) {
  ensureSessionOrder();

  // If dragged into a group, add to that group
  const draggedGroup = getGroupForTab(draggedId);
  if (targetGroup && (!draggedGroup || draggedGroup.id !== targetGroup.id)) {
    // Move into target group at the right position within group.tabIds
    if (draggedGroup) {
      draggedGroup.tabIds = draggedGroup.tabIds.filter(id => id !== draggedId);
      if (draggedGroup.tabIds.length === 0) tabGroups = tabGroups.filter(g => g.id !== draggedGroup.id);
    }
    const targetIdx = targetGroup.tabIds.indexOf(targetId);
    const insertIdx = insertAbove ? targetIdx : targetIdx + 1;
    if (!targetGroup.tabIds.includes(draggedId)) {
      targetGroup.tabIds.splice(insertIdx, 0, draggedId);
    }
  } else if (targetGroup && draggedGroup && draggedGroup.id === targetGroup.id) {
    // Reorder within same group
    draggedGroup.tabIds = draggedGroup.tabIds.filter(id => id !== draggedId);
    const targetIdx = draggedGroup.tabIds.indexOf(targetId);
    const insertIdx = insertAbove ? targetIdx : targetIdx + 1;
    draggedGroup.tabIds.splice(insertIdx, 0, draggedId);
  } else if (!targetGroup && draggedGroup) {
    // Dragging out of group to ungrouped area
    draggedGroup.tabIds = draggedGroup.tabIds.filter(id => id !== draggedId);
    if (draggedGroup.tabIds.length === 0) tabGroups = tabGroups.filter(g => g.id !== draggedGroup.id);
  }

  // Update global sessionOrder
  sessionOrder = sessionOrder.filter(id => id !== draggedId);
  const targetIdx = sessionOrder.indexOf(targetId);
  if (targetIdx !== -1) {
    sessionOrder.splice(insertAbove ? targetIdx : targetIdx + 1, 0, draggedId);
  } else {
    sessionOrder.push(draggedId);
  }

  normalizeSessionOrderToActiveList();
  // Mirror the new order in the top tab strip so Ctrl+Tab cycles in
  // the same sequence the user just arranged in the sidebar.
  syncTabStripOrder();
  renderSessionList();
  saveTabState();
}

function handleGroupReorder(draggedGroupId, targetGroupId, insertAbove) {
  if (!draggedGroupId || !targetGroupId || draggedGroupId === targetGroupId) return false;
  const draggedIndex = tabGroups.findIndex(g => g.id === draggedGroupId);
  if (draggedIndex === -1 || !tabGroups.some(g => g.id === targetGroupId)) return false;

  const [draggedGroup] = tabGroups.splice(draggedIndex, 1);
  const targetIndex = tabGroups.findIndex(g => g.id === targetGroupId);
  tabGroups.splice(insertAbove ? targetIndex : targetIndex + 1, 0, draggedGroup);

  normalizeSessionOrderToActiveList();
  syncTabStripOrder();
  renderSessionList();
  saveTabState();
  return true;
}

function moveGroupByOffset(groupId, offset) {
  const index = tabGroups.findIndex(g => g.id === groupId);
  const target = tabGroups[index + offset];
  if (index === -1 || !target) return;
  if (handleGroupReorder(groupId, target.id, offset < 0)) {
    sessionList.querySelector(`.session-group-header[data-group-id="${groupId}"]`)?.focus();
  }
}

// ───────────── Tab Grouping ─────────────

function generateGroupId() {
  return 'grp-' + Date.now().toString(36) + Math.random().toString(36).substring(2, 6);
}

function getGroupForTab(sessionId) {
  return tabGroups.find(g => g.tabIds.includes(sessionId)) || null;
}

function createGroup(tabIds, name) {
  const color = GROUP_COLORS[nextGroupColorIdx % GROUP_COLORS.length].value;
  nextGroupColorIdx++;
  const group = {
    id: generateGroupId(),
    name: name || `Group ${tabGroups.length + 1}`,
    color,
    collapsed: false,
    tabIds: tabIds || [],
  };
  tabGroups.push(group);
  normalizeSessionOrderToActiveList();
  syncTabStripOrder();
  renderSessionList();
  saveTabState();
  return group;
}

function removeGroup(groupId, closeTabs) {
  const group = tabGroups.find(g => g.id === groupId);
  if (!group) return;
  if (closeTabs) {
    for (const tabId of [...group.tabIds]) {
      terminateSession(tabId, { rememberClosedTab: true });
    }
  }
  tabGroups = tabGroups.filter(g => g.id !== groupId);
  normalizeSessionOrderToActiveList();
  syncTabStripOrder();
  renderSessionList();
  saveTabState();
}

function addTabToGroup(sessionId, groupId) {
  // Remove from any existing group first
  for (const g of tabGroups) {
    const idx = g.tabIds.indexOf(sessionId);
    if (idx !== -1) g.tabIds.splice(idx, 1);
  }
  // Clean up empty groups left behind
  tabGroups = tabGroups.filter(g => g.tabIds.length > 0 || g.id === groupId);
  const group = tabGroups.find(g => g.id === groupId);
  if (group && !group.tabIds.includes(sessionId)) {
    group.tabIds.push(sessionId);
    normalizeSessionOrderToActiveList();
    syncTabStripOrder();
    renderSessionList();
    saveTabState();
  }
}

function removeTabFromGroup(sessionId) {
  tabGroups = pruneSessionFromGroups(tabGroups, sessionId);
  normalizeSessionOrderToActiveList();
  syncTabStripOrder();
  renderSessionList();
  saveTabState();
}

function toggleGroupCollapse(groupId) {
  const group = tabGroups.find(g => g.id === groupId);
  if (group) {
    group.collapsed = !group.collapsed;
    renderSessionList();
    saveTabState();
  }
}

// ───────────── Context Menus ─────────────

function hideContextMenu() {
  const existing = document.getElementById('tab-context-menu');
  if (existing) existing.remove();
}

function showContextMenu(x, y, items) {
  hideContextMenu();

  const menu = document.createElement('div');
  menu.id = 'tab-context-menu';
  menu.className = 'context-menu';
  menu.setAttribute('role', 'menu');

  const focusableItems = () => [...menu.querySelectorAll('[role="menuitem"], [role="menuitemradio"]')]
    .filter(el => !el.closest('.hidden'));

  const wireMenuItem = (el, action) => {
    el.setAttribute('role', 'menuitem');
    el.setAttribute('tabindex', '0');
    el.addEventListener('click', () => {
      action();
      hideContextMenu();
    });
    el.addEventListener('keydown', (event) => {
      if (event.key !== 'Enter' && event.key !== ' ') return;
      event.preventDefault();
      action();
      hideContextMenu();
    });
  };

  menu.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') {
      event.preventDefault();
      hideContextMenu();
      return;
    }
    if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp') return;
    event.preventDefault();
    const items = focusableItems();
    if (items.length === 0) return;
    const currentIndex = items.indexOf(document.activeElement);
    const direction = event.key === 'ArrowDown' ? 1 : -1;
    const nextIndex = currentIndex === -1
      ? 0
      : (currentIndex + direction + items.length) % items.length;
    items[nextIndex].focus();
  });

  for (const item of items) {
    if (item.separator) {
      const sep = document.createElement('div');
      sep.className = 'context-menu-separator';
      menu.appendChild(sep);
      continue;
    }

    if (item.colors) {
      const colorsDiv = document.createElement('div');
      colorsDiv.className = 'context-menu-colors';
      for (const c of GROUP_COLORS) {
        const swatch = document.createElement('span');
        swatch.className = 'color-swatch';
        if (c.value === item.currentColor) swatch.classList.add('selected');
        swatch.style.background = c.value;
        swatch.title = c.name;
        swatch.setAttribute('role', 'menuitemradio');
        swatch.setAttribute('tabindex', '0');
        swatch.setAttribute('aria-label', c.name);
        swatch.setAttribute('aria-checked', c.value === item.currentColor ? 'true' : 'false');
        const selectColor = () => {
          item.onSelect(c.value);
          hideContextMenu();
        };
        swatch.addEventListener('click', selectColor);
        swatch.addEventListener('keydown', (event) => {
          if (event.key !== 'Enter' && event.key !== ' ') return;
          event.preventDefault();
          selectColor();
        });
        colorsDiv.appendChild(swatch);
      }
      menu.appendChild(colorsDiv);
      continue;
    }

    if (item.submenu) {
      const submenuWrapper = document.createElement('div');
      submenuWrapper.className = 'context-menu-submenu';
      const trigger = document.createElement('div');
      trigger.className = 'context-menu-item';
      trigger.textContent = item.label + ' →';
      trigger.setAttribute('role', 'menuitem');
      trigger.setAttribute('tabindex', '0');
      submenuWrapper.appendChild(trigger);

      const sub = document.createElement('div');
      sub.className = 'context-menu hidden';
      for (const subItem of item.submenu) {
        const subEl = document.createElement('div');
        subEl.className = 'context-menu-item';
        if (subItem.colorDot) {
          const dot = document.createElement('span');
          dot.className = 'color-swatch';
          dot.style.background = subItem.colorDot;
          dot.style.width = '10px';
          dot.style.height = '10px';
          subEl.appendChild(dot);
        }
        const labelSpan = document.createElement('span');
        labelSpan.textContent = subItem.label;
        subEl.appendChild(labelSpan);
        wireMenuItem(subEl, subItem.action);
        sub.appendChild(subEl);
      }
      submenuWrapper.appendChild(sub);
      menu.appendChild(submenuWrapper);
      continue;
    }

    const el = document.createElement('div');
    el.className = 'context-menu-item';
    el.textContent = item.label;
    wireMenuItem(el, item.action);
    menu.appendChild(el);
  }

  document.body.appendChild(menu);

  // Position, keeping within viewport
  const menuRect = menu.getBoundingClientRect();
  if (x + menuRect.width > window.innerWidth) x = window.innerWidth - menuRect.width - 4;
  if (y + menuRect.height > window.innerHeight) y = window.innerHeight - menuRect.height - 4;
  menu.style.left = x + 'px';
  menu.style.top = y + 'px';

  // Close on click outside
  const closeHandler = (e) => {
    if (!menu.contains(e.target)) {
      hideContextMenu();
      document.removeEventListener('mousedown', closeHandler, true);
    }
  };
  setTimeout(() => document.addEventListener('mousedown', closeHandler, true), 0);
  return menu;
}

function showSessionContextMenu(e, sessionId) {
  if (currentSidebarTab !== 'active') return;
  const group = getGroupForTab(sessionId);
  const items = [];

  items.push({
    label: 'Rename',
    action: () => {
      const el = sessionList.querySelector(`.session-item[data-session-id="${sessionId}"] .session-title`);
      if (el) startRenameSession(sessionId, el);
    },
  });

  items.push({
    label: 'Add to new group',
    action: () => {
      if (group) removeTabFromGroupSilent(sessionId);
      createGroup([sessionId]);
    },
  });

  const otherGroups = tabGroups.filter(g => !group || g.id !== group.id);
  if (otherGroups.length > 0) {
    items.push({
      label: 'Move to group',
      submenu: otherGroups.map(g => ({
        label: g.name,
        colorDot: g.color,
        action: () => addTabToGroup(sessionId, g.id),
      })),
    });
  }

  if (group) {
    items.push({
      label: 'Remove from group',
      action: () => removeTabFromGroup(sessionId),
    });
  }

  return showContextMenu(e.clientX, e.clientY, items);
}

function startGroupRename(group) {
  if (activeSessionRenameId || (activeGroupRenameId && activeGroupRenameId !== group.id)) return;
  const header = sessionList.querySelector(`.session-group-header[data-group-id="${group.id}"]`);
  if (!header) return;
  const nameSpan = header.querySelector('.session-group-name');
  activeGroupRenameId = group.id;
  nameSpan.setAttribute('contenteditable', 'true');
  nameSpan.focus();
  const range = document.createRange();
  range.selectNodeContents(nameSpan);
  const sel = window.getSelection();
  sel.removeAllRanges();
  sel.addRange(range);

  const finishRename = () => {
    if (activeGroupRenameId === group.id) {
      activeGroupRenameId = null;
    }
    nameSpan.setAttribute('contenteditable', 'false');
    let newName = nameSpan.textContent.trim().substring(0, 50);
    if (newName) group.name = newName;
    else nameSpan.textContent = group.name;
    saveTabState();
    renderSessionList();
    nameSpan.removeEventListener('keydown', onKey);
  };
  const onKey = (ev) => {
    if (ev.key === 'Enter') { ev.preventDefault(); finishRename(); }
    if (ev.key === 'Escape') { nameSpan.textContent = group.name; finishRename(); }
  };
  nameSpan.addEventListener('blur', finishRename);
  nameSpan.addEventListener('keydown', onKey);
}

function showGroupContextMenu(e, groupId) {
  const group = tabGroups.find(g => g.id === groupId);
  if (!group) return;
  const groupIndex = tabGroups.findIndex(g => g.id === groupId);

  const items = [
    {
      label: 'Rename group',
      action: () => startGroupRename(group),
    },
    ...(groupIndex > 0 ? [{
      label: 'Move group up',
      action: () => moveGroupByOffset(groupId, -1),
    }] : []),
    ...(groupIndex >= 0 && groupIndex < tabGroups.length - 1 ? [{
      label: 'Move group down',
      action: () => moveGroupByOffset(groupId, 1),
    }] : []),
    {
      label: 'Change color',
      colors: true,
      currentColor: group.color,
      onSelect: (color) => {
        group.color = color;
        renderSessionList();
        saveTabState();
      },
    },
    { separator: true },
    {
      label: 'Ungroup',
      action: () => removeGroup(groupId, false),
    },
    {
      label: 'Close group',
      action: () => removeGroup(groupId, true),
    },
  ];

  return showContextMenu(e.clientX, e.clientY, items);
}

function removeTabFromGroupSilent(sessionId) {
  tabGroups = pruneSessionFromGroups(tabGroups, sessionId);
}

// Status panel
function toggleStatusPanel() {
  const collapsed = statusPanel.classList.toggle('collapsed');
  btnToggleStatus.classList.toggle('active', !collapsed);
  if (!collapsed && activeSessionId) updateStatusPanel(activeSessionId);
  // Refit terminal once the CSS width transition actually finishes
  let fitted = false;
  statusPanel.addEventListener('transitionend', function onEnd(e) {
    if (e.propertyName === 'width') {
      statusPanel.removeEventListener('transitionend', onEnd);
      fitted = true;
      fitActiveTerminal();
    }
  });
  // Fallback if transitionend doesn't fire (e.g. transition disabled or instant)
  setTimeout(() => { if (!fitted) fitActiveTerminal(); }, 350);
}

// Section expand/collapse state
let statusSectionState = {};

function loadStatusSectionState() {
  try {
    const settings = window._cachedSettings || {};
    const savedSections = settings.statusPanelSections || {};
    statusSectionState = settings.statusPanelSections || {
      summary: true, nextSteps: false, prs: false, workitems: false,
      files: false, generatedFiles: false, pipelines: false, timeline: false
    };
    statusSectionState.generatedFiles = savedSections.generatedFiles ?? savedSections.reportsGenerated ?? statusSectionState.generatedFiles;
  } catch { /* defaults above */ }
}

function saveStatusSectionState() {
  window.api.updateSettings({ statusPanelSections: statusSectionState });
}

function toggleStatusSection(sectionKey, el) {
  const expanded = el.classList.toggle('expanded');
  statusSectionState[sectionKey] = expanded;
  el.querySelector('.status-section-header')?.setAttribute('aria-expanded', String(expanded));
  saveStatusSectionState();
}

function renderStatusSection(key, icon, title, badge, contentHtml) {
  if (!contentHtml) return '';
  const expanded = statusSectionState[key] ? 'expanded' : '';
  return `<div class="status-section ${expanded}" data-section="${key}">
    <button class="status-section-header" type="button" aria-expanded="${statusSectionState[key] ? 'true' : 'false'}">
      <span class="status-section-icon">${icon}</span>
      <span class="status-section-title">${escapeHtml(title)}</span>
      ${badge ? `<span class="status-section-badge">${escapeHtml(String(badge))}</span>` : ''}
      <span class="status-section-chevron">▶</span>
    </button>
    <div class="status-section-content">${contentHtml}</div>
  </div>
  <div class="status-divider"></div>`;
}

function renderResourceItems(resources) {
  const ICONS = {
    pr: ['PR', 'status-resource-icon-pr'],
    workitem: ['WI', 'status-resource-icon-wi'],
    pipeline: ['Build', 'status-resource-icon-pipeline'],
    release: ['Rel', 'status-resource-icon-release'],
    repo: ['Repo', 'status-resource-icon-repo'],
    wiki: ['Wiki', 'status-resource-icon-wiki'],
    link: ['🔗', 'status-resource-icon-link'],
  };

  return resources.map(r => {
    const [iconText, iconClass] = ICONS[r.type] || ['·', ''];
    let label = '';
    if (r.type === 'pr') {
      const stateTag = r.state ? ` <span class="status-pr-state status-pr-${r.state}">${r.state}</span>` : '';
      label = `<span class="status-resource-id">${escapeHtml(r.id)}</span> ${r.repo ? escapeHtml(r.repo) : ''}${stateTag}`;
    } else if (r.type === 'workitem') {
      const title = r.title || r.name || '';
      const typeBadge = r.workItemType ? ` <span class="status-resource-type">${escapeHtml(r.workItemType)}</span>` : '';
      label = `<span class="status-resource-id">${escapeHtml(r.id)}</span>${typeBadge}${title ? ` <span class="status-resource-title">${escapeHtml(title)}</span>` : ''}`;
    } else if (r.type === 'pipeline') {
      const displayId = r.id.startsWith('def-') ? `Def ${r.id.slice(4)}` : `#${r.id}`;
      label = `<span class="status-resource-id">${escapeHtml(displayId)}</span>`;
    } else if (r.type === 'release') {
      label = `<span class="status-resource-id">#${escapeHtml(r.id)}</span>`;
    } else if (r.type === 'repo') {
      label = escapeHtml(r.name || r.url);
    } else if (r.type === 'wiki') {
      try { label = escapeHtml(decodeURIComponent(r.url.split('/').pop() || r.url)); }
      catch { label = escapeHtml(r.url.split('/').pop() || r.url); }
    } else {
      label = escapeHtml(r.name || r.url || '');
    }

    const url = r.url || '#';
    const resourceTitle = r.title || r.name;
    const itemTitle = r.type === 'workitem'
      ? `WI ${r.id}${r.workItemType ? ` [${r.workItemType}]` : ''}${resourceTitle ? ` - ${resourceTitle}` : ''}`
      : (r.name || r.url || (r.id ? `${iconText} ${r.id}` : ''));
    return `<div class="status-resource-item" data-url="${escapeHtml(url)}" title="${escapeHtml(itemTitle)}">
      <span class="status-resource-icon ${iconClass}">${escapeHtml(iconText)}</span>
      <span class="status-resource-details">${label}</span>
    </div>`;
  }).join('');
}

async function updateStatusPanel(sessionId) {
  const requestId = ++statusPanelRequestSeq;
  if (statusPanel.classList.contains('collapsed')) return;
  loadStatusSectionState();

  if (!sessionId) {
    hideStatusDiffPopover();
    statusPanelBody.innerHTML = '<div class="status-empty">Open a session to see its status</div>';
    return;
  }

  // Fetch status data and resources in parallel
  const [statusData, session] = await Promise.all([
    window.api.getSessionStatus(sessionId).catch(() => null),
    Promise.resolve(allSessions.find(s => s.id === sessionId)),
  ]);
  if (!shouldApplyStatusPanelUpdate({
    requestId,
    currentRequestId: statusPanelRequestSeq,
    requestedSessionId: sessionId,
    activeSessionId,
    panelCollapsed: statusPanel.classList.contains('collapsed'),
  })) {
    return;
  }

  const resources = session?.resources || [];
  const status = statusData || { intent: null, summary: null, nextSteps: [], files: [], generatedFiles: [], timeline: [] };

  let html = '';

  // Current intent
  if (status.intent) {
    html += `<div class="status-intent">
      <div class="status-intent-pulse"></div>
      <span class="status-intent-text">${escapeHtml(status.intent)}</span>
    </div>`;
  }

  // Summary section
  const summaryText = status.summary?.text
    ? `<div class="status-summary-text">${escapeHtml(status.summary.text)}</div>`
    : '<div class="status-summary-empty">No summary yet for this session.</div>';
  const directoryAvailability = await window.api.getSessionDirectoryAvailability(sessionId).catch(() => ({
    sessionDirectoryAvailable: false,
    filesDirectoryAvailable: false,
  }));
  const summaryMeta = renderStatusSummaryMetaHtml(sessionId, directoryAvailability);
  html += renderStatusSection('summary', '📝', 'Summary', null, `${summaryText}${summaryMeta}`);

  // Next steps
  if (status.nextSteps.length > 0) {
    const total = status.nextSteps.length;
    const doneCount = status.nextSteps.filter(s => s.done).length;
    const remaining = total - doneCount;
    const stepsHtml = status.nextSteps.map((step, i) => {
      const cls = step.done ? 'done' : step.current ? 'current' : '';
      const num = step.done ? '✓' : String(i + 1);
      return `<div class="status-step ${cls}">
        <span class="status-step-num">${num}</span>
        <span class="status-step-text">${escapeHtml(step.text)}</span>
      </div>`;
    }).join('');
    // Show badge only when there's a mix of done/pending (i.e. progress is meaningful)
    const badge = doneCount > 0 && remaining > 0 ? `${remaining} remaining` : remaining > 0 ? `${total} steps` : 'done';
    html += renderStatusSection('nextSteps', '🎯', 'Next Steps', badge, stepsHtml);
  }

  // Pull requests
  const prs = resources.filter(r => r.type === 'pr');
  if (prs.length > 0) {
    html += renderStatusSection('prs', '⤴', 'Pull Requests', prs.length, renderResourceItems(prs));
  }

  // Work items
  const wis = resources.filter(r => r.type === 'workitem');
  if (wis.length > 0) {
    html += renderStatusSection('workitems', '📌', 'Work Items', wis.length, renderResourceItems(wis));
  }

  // Files changed
  if (status.files.length > 0) {
    const filesHtml = status.files.map(f => {
      const badgeCls =
        f.action === 'A' ? 'status-file-added' :
        f.action === 'D' ? 'status-file-deleted' :
        f.action === 'R' ? 'status-file-renamed' :
        'status-file-modified';
      const diffData = f.diff ? ` data-diff="${escapeHtml(encodeURIComponent(f.diff))}"` : '';
      return `<div class="status-file-item${f.diff ? ' status-file-item-hoverable' : ''}"${diffData}>
        <span class="status-file-badge ${badgeCls}">${f.action}</span>
        <span class="status-file-path">${escapeHtml(f.path)}</span>
      </div>`;
    }).join('');
    html += renderStatusSection('files', '📂', 'Files Changed', status.files.length, filesHtml);
  }

  if (status.generatedFiles.length > 0) {
    const generatedFilesHtml = status.generatedFiles.map((file) => {
      const badge = file.ext ? file.ext.toUpperCase().slice(0, 5) : 'FILE';
      return `<div class="status-generated-file-item" data-session-id="${escapeHtml(sessionId)}" data-relative-path="${escapeHtml(file.path)}" title="${escapeHtml(file.path)}">
        <span class="status-generated-file-badge">${escapeHtml(badge)}</span>
        <div class="status-generated-file-details">
          <div class="status-generated-file-name">${escapeHtml(file.name)}</div>
          <div class="status-generated-file-path">${escapeHtml(file.path)}</div>
        </div>
      </div>`;
    }).join('');
    html += renderStatusSection('generatedFiles', '📄', 'Reports Generated', status.generatedFiles.length, generatedFilesHtml);
  }

  // Pipelines, releases, repos, wikis, links
  const otherResources = resources.filter(r => !['pr', 'workitem'].includes(r.type));
  if (otherResources.length > 0) {
    html += renderStatusSection('pipelines', '🔗', 'Resources', otherResources.length, renderResourceItems(otherResources));
  }

  // Timeline
  if (status.timeline.length > 0) {
    const DOT_COLORS = {
      user: 'var(--accent)', assistant: 'var(--green)',
    };
    const timelineHtml = status.timeline.map(ev => {
      const time = new Date(ev.time);
      const hhmm = `${String(time.getHours()).padStart(2, '0')}:${String(time.getMinutes()).padStart(2, '0')}`;
      const color = DOT_COLORS[ev.type] || 'var(--text-dim)';
      const title = ev.fullText && ev.fullText !== ev.text ? ` title="${escapeHtml(ev.fullText)}"` : '';
      return `<div class="status-timeline-item">
        <span class="status-timeline-time">${hhmm}</span>
        <div class="status-timeline-dot" style="background:${color}"></div>
        <span class="status-timeline-text"${title}>${escapeHtml(ev.text)}</span>
      </div>`;
    }).join('');
    html += renderStatusSection('timeline', '🕐', 'Timeline', null, timelineHtml);
  }

  if (!html) {
    html = '<div class="status-empty">No status data yet for this session</div>';
  }

  hideStatusDiffPopover();
  statusPanelBody.innerHTML = html;

  // Wire section expand/collapse
  statusPanelBody.querySelectorAll('.status-section-header').forEach(header => {
    header.addEventListener('click', () => {
      const section = header.closest('.status-section');
      const key = section.dataset.section;
      toggleStatusSection(key, section);
    });
  });

  // Wire resource item clicks → open in external browser
  statusPanelBody.querySelectorAll('.status-resource-item').forEach(item => {
    item.addEventListener('click', () => {
      const url = item.dataset.url;
      if (url && url !== '#') window.api.openExternal(url);
    });
  });

  statusPanelBody.querySelectorAll('.status-generated-file-item').forEach(item => {
    item.addEventListener('click', async () => {
      const targetSessionId = item.dataset.sessionId;
      const relativePath = item.dataset.relativePath;
      if (!targetSessionId || !relativePath) return;

      const result = await window.api.openGeneratedFile(targetSessionId, relativePath);
      if (!result?.ok) {
        showToast({
          type: 'error',
          title: 'Could not open generated file',
          body: result?.error || relativePath,
        });
      }
    });
  });
}

function fitActiveTerminal() {
  if (activeSessionId && terminals.has(activeSessionId)) {
    const entry = terminals.get(activeSessionId);
    entry.fitAddon.fit();
    trackedResizePty(activeSessionId, entry.terminal.cols, entry.terminal.rows);
    // Force viewport scroll area sync even when fit() is a no-op (same cols/rows).
    syncTerminalViewport(activeSessionId);
    // Reset any horizontal scroll offset that xterm's viewport may have retained
    // from a wider column count (e.g. when status panel opens and narrows the container).
    const viewport = entry.terminal.element?.querySelector('.xterm-viewport');
    if (viewport) viewport.scrollLeft = 0;
    const screen = entry.terminal.element?.querySelector('.xterm-screen');
    if (screen) screen.style.width = '';
    scheduleTerminalViewportSync(activeSessionId, { refreshSearch: true });
  }
}

// Instructions panel
async function showInstructions() {
  const content = await window.api.readInstructions();
  originalInstructions = content;
  currentInstructions = content;

  renderMarkdown(content);

  instructionsPanel.classList.remove('hidden');
  terminalArea.style.display = 'none';

  if (typeof refreshReviewButton === 'function') {
    refreshReviewButton().catch(err => console.warn('refreshReviewButton failed:', err));
  }
}

function renderMarkdown(md, changedLineNumbers) {
  const changedSet = new Set(changedLineNumbers || []);
  const lines = md.replace(/\r\n/g, '\n').split('\n');

  // First pass: collect headers for TOC
  const headers = [];
  let inCB = false;
  for (let i = 0; i < lines.length; i++) {
    if (lines[i].startsWith('```')) { inCB = !inCB; continue; }
    if (inCB) continue;
    const m3 = lines[i].match(/^(#{1,3}) (.+)$/);
    if (m3) {
      const level = m3[1].length;
      const text = m3[2].replace(/\*\*/g, '').replace(/\*/g, '');
      const id = 'sec-' + text.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '');
      headers.push({ level, text, id, lineNum: i });
    }
  }

  // Build TOC
  let toc = '<nav class="instructions-toc"><div class="toc-title">Contents</div><ul>';
  for (const h of headers) {
    const indent = h.level === 1 ? '' : h.level === 2 ? 'toc-l2' : 'toc-l3';
    toc += `<li class="${indent}"><a href="#${h.id}">${escapeHtml(h.text)}</a></li>`;
  }
  toc += '</ul></nav>';

  // Second pass: render content grouped into collapsible sections
  // Each h1/h2 starts a new <details> section; h3 stays inside the current one
  let html = toc;
  let inCodeBlock = false;
  let codeBlockContent = '';
  let codeBlockStartLine = -1;
  let listItems = [];
  let openDetails = 0; // nesting depth of open <details>

  function flushList() {
    if (listItems.length === 0) return;
    const anyChanged = listItems.some(li => changedSet.has(li.lineNum));
    const cls = anyChanged ? ' class="changed-line"' : '';
    html += `<ul${cls}>` + listItems.map(li => `<li>${processInline(li.text)}</li>`).join('') + '</ul>';
    listItems = [];
  }

  function processInline(text) {
    const codeSpans = [];
    text = text
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/`([^`]+)`/g, (match, code) => {
        codeSpans.push(`<code>${code}</code>`);
        return `\x00CODE${codeSpans.length - 1}\x00`;
      })
      .replace(/\*\*\*(.+?)\*\*\*/g, '<strong><em>$1</em></strong>')
      .replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
      .replace(/\*(.+?)\*/g, '<em>$1</em>')
      .replace(/\x00CODE(\d+)\x00/g, (_, i) => codeSpans[parseInt(i)]);
    return text;
  }

  function closeOpenDetails() {
    flushList();
    while (openDetails > 0) { html += '</div></details>'; openDetails--; }
  }

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const changed = changedSet.has(i);
    const cls = changed ? ' class="changed-line"' : '';

    // Code block toggle
    if (line.startsWith('```')) {
      if (inCodeBlock) {
        const anyChanged = changedSet.has(codeBlockStartLine) || changedSet.has(i);
        const ccls = anyChanged ? ' class="changed-line"' : '';
        html += `<pre${ccls}><code>${codeBlockContent.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').trim()}</code></pre>`;
        inCodeBlock = false;
        codeBlockContent = '';
      } else {
        flushList();
        inCodeBlock = true;
        codeBlockStartLine = i;
        codeBlockContent = '';
      }
      continue;
    }
    if (inCodeBlock) { codeBlockContent += line + '\n'; continue; }

    // List items
    if (/^[-*] /.test(line)) {
      listItems.push({ text: line.replace(/^[-*] /, ''), lineNum: i });
      continue;
    } else {
      flushList();
    }

    // Empty line
    if (line.trim() === '') { html += '\n'; continue; }

    // Headers — h1/h2 start collapsible sections
    const headerInfo = headers.find(h => h.lineNum === i);
    if (headerInfo) {
      if (headerInfo.level <= 2) {
        closeOpenDetails();
        const tag = headerInfo.level === 1 ? 'h1' : 'h2';
        html += `<details class="section-collapse" open><summary${cls}><${tag} id="${headerInfo.id}">${processInline(headerInfo.text)}</${tag}></summary><div class="section-body">`;
        openDetails++;
      } else {
        flushList();
        html += `<h3 id="${headerInfo.id}"${cls}>${processInline(headerInfo.text)}</h3>`;
      }
      continue;
    }

    // HR
    if (/^---+$/.test(line)) { html += '<hr>'; continue; }

    // Blockquote
    if (line.startsWith('> ')) { html += `<blockquote${cls}>${processInline(line.slice(2))}</blockquote>`; continue; }

    // Table rows
    if (line.startsWith('|') && line.endsWith('|')) {
      let tableRows = [{ line, lineNum: i }];
      while (i + 1 < lines.length && lines[i + 1].startsWith('|') && lines[i + 1].endsWith('|')) {
        i++;
        tableRows.push({ line: lines[i], lineNum: i });
      }
      const anyChanged = tableRows.some(r => changedSet.has(r.lineNum));
      const tcls = anyChanged ? ' class="changed-line"' : '';
      let table = `<table${tcls}>`;
      tableRows.forEach((row, ri) => {
        const cells = row.line.split('|').filter(c => c.trim());
        if (cells.every(c => /^[-:]+$/.test(c.trim()))) return;
        const tag = ri === 0 ? 'th' : 'td';
        table += '<tr>' + cells.map(c => `<${tag}>${processInline(c.trim())}</${tag}>`).join('') + '</tr>';
      });
      table += '</table>';
      html += table;
      continue;
    }

    // Paragraph
    html += `<p${cls}>${processInline(line)}</p>`;
  }
  closeOpenDetails();

  instructionsRendered.innerHTML = html;

  // TOC click — smooth scroll
  instructionsRendered.querySelectorAll('.instructions-toc a').forEach(a => {
    a.addEventListener('click', (e) => {
      e.preventDefault();
      const id = a.getAttribute('href').slice(1);
      const target = instructionsRendered.querySelector('#' + id);
      if (target) {
        // Make sure parent details is open
        const details = target.closest('details');
        if (details && !details.open) details.open = true;
        target.scrollIntoView({ behavior: 'smooth', block: 'start' });
      }
    });
  });

  // Fade out change highlights — handled by CSS animation now
}

function hideInstructions() {
  instructionsPanel.classList.add('hidden');
  terminalArea.style.display = '';
}

// Import/export instructions
async function exportInstructions() {
  const content = currentInstructions || await window.api.readInstructions();
  const blob = new Blob([content], { type: 'text/markdown' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = 'copilot-instructions.md';
  a.click();
  URL.revokeObjectURL(url);
}

function importInstructions(mode) {
  const input = document.createElement('input');
  input.type = 'file';
  input.accept = '.md,.txt,.markdown';
  input.addEventListener('change', async () => {
    const file = input.files?.[0];
    if (!file) return;
    const text = await file.text();

    if (mode === 'override') {
      currentInstructions = text;
      await window.api.writeInstructions(text);
      renderMarkdown(text);
    } else {
      // Merge — append non-duplicate lines
      const existingLines = new Set(
        currentInstructions.split('\n')
          .map(l => l.trim())
          .filter(l => l && l !== '---' && !l.match(/^#{1,6}\s/) && l !== '```')
      );
      const newLines = text.split('\n');
      const toAdd = [];
      newLines.forEach(line => {
        if (line.trim() && !existingLines.has(line.trim())) {
          toAdd.push(line);
        }
      });
      if (toAdd.length > 0) {
        const merged = currentInstructions.trimEnd() + '\n\n' + toAdd.join('\n') + '\n';
        currentInstructions = merged;
        await window.api.writeInstructions(merged);
        renderMarkdown(merged);
      }
    }
  });
  input.click();
}

btnInstructions.addEventListener('click', showInstructions);
btnCloseInstructions.addEventListener('click', hideInstructions);

// Import/export
document.getElementById('btn-export-instructions').addEventListener('click', exportInstructions);
document.getElementById('btn-import-instructions').addEventListener('click', () => {
  showImportMenu();
});

// ===== Enhance Instructions =====
let lastEnhanceBackup = null;
let enhancementInFlight = false;

const enhanceConfirmModal = document.getElementById('enhance-confirm-modal');
const reviewModal = document.getElementById('review-modal');
const reviewIframe = document.getElementById('review-modal-iframe');
const reviewTimestampLabel = document.getElementById('review-modal-timestamp');
const btnEnhance = document.getElementById('btn-enhance-instructions');
const btnReview = document.getElementById('btn-review-enhancement');
const enhanceConfirmContent = enhanceConfirmModal.querySelector('.enhance-modal-content');
const reviewModalContent = reviewModal.querySelector('.review-modal-content');

async function refreshReviewButton() {
  try {
    const backups = await window.api.enhanceListBackups();
    // Prefer a pending proposal (has changes.html, not yet applied) over an already-applied one.
    // If none pending, fall back to the most recent applied backup so the user can still rollback.
    const pending = backups.find(b => b.hasChangesHtml && !b.applied);
    const applied = backups.find(b => b.applied);
    const target = pending || applied || null;

    if (target) {
      lastEnhanceBackup = target;
      btnReview.classList.remove('hidden');
      btnReview.title = pending
        ? `Review proposed enhancement from ${target.timestamp}`
        : `Review or roll back applied enhancement from ${target.timestamp}`;
    } else {
      lastEnhanceBackup = null;
      btnReview.classList.add('hidden');
    }
  } catch (err) {
    console.warn('Failed to list enhancement backups:', err);
  }
}

function openEnhanceConfirm() {
  enhanceConfirmModal.classList.remove('hidden');
  // Focus the safe (cancel) button by default
  setTimeout(() => document.getElementById('btn-enhance-cancel')?.focus(), 0);
}
function closeEnhanceConfirm() {
  enhanceConfirmModal.classList.add('hidden');
  if (!enhancementInFlight) btnEnhance.focus();
}

async function startEnhancement() {
  if (enhancementInFlight) return;
  enhancementInFlight = true;
  closeEnhanceConfirm();
  btnEnhance.disabled = true;

  hideInstructions();
  try {
    // SINGLE atomic IPC: backup + write prompt file + spawn new session with
    // the prompt baked into the CLI args via `-i`. Both Copilot CLI and
    // `agency copilot` execute it on startup — no PTY-write timing involved.
    const { sessionId, backup } = await window.api.enhanceStartSession();

    showToast({
      type: 'success',
      title: backup.reused ? 'Reusing existing backup' : 'Backup created',
      body: backup.reused
        ? `No changes since ${backup.timestamp} — using that snapshot.`
        : `Saved ${backup.fileCount} file(s) to ${backup.timestamp}`,
    });

    sessionAliveState.add(sessionId);
    createTerminal(sessionId);
    switchToSession(sessionId);
    addTab(sessionId, 'Enhance Instructions');

    if (!allSessions.find(s => s.id === sessionId)) {
      allSessions.unshift({
        id: sessionId,
        title: 'Enhance Instructions',
        cwd: '',
        updatedAt: new Date().toISOString(),
        tags: [],
        resources: [],
      });
    }
    currentSidebarTab = 'active';
    document.querySelectorAll('.sidebar-tab').forEach(t =>
      t.classList.toggle('active', t.dataset.tab === 'active')
    );
    renderSessionList();
    saveTabState();

    showToast({
      type: 'info',
      title: 'Enhancement session started',
      body: 'When it finishes, click Review on the Instructions panel.',
    });
  } catch (err) {
    showToast({ type: 'error', title: 'Enhancement failed to start', body: String(err.message || err) });
  } finally {
    enhancementInFlight = false;
    btnEnhance.disabled = false;
  }
}

async function openReviewModal() {
  if (!lastEnhanceBackup) {
    await refreshReviewButton();
    if (!lastEnhanceBackup) {
      showToast({ type: 'info', title: 'No enhancement found', body: 'Run Enhance to generate one.' });
      return;
    }
  }
  let html;
  try {
    html = await window.api.enhanceGetBackupHtml(lastEnhanceBackup.timestamp);
  } catch (err) {
    showToast({ type: 'error', title: 'Failed to load report', body: String(err.message || err) });
    return;
  }
  if (!html) {
    showToast({ type: 'info', title: 'Report not ready yet', body: 'The enhancement session has not produced changes.html.' });
    return;
  }
  reviewIframe.srcdoc = decorateReportHtml(html);
  reviewTimestampLabel.textContent = lastEnhanceBackup.timestamp;
  updateReviewModalActions();
  reviewModal.classList.remove('hidden');
  setTimeout(() => document.getElementById('btn-review-close')?.focus(), 0);
}

// Inject theme + diff-coloring overrides into the agent's report HTML so it
// renders consistently in the iframe regardless of how the agent styled it.
// We inject the override stylesheet at end-of-body to win cascade order, and
// match the same specificity (html[data-theme="..."]) the report templates use.
// We also run a JS pass that auto-colors unified-diff lines inside <pre> blocks
// — older reports emit raw text diffs without semantic <ins>/<del> markup.
function decorateReportHtml(html) {
  const isDark = currentTheme !== 'latte';
  const dataTheme = isDark ? 'dark' : 'light';
  const palette = isDark
    ? {
        bg: '#1e1e2e', bgElev: '#181825', surface: '#313244', surfaceSoft: '#45475a',
        text: '#cdd6f4', muted: '#a6adc8', soft: '#bac2de',
        border: '#45475a', borderStrong: '#585b70', accent: '#cba6f7', accentSoft: 'rgba(203,166,247,0.14)',
        link: '#89b4fa',
        addBg: 'rgba(166, 227, 161, 0.18)', addFg: '#a6e3a1', addBorder: '#a6e3a1',
        delBg: 'rgba(243, 139, 168, 0.18)', delFg: '#f38ba8', delBorder: '#f38ba8',
        ctxFg: '#a6adc8',
      }
    : {
        bg: '#eff1f5', bgElev: '#e6e9ef', surface: '#ccd0da', surfaceSoft: '#dce0e8',
        text: '#4c4f69', muted: '#6c6f85', soft: '#5c5f77',
        border: '#bcc0cc', borderStrong: '#acb0be', accent: '#8839ef', accentSoft: 'rgba(136,57,239,0.14)',
        link: '#1e66f5',
        addBg: 'rgba(64, 160, 43, 0.18)', addFg: '#40a02b', addBorder: '#40a02b',
        delBg: 'rgba(210, 15, 57, 0.18)', delFg: '#d20f39', delBorder: '#d20f39',
        ctxFg: '#6c6f85',
      };
  const overrideStyle = `<style id="deepsky-report-overrides">
    html[data-theme="${dataTheme}"], html[data-theme="dark"], html[data-theme="light"], :root {
      color-scheme: ${dataTheme} !important;
      --cp-bg: ${palette.bg} !important;
      --cp-bg-elevated: ${palette.bgElev} !important;
      --cp-surface: ${palette.surface} !important;
      --cp-surface-soft: ${palette.surfaceSoft} !important;
      --cp-border: ${palette.border} !important;
      --cp-border-strong: ${palette.borderStrong} !important;
      --cp-text: ${palette.text} !important;
      --cp-text-muted: ${palette.muted} !important;
      --cp-text-soft: ${palette.soft} !important;
      --cp-accent: ${palette.accent} !important;
      --cp-accent-hover: ${palette.accent} !important;
      --cp-accent-soft: ${palette.accentSoft} !important;
      --cp-link: ${palette.link} !important;
      --cp-panel: ${palette.surface} !important;
      --cp-panel-strong: ${palette.surface} !important;
    }
    html, body { background: ${palette.bg} !important; color: ${palette.text} !important; }
    /* Semantic diff markup */
    ins, .diff-add, .diff-line.added, .diff-add-line, .added {
      background: ${palette.addBg} !important;
      color: ${palette.addFg} !important;
      text-decoration: none !important;
    }
    del, .diff-remove, .diff-line.removed, .diff-del-line, .removed {
      background: ${palette.delBg} !important;
      color: ${palette.delFg} !important;
      text-decoration: none !important;
    }
    /* Block-level diff lines DeepSky auto-wraps in <pre> blocks */
    .deepsky-diff-add {
      display: block;
      background: ${palette.addBg};
      color: ${palette.addFg};
      border-left: 3px solid ${palette.addBorder};
      padding: 1px 8px;
      margin: 0 -8px;
    }
    .deepsky-diff-del {
      display: block;
      background: ${palette.delBg};
      color: ${palette.delFg};
      border-left: 3px solid ${palette.delBorder};
      padding: 1px 8px;
      margin: 0 -8px;
    }
    .deepsky-diff-ctx {
      display: block;
      color: ${palette.ctxFg};
      padding: 1px 8px;
      margin: 0 -8px;
    }
  </style>
  <script>
    (function(){
      try { document.documentElement.setAttribute('data-theme', '${dataTheme}'); } catch(_) {}
      // Remove any prefers-color-scheme based theme inversions the report tried to apply
      try {
        var mo = new MutationObserver(function(){
          if (document.documentElement.getAttribute('data-theme') !== '${dataTheme}') {
            document.documentElement.setAttribute('data-theme', '${dataTheme}');
          }
        });
        mo.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });
      } catch(_) {}
      // Auto-color unified-diff lines (+/-) inside <pre> blocks for reports
      // that emitted raw text diffs without semantic markup.
      function decorateDiffs() {
        document.querySelectorAll('pre').forEach(function(pre){
          if (pre.dataset.deepskyDecorated) return;
          var raw = pre.textContent || '';
          var lines = raw.split('\\n');
          // Heuristic: only treat as diff if at least 2 lines start with + or - (and not ++ or -- which are headers)
          var diffLineCount = 0;
          for (var i = 0; i < lines.length; i++) {
            var l = lines[i];
            if ((l[0] === '+' || l[0] === '-') && l[1] !== l[0]) diffLineCount++;
          }
          if (diffLineCount < 2) return;
          var frag = document.createDocumentFragment();
          for (var j = 0; j < lines.length; j++) {
            var line = lines[j];
            var span = document.createElement('span');
            if (line.startsWith('+++') || line.startsWith('---') || line.startsWith('@@')) {
              span.className = 'deepsky-diff-ctx';
              span.style.fontWeight = '600';
            } else if (line[0] === '+') {
              span.className = 'deepsky-diff-add';
            } else if (line[0] === '-') {
              span.className = 'deepsky-diff-del';
            } else {
              span.className = 'deepsky-diff-ctx';
            }
            span.textContent = line + (j < lines.length - 1 ? '\\n' : '');
            frag.appendChild(span);
          }
          pre.textContent = '';
          pre.appendChild(frag);
          pre.dataset.deepskyDecorated = '1';
        });
      }
      if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', decorateDiffs);
      } else {
        decorateDiffs();
      }
    })();
  </script>`;
  // Inject at END of body so we win cascade order against the report's own CSS.
  if (/<\/body>/i.test(html)) {
    return html.replace(/<\/body>/i, overrideStyle + '</body>');
  }
  // No </body>? Append.
  return html + overrideStyle;
}

function updateReviewModalActions() {
  const btnApply = document.getElementById('btn-review-apply');
  const btnDiscard = document.getElementById('btn-review-discard');
  const btnRollback = document.getElementById('btn-review-rollback');
  if (!lastEnhanceBackup) {
    btnApply.classList.add('hidden');
    btnDiscard.classList.add('hidden');
    btnRollback.classList.add('hidden');
    return;
  }
  const pending = lastEnhanceBackup.hasProposed && !lastEnhanceBackup.applied;
  btnApply.classList.toggle('hidden', !pending);
  btnDiscard.classList.toggle('hidden', !pending);
  btnRollback.classList.toggle('hidden', !lastEnhanceBackup.applied);
}

function focusReviewTrigger() {
  if (!btnReview.classList.contains('hidden')) {
    btnReview.focus();
    return;
  }
  btnEnhance.focus();
}

function focusReviewModalAction() {
  const focusTarget = [
    document.getElementById('btn-review-apply'),
    document.getElementById('btn-review-discard'),
    document.getElementById('btn-review-rollback'),
    document.getElementById('btn-review-close'),
  ].find((button) => button && !button.classList.contains('hidden') && !button.disabled);

  focusTarget?.focus();
}

function closeReviewModal({ restoreFocus = true } = {}) {
  reviewModal.classList.add('hidden');
  reviewIframe.removeAttribute('srcdoc');
  if (restoreFocus) focusReviewTrigger();
}

async function applyEnhancement() {
  if (!lastEnhanceBackup) return;
  try {
    const result = await window.api.enhanceApply(lastEnhanceBackup.timestamp);
    showToast({
      type: 'success',
      title: 'Enhancement applied',
      body: `${result.applied.length} change(s) applied. Roll back from the same Review button if needed.`,
    });
    closeReviewModal({ restoreFocus: false });
    await refreshReviewButton();
    focusReviewTrigger();
    if (!instructionsPanel.classList.contains('hidden')) {
      await showInstructions();
    }
  } catch (err) {
    showToast({ type: 'error', title: 'Apply failed', body: String(err.message || err) });
    await refreshReviewButton();
    updateReviewModalActions();
    focusReviewModalAction();
  }
}

async function discardEnhancement() {
  if (!lastEnhanceBackup) return;
  const ok = confirm(`Discard the proposed changes from ${lastEnhanceBackup.timestamp}? Your current instructions are not modified.`);
  if (!ok) return;
  try {
    await window.api.enhanceDiscard(lastEnhanceBackup.timestamp);
    showToast({ type: 'info', title: 'Proposal discarded', body: 'Your current instructions remain unchanged.' });
    closeReviewModal({ restoreFocus: false });
    await refreshReviewButton();
    focusReviewTrigger();
  } catch (err) {
    showToast({ type: 'error', title: 'Discard failed', body: String(err.message || err) });
    await refreshReviewButton();
    updateReviewModalActions();
    focusReviewModalAction();
  }
}

async function rollbackEnhancement() {
  if (!lastEnhanceBackup) return;
  const ok = confirm(`Roll back to backup ${lastEnhanceBackup.timestamp}? This will overwrite your current instructions and playbooks.`);
  if (!ok) return;
  try {
    const result = await window.api.enhanceRollback(lastEnhanceBackup.timestamp);
    showToast({
      type: 'success',
      title: 'Rolled back',
      body: `Restored ${result.restored.length} item(s) from ${result.timestamp}`,
    });
    closeReviewModal({ restoreFocus: false });
    await refreshReviewButton();
    focusReviewTrigger();
    if (!instructionsPanel.classList.contains('hidden')) {
      await showInstructions();
    }
  } catch (err) {
    showToast({ type: 'error', title: 'Rollback failed', body: String(err.message || err) });
    await refreshReviewButton();
    updateReviewModalActions();
    focusReviewModalAction();
  }
}

btnEnhance.addEventListener('click', openEnhanceConfirm);
document.getElementById('btn-enhance-cancel').addEventListener('click', closeEnhanceConfirm);
document.getElementById('btn-enhance-confirm').addEventListener('click', startEnhancement);
btnReview.addEventListener('click', openReviewModal);
document.getElementById('btn-review-close').addEventListener('click', closeReviewModal);
document.getElementById('btn-review-apply').addEventListener('click', applyEnhancement);
document.getElementById('btn-review-discard').addEventListener('click', discardEnhancement);
document.getElementById('btn-review-rollback').addEventListener('click', rollbackEnhancement);
enhanceConfirmModal.addEventListener('click', (e) => {
  if (isBackdropClickTarget(e.target)) closeEnhanceConfirm();
});
reviewModal.addEventListener('click', (e) => {
  if (isBackdropClickTarget(e.target)) closeReviewModal();
});

// Trap focus inside the active modal and let Esc close it.
document.addEventListener('keydown', (e) => {
  if (e.key === 'Tab') {
    if (!reviewModal.classList.contains('hidden') && trapFocusWithin(e, reviewModalContent)) {
      return;
    }
    if (!enhanceConfirmModal.classList.contains('hidden') && trapFocusWithin(e, enhanceConfirmContent)) {
      return;
    }
  }
  if (e.key === 'Escape') {
    if (!reviewModal.classList.contains('hidden')) {
      closeReviewModal();
      e.stopPropagation();
    } else if (!enhanceConfirmModal.classList.contains('hidden')) {
      closeEnhanceConfirm();
      e.stopPropagation();
    }
  }
});

// Refresh on initial load
refreshReviewButton();


function showImportMenu() {
  // Remove existing menu if any
  document.querySelectorAll('.import-menu').forEach(el => el.remove());

  const btn = document.getElementById('btn-import-instructions');
  const rect = btn.getBoundingClientRect();
  const menu = document.createElement('div');
  menu.className = 'import-menu';
  menu.style.top = (rect.bottom + 4) + 'px';
  menu.style.right = (window.innerWidth - rect.right) + 'px';
  menu.innerHTML = `
    <button class="import-menu-item" data-mode="merge">
      <span class="import-menu-icon">+</span>
      <span><strong>Merge</strong><br><span class="import-menu-desc">Add new lines, keep existing</span></span>
    </button>
    <button class="import-menu-item" data-mode="override">
      <span class="import-menu-icon">↻</span>
      <span><strong>Override</strong><br><span class="import-menu-desc">Replace everything</span></span>
    </button>
  `;
  document.body.appendChild(menu);

  menu.querySelectorAll('.import-menu-item').forEach(item => {
    item.addEventListener('click', () => {
      importInstructions(item.dataset.mode);
      menu.remove();
    });
  });

  // Close on click outside
  const closeMenu = (e) => {
    if (!menu.contains(e.target) && e.target !== btn) {
      menu.remove();
      document.removeEventListener('click', closeMenu, true);
    }
  };
  setTimeout(() => document.addEventListener('click', closeMenu, true), 0);
}

// Date helpers
function getDateLabel(dateStr) {
  const date = new Date(dateStr);
  const now = new Date();
  const diff = now - date;
  const days = Math.floor(diff / (1000 * 60 * 60 * 24));
  if (days === 0) return 'Today';
  if (days === 1) return 'Yesterday';
  if (days < 7) return `${days} days ago`;
  if (days < 30) return `${Math.floor(days / 7)} weeks ago`;
  return date.toLocaleDateString(undefined, { month: 'short', year: 'numeric' });
}

function escapeHtml(str) {
  const div = document.createElement('div');
  div.textContent = str;
  return div.innerHTML.replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

function shortenPath(p) {
  if (!p) return '';
  const sep = p.includes('/') ? '/' : '\\';
  const parts = p.split(sep).filter(Boolean);
  if (parts.length <= 2) return p;
  // Show drive/root + ... + last folder
  return parts[0] + sep + '…' + sep + parts[parts.length - 1];
}


// Sidebar resize
const resizeHandle = document.getElementById('resize-handle');
const sidebar = document.getElementById('sidebar');
let isResizing = false;
let resizeStartX = 0;
let resizeDidDrag = false;

resizeHandle.addEventListener('mousedown', (e) => {
  isResizing = true;
  resizeStartX = e.clientX;
  resizeDidDrag = false;
  resizeHandle.classList.add('dragging');
  document.body.style.cursor = 'col-resize';
  document.body.style.userSelect = 'none';
});

document.addEventListener('mousemove', (e) => {
  if (!isResizing) return;
  if (!resizeDidDrag && Math.abs(e.clientX - resizeStartX) > 3) resizeDidDrag = true;
  if (!resizeDidDrag) return;
  // Un-hide on drag
  if (sidebarHidden) {
    setSidebarHidden(false, { persist: false });
  }

  const nextSidebarState = resolveSidebarDragWidth(e.clientX, {
    minWidth: SIDEBAR_MIN_WIDTH,
    maxWidth: SIDEBAR_MAX_WIDTH
  });

  if (nextSidebarState.mode === 'collapsed') {
    // Dragged narrow enough → snap into collapsed icon mode.
    setSidebarCollapsed(true, { persist: false });
  } else {
    if (sidebarCollapsed) {
      setSidebarCollapsed(false, { persist: false });
    }
    sidebar.style.width = nextSidebarState.width + 'px';
  }
});

document.addEventListener('mouseup', () => {
  if (isResizing) {
    isResizing = false;
    resizeHandle.classList.remove('dragging');
    document.body.style.cursor = '';
    document.body.style.userSelect = '';

    if (!resizeDidDrag) {
      // Click → toggle full hide
      setSidebarHidden(!sidebarHidden);
    } else {
      const width = parseInt(sidebar.style.width, 10);
      if (sidebarCollapsed) {
        if (window._cachedSettings) window._cachedSettings.sidebarCollapsed = false;
        if (window._cachedSettings) window._cachedSettings.sidebarHidden = false;
        window.api.updateSettings({ sidebarCollapsed: false, sidebarHidden: false });
      } else if (width) {
        persistSidebarWidth(width);
        if (window._cachedSettings) window._cachedSettings.sidebarCollapsed = false;
        if (window._cachedSettings) window._cachedSettings.sidebarHidden = false;
        window.api.updateSettings({ sidebarCollapsed: false, sidebarHidden: false });
      }
    }

    fitActiveTerminal();
  }
});

// Events
searchInput.addEventListener('input', (e) => {
  searchQuery = e.target.value;
  searchClear.classList.toggle('hidden', !searchQuery);
  renderSessionList();
});
searchInput.addEventListener('focus', () => {
  document.getElementById('search-wrapper').classList.add('search-active');
});
searchInput.addEventListener('blur', () => {
  document.getElementById('search-wrapper').classList.remove('search-active');
});
searchClear.addEventListener('click', () => {
  searchInput.value = '';
  searchQuery = '';
  searchClear.classList.add('hidden');
  renderSessionList();
  searchInput.focus();
});
sidebarSearchToggle.addEventListener('click', () => focusSidebarSearch());
sessionSearchInput.addEventListener('input', () => {
  refreshSessionSearch(false);
});
sessionSearchInput.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') {
    e.preventDefault();
    e.stopPropagation();
    stepSessionSearch(e.shiftKey ? -1 : 1);
  } else if (e.key === 'Escape') {
    e.preventDefault();
    e.stopPropagation();
    closeSessionSearch();
  }
});
sessionSearchPrev.addEventListener('click', () => stepSessionSearch(-1));
sessionSearchNext.addEventListener('click', () => stepSessionSearch(1));
sessionSearchClose.addEventListener('click', () => closeSessionSearch());
btnNew.addEventListener('click', () => newSession());
btnNewCenter.addEventListener('click', () => newSession());

maxConcurrentInput.addEventListener('change', (e) => {
  const val = parseInt(e.target.value, 10);
  if (val >= 1 && val <= 20) window.api.updateSettings({ maxConcurrent: val });
});

useAgencyCopilotInput.addEventListener('change', async (e) => {
  const settings = await window.api.updateSettings({ useAgencyCopilot: e.target.checked });
  applySettingsToControls(settings);
});

async function saveLauncherArgs(input, key) {
  const nextValue = input.value.trim();
  try {
    const settings = await window.api.updateSettings({ [key]: nextValue });
    applySettingsToControls(settings);
  } catch (err) {
    input.value = window._cachedSettings?.[key] || '';
    showToast({ type: 'error', title: 'Invalid launcher arguments', body: String(err?.message || err) });
  }
}

copilotArgsInput?.addEventListener('change', (e) => {
  saveLauncherArgs(e.target, 'copilotArgs');
});

promptWorkdirInput.addEventListener('change', (e) => {
  window.api.updateSettings({ promptForWorkdir: e.target.checked });
});

btnPickDefaultWorkdir.addEventListener('click', async () => {
  const current = defaultWorkdirInput.value || undefined;
  const picked = await window.api.pickDirectory(current);
  if (picked) {
    defaultWorkdirInput.value = picked;
    window.api.updateSettings({ defaultWorkdir: picked });
  }
});

btnClearDefaultWorkdir.addEventListener('click', () => {
  defaultWorkdirInput.value = '';
  window.api.updateSettings({ defaultWorkdir: '' });
});

autoUpdateToggle.addEventListener('change', (e) => {
  window.api.updateSettings({ autoUpdateEnabled: e.target.checked });
  betaChannelRow.classList.toggle('disabled', !e.target.checked);
  betaChannelToggle.disabled = !e.target.checked;
  window.api.applyUpdateSettings();
});

btnUpdateInstall?.addEventListener('click', () => {
  installDownloadedUpdateNow().catch((error) => {
    console.error('Failed to start update install', error);
    showToast({
      type: 'error',
      title: 'Update install failed',
      body: error?.message || 'DeepSky could not start the update installer.',
    });
  });
});

copyOnSelectToggle.addEventListener('change', (e) => {
  window._cachedSettings = { ...(window._cachedSettings || {}), copyOnSelect: e.target.checked };
  window.api.updateSettings({ copyOnSelect: e.target.checked });
});

betaChannelToggle.addEventListener('change', (e) => {
  window.api.updateSettings({ updateChannel: e.target.checked ? 'beta' : 'stable' });
  window.api.applyUpdateSettings();
});

// Notification functions
async function toggleNotificationPanel() {
  const wasHidden = notificationPanel.classList.contains('hidden');
  notificationPanel.classList.toggle('hidden');
  feedbackPanel.classList.add('hidden');
  if (wasHidden) {
    await window.api.markAllNotificationsRead();
    await refreshNotifications();
  }
}

function toggleFeedbackPanel() {
  notificationPanel.classList.add('hidden');
  feedbackPanel.classList.toggle('hidden');
}

async function openFeedbackIssue(type) {
  feedbackPanel.classList.add('hidden');
  const version = await window.api.getVersion();
  const repoBase = 'https://github.com/itsela-ms/DeepSky/issues/new';

  if (type === 'bug') {
    const title = encodeURIComponent('[Bug] ');
    const body = encodeURIComponent(
      `**DeepSky Version:** v${version}\n\n` +
      `**Describe the bug:**\n<!-- A clear description of what the bug is. -->\n\n` +
      `**Steps to reproduce:**\n1. \n2. \n3. \n\n` +
      `**Expected behavior:**\n\n` +
      `**Actual behavior:**\n`
    );
    window.api.openExternal(`${repoBase}?labels=bug&title=${title}&body=${body}`);
  } else {
    const title = encodeURIComponent('[Feature] ');
    const body = encodeURIComponent(
      `**DeepSky Version:** v${version}\n\n` +
      `**Feature Request:**\n<!-- A clear description of the feature you'd like. -->\n\n` +
      `**Problem it solves:**\n\n` +
      `**Proposed solution:**\n`
    );
    window.api.openExternal(`${repoBase}?labels=enhancement&title=${title}&body=${body}`);
  }
}

async function refreshNotifications() {
  const notifications = await window.api.getNotifications();
  const unread = notifications.filter(n => !n.read).length;

  // Update badge
  if (unread > 0) {
    notificationBadge.textContent = unread > 99 ? '99+' : unread;
    notificationBadge.classList.remove('hidden');
    notificationBadge.setAttribute('aria-label', `${unread} unread notification${unread === 1 ? '' : 's'}`);
    notificationBadge.setAttribute('aria-hidden', 'false');
  } else {
    notificationBadge.classList.add('hidden');
    notificationBadge.setAttribute('aria-hidden', 'true');
  }
  announceLiveMessage(unread > 0 ? `${unread} unread notification${unread === 1 ? '' : 's'}.` : 'All notifications read.');

  // Update dropdown list
  if (notifications.length === 0) {
    notificationListEl.innerHTML = '<div class="notification-empty">No notifications</div>';
    return;
  }

  notificationListEl.innerHTML = notifications
    .sort((a, b) => new Date(b.timestamp) - new Date(a.timestamp))
    .map(n => {
      const icon = NOTIF_ICONS[n.type] || 'ℹ️';
      const cls = n.read ? '' : ' unread';
      const time = formatNotifTime(n.timestamp);
      return `<div class="notification-item${cls}" data-id="${n.id}" data-session="${escapeHtml(n.sessionId || '')}">
        <div class="notification-icon">${icon}</div>
        <div class="notification-content">
          <div class="notification-title">${escapeHtml(n.title)}</div>
          ${n.body ? `<div class="notification-body">${escapeHtml(n.body)}</div>` : ''}
          <div class="notification-time">${time}</div>
        </div>
        <button class="notification-dismiss" data-dismiss="${n.id}" title="Dismiss">✕</button>
      </div>`;
    }).join('');

  // Wire up click handlers
  notificationListEl.querySelectorAll('.notification-item').forEach(el => {
    el.addEventListener('click', async (e) => {
      if (e.target.closest('.notification-dismiss')) return;
      const id = parseInt(el.dataset.id);
      const sessionId = el.dataset.session;
      await window.api.markNotificationRead(id);
      notificationPanel.classList.add('hidden');
      if (sessionId) await openSession(sessionId);
      refreshNotifications();
    });
  });

  notificationListEl.querySelectorAll('.notification-dismiss').forEach(btn => {
    btn.addEventListener('click', async (e) => {
      e.stopPropagation();
      const id = parseInt(btn.dataset.dismiss);
      await window.api.dismissNotification(id);
      refreshNotifications();
    });
  });
}

function formatNotifTime(timestamp) {
  const d = new Date(timestamp);
  const now = new Date();
  const diffMs = now - d;
  const diffMin = Math.floor(diffMs / 60000);
  if (diffMin < 1) return 'just now';
  if (diffMin < 60) return `${diffMin}m ago`;
  const diffHr = Math.floor(diffMin / 60);
  if (diffHr < 24) return `${diffHr}h ago`;
  return d.toLocaleDateString();
}

function showToast(notification) {
  const icon = NOTIF_ICONS[notification.type] || 'ℹ️';
  const toast = document.createElement('div');
  toast.className = 'toast';
  toast.innerHTML = `
    <div class="toast-icon">${icon}</div>
    <div class="toast-content">
      <div class="toast-title">${escapeHtml(notification.title)}</div>
      ${notification.body ? `<div class="toast-body">${escapeHtml(notification.body)}</div>` : ''}
    </div>`;

  toast.addEventListener('click', async () => {
    toast.classList.add('toast-out');
    setTimeout(() => toast.remove(), 300);
    if (notification.sessionId) await openSession(notification.sessionId);
  });

  toastContainer.appendChild(toast);
  announceLiveMessage([notification.title, notification.body].filter(Boolean).join('. '));

  // Auto-dismiss after 6 seconds
  setTimeout(() => {
    if (toast.parentNode) {
      toast.classList.add('toast-out');
      setTimeout(() => toast.remove(), 300);
    }
  }, 6000);
}

// Zoom — refit all terminals after the zoom factor changes
async function applyZoom(direction) {
  await window.api.setZoom(direction);
  syncTitlebarPadding();
  // Small delay lets Electron apply the new factor before we refit
  setTimeout(() => {
    for (const { terminal, fitAddon } of terminals.values()) {
      try { fitAddon.fit(); } catch {}
      try { terminal.scrollToBottom(); } catch {}
    }
  }, 100);
}

// Terminal wheel handling lives at the document capture layer because xterm's
// helper textarea and DeepSky's prompt/info bar can take focus/targeting away
// from the per-session wrapper. Route only when the pointer is visually over
// the terminal column so sidebars, status panels, modals, and settings keep
// their native scroll behavior.
document.addEventListener('wheel', (e) => {
  if (shouldRouteTerminalWheel(e)) {
    handleTerminalScrollbackWheel(e, activeSessionId ? terminals.get(activeSessionId) : null);
    return;
  }
  if (!(e.ctrlKey || e.metaKey)) return;
  e.preventDefault();
  applyZoom(e.deltaY < 0 ? 'in' : 'out');
}, { capture: true, passive: false });

// Global copy for regular DOM UI (status panel, sidebar, commits list, etc.).
// The app uses a custom Electron menu without the native Copy role so xterm can
// own Ctrl+C inside the terminal; that also removes the default Ctrl+C
// accelerator for ordinary selectable DOM. This restores it: when the user has
// a text selection OUTSIDE the terminal and presses Ctrl+C / Ctrl+Insert, copy
// it through the clipboard IPC. Selections inside the terminal are left to the
// terminal's own key handler and copy-on-select path.
document.addEventListener('keydown', (e) => {
  if (!isCopyShortcut(e)) return;
  const active = document.activeElement;
  // Focus is in the terminal → its custom key handler owns Ctrl+C.
  if (active?.classList?.contains('xterm-helper-textarea')) return;
  const sel = window.getSelection();
  const text = sel?.toString() || '';
  if (!text.trim()) return;
  // Defensive: if the selection lives inside a terminal wrapper, defer to the
  // terminal's copy path (copy-on-select already mirrored it to the clipboard).
  if (sel.anchorNode?.parentElement?.closest?.('.terminal-wrapper')) return;
  e.preventDefault();
  window.api.copyText(text);
});

// Keyboard shortcuts
document.addEventListener('keydown', (e) => {
  if (writePlainKeyToActiveTerminal(e)) return;

  const shortcutAction = getGlobalShortcutAction(e, {
    activeElement: document.activeElement,
    hasActiveSession: !!(activeSessionId && terminals.has(activeSessionId)),
  });
  if (shortcutAction) {
    if (isBlockingModalOpen()) {
      e.preventDefault();
      return;
    }
    e.preventDefault();
    switch (shortcutAction.type) {
      case 'new-session':
        newSession();
        return;
      case 'zoom':
        applyZoom(shortcutAction.direction);
        return;
      case 'switch-tab': {
        const tabs = [...document.querySelectorAll('.tab')];
        if (tabs.length < 2) return;
        const i = tabs.findIndex(t => t.dataset.sessionId === activeSessionId);
        const next = shortcutAction.direction < 0
          ? (i - 1 + tabs.length) % tabs.length
          : (i + 1) % tabs.length;
        switchToSession(tabs[next].dataset.sessionId);
        return;
      }
      case 'close-tab':
        if (activeSessionId) terminateSession(activeSessionId, { rememberClosedTab: true });
        return;
      case 'restore-tab':
        void restoreMostRecentClosedTab();
        return;
      case 'toggle-status':
        toggleStatusPanel();
        return;
      case 'session-search':
        openSessionSearch();
        return;
      case 'sidebar-search':
        focusSidebarSearch();
        return;
      default:
        break;
    }
  }

  if (e.key === 'Escape') {
    if (!sessionSearch.classList.contains('hidden')) {
      closeSessionSearch();
      return;
    }
    // Close context menu first if open
    const ctxMenu = document.getElementById('tab-context-menu');
    if (ctxMenu) {
      hideContextMenu();
    } else if (!notificationPanel.classList.contains('hidden')) {
      notificationPanel.classList.add('hidden');
    } else if (!newSessionOptionsOverlay.classList.contains('hidden')) {
      closeNewSessionOptions();
    } else if (!settingsOverlay.classList.contains('hidden')) {
      closeSettings();
    } else if (!instructionsPanel.classList.contains('hidden')) {
      hideInstructions();
    } else if (document.activeElement === searchInput) {
      searchInput.value = '';
      searchQuery = '';
      searchClear.classList.add('hidden');
      document.getElementById('search-wrapper').classList.remove('search-active');
      renderSessionList();
      if (activeSessionId && terminals.has(activeSessionId)) terminals.get(activeSessionId).terminal.focus();
    }
  }
});

init()
  .then(completeStartupLoading)
  .catch((error) => {
    console.error('DeepSky startup failed', error);
    startupLoading.fail(error);
  });
