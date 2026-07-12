import { describe, it, expect } from 'vitest';
const { deriveSessionState, getNewSessionAvailability, filterSessionsForSidebar } = require('../src/session-state');

describe('deriveSessionState', () => {
  it('returns Idle when nothing is active', () => {
    const result = deriveSessionState({ isRunning: false, isActive: false, hasPR: false, isHistory: false, isBusy: false });
    expect(result).toEqual({ label: 'Idle', cls: 'state-idle', tip: 'New session \u2014 no activity yet' });
  });

  it('returns Working when running and busy', () => {
    const result = deriveSessionState({ isRunning: true, isActive: true, hasPR: false, isHistory: false, isBusy: true });
    expect(result).toEqual({ label: 'Working', cls: 'state-working', tip: 'AI is processing' });
  });

  it('returns Starting for a launch pending real session id discovery', () => {
    const result = deriveSessionState({ isRunning: false, isActive: false, hasPR: false, isHistory: false, isBusy: false, isStarting: true });
    expect(result).toEqual({ label: 'Starting', cls: 'state-starting', tip: 'Starting session' });
  });

  it('returns Waiting when running but not busy', () => {
    const result = deriveSessionState({ isRunning: true, isActive: true, hasPR: false, isHistory: false, isBusy: false });
    expect(result).toEqual({ label: 'Waiting', cls: 'state-waiting', tip: 'Waiting on user response' });
  });

  it('returns Waiting when running and active but not busy', () => {
    const result = deriveSessionState({ isRunning: true, isActive: false, hasPR: false, isHistory: false, isBusy: false });
    expect(result).toEqual({ label: 'Waiting', cls: 'state-waiting', tip: 'Waiting on user response' });
  });

  it('returns Pending when has PR and not running', () => {
    const result = deriveSessionState({ isRunning: false, isActive: false, hasPR: true, isHistory: false, isBusy: false });
    expect(result).toEqual({ label: 'Pending PR', cls: 'state-pending', tip: 'Has a PR linked \u2014 waiting for review' });
  });

  it('returns Done when in history tab', () => {
    const result = deriveSessionState({ isRunning: false, isActive: false, hasPR: false, isHistory: true, isBusy: false });
    expect(result).toEqual({ label: '\u2713 Done', cls: 'state-done', tip: 'Session completed' });
  });

  // Priority tests
  it('Pending takes priority over Done (PR + history)', () => {
    const result = deriveSessionState({ isRunning: false, isActive: false, hasPR: true, isHistory: true, isBusy: false });
    expect(result).toEqual({ label: 'Pending PR', cls: 'state-pending', tip: 'Has a PR linked \u2014 waiting for review' });
  });

  it('Pending takes priority over Working (running + busy + PR)', () => {
    const result = deriveSessionState({ isRunning: true, isActive: true, hasPR: true, isHistory: false, isBusy: true });
    expect(result).toEqual({ label: 'Pending PR', cls: 'state-pending', tip: 'Has a PR linked \u2014 waiting for review' });
  });

  it('Pending takes priority over Waiting (running + PR + not busy)', () => {
    const result = deriveSessionState({ isRunning: true, isActive: false, hasPR: true, isHistory: false, isBusy: false });
    expect(result).toEqual({ label: 'Pending PR', cls: 'state-pending', tip: 'Has a PR linked \u2014 waiting for review' });
  });

  it('Done takes priority over Idle in history tab', () => {
    const result = deriveSessionState({ isRunning: false, isActive: false, hasPR: false, isHistory: true, isBusy: false });
    expect(result.cls).toBe('state-done');
  });

  it('isBusy false with running session yields Waiting, not Working', () => {
    const result = deriveSessionState({ isRunning: true, isActive: true, hasPR: false, isHistory: false, isBusy: false });
    expect(result.cls).toBe('state-waiting');
  });
});

describe('filterSessionsForSidebar', () => {
  const sessions = [
    { id: 'active-1', title: 'Active 1' },
    { id: 'done-1', title: 'Done 1' },
    { id: 'active-2', title: 'Active 2' }
  ];

  it('returns only active sessions on the active tab', () => {
    const result = filterSessionsForSidebar({
      sessions,
      activeSessionIds: new Set(['active-1', 'active-2']),
      currentSidebarTab: 'active'
    });

    expect(result.map(session => session.id)).toEqual(['active-1', 'active-2']);
  });

  it('hides active sessions from the history tab', () => {
    const result = filterSessionsForSidebar({
      sessions,
      activeSessionIds: new Set(['active-1', 'active-2']),
      currentSidebarTab: 'history'
    });

    expect(result.map(session => session.id)).toEqual(['done-1']);
  });

  it('returns a copy of all sessions for other tabs', () => {
    const result = filterSessionsForSidebar({
      sessions,
      activeSessionIds: new Set(['active-1']),
      currentSidebarTab: 'unknown'
    });

    expect(result).toEqual(sessions);
    expect(result).not.toBe(sessions);
  });
});

describe('getNewSessionAvailability', () => {
  it('blocks new sessions when Copilot CLI is unavailable', () => {
    const result = getNewSessionAvailability({
      useAgencyCopilot: false,
      copilotAvailable: false,
      agencyAvailable: false,
    });

    expect(result).toEqual({
      launcher: 'copilot',
      available: false,
      reason: 'New sessions are unavailable because GitHub Copilot CLI is not installed.',
    });
  });

  it('allows agency launches without Copilot CLI when agency is available', () => {
    const result = getNewSessionAvailability({
      useAgencyCopilot: true,
      copilotAvailable: false,
      agencyAvailable: true,
    });

    expect(result).toEqual({
      launcher: 'agency',
      available: true,
      reason: '',
    });
  });

  it('falls back to a combined missing-tools message when agency is requested but both launchers are missing', () => {
    const result = getNewSessionAvailability({
      useAgencyCopilot: true,
      copilotAvailable: false,
      agencyAvailable: false,
    });

    expect(result).toEqual({
      launcher: 'copilot',
      available: false,
      reason: 'New sessions are unavailable because neither GitHub Copilot CLI nor Agency is installed.',
    });
  });
});
