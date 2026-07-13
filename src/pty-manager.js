const EventEmitter = require('events');
const path = require('path');
const fs = require('fs');
const { randomUUID } = require('crypto');

const os = require('os');
const { isValidSessionId, buildAugmentedPath, parseLauncherArgs, resolveAgencyInfo } = require('./app-support');

// Default to node-pty, but allow injection for testing
let defaultPty;
try { defaultPty = require('node-pty'); } catch { defaultPty = null; }

// Build the env used for every PTY spawn. On macOS we augment PATH so
// children (copilot, node, git, etc.) resolve even when the app was launched
// from Finder/Dock with the minimal launchd PATH. On Windows / Linux PATH is
// already inherited correctly so we just pass it through.
function _buildSpawnEnv(baseEnv = process.env) {
  const env = { ...baseEnv, TERM: 'xterm-256color' };
  if (process.platform === 'darwin') {
    env.PATH = buildAugmentedPath(env.PATH || '');
  }
  return env;
}

const DEFAULT_SESSION_STATE_DIR = path.join(os.homedir(), '.copilot', 'session-state');
// The Copilot CLI normally creates its session-state folder within ~1–3s on a
// healthy machine. Under load (other Electron apps running, slow disk,
// antivirus scanning the spawn) cold-start can comfortably exceed 10s and
// users would see "Failed to discover session ID after CLI spawn: Timed out".
// 30s gives the CLI plenty of room without hanging the UI forever when the
// spawn truly fails.
const DEFAULT_DISCOVERY_TIMEOUT_MS = 30000;
const DEFAULT_DISCOVERY_POLL_INTERVAL_MS = 100;

class PtyManager extends EventEmitter {
  constructor(copilotPath, settingsService, ptyModule, options = {}) {
    super();
    this.copilotPath = copilotPath;
    this.agencyPath = options.agencyPath || resolveAgencyInfo().path || 'agency';
    const windowsDir = process.env.SystemRoot || process.env.windir || 'C:\\Windows';
    this._cmdPath = options.cmdPath || (process.platform === 'win32' ? path.join(windowsDir, 'System32', 'cmd.exe') : 'cmd.exe');
    this.sessions = new Map();
    this.settingsService = settingsService;
    this._pty = ptyModule || defaultPty;

    // On Windows, .cmd files must be spawned via cmd.exe
    this._useCmd = process.platform === 'win32' &&
      copilotPath.toLowerCase().endsWith('.cmd');
    this._agencyUseCmd = process.platform === 'win32' &&
      this.agencyPath.toLowerCase().endsWith('.cmd');
    this._standby = null;
    this._warmUpGeneration = 0;

    // New sessions are created with a DeepSky-generated UUID via
    // `--session-id <uuid>`. The CLI may create the session-state folder only
    // after its interactive UI finishes initializing, so DeepSky must not block
    // tab creation on a filesystem diff. The discoverer remains for targeted
    // compatibility tests around startup-failure diagnostics.
    this._sessionStateDir = options.sessionStateDir || DEFAULT_SESSION_STATE_DIR;
    this._discoveryTimeoutMs = options.discoveryTimeoutMs ?? DEFAULT_DISCOVERY_TIMEOUT_MS;
    this._sessionIdDiscoverer = options.sessionIdDiscoverer
      || ((before, pty) => this._defaultDiscoverer(before, pty));
    this._sessionIdFactory = options.sessionIdFactory || randomUUID;

    // Serialize concurrent spawn+discover sequences so two parallel
    // newSession/warmUp calls can't race on the folder-diff snapshot.
    this._spawnLock = Promise.resolve();
  }

  _resolveLauncher(launcher) {
    if (launcher === 'agency' || launcher === 'copilot') return launcher;
    return this.settingsService?.get().useAgencyCopilot ? 'agency' : 'copilot';
  }

  _launcherArgs(launcher, overrideArgsText) {
    if (typeof overrideArgsText === 'string') {
      return parseLauncherArgs(overrideArgsText);
    }
    const settings = this.settingsService?.get() || {};
    return parseLauncherArgs(settings.copilotArgs || '');
  }

