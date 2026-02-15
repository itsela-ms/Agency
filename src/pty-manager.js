const EventEmitter = require('events');
const pty = require('node-pty');
const crypto = require('crypto');

class PtyManager extends EventEmitter {
  constructor(copilotPath, settingsService) {
    super();
    this.copilotPath = copilotPath;
    this.sessions = new Map();
    this.settingsService = settingsService;
  }

  _generateId() {
    return crypto.randomUUID();
  }

  get maxConcurrent() {
    return this.settingsService?.get().maxConcurrent || 5;
  }

  openSession(sessionId) {
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

    let ptyProcess;
    try {
      ptyProcess = pty.spawn(this.copilotPath, ['--resume', sessionId, '--yolo'], {
        name: 'xterm-256color',
        cols: 120,
        rows: 40,
        cwd: process.env.USERPROFILE,
        env: { ...process.env, TERM: 'xterm-256color' }
      });
    } catch (err) {
      throw new Error(`Failed to spawn PTY for session ${sessionId}: ${err.message}`);
    }

    ptyProcess.onData((data) => {
      const entry = this.sessions.get(sessionId);
      if (entry && entry.alive) this.emit('data', sessionId, data);
    });

    ptyProcess.onExit(({ exitCode }) => {
      const entry = this.sessions.get(sessionId);
      if (entry && entry.alive) {
        entry.alive = false;
        this.emit('exit', sessionId, exitCode);
      }
    });

    this.sessions.set(sessionId, {
      pty: ptyProcess,
      alive: true,
      openedAt: Date.now()
    });

    return sessionId;
  }

  newSession() {
    const sessionId = this._generateId();

    this._evictIfNeeded();

    let ptyProcess;
    try {
      ptyProcess = pty.spawn(this.copilotPath, ['--resume', sessionId, '--yolo'], {
        name: 'xterm-256color',
        cols: 120,
        rows: 40,
        cwd: process.env.USERPROFILE,
        env: { ...process.env, TERM: 'xterm-256color' }
      });
    } catch (err) {
      throw new Error(`Failed to spawn PTY for session ${sessionId}: ${err.message}`);
    }

    ptyProcess.onData((data) => {
      const entry = this.sessions.get(sessionId);
      if (entry && entry.alive) this.emit('data', sessionId, data);
    });

    ptyProcess.onExit(({ exitCode }) => {
      const entry = this.sessions.get(sessionId);
      if (entry && entry.alive) {
        entry.alive = false;
        this.emit('exit', sessionId, exitCode);
      }
    });

    this.sessions.set(sessionId, {
      pty: ptyProcess,
      alive: true,
      openedAt: Date.now()
    });

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

  killAll() {
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
        result.push({ id, openedAt: entry.openedAt });
      }
    }
    return result;
  }

  updateSettings(settings) {
    // Settings are persisted by SettingsService; just evict if needed
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
