/**
 * Derive the display state for a session.
 * Pure function — no DOM dependencies.
 *
 * @param {object} opts
 * @param {boolean} opts.isRunning      - Session has an active terminal
 * @param {boolean} opts.isActive       - Session is the currently focused one
 * @param {boolean} opts.hasPR          - Session has an active PR
 * @param {boolean} opts.isHistory      - Currently viewing the history tab
 * @param {boolean} [opts.isBusy]       - Session produced pty output recently
 * @param {boolean} [opts.isStarting]   - Session launch is in progress but no PTY/session id is available yet
 * @returns {{ label: string, cls: string }}
 */
function deriveSessionState({ isRunning, isActive, hasPR, isHistory, isBusy, isStarting }) {
  if (hasPR)                return { label: 'Pending PR', cls: 'state-pending', tip: 'Has a PR linked — waiting for review' };
  if (isStarting)           return { label: 'Starting', cls: 'state-starting', tip: 'Starting session' };
  if (isRunning && isBusy)  return { label: 'Working', cls: 'state-working', tip: 'AI is processing' };
  if (isRunning)            return { label: 'Waiting', cls: 'state-waiting', tip: 'Waiting on user response' };
  if (isHistory)            return { label: '\u2713 Done', cls: 'state-done', tip: 'Session completed' };
  return { label: 'Idle', cls: 'state-idle', tip: 'New session — no activity yet' };
}

function getNewSessionAvailability(settings = {}) {
  const agencyAvailable = settings.agencyAvailable !== false;
  const copilotAvailable = settings.copilotAvailable !== false;
  const launcher = settings.useAgencyCopilot && agencyAvailable ? 'agency' : 'copilot';

  if (launcher === 'agency') {
    return {
      launcher,
      available: true,
      reason: '',
    };
  }

  if (copilotAvailable) {
    return {
      launcher,
      available: true,
      reason: '',
    };
  }

  const reason = settings.useAgencyCopilot && !agencyAvailable
    ? 'New sessions are unavailable because neither GitHub Copilot CLI nor Agency is installed.'
    : 'New sessions are unavailable because GitHub Copilot CLI is not installed.';

  return {
    launcher,
    available: false,
    reason,
  };
}

function filterSessionsForSidebar({ sessions, activeSessionIds, currentSidebarTab }) {
  if (currentSidebarTab === 'active') {
    return sessions.filter(session => activeSessionIds.has(session.id));
  }

  if (currentSidebarTab === 'history') {
    return sessions.filter(session => !activeSessionIds.has(session.id));
  }

  return [...sessions];
}

module.exports = { deriveSessionState, getNewSessionAvailability, filterSessionsForSidebar };