  _launcherArgsKey(launcher, overrideArgsText) {
    return JSON.stringify(this._launcherArgs(launcher, overrideArgsText));
  }

  _ensureCmdSafeLauncherArgs(args) {
    const unsafe = args.find(arg => /[%!]/.test(arg));
    if (unsafe !== undefined) {
      throw new Error('Custom launcher arguments for Windows command launchers cannot contain % or !.');
    }
  }

  _standbyKey(cwd, launcher) {
    const resolvedLauncher = this._resolveLauncher(launcher);
    return JSON.stringify({
      cwd: cwd || os.homedir(),
      launcher: resolvedLauncher,
      args: this._launcherArgsKey(resolvedLauncher),
    });
  }

  _newSessionId() {
    for (let i = 0; i < 5; i++) {
      const id = this._sessionIdFactory();
      if (isValidSessionId(id) && !this.sessions.has(id)) return id;
    }
    throw new Error('Failed to allocate a valid session ID.');
  }

  _spawnArgs(extraArgs, launcher, overrideArgsText) {
    const resolvedLauncher = this._resolveLauncher(launcher);
    const launcherArgs = this._launcherArgs(resolvedLauncher, overrideArgsText);
    const allArgs = [...launcherArgs, ...extraArgs];
    if (resolvedLauncher === 'agency') {
      if (!path.isAbsolute(this.agencyPath)) {
        throw new Error('Agency executable path is unavailable.');
      }
      if (this._agencyUseCmd) {
        if (!path.isAbsolute(this._cmdPath)) throw new Error('Windows command processor path is unavailable.');
        this._ensureCmdSafeLauncherArgs(launcherArgs);
        return { file: this._cmdPath, args: ['/d', '/s', '/c', `"${this.agencyPath}"`, 'copilot', ...allArgs], launcher: resolvedLauncher };
      }
      return { file: this.agencyPath, args: ['copilot', ...allArgs], launcher: resolvedLauncher };
    }
    if (this._useCmd) {
      if (!path.isAbsolute(this._cmdPath)) throw new Error('Windows command processor path is unavailable.');
      this._ensureCmdSafeLauncherArgs(launcherArgs);
      return { file: this._cmdPath, args: ['/c', this.copilotPath, ...allArgs], launcher: resolvedLauncher };
    }
    return { file: this.copilotPath, args: allArgs, launcher: resolvedLauncher };
  }

  get maxConcurrent() {
    return this.settingsService?.get().maxConcurrent || 5;
  }

  // Serialize spawn+discover sequences so concurrent newSession/warmUp
  // calls don't race on the folder-snapshot diff used for ID discovery.
  async _serializeSpawn(fn) {
    const prev = this._spawnLock;
    let resolveOurs;
    this._spawnLock = new Promise(r => { resolveOurs = r; });
    try {
      await prev.catch(() => {});
      return await fn();
    } finally {
      resolveOurs();
    }
  }

  async _snapshotSessionFolders() {
    try {
      const entries = await fs.promises.readdir(this._sessionStateDir, { withFileTypes: true });
      return new Set(entries.filter(e => e.isDirectory()).map(e => e.name).filter(isValidSessionId));
    } catch {
      // Directory might not exist yet; treat as empty snapshot
      return new Set();
    }
  }

  // Default discoverer: poll session-state dir until a folder not present in
  // `beforeSnapshot` shows up. Folder appears within ~3s in practice; we wait
  // up to `_discoveryTimeoutMs` (10s default) before giving up.
  async _defaultDiscoverer(beforeSnapshot, ptyProcess) {
    const start = Date.now();
    const sleep = (ms) => new Promise(r => setTimeout(r, ms));
    const startupOutput = [];
    let exitCode = null;
    const dataDisposable = ptyProcess?.onData?.((data) => {
      if (startupOutput.join('').length < 4000) startupOutput.push(String(data || ''));
    });
    const exitDisposable = ptyProcess?.onExit?.(({ exitCode: code }) => {
      exitCode = code;
    });

    const startupFailure = () => {
      if (exitCode === null) return null;
      const output = startupOutput
        .join('')
        .replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, '')
        .trim()
        .slice(0, 1000);
      return `CLI exited before creating session-state folder (exit code ${exitCode})${output ? `: ${output}` : ''}`;
    };

