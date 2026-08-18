import { describe, it, expect, vi, beforeEach } from 'vitest';
const PtyManager = require('../src/pty-manager');

function createMockPty() {
  const handlers = {};
  return {
    onData: (cb) => { handlers.data = cb; },
    onExit: (cb) => { handlers.exit = cb; },
    kill: vi.fn(),
    resize: vi.fn(),
    write: vi.fn(),
    _emitData: (data) => handlers.data?.(data),
    _emitExit: (code) => handlers.exit?.({ exitCode: code }),
  };
}

const mockPtyModule = { spawn: vi.fn(() => createMockPty()) };

// Tests inject a fake discoverer so we don't hit the real filesystem. Each
// call resolves to a unique stub session ID, mirroring the real CLI's
// behaviour of creating a fresh session-state folder per spawn.
let nextDiscoveredId = 0;
let nextGeneratedId = 0;
const mockSessionIdDiscoverer = vi.fn(async () => `discovered-${++nextDiscoveredId}`);

function generatedGuid(n) {
  return `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
}

function createManager(settings = {}, overrides = {}) {
  const settingsService = { get: () => ({ maxConcurrent: 5, useAgencyCopilot: false, ...settings }) };
  return new PtyManager('/fake/copilot', settingsService, mockPtyModule, {
    sessionStateDir: '/fake/session-state',
    sessionIdDiscoverer: mockSessionIdDiscoverer,
    sessionIdFactory: () => generatedGuid(++nextGeneratedId),
    agencyPath: process.platform === 'win32' ? 'C:\\Tools\\agency.exe' : '/opt/agency/bin/agency',
    ...overrides,
  });
}

function getPty(manager, sessionId) {
  // Access internal session entry to get the mock pty
  const entry = manager.sessions.get(sessionId);
  return entry?.pty;
}

describe('PtyManager', () => {
  let manager;

  beforeEach(() => {
    vi.useFakeTimers();
    nextDiscoveredId = 0;
    nextGeneratedId = 0;
    mockSessionIdDiscoverer.mockClear();
    mockSessionIdDiscoverer.mockImplementation(async () => `discovered-${++nextDiscoveredId}`);
    manager = createManager();
    mockPtyModule.spawn.mockClear();
    mockPtyModule.spawn.mockImplementation(() => createMockPty());
  });

  describe('lastDataAt tracking', () => {
    it('initializes lastDataAt as null on openSession', () => {
      const id = manager.openSession('test-1');
      const entry = manager.sessions.get(id);
      expect(entry.lastDataAt).toBeNull();
    });

    it('initializes lastDataAt as null on newSession', async () => {
      const id = await manager.newSession();
      const entry = manager.sessions.get(id);
      expect(entry.lastDataAt).toBeNull();
    });

    it('updates lastDataAt when pty emits data', () => {
      const id = manager.openSession('test-2');
      const entry = manager.sessions.get(id);
      expect(entry.lastDataAt).toBeNull();

      vi.advanceTimersByTime(1000);
      getPty(manager, id)._emitData('hello');

      expect(entry.lastDataAt).toBeGreaterThan(0);
    });
  });

  describe('getBusySessions', () => {
    it('returns sessions with recent output', () => {
      const id = manager.openSession('busy-1');
      // Simulate substantial output (>500 bytes to qualify as busy)
      getPty(manager, id)._emitData('x'.repeat(600));
      const busy = manager.getBusySessions(5000);
      expect(busy).toContain('busy-1');
    });

    it('excludes sessions with stale output', () => {
      manager.openSession('stale-1');
      vi.advanceTimersByTime(6000);

      const busy = manager.getBusySessions(5000);
      expect(busy).not.toContain('stale-1');
    });

    it('excludes dead sessions', () => {
      const id = manager.openSession('dead-1');
      manager.kill(id);

      const busy = manager.getBusySessions(5000);
      expect(busy).not.toContain('dead-1');
    });

    it('returns empty array when no sessions exist', () => {
      expect(manager.getBusySessions(5000)).toEqual([]);
    });

    it('excludes sessions with no output yet', () => {
      manager.openSession('fresh-no-output');
      const busy = manager.getBusySessions(5000);
      expect(busy).not.toContain('fresh-no-output');
    });

    it('uses threshold correctly', () => {
      const id = manager.openSession('threshold-1');
      getPty(manager, id)._emitData('x'.repeat(600));
      vi.advanceTimersByTime(3000);

      expect(manager.getBusySessions(5000)).toContain('threshold-1');
      expect(manager.getBusySessions(2000)).not.toContain('threshold-1');
    });
  });

  describe('killIdle', () => {
    it('kills sessions with stale output', () => {
      manager.openSession('idle-1');
      vi.advanceTimersByTime(6000);

      const killed = manager.killIdle(5000);
      expect(killed).toContain('idle-1');
      expect(manager.sessions.has('idle-1')).toBe(false);
    });

    it('keeps sessions with recent output', () => {
      const id = manager.openSession('fresh-1');
      getPty(manager, id)._emitData('output');

      const killed = manager.killIdle(5000);
      expect(killed).not.toContain('fresh-1');
      expect(manager.sessions.has('fresh-1')).toBe(true);
    });

    it('calls kill on the pty process', () => {
      const id = manager.openSession('kill-pty-1');
      const pty = getPty(manager, id);
      vi.advanceTimersByTime(6000);

      manager.killIdle(5000);
      expect(pty.kill).toHaveBeenCalled();
    });

    it('handles mixed busy and idle sessions', () => {
      const oldId = manager.openSession('old-1');
      getPty(manager, oldId)._emitData('output');
      vi.advanceTimersByTime(6000);
      const newId = manager.openSession('new-1');
      getPty(manager, newId)._emitData('output');

      const killed = manager.killIdle(5000);
      expect(killed).toContain('old-1');
      expect(killed).not.toContain('new-1');
      expect(manager.sessions.has('old-1')).toBe(false);
      expect(manager.sessions.has('new-1')).toBe(true);
    });

    it('is safe to call when no sessions exist', () => {
      expect(() => manager.killIdle(5000)).not.toThrow();
      expect(manager.killIdle(5000)).toEqual([]);
    });

    it('marks killed sessions as not alive', () => {
      const id = manager.openSession('alive-check');
      vi.advanceTimersByTime(6000);

      // Session is still in map before killIdle, with alive=true
      expect(manager.sessions.get(id).alive).toBe(true);

      manager.killIdle(5000);
      // Session should be deleted from map entirely
      expect(manager.sessions.has(id)).toBe(false);
    });
  });

  describe('integration: busy detection after data events', () => {
    it('session becomes busy again after receiving new data', () => {
      const id = manager.openSession('revive-1');
      vi.advanceTimersByTime(6000);
      expect(manager.getBusySessions(5000)).not.toContain('revive-1');

      // Simulate substantial new output
      getPty(manager, id)._emitData('x'.repeat(600));
      expect(manager.getBusySessions(5000)).toContain('revive-1');
    });

    it('killIdle spares a session that just received data', () => {
      const id = manager.openSession('just-in-time');
      vi.advanceTimersByTime(6000);

      // Right before killIdle, session gets output
      getPty(manager, id)._emitData('output');

      const killed = manager.killIdle(5000);
      expect(killed).not.toContain('just-in-time');
    });
  });

  describe('cwd parameter', () => {
    it('uses a recovered absolute Copilot path for later PTY spawns', async () => {
      manager.updateCopilotPath('/recovered/bin/copilot');

      await manager.newSession('/my/project');

      expect(mockPtyModule.spawn.mock.calls[0][0]).toBe('/recovered/bin/copilot');
    });

    it('newSession passes cwd to pty.spawn', async () => {
      mockPtyModule.spawn.mockClear();
      await manager.newSession('/my/project');
      const callArgs = mockPtyModule.spawn.mock.calls[0];
      expect(callArgs[2].cwd).toBe('/my/project');
    });

    it('newSession defaults to homedir when no cwd provided', async () => {
      mockPtyModule.spawn.mockClear();
      await manager.newSession();
      const callArgs = mockPtyModule.spawn.mock.calls[0];
      expect(callArgs[2].cwd).toBe(require('os').homedir());
    });

    it('openSession passes cwd to pty.spawn', () => {
      mockPtyModule.spawn.mockClear();
      manager.openSession('cwd-test-1', '/custom/dir');
      const callArgs = mockPtyModule.spawn.mock.calls[0];
      expect(callArgs[2].cwd).toBe('/custom/dir');
    });

    it('openSession defaults to homedir when no cwd provided', () => {
      mockPtyModule.spawn.mockClear();
      manager.openSession('cwd-test-2');
      const callArgs = mockPtyModule.spawn.mock.calls[0];
      expect(callArgs[2].cwd).toBe(require('os').homedir());
    });

    it('stores cwd in session entry', async () => {
      const id = await manager.newSession('/stored/path');
      const entry = manager.sessions.get(id);
      expect(entry.cwd).toBe('/stored/path');
    });

    it('old pty exit does not affect new entry after kill+reopen', () => {
      // Simulate cwd change: kill old pty, open new one for same sessionId
      const id = manager.openSession('reopen-1', '/old/path');
      const oldPty = getPty(manager, id);

      // Kill old session
      manager.kill(id);
      expect(manager.sessions.has(id)).toBe(false);

      // Open new session with same id (like changeCwd does)
      manager.openSession('reopen-1', '/new/path');
      const newEntry = manager.sessions.get('reopen-1');
      expect(newEntry.alive).toBe(true);
      expect(newEntry.cwd).toBe('/new/path');

      // Old pty fires exit (async in real life)
      oldPty._emitExit(0);

      // New entry should still be alive
      expect(newEntry.alive).toBe(true);
      expect(manager.sessions.has('reopen-1')).toBe(true);
    });

    it('restartSession waits for the old pty exit before respawning the same session', async () => {
      const id = manager.openSession('restart-1', '/old/path');
      const oldPty = getPty(manager, id);
      mockPtyModule.spawn.mockClear();

      const restart = manager.restartSession(id, '/new/path');
      await Promise.resolve();

      expect(oldPty.kill).toHaveBeenCalled();
      expect(mockPtyModule.spawn).not.toHaveBeenCalled();

      oldPty._emitExit(0);
      await restart;

      expect(mockPtyModule.spawn).toHaveBeenCalledTimes(1);
      expect(manager.sessions.get(id).cwd).toBe('/new/path');
    });

    it('restartSession suppresses the intentional exit event from the replaced pty', async () => {
      const onExit = vi.fn();
      manager.on('exit', onExit);
      const id = manager.openSession('restart-suppress-exit', '/old/path');
      const oldPty = getPty(manager, id);

      const restart = manager.restartSession(id, '/new/path');
      oldPty._emitExit(0);
      await restart;

      expect(onExit).not.toHaveBeenCalled();
      expect(manager.sessions.get(id).alive).toBe(true);
    });

    it('restartSession does not resurrect a session killed while waiting for the old pty exit', async () => {
      const id = manager.openSession('restart-killed', '/old/path');
      const oldPty = getPty(manager, id);
      mockPtyModule.spawn.mockClear();

      const restart = manager.restartSession(id, '/new/path');
      await Promise.resolve();

      manager.kill(id);
      oldPty._emitExit(0);
      const result = await restart;

      expect(result).toBeNull();
      expect(mockPtyModule.spawn).not.toHaveBeenCalled();
      expect(manager.sessions.has(id)).toBe(false);
    });

    it('restartSession does not overwrite a session reopened by another caller while waiting', async () => {
      const id = manager.openSession('restart-reopened', '/old/path');
      const oldPty = getPty(manager, id);
      mockPtyModule.spawn.mockClear();

      const restart = manager.restartSession(id, '/new/path');
      await Promise.resolve();

      manager.openSession(id, '/manual/path');
      const manualEntry = manager.sessions.get(id);
      oldPty._emitExit(0);
      const result = await restart;

      expect(result).toBeNull();
      expect(mockPtyModule.spawn).toHaveBeenCalledTimes(1);
      expect(manager.sessions.get(id)).toBe(manualEntry);
      expect(manager.sessions.get(id).cwd).toBe('/manual/path');
    });

    it('falls back to homedir when spawn with bad cwd fails', async () => {
      mockPtyModule.spawn.mockClear();
      let callCount = 0;
      mockPtyModule.spawn.mockImplementation((...args) => {
        callCount++;
        if (callCount === 1) throw new Error('bad cwd');
        return createMockPty();
      });

      const id = await manager.newSession('/nonexistent/path');
      // Should have called spawn twice (failed + fallback)
      expect(callCount).toBe(2);
      expect(manager.sessions.has(id)).toBe(true);

      // Restore default
      mockPtyModule.spawn.mockImplementation(() => createMockPty());
    });
  });

  describe('launcher selection', () => {
    it('uses agency copilot for new sessions when enabled in settings', async () => {
      manager = createManager({ useAgencyCopilot: true });
      const id = await manager.newSession('/agency/project');
      const [file, args, options] = mockPtyModule.spawn.mock.calls[0];

      if (process.platform === 'win32') {
        expect(file).toBe('C:\\Tools\\agency.exe');
        expect(args).toEqual(['copilot', '--session-id', generatedGuid(1), '--yolo']);
      } else {
        expect(file).toBe('/opt/agency/bin/agency');
        expect(args).toEqual(['copilot', '--session-id', generatedGuid(1), '--yolo']);
      }
      expect(options.cwd).toBe('/agency/project');
      expect(manager.sessions.get(id).launcher).toBe('agency');
    });

    it('passes custom copilot args before DeepSky default args', async () => {
      manager = createManager({ copilotArgs: '--model gpt-5.5 --profile "fast lane"' });
      await manager.newSession('/copilot/project');
      const [, args] = mockPtyModule.spawn.mock.calls[0];

      expect(args).toEqual(['--model', 'gpt-5.5', '--profile', 'fast lane', '--session-id', generatedGuid(1), '--yolo']);
    });

    it('uses captured launcher args for queued cold-start sessions', async () => {
      manager = createManager({ copilotArgs: '--model current' });
      await manager.newSession('/copilot/project', 'copilot', [], '--model captured');
      const [, args] = mockPtyModule.spawn.mock.calls[0];

      expect(args).toEqual(['--model', 'captured', '--session-id', generatedGuid(1), '--yolo']);
    });

    it('passes the shared custom args after agency copilot when Agency is enabled', async () => {
      manager = createManager({ useAgencyCopilot: true, copilotArgs: '--agent squad' });
      await manager.newSession('/agency/project');
      const [file, args] = mockPtyModule.spawn.mock.calls[0];

      if (process.platform === 'win32') {
        expect(file).toBe('C:\\Tools\\agency.exe');
        expect(args).toEqual(['copilot', '--agent', 'squad', '--session-id', generatedGuid(1), '--yolo']);
      } else {
        expect(file).toBe('/opt/agency/bin/agency');
        expect(args).toEqual(['copilot', '--agent', 'squad', '--session-id', generatedGuid(1), '--yolo']);
      }
    });

    it('uses saved launcher args when reopening existing sessions', () => {
      manager = createManager({ copilotArgs: '--model current' });
      manager.openSession('restore-args', '/cwd', 'copilot', '--model saved');
      const [, args] = mockPtyModule.spawn.mock.calls[0];

      expect(args).toEqual(['--model', 'saved', '--session-id', 'restore-args', '--yolo']);
    });

    it('does not apply current custom args when reopening older sessions without saved args', () => {
      manager = createManager({ copilotArgs: '--model current' });
      manager.openSession('restore-no-args', '/cwd', 'copilot');
      const [, args] = mockPtyModule.spawn.mock.calls[0];

      expect(args).toEqual(['--session-id', 'restore-no-args', '--yolo']);
    });

    it('uses cmd.exe only with an absolute agency .cmd path on Windows', async () => {
      if (process.platform !== 'win32') return;
      manager = createManager({ useAgencyCopilot: true, copilotArgs: '--agent squad' }, { agencyPath: 'C:\\Tools\\agency.cmd' });
      await manager.newSession('/agency/project');
      const [file, args] = mockPtyModule.spawn.mock.calls[0];

      expect(file.toLowerCase()).toMatch(/\\system32\\cmd\.exe$/);
      expect(args).toEqual(['/d', '/s', '/c', '"\"C:\\Tools\\agency.cmd\" \"copilot\" \"--agent\" \"squad\" \"--session-id\" \"' + generatedGuid(1) + '\" \"--yolo\""']);
    });

    it('quotes recovered Copilot .cmd paths when spawning through cmd.exe on Windows', async () => {
      if (process.platform !== 'win32') return;
      manager.updateCopilotPath('C:\\Tools With Spaces\\copilot.cmd');

      await manager.newSession('/copilot/project');

      const [file, args] = mockPtyModule.spawn.mock.calls[0];
      expect(file.toLowerCase()).toMatch(/\\system32\\cmd\.exe$/);
      expect(args).toEqual(['/d', '/s', '/c', '"\"C:\\Tools With Spaces\\copilot.cmd\" \"--session-id\" \"' + generatedGuid(1) + '\" \"--yolo\""']);
    });

    it('quotes recovered Copilot .cmd paths and spaced arguments as one cmd command string on Windows', async () => {
      if (process.platform !== 'win32') return;
      manager.updateCopilotPath('C:\\Program Files\\Copilot\\copilot.cmd');

      await manager.newSession('/copilot/project', 'copilot', ['-i', 'Read the file at C:/tmp/prompt.txt']);

      const [file, args] = mockPtyModule.spawn.mock.calls[0];
      expect(file.toLowerCase()).toMatch(/\\system32\\cmd\.exe$/);
      expect(args).toEqual([
        '/d',
        '/s',
        '/c',
        '"\"C:\\Program Files\\Copilot\\copilot.cmd\" \"--session-id\" \"' + generatedGuid(1) + '\" \"--yolo\" \"-i\" \"Read the file at C:/tmp/prompt.txt\""',
      ]);
    });

    it('rejects unsupported characters in recovered Copilot .cmd launcher paths on Windows', async () => {
      if (process.platform !== 'win32') return;
      manager.updateCopilotPath('C:\\Tools\\bad%copilot.cmd');

      await expect(manager.newSession('/copilot/project')).rejects.toThrow(/unsupported characters/);
      expect(mockPtyModule.spawn).not.toHaveBeenCalled();
    });

    it('allows legal metacharacters in quoted recovered Copilot .cmd launcher paths on Windows', async () => {
      if (process.platform !== 'win32') return;
      manager.updateCopilotPath('C:\\Tools\\A&B\\copilot.cmd');

      await manager.newSession('/copilot/project');

      const [, args] = mockPtyModule.spawn.mock.calls[0];
      expect(args[3]).toContain('"C:\\Tools\\A&B\\copilot.cmd"');
    });

    it('rejects environment-expansion characters for Windows .cmd launcher args', async () => {
      if (process.platform !== 'win32') return;
      manager = createManager(
        { useAgencyCopilot: true, copilotArgs: '--agent %DEEPSKY_INJECT%' },
        { agencyPath: 'C:\\Tools\\agency.cmd' }
      );

      await expect(manager.newSession('/agency/project')).rejects.toThrow(/cannot contain % or !/);
      expect(mockPtyModule.spawn).not.toHaveBeenCalled();
    });

    it('rejects unsafe custom launcher args before spawning', async () => {
      manager = createManager({ copilotArgs: '--model gpt & whoami' });
      await expect(manager.newSession('/copilot/project')).rejects.toThrow(/shell control/);
      expect(mockPtyModule.spawn).not.toHaveBeenCalled();
    });

    it('rejects standby sessions when launcher does not match', async () => {
      await manager.warmUp('/cwd', 'agency');
      const standbyPty = manager._standby.pty;

      const result = manager.claimStandby('/cwd', 'copilot');

      expect(result).toBeNull();
      expect(standbyPty.kill).toHaveBeenCalled();
      expect(manager._standby).toBeNull();
    });
  });

  describe('warmUp / claimStandby', () => {
    it('invalidates a warmed standby when launcher availability changes', async () => {
      await manager.warmUp('/cwd');
      const standbyPty = manager._standby.pty;

      manager.invalidateStandby();

      expect(standbyPty.kill).toHaveBeenCalled();
      expect(manager._standby).toBeNull();
    });

    it('clears the Copilot launcher and blocks later Copilot spawns when detection becomes unavailable', async () => {
      manager.updateCopilotPath('');

      await expect(manager.newSession('/cwd', 'copilot')).rejects.toThrow(/Copilot executable path is unavailable/);
      expect(mockPtyModule.spawn).not.toHaveBeenCalled();
    });

    it('does not kill an Agency standby when only Copilot availability changes', async () => {
      await manager.warmUp('/cwd', 'agency');
      const standbyPty = manager._standby.pty;

      manager.updateCopilotPath('');

      expect(standbyPty.kill).not.toHaveBeenCalled();
      expect(manager._standby).not.toBeNull();
      expect(manager._standby.launcher).toBe('agency');
    });

    it('warmUp creates a standby session', async () => {
      mockPtyModule.spawn.mockClear();
      await manager.warmUp('/my/cwd');
      expect(mockPtyModule.spawn).toHaveBeenCalledTimes(1);
      expect(manager._standby).not.toBeNull();
      expect(manager._standby.alive).toBe(true);
      expect(manager._standby.cwd).toBe('/my/cwd');
    });

    it('warmUp uses homedir when no cwd provided', async () => {
      mockPtyModule.spawn.mockClear();
      await manager.warmUp();
      expect(manager._standby.cwd).toBe(require('os').homedir());
    });

    it('warmUp is a no-op if standby already exists', async () => {
      await manager.warmUp('/cwd');
      mockPtyModule.spawn.mockClear();
      await manager.warmUp('/cwd');
      expect(mockPtyModule.spawn).not.toHaveBeenCalled();
    });

    it('warmUp does not spawn if at max capacity', async () => {
      // Fill to capacity
      for (let i = 0; i < 5; i++) await manager.newSession('/cwd');
      mockPtyModule.spawn.mockClear();
      await manager.warmUp('/cwd');
      expect(mockPtyModule.spawn).not.toHaveBeenCalled();
      expect(manager._standby).toBeNull();
    });

    it('warmUp buffers data from the standby PTY', async () => {
      await manager.warmUp('/cwd');
      const standby = manager._standby;
      standby.pty._emitData('hello ');
      standby.pty._emitData('world');
      expect(standby.bufferedData).toEqual(['hello ', 'world']);
    });

    it('claimStandby returns standby with matching cwd', async () => {
      await manager.warmUp('/my/cwd');
      const result = manager.claimStandby('/my/cwd');
      expect(result).not.toBeNull();
      expect(result.id).toBeTruthy();
      expect(result.bufferedData).toEqual([]);
      expect(manager._standby).toBeNull();
    });

    it('claimStandby returns buffered data', async () => {
      await manager.warmUp('/cwd');
      manager._standby.pty._emitData('startup output');
      const result = manager.claimStandby('/cwd');
      expect(result.bufferedData).toEqual(['startup output']);
    });

    it('claimStandby registers session in sessions map', async () => {
      await manager.warmUp('/cwd');
      const result = manager.claimStandby('/cwd');
      expect(manager.sessions.has(result.id)).toBe(true);
      expect(manager.sessions.get(result.id).alive).toBe(true);
    });

    it('claimed session emits data events normally', async () => {
      const dataHandler = vi.fn();
      manager.on('data', dataHandler);
      await manager.warmUp('/cwd');
      const result = manager.claimStandby('/cwd');
      const pty = manager.sessions.get(result.id).pty;
      pty._emitData('post-claim data');
      expect(dataHandler).toHaveBeenCalledWith(result.id, 'post-claim data');
    });

    it('claimStandby returns null on cwd mismatch and kills standby', async () => {
      await manager.warmUp('/cwd-a');
      const standbyPty = manager._standby.pty;
      const result = manager.claimStandby('/cwd-b');
      expect(result).toBeNull();
      expect(standbyPty.kill).toHaveBeenCalled();
      expect(manager._standby).toBeNull();
    });

    it('updateSettings clears stale standby when launcher setting changes', async () => {
      await manager.warmUp('/cwd', 'copilot');
      const standbyPty = manager._standby.pty;
      manager.updateSettings({ useAgencyCopilot: true, promptForWorkdir: false, defaultWorkdir: '/cwd' });
      expect(standbyPty.kill).toHaveBeenCalled();
      expect(manager._standby).toBeNull();
    });

    it('updateSettings clears stale standby when launcher args change', async () => {
      let settings = { maxConcurrent: 5, useAgencyCopilot: false, copilotArgs: '' };
      manager = new PtyManager('/fake/copilot', { get: () => settings }, mockPtyModule, {
        sessionStateDir: '/fake/session-state',
        sessionIdDiscoverer: mockSessionIdDiscoverer,
        agencyPath: process.platform === 'win32' ? 'C:\\Tools\\agency.exe' : '/opt/agency/bin/agency',
      });
      await manager.warmUp('/cwd', 'copilot');
      const standbyPty = manager._standby.pty;
      settings = { ...settings, copilotArgs: '--model gpt-5.5' };
      manager.updateSettings({ useAgencyCopilot: false, promptForWorkdir: false, defaultWorkdir: '/cwd', copilotArgs: '--model gpt-5.5' });
      expect(standbyPty.kill).toHaveBeenCalled();
      expect(manager._standby).toBeNull();
    });

    it('updateSettings clears standby when prompt-for-workdir is enabled', async () => {
      await manager.warmUp('/cwd', 'copilot');
      const standbyPty = manager._standby.pty;
      manager.updateSettings({ useAgencyCopilot: false, promptForWorkdir: true, defaultWorkdir: '/cwd' });
      expect(standbyPty.kill).toHaveBeenCalled();
      expect(manager._standby).toBeNull();
    });

    it('updateSettings keeps standby and generation for unrelated settings changes', async () => {
      await manager.warmUp('/cwd', 'copilot');
      const standby = manager._standby;
      const generation = manager._warmUpGeneration;

      manager.updateSettings({ theme: 'latte', activeTab: 'abc' }, false);

      expect(manager._standby).toBe(standby);
      expect(manager._warmUpGeneration).toBe(generation);
      expect(standby.pty.kill).not.toHaveBeenCalled();
    });

    it('claimStandby returns null when no standby exists', () => {
      expect(manager.claimStandby('/cwd')).toBeNull();
    });

    it('claimStandby returns null when standby died', async () => {
      await manager.warmUp('/cwd');
      manager._standby.pty._emitExit(1);
      expect(manager.claimStandby('/cwd')).toBeNull();
    });

    it('killAll cleans up standby', async () => {
      await manager.warmUp('/cwd');
      const standbyPty = manager._standby.pty;
      manager.killAll();
      expect(standbyPty.kill).toHaveBeenCalled();
      expect(manager._standby).toBeNull();
    });

    it('standby does not count toward active sessions', async () => {
      await manager.warmUp('/cwd');
      expect(manager.getActiveSessions()).toHaveLength(0);
    });
  });

  // Regression guard for CLI 1.0.49+ which strictly rejects --resume with an
  // unknown session ID. DeepSky must NEVER spawn a new (i.e. not-yet-existing)
  // session via --resume, otherwise every new tab dies with
  // "Error: No session, task, or name matched '<uuid>'".
  describe('CLI 1.0.49 compatibility — new sessions do not pass --resume', () => {
    it('newSession spawn args contain --yolo but never --resume', async () => {
      mockPtyModule.spawn.mockClear();
      await manager.newSession('/cwd');
      const [, args] = mockPtyModule.spawn.mock.calls[0];
      expect(args).toContain('--yolo');
      expect(args).not.toContain('--resume');
      expect(args).not.toContain('--name');
    });

    it('newSession spawn args contain --yolo but never --resume (agency launcher)', async () => {
      manager = createManager({ useAgencyCopilot: true });
      mockPtyModule.spawn.mockClear();
      await manager.newSession('/cwd');
      const [, args] = mockPtyModule.spawn.mock.calls[0];
      expect(args).toContain('--yolo');
      expect(args).not.toContain('--resume');
      expect(args).not.toContain('--name');
    });

    it('warmUp spawn args contain --yolo but never --resume', async () => {
      mockPtyModule.spawn.mockClear();
      await manager.warmUp('/cwd');
      const [, args] = mockPtyModule.spawn.mock.calls[0];
      expect(args).toContain('--yolo');
      expect(args).not.toContain('--resume');
      expect(args).not.toContain('--name');
    });

    it('openSession uses --session-id <id> so local history folders reopen even if resume index misses them', () => {
      mockPtyModule.spawn.mockClear();
      manager.openSession('existing-session-xyz', '/cwd');
      const [, args] = mockPtyModule.spawn.mock.calls[0];
      expect(args).toContain('--session-id');
      expect(args).not.toContain('--resume');
      expect(args).toContain('existing-session-xyz');
      expect(args).toContain('--yolo');
    });

    it('newSession returns the DeepSky-generated ID passed to the CLI', async () => {
      const id = await manager.newSession('/cwd');
      expect(id).toBe(generatedGuid(1));
      expect(manager.sessions.has(generatedGuid(1))).toBe(true);
      const [, args] = mockPtyModule.spawn.mock.calls[0];
      expect(args).toEqual(['--session-id', generatedGuid(1), '--yolo']);
    });

    it('warmUp standby uses the generated ID, claimStandby returns it', async () => {
      await manager.warmUp('/cwd');
      expect(manager._standby.id).toBe(generatedGuid(1));

      const claimed = manager.claimStandby('/cwd');
      expect(claimed.id).toBe(generatedGuid(1));
      expect(manager.sessions.has(generatedGuid(1))).toBe(true);
    });

    it('does not wait for filesystem discovery before returning a new session', async () => {
      mockSessionIdDiscoverer.mockClear();
      await manager.newSession('/cwd');
      expect(mockSessionIdDiscoverer).not.toHaveBeenCalled();
    });

    it('newSession does not fail when the legacy discoverer would time out', async () => {
      const failingDiscoverer = vi.fn(async () => { throw new Error('timeout'); });
      manager = createManager({}, { sessionIdDiscoverer: failingDiscoverer });
      const mockPty = createMockPty();
      mockPtyModule.spawn.mockReturnValueOnce(mockPty);

      await expect(manager.newSession('/cwd')).resolves.toBe(generatedGuid(1));
      expect(mockPty.kill).not.toHaveBeenCalled();
    });

    it('warmUp does not depend on the legacy discoverer', async () => {
      const failingDiscoverer = vi.fn(async () => { throw new Error('timeout'); });
      manager = createManager({}, { sessionIdDiscoverer: failingDiscoverer });
      const mockPty = createMockPty();
      mockPtyModule.spawn.mockReturnValueOnce(mockPty);

      await manager.warmUp('/cwd');
      expect(manager._standby.id).toBe(generatedGuid(1));
      expect(mockPty.kill).not.toHaveBeenCalled();
    });

    it('concurrent newSession calls each get a distinct generated ID', async () => {
      const [id1, id2] = await Promise.all([
        manager.newSession('/cwd'),
        manager.newSession('/cwd'),
      ]);

      expect(id1).toBe(generatedGuid(1));
      expect(id2).toBe(generatedGuid(2));
      expect(manager.sessions.has(generatedGuid(1))).toBe(true);
      expect(manager.sessions.has(generatedGuid(2))).toBe(true);
    });
  });

  // Direct checks for the legacy fs-based discoverer used only for startup
  // failure diagnostics. New sessions use DeepSky-generated --session-id and
  // do not depend on this path for normal startup.
  describe('default session-id discoverer (fs-based)', () => {
    it('returns the first UUID folder name not present in the before-snapshot', async () => {
      const realFs = require('fs');
      const realPath = require('path');
      const realOs = require('os');
      const tmp = realFs.mkdtempSync(realPath.join(realOs.tmpdir(), 'ds-pty-disc-'));
      const discoveredId = '207cdf12-ab63-4d96-b4b3-1322d4a0bdfe';
      try {
        realFs.mkdirSync(realPath.join(tmp, '376fedd7-eec9-429e-a4b9-5fb252880d42'));
        // Use the real default discoverer
        manager = new PtyManager('/fake/copilot',
          { get: () => ({ maxConcurrent: 5 }) },
          mockPtyModule,
          { sessionStateDir: tmp, discoveryTimeoutMs: 3000 }
        );

        const before = await manager._snapshotSessionFolders();
        const mockPty = createMockPty();

        vi.useRealTimers();
        const discoverPromise = manager._defaultDiscoverer(before, mockPty);
        // Simulate the CLI creating its folder ~150ms after spawn
        setTimeout(() => {
          realFs.mkdirSync(realPath.join(tmp, discoveredId));
        }, 150);
        const id = await discoverPromise;
        expect(id).toBe(discoveredId);
      } finally {
        vi.useFakeTimers();
        realFs.rmSync(tmp, { recursive: true, force: true });
      }
    });

    it('ignores non-UUID folders created during discovery', async () => {
      const realFs = require('fs');
      const realPath = require('path');
      const realOs = require('os');
      const tmp = realFs.mkdtempSync(realPath.join(realOs.tmpdir(), 'ds-pty-disc-'));
      const discoveredId = '11111111-2222-4333-8444-555555555555';
      try {
        manager = new PtyManager('/fake/copilot',
          { get: () => ({ maxConcurrent: 5 }) },
          mockPtyModule,
          { sessionStateDir: tmp, discoveryTimeoutMs: 3000 }
        );

        const before = await manager._snapshotSessionFolders();
        const mockPty = createMockPty();

        vi.useRealTimers();
        const discoverPromise = manager._defaultDiscoverer(before, mockPty);
        setTimeout(() => {
          realFs.mkdirSync(realPath.join(tmp, 'not-a-session-id'));
        }, 50);
        setTimeout(() => {
          realFs.mkdirSync(realPath.join(tmp, discoveredId));
        }, 150);
        const id = await discoverPromise;
        expect(id).toBe(discoveredId);
      } finally {
        vi.useFakeTimers();
        realFs.rmSync(tmp, { recursive: true, force: true });
      }
    });

    it('throws when no folder appears within the timeout', async () => {
      const realFs = require('fs');
      const realPath = require('path');
      const realOs = require('os');
      const tmp = realFs.mkdtempSync(realPath.join(realOs.tmpdir(), 'ds-pty-disc-'));
      try {
        manager = new PtyManager('/fake/copilot',
          { get: () => ({ maxConcurrent: 5 }) },
          mockPtyModule,
          { sessionStateDir: tmp, discoveryTimeoutMs: 200 }
        );
        const before = await manager._snapshotSessionFolders();
        const mockPty = createMockPty();

        vi.useRealTimers();
        await expect(manager._defaultDiscoverer(before, mockPty)).rejects.toThrow(/session-state folder/);
      } finally {
        vi.useFakeTimers();
        realFs.rmSync(tmp, { recursive: true, force: true });
      }
    });

    it('fails fast with CLI startup output when the spawned process exits before creating a session folder', async () => {
      const realFs = require('fs');
      const realPath = require('path');
      const realOs = require('os');
      const tmp = realFs.mkdtempSync(realPath.join(realOs.tmpdir(), 'ds-pty-disc-'));
      const mockPty = createMockPty();
      try {
        manager = new PtyManager('/fake/copilot',
          { get: () => ({ maxConcurrent: 5 }) },
          mockPtyModule,
          { sessionStateDir: tmp, discoveryTimeoutMs: 3000 }
        );
        mockPtyModule.spawn.mockReturnValueOnce(mockPty);

        const before = await manager._snapshotSessionFolders();

        vi.useRealTimers();
        const discoverPromise = manager._defaultDiscoverer(before, mockPty);
        setTimeout(() => {
          mockPty._emitData("error: unknown option '--mcp'\r\n");
          mockPty._emitExit(1);
        }, 50);

        await expect(discoverPromise).rejects.toThrow(/unknown option '--mcp'/);
      } finally {
        vi.useFakeTimers();
        realFs.rmSync(tmp, { recursive: true, force: true });
      }
    });

    it('default discovery timeout is generous (≥ 30s) so heavy load does not falsely fail new sessions', () => {
      const realFs = require('fs');
      const src = realFs.readFileSync(require('path').join(__dirname, '..', 'src', 'pty-manager.js'), 'utf8');
      const m = src.match(/DEFAULT_DISCOVERY_TIMEOUT_MS\s*=\s*(\d+)/);
      expect(m, 'DEFAULT_DISCOVERY_TIMEOUT_MS must be declared').not.toBeNull();
      expect(Number(m[1])).toBeGreaterThanOrEqual(30000);
    });
  });
});
