import { describe, it, expect, vi } from 'vitest';

const {
  calculateNotificationPosition,
  isValidSessionId,
  pickNotificationDisplay,
  parseLauncherArgs,
  mergePathEntries,
  readWindowsPersistedPath,
  refreshWindowsProcessPath,
  resolveCommandPath,
  resolveAgencyInfo,
  resolveBrochureInfo,
  resolveCopilotInfo,
  resolveCopilotPath,
} = require('../src/app-support');

describe('app-support', () => {
  describe('resolveCopilotPath', () => {
    it('falls back to bare copilot command when nothing is found', () => {
      const execSync = vi.fn(() => { throw new Error('missing'); });
      const existsSync = vi.fn(() => false);
      expect(resolveCopilotPath({ execSync, existsSync, env: {} })).toBe('copilot');
    });

    it('returns the first PATH hit when available', () => {
      const execSync = vi.fn(() => 'C:\\Tools\\copilot.exe\r\n');
      const existsSync = vi.fn((file) => file === 'C:\\Tools\\copilot.exe');
      expect(resolveCopilotPath({ execSync, existsSync, env: {} })).toBe('C:\\Tools\\copilot.exe');
    });
  });

  describe('resolveCopilotInfo', () => {
    it('reports Copilot CLI as unavailable when not found', () => {
      const execSync = vi.fn(() => { throw new Error('missing'); });
      const existsSync = vi.fn(() => false);
      expect(resolveCopilotInfo({ execSync, existsSync, env: {} })).toEqual({
        path: 'copilot',
        found: false,
      });
    });
  });

  describe('resolveAgencyInfo', () => {
    // Constructs candidates via path.join(env.APPDATA, ...) which uses the
    // host separator — on macOS path.join produces mixed slashes that won't
    // match the Windows-style existsSync mock. Skip on POSIX; the darwin
    // equivalent is covered in `darwin command path resolution` below.
    it.skipIf(process.platform !== 'win32')('detects agency from a known install location', () => {
      const execSync = vi.fn(() => { throw new Error('missing'); });
      const existsSync = vi.fn((file) => file === 'C:\\Users\\dev\\AppData\\Roaming\\agency\\CurrentVersion\\agency.exe');
      const info = resolveAgencyInfo({
        execSync,
        existsSync,
        env: { APPDATA: 'C:\\Users\\dev\\AppData\\Roaming' },
        platform: 'win32',
      });
      expect(info).toEqual({
        path: 'C:\\Users\\dev\\AppData\\Roaming\\agency\\CurrentVersion\\agency.exe',
        found: true,
      });
    });

    it('reports agency as unavailable when not found', () => {
      const execSync = vi.fn(() => { throw new Error('missing'); });
      const existsSync = vi.fn(() => false);
      expect(resolveAgencyInfo({ execSync, existsSync, env: {} })).toEqual({
        path: 'agency',
        found: false,
      });
    });

    it('does not resolve agency through PATH/current-directory lookup on Windows', () => {
      const execSync = vi.fn(() => 'C:\\repo\\agency.cmd\r\n');
      const existsSync = vi.fn(() => false);
      expect(resolveAgencyInfo({ execSync, existsSync, env: {}, platform: 'win32' })).toEqual({
        path: 'agency',
        found: false,
      });
      expect(execSync).not.toHaveBeenCalled();
    });
  });

  // resolveBrochureInfo builds Windows-style paths (`C:\\Docs\\...`) through
  // path.join, which is non-portable. These tests assert that exact Windows
  // string form, so they're inherently Windows-only. Skip on POSIX CI runners.
  describe.skipIf(process.platform !== 'win32')('resolveBrochureInfo', () => {
    it('prefers the documents brochure when present', () => {
      const existsSync = vi.fn((file) => file === 'C:\\Docs\\deepsky-brochure.html');
      expect(resolveBrochureInfo({
        appPath: 'C:\\DeepSky',
        documentsPath: 'C:\\Docs',
        homeDir: 'C:\\Users\\dev',
        existsSync,
      })).toEqual({
        path: 'C:\\Docs\\deepsky-brochure.html',
        found: true,
      });
    });

    it('falls back to the known OneDrive documents path when needed', () => {
      const existsSync = vi.fn((file) => file === 'C:\\Users\\dev\\OneDrive - Microsoft\\Documents\\deepsky-brochure.html');
      expect(resolveBrochureInfo({
        appPath: 'C:\\DeepSky',
        documentsPath: 'C:\\Users\\dev\\Documents',
        homeDir: 'C:\\Users\\dev',
        existsSync,
      })).toEqual({
        path: 'C:\\Users\\dev\\OneDrive - Microsoft\\Documents\\deepsky-brochure.html',
        found: true,
      });
    });

    it('reports brochure as unavailable when no candidate exists', () => {
      const existsSync = vi.fn(() => false);
      expect(resolveBrochureInfo({
        appPath: 'C:\\DeepSky',
        documentsPath: 'C:\\Docs',
        homeDir: 'C:\\Users\\dev',
        existsSync,
      })).toEqual({
        path: 'C:\\DeepSky\\deepsky-brochure.html',
        found: false,
      });
    });
  });

  describe('resolveCommandPath', () => {
    it('ignores unsafe command names instead of interpolating them into where', () => {
      const execSync = vi.fn(() => 'should not run');
      const existsSync = vi.fn(() => false);

      const result = resolveCommandPath({
        names: ['agency.exe & whoami'],
        candidates: [],
        fallbackCommand: 'agency',
        execSyncImpl: execSync,
        existsSync,
      });

      expect(result).toEqual({ path: 'agency', found: false });
      expect(execSync).not.toHaveBeenCalled();
    });

    it('passes stdio that detaches child stdin so where cannot EPIPE the parent', () => {
      const execSync = vi.fn(() => 'C:\\Tools\\copilot.exe\r\n');
      const existsSync = vi.fn(() => true);
      resolveCommandPath({
        names: ['copilot.exe'],
        candidates: [],
        fallbackCommand: 'copilot',
        execSyncImpl: execSync,
        existsSync,
      });
      expect(execSync).toHaveBeenCalledTimes(1);
      const [, opts] = execSync.mock.calls[0];
      expect(opts).toMatchObject({ stdio: ['ignore', 'pipe', 'ignore'] });
    });
  });

  describe('parseLauncherArgs', () => {
    it('splits launcher args while preserving quoted values', () => {
      expect(parseLauncherArgs('--agent squad --label "red team" --flag=value')).toEqual([
        '--agent',
        'squad',
        '--label',
        'red team',
        '--flag=value',
      ]);
    });

    it('keeps Windows paths intact instead of treating backslash as an escape', () => {
      expect(parseLauncherArgs('--config C:\\Tools\\agency.json')).toEqual(['--config', 'C:\\Tools\\agency.json']);
    });

    it('preserves explicitly quoted empty arguments', () => {
      expect(parseLauncherArgs('--flag ""')).toEqual(['--flag', '']);
    });

    it('rejects unclosed quotes', () => {
      expect(() => parseLauncherArgs('--agent "squad')).toThrow(/unclosed quote/);
    });

    it('rejects shell control characters', () => {
      expect(() => parseLauncherArgs('--agent squad & whoami')).toThrow(/shell control/);
    });

    it('rejects session-breaking flags that prevent a fresh interactive session', () => {
      expect(() => parseLauncherArgs('--')).toThrow(/cannot include --/);
      expect(() => parseLauncherArgs('--mcp gateway')).toThrow(/cannot include --mcp/);
      expect(() => parseLauncherArgs('--resume abc')).toThrow(/cannot include --resume/);
      expect(() => parseLauncherArgs('--session-id=11111111-2222-4333-8444-555555555555')).toThrow(/cannot include --session-id/);
      expect(() => parseLauncherArgs('-p "do work"')).toThrow(/cannot include -p/);
    });
  });

  describe('command-path caching', () => {
    const { _clearCommandPathCache } = require('../src/app-support');

    it('caches positive resolveCopilotInfo results across calls so Ctrl+W does not shell out per close', () => {
      _clearCommandPathCache();
      const execSync = vi.fn(() => 'C:\\Tools\\copilot.exe\r\n');
      const existsSync = vi.fn((file) => file === 'C:\\Tools\\copilot.exe');
      const deps = {
        execSync,
        existsSync,
        env: {},
        platform: 'win32',
        _cacheable: true,
        _skipWindowsPathRefresh: true,
      };
      const first = resolveCopilotInfo(deps);
      const second = resolveCopilotInfo(deps);

      expect(first).toEqual({ path: 'C:\\Tools\\copilot.exe', found: true });
      expect(second).toBe(first);
      expect(execSync).toHaveBeenCalledTimes(1);
    });

    it('does not permanently cache negative Copilot lookups', () => {
      const existsSync = vi.fn((file) => file === 'C:\\Tools\\copilot.exe');
      const execSync = vi.fn()
        .mockImplementationOnce(() => { throw new Error('missing'); })
        .mockImplementationOnce(() => { throw new Error('missing'); })
        .mockImplementationOnce(() => 'C:\\Tools\\copilot.exe\r\n');

      const first = resolveCopilotInfo({
        execSync,
        existsSync,
        env: {},
        platform: 'win32',
        readWindowsPersistedPath: () => ({ userPath: '', machinePath: '' }),
        _skipWindowsPathRefresh: true,
      });
      const second = resolveCopilotInfo({
        execSync,
        existsSync,
        env: {},
        platform: 'win32',
        readWindowsPersistedPath: () => ({ userPath: '', machinePath: '' }),
        _skipWindowsPathRefresh: true,
      });

      expect(first).toEqual({ path: 'copilot', found: false });
      expect(second).toEqual({ path: 'C:\\Tools\\copilot.exe', found: true });
    });

    it('caches resolveAgencyInfo across calls', () => {
      _clearCommandPathCache();
      const first = resolveAgencyInfo();
      const second = resolveAgencyInfo();
      expect(second).toBe(first);
    });

    describe('Windows PATH recovery', () => {
      it('reads persisted PATH through absolute reg.exe without shell command text', () => {
        const execFileSync = vi.fn((file, args) => {
          expect(file).toBe('C:\\Windows\\System32\\reg.exe');
          expect(args[0]).toBe('query');
          expect(args[2]).toBe('/v');
          expect(args[3]).toBe('Path');
          return args[1] === 'HKCU\\Environment'
            ? '    Path    REG_EXPAND_SZ    C:\\UserBin\r\n'
            : '    Path    REG_SZ    C:\\MachineBin\r\n';
        });

        expect(readWindowsPersistedPath({
          platform: 'win32',
          env: { SystemRoot: 'C:\\Windows' },
          execFileSync,
        })).toEqual({
          userPath: 'C:\\UserBin',
          machinePath: 'C:\\MachineBin',
        });
        expect(execFileSync).toHaveBeenCalledTimes(2);
      });

      it('merges persisted User and Machine PATH entries into a stale process PATH', () => {
        const env = {
          PATH: 'C:\\ProcessOnly;C:\\Windows\\System32',
          LOCALAPPDATA: 'C:\\Users\\dev\\AppData\\Local',
          ProgramFiles: 'C:\\Program Files',
        };
        const result = refreshWindowsProcessPath({
          platform: 'win32',
          env,
          readWindowsPersistedPath: () => ({
            userPath: '%LOCALAPPDATA%\\Microsoft\\WinGet\\Packages\\GitHub.Copilot_123',
            machinePath: '%ProgramFiles%\\GitHub Copilot CLI;C:\\Windows\\System32',
          }),
        });

        expect(result.mutated).toBe(true);
        expect(env.PATH).toBe(
          'C:\\ProcessOnly;C:\\Windows\\System32;C:\\Users\\dev\\AppData\\Local\\Microsoft\\WinGet\\Packages\\GitHub.Copilot_123;C:\\Program Files\\GitHub Copilot CLI'
        );
        expect(env.Path).toBe(env.PATH);
      });

      it('preserves existing entries and removes duplicates case-insensitively', () => {
        expect(mergePathEntries([
          'C:\\Tools;C:\\Windows',
          'c:\\tools;C:\\New',
          'C:\\WINDOWS;C:\\Other',
        ], 'win32')).toBe('C:\\Tools;C:\\Windows;C:\\New;C:\\Other');
      });

      it('detects Copilot after Windows PATH refresh without requiring app relaunch', () => {
        const env = { PATH: 'C:\\Windows\\System32' };
        const existsSync = vi.fn((file) => file === 'C:\\Winget\\GitHub.Copilot\\copilot.exe');
        const execSync = vi.fn((cmd) => {
          if (cmd.startsWith('where')) {
            if (env.PATH.includes('C:\\Winget\\GitHub.Copilot')) {
              return 'C:\\Winget\\GitHub.Copilot\\copilot.exe\r\n';
            }
            throw new Error('missing');
          }
          throw new Error('unexpected command');
        });

        const info = resolveCopilotInfo({
          execSync,
          existsSync,
          env,
          platform: 'win32',
          readWindowsPersistedPath: () => ({
            userPath: 'C:\\Winget\\GitHub.Copilot',
            machinePath: '',
          }),
        });

        expect(info).toEqual({
          path: 'C:\\Winget\\GitHub.Copilot\\copilot.exe',
          found: true,
          recoveredFromPathRefresh: true,
        });
        expect(env.PATH).toContain('C:\\Winget\\GitHub.Copilot');
      });

      it('retries the Copilot lookup at most once after Windows PATH refresh', () => {
        const execSync = vi.fn(() => { throw new Error('missing'); });
        const existsSync = vi.fn(() => false);
        const info = resolveCopilotInfo({
          execSync,
          existsSync,
          env: { PATH: 'C:\\Windows' },
          platform: 'win32',
          readWindowsPersistedPath: () => ({ userPath: 'C:\\New', machinePath: '' }),
        });

        expect(info).toEqual({ path: 'copilot', found: false });
        expect(execSync.mock.calls.filter(([cmd]) => String(cmd).startsWith('where '))).toHaveLength(4);
      });
    });

    it('bypasses the cache when deps are injected so tests stay isolated', () => {
      _clearCommandPathCache();
      // Warm the production cache.
      resolveCopilotInfo();
      // Inject a deterministic execSync — the cache must NOT be returned.
      const execSync = vi.fn(() => { throw new Error('nope'); });
      const existsSync = vi.fn(() => false);
      const injected = resolveCopilotInfo({ execSync, existsSync, env: {} });
      expect(injected).toEqual({ path: 'copilot', found: false });
      // Subsequent uncached call still returns the production-cached value,
      // confirming the injected call did not overwrite or replace it.
      const reCached = resolveCopilotInfo();
      expect(reCached).not.toBe(injected);
    }, 15000);
  });

  describe('session id validation', () => {
    it('accepts UUID session ids', () => {
      expect(isValidSessionId('376fedd7-eec9-429e-a4b9-5fb252880d42')).toBe(true);
    });

    it('rejects path-like session ids', () => {
      expect(isValidSessionId('..\\..\\oops')).toBe(false);
    });
  });

  describe('notification placement', () => {
    it('anchors notifications to the display containing the app window', () => {
      const displays = [
        { bounds: { x: 0, y: 0, width: 1920, height: 1080 }, workArea: { x: 0, y: 0, width: 1920, height: 1040 } },
        { bounds: { x: 1920, y: 0, width: 2560, height: 1440 }, workArea: { x: 1920, y: 0, width: 2560, height: 1400 } },
      ];
      const display = pickNotificationDisplay(displays, { x: 2200, y: 200, width: 1200, height: 900 });
      expect(display.workArea).toEqual({ x: 1920, y: 0, width: 2560, height: 1400 });
    });

    it('calculates stacked bottom-right popup positions', () => {
      expect(calculateNotificationPosition({ x: 1920, y: 0, width: 2560, height: 1400 }, 1)).toEqual({
        width: 360,
        height: 100,
        x: 4100,
        y: 1172,
      });
    });
  });

  // --- macOS / POSIX path resolution ----------------------------------------
  // These tests inject `platform: 'darwin'` to exercise the non-Windows
  // branches of resolveCopilotInfo / resolveAgencyInfo / buildAugmentedPath
  // even though the test suite runs on Windows CI.
  describe('darwin command path resolution', () => {
    const {
      buildAugmentedPath,
      getLoginShellPath,
      _clearLoginShellPathCache,
      _clearCommandPathCache,
    } = require('../src/app-support');

    it('finds copilot via `command -v` on darwin when on PATH', () => {
      _clearCommandPathCache();
      // /bin/sh -c "command -v copilot ..." pipes through head; we just need
      // the execSync mock to return a valid absolute path.
      const execSync = vi.fn(() => '/opt/homebrew/bin/copilot\n');
      const existsSync = vi.fn((p) => p === '/opt/homebrew/bin/copilot');
      const info = resolveCopilotInfo({
        execSync,
        existsSync,
        env: { HOME: '/Users/dev' },
        platform: 'darwin',
      });
      expect(info).toEqual({ path: '/opt/homebrew/bin/copilot', found: true });
      // Sanity: must be using `command -v`, not `where`
      expect(execSync.mock.calls[0][0]).toContain('command -v copilot');
      expect(execSync.mock.calls[0][0]).not.toContain('where');
    });

    it('falls back to /opt/homebrew/bin/copilot candidate when which finds nothing', () => {
      _clearCommandPathCache();
      const execSync = vi.fn(() => { throw new Error('not found'); });
      const existsSync = vi.fn((p) => p === '/opt/homebrew/bin/copilot');
      const info = resolveCopilotInfo({
        execSync,
        existsSync,
        env: { HOME: '/Users/dev' },
        platform: 'darwin',
      });
      expect(info).toEqual({ path: '/opt/homebrew/bin/copilot', found: true });
    });

    it('falls back to ~/.local/bin/copilot for non-root install-script users', () => {
      _clearCommandPathCache();
      const execSync = vi.fn(() => { throw new Error('not found'); });
      const existsSync = vi.fn((p) => p === '/Users/dev/.local/bin/copilot');
      const info = resolveCopilotInfo({
        execSync,
        existsSync,
        env: { HOME: '/Users/dev' },
        platform: 'darwin',
      });
      expect(info).toEqual({ path: '/Users/dev/.local/bin/copilot', found: true });
    });

    it('reports copilot as unavailable on darwin when nothing is found', () => {
      _clearCommandPathCache();
      const execSync = vi.fn(() => { throw new Error('not found'); });
      const existsSync = vi.fn(() => false);
      expect(resolveCopilotInfo({
        execSync,
        existsSync,
        env: { HOME: '/Users/dev' },
        platform: 'darwin',
      })).toEqual({ path: 'copilot', found: false });
    });

    it('resolves agency the same way as copilot on darwin', () => {
      _clearCommandPathCache();
      const execSync = vi.fn(() => '/opt/homebrew/bin/agency\n');
      const existsSync = vi.fn((p) => p === '/opt/homebrew/bin/agency');
      const info = resolveAgencyInfo({
        execSync,
        existsSync,
        env: { HOME: '/Users/dev' },
        platform: 'darwin',
      });
      expect(info).toEqual({ path: '/opt/homebrew/bin/agency', found: true });
    });
  });

  describe('getLoginShellPath', () => {
    const {
      getLoginShellPath,
      _clearLoginShellPathCache,
    } = require('../src/app-support');

    it('returns null on non-darwin platforms (no shellout needed)', () => {
      _clearLoginShellPathCache();
      const execSync = vi.fn();
      expect(getLoginShellPath({ execSync, env: {}, platform: 'win32' })).toBeNull();
      expect(execSync).not.toHaveBeenCalled();
    });

    it('shells out to $SHELL -l -c "printf %s \\"$PATH\\"" on darwin', () => {
      _clearLoginShellPathCache();
      const execSync = vi.fn(() => '/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin');
      const result = getLoginShellPath({
        execSync,
        env: { SHELL: '/bin/zsh' },
        platform: 'darwin',
      });
      expect(result).toBe('/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin');
      expect(execSync.mock.calls[0][0]).toBe(`/bin/zsh -l -c 'printf %s "$PATH"'`);
    });

    it('coerces unknown $SHELL values to /bin/zsh to prevent shell injection', () => {
      _clearLoginShellPathCache();
      const execSync = vi.fn(() => '/usr/bin');
      getLoginShellPath({
        execSync,
        env: { SHELL: '/tmp/malicious; rm -rf /' },
        platform: 'darwin',
      });
      // Must NOT have invoked the malicious shell — coerced back to safe default
      expect(execSync.mock.calls[0][0]).toBe(`/bin/zsh -l -c 'printf %s "$PATH"'`);
    });

    it('returns null when the shell probe throws', () => {
      _clearLoginShellPathCache();
      const execSync = vi.fn(() => { throw new Error('no shell'); });
      expect(getLoginShellPath({
        execSync,
        env: { SHELL: '/bin/zsh' },
        platform: 'darwin',
      })).toBeNull();
    });
  });

  describe('buildAugmentedPath', () => {
    const {
      buildAugmentedPath,
      _clearLoginShellPathCache,
    } = require('../src/app-support');

    it('returns currentPath unchanged on non-darwin', () => {
      _clearLoginShellPathCache();
      expect(buildAugmentedPath('/usr/bin', { platform: 'linux', env: {} })).toBe('/usr/bin');
      expect(buildAugmentedPath('C:\\Windows', { platform: 'win32', env: {} })).toBe('C:\\Windows');
    });

    it('prepends login-shell PATH + known dirs on darwin and de-dupes', () => {
      _clearLoginShellPathCache();
      const execSync = vi.fn(() => '/Users/dev/.asdf/shims:/opt/homebrew/bin:/usr/local/bin');
      const result = buildAugmentedPath('/usr/bin:/bin', {
        execSync,
        env: { SHELL: '/bin/zsh', HOME: '/Users/dev' },
        platform: 'darwin',
      });
      // Order check: login-shell PATH first (so asdf shims win),
      // then hardcoded brew/local/bin fallbacks, then ~/.local/bin (HOME),
      // then /usr/bin /bin, then the inherited current PATH. De-duped.
      expect(result).toBe(
        '/Users/dev/.asdf/shims:/opt/homebrew/bin:/usr/local/bin:/Users/dev/.local/bin:/usr/bin:/bin'
      );
    });

    it('still produces a usable PATH on darwin when login-shell probe fails', () => {
      _clearLoginShellPathCache();
      const execSync = vi.fn(() => { throw new Error('no shell'); });
      const result = buildAugmentedPath('/usr/bin', {
        execSync,
        env: { SHELL: '/bin/zsh', HOME: '/Users/dev' },
        platform: 'darwin',
      });
      expect(result).toBe(
        '/opt/homebrew/bin:/usr/local/bin:/Users/dev/.local/bin:/usr/bin:/bin'
      );
    });
  });

  describe('bootstrapMacEnvironment', () => {
    const {
      bootstrapMacEnvironment,
      _clearLoginShellPathCache,
    } = require('../src/app-support');

    it('is a no-op on non-darwin platforms', () => {
      _clearLoginShellPathCache();
      const env = { PATH: '/usr/bin' };
      const result = bootstrapMacEnvironment({ env, platform: 'win32', execSync: vi.fn() });
      expect(result.mutated).toBe(false);
      expect(env.PATH).toBe('/usr/bin');
    });

    it('mutates env.PATH on darwin to include brew + login-shell dirs', () => {
      _clearLoginShellPathCache();
      const execSync = vi.fn(() => '/opt/homebrew/bin:/usr/local/bin');
      const env = { PATH: '/usr/bin:/bin', SHELL: '/bin/zsh', HOME: '/Users/dev' };
      const result = bootstrapMacEnvironment({ env, platform: 'darwin', execSync });
      expect(result.mutated).toBe(true);
      expect(env.PATH).toContain('/opt/homebrew/bin');
      expect(env.PATH).toContain('/usr/local/bin');
      expect(env.PATH).toContain('/usr/bin');
    });

    it('does not mutate env.PATH when augmented value equals current', () => {
      _clearLoginShellPathCache();
      const execSync = vi.fn(() => '');
      // Edge case: if there's no login-shell PATH and current PATH already
      // contains all the hardcoded segments in the expected order, mutated
      // should be false. In practice this is unlikely but the no-op path
      // shouldn't crash.
      const env = { PATH: '/opt/homebrew/bin:/usr/local/bin:/Users/dev/.local/bin:/usr/bin:/bin', HOME: '/Users/dev' };
      const result = bootstrapMacEnvironment({ env, platform: 'darwin', execSync });
      expect(result.mutated).toBe(false);
    });
  });
});