    try {
      while (Date.now() - start < this._discoveryTimeoutMs) {
        const failure = startupFailure();
        if (failure) throw new Error(failure);

        let entries;
        try {
          entries = await fs.promises.readdir(this._sessionStateDir, { withFileTypes: true });
        } catch {
          await sleep(DEFAULT_DISCOVERY_POLL_INTERVAL_MS);
          continue;
        }
        for (const e of entries) {
          if (e.isDirectory() && isValidSessionId(e.name) && !beforeSnapshot.has(e.name)) {
            return e.name;
          }
        }
        await sleep(DEFAULT_DISCOVERY_POLL_INTERVAL_MS);
      }
      throw new Error('Timed out waiting for CLI session-state folder to appear');
    } finally {
      dataDisposable?.dispose?.();
      exitDisposable?.dispose?.();
    }
  }

  openSession(sessionId, cwd, launcher, launcherArgsText = '') {
    // If already alive, just return the id
    if (this.sessions.has(sessionId) && this.sessions.get(sessionId).alive) {
      return sessionId;
    }

    // Bug #26: clean up dead entry before respawning
    if (this.sessions.has(sessionId)) {
      this.sessions.delete(sessionId);
    }

    // Evict oldest if at max capacity
    this._evictIfNeeded();

    const spawnCwd = cwd || os.homedir();
    let ptyProcess;
    try {
      // `--resume <id>` depends on the CLI resume index, which can reject
      // local history folders. `--session-id` resumes local state by UUID and
      // keeps history cards reopenable even when that index is stale.
      const spawnConfig = this._spawnArgs(['--session-id', sessionId, '--yolo'], launcher, launcherArgsText);
      launcher = spawnConfig.launcher;
      const { file, args } = spawnConfig;
      ptyProcess = this._pty.spawn(file, args, {
        name: 'xterm-256color',
        cols: 120,
        rows: 40,
        cwd: spawnCwd,
        env: _buildSpawnEnv()
      });
    } catch (err) {
      // If spawn fails with given cwd, retry with homedir
      if (cwd && cwd !== os.homedir()) {
        try {
          const spawnConfig = this._spawnArgs(['--session-id', sessionId, '--yolo'], launcher, launcherArgsText);
          launcher = spawnConfig.launcher;
          const { file, args } = spawnConfig;
          ptyProcess = this._pty.spawn(file, args, {
            name: 'xterm-256color',
            cols: 120,
            rows: 40,
            cwd: os.homedir(),
            env: _buildSpawnEnv()
          });
        } catch (err2) {
          throw new Error(`Failed to spawn PTY for session ${sessionId}: ${err2.message}`);
        }
      } else {
        throw new Error(`Failed to spawn PTY for session ${sessionId}: ${err.message}`);
      }
    }

    // Capture entry reference directly so exit/data handlers don't
    // accidentally operate on a NEW entry after kill+respawn
    const sessionEntry = {
      pty: ptyProcess,
      alive: true,
      openedAt: Date.now(),
      lastDataAt: null,
      dataBytesSinceIdle: 0,
      cwd: spawnCwd,
      launcher: this._resolveLauncher(launcher),
      argsKey: this._launcherArgsKey(this._resolveLauncher(launcher), launcherArgsText)
    };

    ptyProcess.onData((data) => {
      if (sessionEntry.alive) {
        const now = Date.now();
        // Reset burst counter after 5s of silence (new burst = new activity)
        if (sessionEntry.lastDataAt && (now - sessionEntry.lastDataAt) > 5000) {
          sessionEntry.dataBytesSinceIdle = 0;
        }
        sessionEntry.lastDataAt = now;
        sessionEntry.dataBytesSinceIdle += data.length;
        this.emit('data', sessionId, data);
      }
    });

    ptyProcess.onExit(({ exitCode }) => this._handleSessionExit(sessionId, sessionEntry, exitCode));

    this.sessions.set(sessionId, sessionEntry);
    return sessionId;
  }

  async restartSession(sessionId, cwd, launcher, launcherArgsText = '') {
    const entry = this.sessions.get(sessionId);
    if (entry?.alive) {
      await this._waitForExitAfterKill(entry);
      if (this.sessions.get(sessionId) !== entry) {
        return null;
      }
      this.sessions.delete(sessionId);
    } else if (entry) {
      this.sessions.delete(sessionId);
    }

    return this.openSession(sessionId, cwd, launcher, launcherArgsText);
  }

  newSession(cwd, launcher, extraArgs = [], launcherArgsText) {
    return this._serializeSpawn(() => this._newSessionImpl(cwd, launcher, extraArgs, launcherArgsText));
  }

  async _newSessionImpl(cwd, launcher, extraArgs = [], launcherArgsText) {
    this._evictIfNeeded();

    const spawnCwd = cwd || os.homedir();
    const sessionId = this._newSessionId();
    const buildArgs = ['--session-id', sessionId, '--yolo', ...extraArgs];
    let ptyProcess;
    let resolvedLauncher;
    try {
      const spawnConfig = this._spawnArgs(buildArgs, launcher, launcherArgsText);
      resolvedLauncher = spawnConfig.launcher;
      const { file, args } = spawnConfig;
      ptyProcess = this._pty.spawn(file, args, {
        name: 'xterm-256color',
        cols: 120,
        rows: 40,
        cwd: spawnCwd,
        env: _buildSpawnEnv()
      });
    } catch (err) {
      if (cwd && cwd !== os.homedir()) {
        try {
          const spawnConfig = this._spawnArgs(buildArgs, launcher, launcherArgsText);
          resolvedLauncher = spawnConfig.launcher;
          const { file, args } = spawnConfig;
          ptyProcess = this._pty.spawn(file, args, {
            name: 'xterm-256color',
            cols: 120,
            rows: 40,
            cwd: os.homedir(),
            env: _buildSpawnEnv()
          });
        } catch (err2) {
          throw new Error(`Failed to spawn PTY: ${err2.message}`);
        }
      } else {
        throw new Error(`Failed to spawn PTY: ${err.message}`);
      }
    }

    const sessionEntry = {
      pty: ptyProcess,
      alive: true,
      openedAt: Date.now(),
      lastDataAt: null,
      dataBytesSinceIdle: 0,
      cwd: spawnCwd,
      launcher: resolvedLauncher,
      argsKey: this._launcherArgsKey(resolvedLauncher, launcherArgsText)
    };

    ptyProcess.onData((data) => {
      if (sessionEntry.alive) {
        const now = Date.now();
        if (sessionEntry.lastDataAt && (now - sessionEntry.lastDataAt) > 5000) {
          sessionEntry.dataBytesSinceIdle = 0;
        }
        sessionEntry.lastDataAt = now;
        sessionEntry.dataBytesSinceIdle += data.length;
        this.emit('data', sessionId, data);
      }
    });

    ptyProcess.onExit(({ exitCode }) => this._handleSessionExit(sessionId, sessionEntry, exitCode));

    this.sessions.set(sessionId, sessionEntry);
    return sessionId;
  }

  write(sessionId, data) {
    const entry = this.sessions.get(sessionId);
    if (entry && entry.alive) {
      entry.pty.write(data);
    }
  }

  resize(sessionId, cols, rows) {
    const entry = this.sessions.get(sessionId);
    if (entry && entry.alive) {
      entry.pty.resize(cols, rows);
    }
  }

  kill(sessionId) {
    const entry = this.sessions.get(sessionId);
    if (entry && entry.alive) {
      entry.pty.kill();
      entry.alive = false;
    }
    this.sessions.delete(sessionId);
  }

  _handleSessionExit(sessionId, sessionEntry, exitCode) {
    const waiters = sessionEntry.exitWaiters || [];
    const wasAlive = sessionEntry.alive;
    if (!wasAlive && waiters.length === 0) return;

    sessionEntry.alive = false;
    sessionEntry.exitWaiters = [];
    waiters.forEach(resolve => resolve(exitCode));

    if (wasAlive && !sessionEntry.suppressExit) {
      this.emit('exit', sessionId, exitCode);
    }

    if (this.sessions.get(sessionId) === sessionEntry && !sessionEntry.suppressExit) {
      this.sessions.delete(sessionId);
    }
  }

  _waitForExitAfterKill(sessionEntry, timeoutMs = 3000) {
    return new Promise((resolve) => {
      let settled = false;
      const finish = () => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve();
      };
      const timer = setTimeout(finish, timeoutMs);
      sessionEntry.suppressExit = true;
      sessionEntry.exitWaiters = sessionEntry.exitWaiters || [];
      sessionEntry.exitWaiters.push(finish);
      sessionEntry.alive = false;

      try {
        sessionEntry.pty.kill();
      } catch {
        finish();
      }
    });
  }

  warmUp(cwd, launcher) {
    return this._serializeSpawn(() => this._warmUpImpl(cwd, launcher));
  }

  async _warmUpImpl(cwd, launcher) {
    const spawnCwd = cwd || os.homedir();
    const resolvedLauncher = this._resolveLauncher(launcher);
    const expectedKey = this._standbyKey(spawnCwd, resolvedLauncher);
    const generation = this._warmUpGeneration;
    if (this._standby && this._standby.alive) {
      if (this._standby.standbyKey === expectedKey) return;
      try { this._standby.pty.kill(); } catch {}
      this._standby.alive = false;
      this._standby = null;
    }

    // Don't warm if at capacity
    const aliveCount = [...this.sessions.values()].filter(e => e.alive).length;
    if (aliveCount >= this.maxConcurrent) return;

    const sessionId = this._newSessionId();
    let ptyProcess;
    let spawnConfig;
    try {
      spawnConfig = this._spawnArgs(['--session-id', sessionId, '--yolo'], resolvedLauncher);
      const { file, args } = spawnConfig;
      ptyProcess = this._pty.spawn(file, args, {
        name: 'xterm-256color',
        cols: 120,
        rows: 40,
        cwd: spawnCwd,
        env: _buildSpawnEnv()
      });
    } catch {
      // Pre-warm failed — cold start will still work
      return;
    }

    if (generation !== this._warmUpGeneration || expectedKey !== this._standbyKey(spawnCwd, resolvedLauncher)) {
      try { ptyProcess.kill(); } catch {}
      return;
    }

    const entry = {
      id: sessionId,
      pty: ptyProcess,
      cwd: spawnCwd,
      launcher: spawnConfig.launcher,
      argsKey: this._launcherArgsKey(spawnConfig.launcher),
      standbyKey: expectedKey,
      bufferedData: [],
      alive: true,
      claimed: false
    };

    ptyProcess.onData((data) => {
      if (!entry.claimed && entry.alive) {
        entry.bufferedData.push(data);
      }
    });

    ptyProcess.onExit(() => {
      if (!entry.claimed) {
        entry.alive = false;
        if (this._standby === entry) this._standby = null;
      }
    });

    this._standby = entry;
  }

  claimStandby(cwd, launcher) {
    const standby = this._standby;
    if (!standby || !standby.alive) return null;

    const spawnCwd = cwd || os.homedir();
    const resolvedLauncher = this._resolveLauncher(launcher);
    const argsKey = this._launcherArgsKey(resolvedLauncher);
    const expectedKey = this._standbyKey(spawnCwd, resolvedLauncher);
    if (standby.cwd !== spawnCwd || standby.launcher !== resolvedLauncher || standby.argsKey !== argsKey || standby.standbyKey !== expectedKey) {
      // CWD mismatch — discard standby
      try { standby.pty.kill(); } catch {}
      standby.alive = false;
      this._standby = null;
      return null;
    }

    standby.claimed = true;
    this._standby = null;

    this._evictIfNeeded();

    const sessionEntry = {
      pty: standby.pty,
      alive: true,
      openedAt: Date.now(),
      lastDataAt: standby.bufferedData.length > 0 ? Date.now() : null,
      dataBytesSinceIdle: 0,
      cwd: standby.cwd,
      launcher: standby.launcher,
      argsKey: standby.argsKey
    };

    standby.pty.onData((data) => {
      if (sessionEntry.alive) {
        const now = Date.now();
        if (sessionEntry.lastDataAt && (now - sessionEntry.lastDataAt) > 5000) {
          sessionEntry.dataBytesSinceIdle = 0;
        }
        sessionEntry.lastDataAt = now;
        sessionEntry.dataBytesSinceIdle += data.length;
        this.emit('data', standby.id, data);
      }
    });

    standby.pty.onExit(({ exitCode }) => this._handleSessionExit(standby.id, sessionEntry, exitCode));

    this.sessions.set(standby.id, sessionEntry);
    return { id: standby.id, bufferedData: standby.bufferedData };
  }

  killAll() {
    if (this._standby && this._standby.alive) {
      try { this._standby.pty.kill(); } catch {}
      this._standby.alive = false;
      this._standby = null;
    }
    for (const [id, entry] of this.sessions) {
      if (entry.alive) {
        try { entry.pty.kill(); } catch {}
      }
    }
    this.sessions.clear();
  }

  getActiveSessions() {
    const result = [];
    for (const [id, entry] of this.sessions) {
      if (entry.alive) {
        result.push({ id, openedAt: entry.openedAt, lastDataAt: entry.lastDataAt || 0 });
      }
    }
    return result;
  }

  /**
   * Returns sessions that are actively producing significant output.
   * A session is "busy" only if it received output within `thresholdMs` AND
   * the current output burst has substantial volume (>500 bytes), which
   * distinguishes AI-generated content from a prompt/cursor redraw.
   */
  getBusySessions(thresholdMs = 5000) {
    const now = Date.now();
    const MIN_BUSY_BYTES = 500;
    const result = [];
    for (const [id, entry] of this.sessions) {
      if (entry.alive && entry.lastDataAt &&
          (now - entry.lastDataAt) < thresholdMs &&
          entry.dataBytesSinceIdle >= MIN_BUSY_BYTES) {
        result.push(id);
      }
    }
    return result;
  }

  /**
   * Kill sessions that haven't produced output within `thresholdMs`.
   * Returns the IDs of sessions that were killed.
   */
  killIdle(thresholdMs = 5000) {
    const now = Date.now();
    const killed = [];
    for (const [id, entry] of this.sessions) {
      if (entry.alive && (!entry.lastDataAt || (now - entry.lastDataAt) >= thresholdMs)) {
        try { entry.pty.kill(); } catch {}
        entry.alive = false;
        this.sessions.delete(id);
        killed.push(id);
      }
    }
    return killed;
  }

  updateSettings(settings, launchSettingsChanged = true) {
    if (!launchSettingsChanged) return;
    this._warmUpGeneration += 1;
    const standby = this._standby;
    if (!standby || !standby.alive) return;

    if (settings?.promptForWorkdir) {
      try { standby.pty.kill(); } catch {}
      standby.alive = false;
      this._standby = null;
      return;
    }

    const expectedLauncher = this._resolveLauncher(settings?.useAgencyCopilot ? 'agency' : 'copilot');
    const expectedCwd = settings?.defaultWorkdir || os.homedir();
    const expectedArgsKey = this._launcherArgsKey(expectedLauncher);
    if (standby.launcher !== expectedLauncher || standby.cwd !== expectedCwd || standby.argsKey !== expectedArgsKey) {
      try { standby.pty.kill(); } catch {}
      standby.alive = false;
      this._standby = null;
    }
  }

  _evictIfNeeded() {
    let alive = [...this.sessions.entries()].filter(([, e]) => e.alive);
    alive.sort((a, b) => a[1].openedAt - b[1].openedAt);
    let i = 0;
    while (alive.length - i >= this.maxConcurrent) {
      const [oldestId, oldestEntry] = alive[i];
      oldestEntry.alive = false;
      this.emit('evicted', oldestId);
      try { oldestEntry.pty.kill(); } catch {}
      this.sessions.delete(oldestId);
      i++;
    }
  }
}

module.exports = PtyManager;
