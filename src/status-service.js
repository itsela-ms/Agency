const fs = require('fs');
const path = require('path');
const readline = require('readline');
const yaml = require('js-yaml');
const { execFile } = require('child_process');
const { promisify } = require('util');
const { readPreferredSessionCwd } = require('./session-cwd');

const MAX_NEXT_STEP_WORDS = 6;
const TRAILING_FILLER_WORDS = new Set(['a', 'an', 'and', 'by', 'for', 'from', 'in', 'of', 'on', 'or', 'the', 'to', 'with']);
const STATUS_CACHE_TTL_MS = 2000;

class StatusService {
  constructor(sessionStateDir, deps = {}) {
    this.sessionStateDir = sessionStateDir;
    this.cache = new Map(); // sessionId → { data, mtimeMs, readAt }
    this._execFile = deps.execFile || promisify(execFile);
  }

  invalidateSession(sessionId) {
    this.cache.delete(sessionId);
  }

  async getSessionStatus(sessionId) {
    if (
      typeof sessionId !== 'string' ||
      !sessionId.trim() ||
      path.basename(sessionId) !== sessionId ||
      sessionId.includes('..')
    ) {
      return { intent: null, summary: null, nextSteps: [], files: [], generatedFiles: [], timeline: [] };
    }
    const sessionDir = path.join(this.sessionStateDir, sessionId);
    try {
      const fingerprint = await this._readStatusFingerprint(sessionDir);
      const cached = this.cache.get(sessionId);
      if (cached &&
          cached.fingerprint === fingerprint &&
          (Date.now() - cached.readAt) < STATUS_CACHE_TTL_MS) {
        return cached.data;
      }

      const [intent, summary, nextSteps, files, generatedFiles, timeline] = await Promise.all([
        this._readIntent(sessionDir),
        this._readSummary(sessionDir),
        this._readPlan(sessionDir),
        this._readFiles(sessionDir),
        this._readGeneratedFiles(sessionDir),
        this._readTimeline(sessionDir),
      ]);

      const data = { intent, summary, nextSteps, files, generatedFiles, timeline };
      this.cache.set(sessionId, { data, fingerprint, readAt: Date.now() });
      return data;
    } catch {
      return { intent: null, summary: null, nextSteps: [], files: [], generatedFiles: [], timeline: [] };
    }
  }

  async _readStatusFingerprint(sessionDir) {
    const parts = [];
    for (const relativePath of ['', 'events.jsonl', 'plan.md', 'session-summary.md', 'workspace.yaml', '.deepsky-cwd']) {
      try {
        const stat = await fs.promises.stat(path.join(sessionDir, relativePath));
        parts.push(`${relativePath}:${stat.mtimeMs}:${stat.size}`);
      } catch {
        parts.push(`${relativePath}:missing`);
      }
    }
    return parts.join('|');
  }

  /**
   * Read the latest report_intent from the tail of events.jsonl.
   * Scans the last ~100 lines for the most recent tool.execution_complete
   * where detailedContent looks like an intent string (short, from report_intent tool).
   */
  async _readIntent(sessionDir) {
    const eventsPath = path.join(sessionDir, 'events.jsonl');
    try { await fs.promises.access(eventsPath); } catch { return null; }

    // Read tail of file efficiently
    const stat = await fs.promises.stat(eventsPath);
    const readSize = Math.min(stat.size, 64 * 1024); // last 64KB
    const buf = Buffer.alloc(readSize);
    const fh = await fs.promises.open(eventsPath, 'r');
    await fh.read(buf, 0, readSize, stat.size - readSize);
    await fh.close();

    const lines = buf.toString('utf8').split('\n').filter(Boolean);
    let latestIntent = null;

    for (let i = lines.length - 1; i >= 0; i--) {
      try {
        const event = JSON.parse(lines[i]);
        if (event.type === 'tool.execution_complete' && event.data?.result?.detailedContent) {
          const content = event.data.result.detailedContent;
          // report_intent tool always returns "Intent logged" in content,
          // with the actual intent text in detailedContent
          if (event.data.result.content === 'Intent logged') {
            latestIntent = content;
            break;
          }
        }
      } catch { /* skip malformed lines */ }
    }

    return latestIntent;
  }

  /**
   * Read session summary from multiple sources in priority order:
   * 1. session-summary.md → Summary section
   * 2. Latest checkpoint → <overview> tag
   * 3. workspace.yaml → summary field
   */
  async _readSummary(sessionDir) {
    // 1. session-summary.md
    try {
      const content = await fs.promises.readFile(path.join(sessionDir, 'session-summary.md'), 'utf8');
      const extractedSummary = this._extractSummarySection(content);
      const normalizedSummary = this._normalizeSummaryText(extractedSummary);
      if (normalizedSummary) {
        return { text: normalizedSummary, source: 'session-summary' };
      }
    } catch {}

    // 2. Latest checkpoint
    try {
      const checkpointDir = path.join(sessionDir, 'checkpoints');
      const files = await fs.promises.readdir(checkpointDir);
      const mdFiles = files.filter(f => f.endsWith('.md') && f !== 'index.md').sort();
      if (mdFiles.length > 0) {
        const latest = await fs.promises.readFile(path.join(checkpointDir, mdFiles[mdFiles.length - 1]), 'utf8');
        const overviewMatch = latest.match(/<overview>\s*([\s\S]*?)\s*<\/overview>/);
        if (overviewMatch) {
          const normalizedSummary = this._normalizeSummaryText(overviewMatch[1]);
          if (normalizedSummary) {
            return { text: normalizedSummary, source: 'checkpoint' };
          }
        }
      }
    } catch {}

    // 3. workspace.yaml summary
    try {
      const yaml = await fs.promises.readFile(path.join(sessionDir, 'workspace.yaml'), 'utf8');
      const match = yaml.match(/^summary:\s*(.+)$/m);
      if (match && match[1].trim()) {
        const normalizedSummary = this._normalizeSummaryText(match[1]);
        if (normalizedSummary) {
          return { text: normalizedSummary, source: 'workspace' };
        }
      }
    } catch {}

    return null;
  }

  _extractSummarySection(content) {
    const markdownMatch = content.match(/## Summary\s*\n([\s\S]*?)(?=\n## |$)/i);
    if (markdownMatch?.[1]) {
      return markdownMatch[1].trim();
    }

    const labeledMatch = content.match(/^Summary:\s*([\s\S]*?)(?=\n\s*(?:Key Context|Resume Prompt):|\s*$)/i);
    if (labeledMatch?.[1]) {
      return labeledMatch[1].trim();
    }

    const body = content.replace(/^#[^\n]*\n/, '').trim();
    return body;
  }

  _normalizeSummaryText(content) {
    const cleaned = String(content || '')
      .replace(/`([^`]+)`/g, '$1')
      .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1')
      .replace(/^[*-]\s+/gm, '')
      .replace(/\s+/g, ' ')
      .trim();

    if (!cleaned) return '';

    const sentences = cleaned
      .split(/(?<=[.!?])\s+/)
      .map(sentence => sentence.trim())
      .filter(Boolean);

    const selected = sentences.length > 0 ? sentences.slice(0, 2).join(' ') : cleaned;
    if (selected.length <= 220) {
      return selected;
    }

    const shortened = selected.slice(0, 217).replace(/\s+\S*$/, '').trim();
    if (!shortened) return selected.slice(0, 220).trim();
    return /[.!?]$/.test(shortened) ? shortened : `${shortened}.`;
  }

  /**
   * Parse plan.md for todo items (markdown checkboxes).
   * Returns array of { text, done, current }.
   */
  async _readPlan(sessionDir) {
    try {
      const content = await fs.promises.readFile(path.join(sessionDir, 'plan.md'), 'utf8');
      const items = [];
      const lines = content.split('\n');
      let foundFirstUnchecked = false;

      for (const line of lines) {
        const doneMatch = line.match(/^\s*[-*]\s+\[x\]\s+(.+)/i);
        const todoMatch = line.match(/^\s*[-*]\s+\[\s?\]\s+(.+)/);

        if (doneMatch) {
          const text = this._summarizeNextStep(doneMatch[1]);
          if (text) {
            items.push({ text, done: true, current: false });
          }
        } else if (todoMatch) {
          const text = this._summarizeNextStep(todoMatch[1]);
          if (!text) continue;

          const isCurrent = !foundFirstUnchecked;
          foundFirstUnchecked = true;
          items.push({ text, done: false, current: isCurrent });
        }
      }

      // If no checkboxes found, try numbered list items (1. ... 2. ...)
      if (items.length === 0) {
        const numberedRe = /^\s*(\d+)\.\s+\*\*(.+?)\*\*\s*[-—]?\s*(.*)/;
        for (const line of lines) {
          const m = line.match(numberedRe);
          if (m) {
            const text = this._summarizeNextStep(m[2]);
            if (text) {
              items.push({ text, done: false, current: items.length === 0 });
            }
          }
        }
      }

      return items;
    } catch {
      return [];
    }
  }

  _summarizeNextStep(text) {
    const cleaned = String(text || '')
      .replace(/`+/g, '')
      .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1')
      .replace(/[^\p{L}\p{N}\p{M}\s_-]/gu, ' ')
      .replace(/\s+/g, ' ')
      .trim();

    if (!cleaned) return '';

    const words = cleaned.split(' ').filter(Boolean);
    if (words.length <= MAX_NEXT_STEP_WORDS) {
      return cleaned;
    }

    const shortened = words.slice(0, MAX_NEXT_STEP_WORDS);
    while (shortened.length > 1 && TRAILING_FILLER_WORDS.has(shortened[shortened.length - 1].toLowerCase())) {
      shortened.pop();
    }

    return shortened.join(' ');
  }

  async _readFiles(sessionDir) {
    const cwd = await this._readSessionCwd(sessionDir);
    if (!cwd) return [];

    try {
      const { stdout: rootStdout } = await this._execFile('git', ['rev-parse', '--show-toplevel'], { cwd });
      const repoRoot = String(rootStdout || '').trim();
      const sessionPaths = await this._readSessionTouchedGitPaths(sessionDir, repoRoot, cwd);
      if (sessionPaths.size === 0) return [];

      const { stdout } = await this._execFile('git', ['status', '--porcelain=v1', '-z', '--untracked-files=all'], { cwd });
      const files = this._parseGitStatusOutput(stdout)
        .filter(file => file && this._hasSessionTouchedGitPath(file, sessionPaths));
      return Promise.all(files.map(async (file) => {
        const { originalPath, ...visibleFile } = file;
        return {
          ...visibleFile,
          diff: await this._readFileDiffPreview(repoRoot || cwd, file),
        };
      }));
    } catch {
      return [];
    }
  }

  async _readFileDiffPreview(cwd, file) {
    const normalizedPath = String(file?.path || '').trim();
    if (!normalizedPath) return '';

    const commands = [];
    switch (file.action) {
      case 'A':
        commands.push(['diff', '--no-ext-diff', '--cached', '--', normalizedPath]);
        break;
      case 'R':
        commands.push(['diff', '--no-ext-diff', '--cached', '--find-renames', '--', normalizedPath]);
        commands.push(['diff', '--no-ext-diff', '--find-renames', '--', normalizedPath]);
        break;
      case 'D':
      case 'M':
      default:
        commands.push(['diff', '--no-ext-diff', '--', normalizedPath]);
        commands.push(['diff', '--no-ext-diff', '--cached', '--', normalizedPath]);
        break;
    }

    for (const args of commands) {
      try {
        const { stdout } = await this._execFile('git', args, { cwd, maxBuffer: 1024 * 1024 });
        const preview = this._normalizeDiffPreview(stdout);
        if (preview) return preview;
      } catch {
        // Try the next git diff variant.
      }
    }

    if (file.action === 'A') return 'New file (no diff preview available yet)';
    if (file.action === 'D') return 'Deleted file (no diff preview available)';
    return '';
  }

  async _readSessionTouchedGitPaths(sessionDir, repoRoot, fallbackCwd) {
    const eventsPath = path.join(sessionDir, 'events.jsonl');
    try { await fs.promises.access(eventsPath); } catch { return new Set(); }

    const normalizedRepoRoot = this._normalizeAbsolutePath(repoRoot);
    if (!normalizedRepoRoot) return new Set();

    return new Promise((resolve) => {
      const paths = new Set();
      const stream = fs.createReadStream(eventsPath, { encoding: 'utf8' });
      const rl = readline.createInterface({ input: stream, crlfDelay: Infinity });

      rl.on('line', (line) => {
        let event;
        try { event = JSON.parse(line); } catch { return; }

        const input = event?.type === 'hook.start' && event.data?.hookType === 'postToolUse'
          ? event.data?.input
          : null;
        if (!input || !this._isFileMutationToolEvent(input)) return;

        try {
          const eventCwd = typeof input.cwd === 'string' && input.cwd.trim() ? input.cwd : fallbackCwd;
          for (const filePath of this._extractMutatedFilePaths(input)) {
            const relativePath = this._toRepoRelativePath(filePath, normalizedRepoRoot, eventCwd);
            if (relativePath) paths.add(this._gitPathKey(relativePath));
          }
        } catch {
          // Ignore malformed historical events; status should remain best-effort.
        }
      });

      rl.on('close', () => resolve(paths));
      rl.on('error', () => resolve(paths));
      stream.on('error', () => resolve(paths));
    });
  }

  _isFileMutationToolEvent(input) {
    if (input?.toolResult?.resultType !== 'success') {
      return false;
    }

    const toolName = String(input?.toolName || '');
    if (toolName === 'apply_patch' || toolName === 'edit' || toolName === 'create' || toolName === 'multi_edit') {
      return true;
    }

    const metrics = input?.toolResult?.toolTelemetry?.metrics || {};
    const linesAdded = Number(metrics.linesAdded || 0);
    const linesRemoved = Number(metrics.linesRemoved || 0);
    return linesAdded > 0 || linesRemoved > 0;
  }

  _extractMutatedFilePaths(input) {
    const paths = [];
    const restricted = input?.toolResult?.toolTelemetry?.restrictedProperties || {};
    for (const key of ['filePaths', 'addedPaths', 'deletedPaths']) {
      paths.push(...this._parsePathArrayProperty(restricted[key]));
    }

    const toolArgs = String(input?.toolArgs || '');
    const patchPathRe = /^\*\*\* (?:Update|Add|Delete) File: (.+)$|^\*\*\* Move to: (.+)$/gm;
    let match;
    while ((match = patchPathRe.exec(toolArgs)) !== null) {
      const filePath = (match[1] || match[2] || '').trim();
      if (filePath) paths.push(filePath);
    }

    return paths;
  }

  _parsePathArrayProperty(value) {
    if (Array.isArray(value)) {
      return value.filter(item => typeof item === 'string' && item.trim());
    }
    if (typeof value !== 'string' || !value.trim()) return [];

    try {
      const parsed = JSON.parse(value);
      return Array.isArray(parsed)
        ? parsed.filter(item => typeof item === 'string' && item.trim())
        : [];
    } catch {
      return [];
    }
  }

  _toRepoRelativePath(filePath, repoRoot, eventCwd) {
    const normalizedPath = String(filePath || '').trim();
    if (!normalizedPath) return '';

    const pathApi = this._pathApiFor(repoRoot, normalizedPath, eventCwd);
    const absolutePath = this._isAbsoluteFsPath(normalizedPath)
      ? normalizedPath
      : pathApi.resolve(eventCwd || repoRoot, normalizedPath);
    const relative = pathApi.relative(repoRoot, absolutePath);
    if (!relative || relative.startsWith('..') || this._isAbsoluteFsPath(relative)) return '';
    return this._normalizeGitPath(relative);
  }

  _normalizeAbsolutePath(filePath) {
    const normalizedPath = String(filePath || '').trim();
    if (!normalizedPath) return '';
    return this._pathApiFor(normalizedPath).resolve(normalizedPath);
  }

  _pathApiFor(...paths) {
    return paths.some(value => /^[A-Za-z]:[\\/]/.test(String(value || ''))) ? path.win32 : path;
  }

  _isAbsoluteFsPath(filePath) {
    const normalizedPath = String(filePath || '');
    return path.isAbsolute(normalizedPath) || /^[A-Za-z]:[\\/]/.test(normalizedPath);
  }

  _normalizeGitPath(filePath) {
    return String(filePath || '')
      .replace(/\\/g, '/')
      .replace(/^\.\//, '')
      .trim();
  }

  _gitPathKey(filePath) {
    const normalizedPath = this._normalizeGitPath(filePath);
    return process.platform === 'win32' ? normalizedPath.toLowerCase() : normalizedPath;
  }

  _hasSessionTouchedGitPath(file, sessionPaths) {
    return sessionPaths.has(this._gitPathKey(file.path)) ||
      (file.originalPath && sessionPaths.has(this._gitPathKey(file.originalPath)));
  }

  _normalizeDiffPreview(diffText) {
    const text = String(diffText || '').trim();
    if (!text) return '';

    const lines = text.split(/\r?\n/);
    const maxLines = 40;
    const maxChars = 4000;
    const clippedLines = lines.slice(0, maxLines);
    let preview = clippedLines.join('\n');
    if (preview.length > maxChars) {
      preview = `${preview.slice(0, maxChars - 1)}…`;
    } else if (lines.length > maxLines) {
      preview += '\n…';
    }
    return preview;
  }

  async _readGeneratedFiles(sessionDir) {
    const filesDir = path.join(sessionDir, 'files');
    try {
      await fs.promises.access(filesDir);
    } catch {
      return [];
    }

    const entries = [];
    const walk = async (dir) => {
      const children = await fs.promises.readdir(dir, { withFileTypes: true });
      for (const child of children) {
        const childPath = path.join(dir, child.name);
        if (child.isSymbolicLink()) {
          continue;
        }
        if (child.isDirectory()) {
          await walk(childPath);
          continue;
        }
        if (!child.isFile()) continue;
        const stat = await fs.promises.stat(childPath);
        const ext = path.extname(child.name).replace(/^\./, '').toLowerCase();
        if (!['html', 'htm', 'pdf'].includes(ext)) continue;
        const relativePath = path.relative(sessionDir, childPath).replace(/\\/g, '/');
        entries.push({
          name: child.name,
          path: relativePath,
          ext,
          modifiedAt: stat.mtime.toISOString(),
          size: stat.size,
        });
      }
    };

    try {
      await walk(filesDir);
    } catch {
      return [];
    }

    const priority = (ext) => {
      if (ext === 'html' || ext === 'htm') return 0;
      if (ext === 'pdf') return 1;
      return 2;
    };

    entries.sort((a, b) => {
      const byPriority = priority(a.ext) - priority(b.ext);
      if (byPriority !== 0) return byPriority;
      return new Date(b.modifiedAt).getTime() - new Date(a.modifiedAt).getTime();
    });

    return entries;
  }

  async _readSessionCwd(sessionDir) {
    return readPreferredSessionCwd(sessionDir);
  }

  _parseGitStatusOutput(stdout) {
    const text = String(stdout || '');
    if (text.includes('\0')) {
      return this._parseGitStatusNullDelimited(text);
    }

    return text
      .split(/\r?\n/)
      .map(line => line.trimEnd())
      .filter(Boolean)
      .map(line => this._parseGitStatusLine(line))
      .filter(Boolean);
  }

  _parseGitStatusNullDelimited(stdout) {
    const records = String(stdout || '').split('\0').filter(Boolean);
    const files = [];

    for (let i = 0; i < records.length; i++) {
      const record = records[i];
      if (record.length < 4) continue;

      const x = record[0];
      const y = record[1];
      const action = this._mapGitAction(x, y);
      if (!action) continue;

      const pathText = record.slice(3);
      const file = {
        path: this._normalizeGitPath(pathText),
        action,
      };

      if (x === 'R' || y === 'R' || x === 'C' || y === 'C') {
        const originalPath = records[i + 1] || '';
        if (originalPath) {
          file.originalPath = this._normalizeGitPath(originalPath);
          i += 1;
        }
      }

      files.push(file);
    }

    return files;
  }

  _parseGitStatusLine(line) {
    if (line.startsWith('?? ')) {
      return { path: this._normalizeGitPath(this._decodeGitStatusPath(line.slice(3))), action: 'A' };
    }

    if (line.length < 4) return null;
    const x = line[0];
    const y = line[1];
    const rawPath = line.slice(3).trim();
    const parts = rawPath.includes(' -> ') ? rawPath.split(' -> ') : null;
    const pathText = this._decodeGitStatusPath(parts ? parts[parts.length - 1].trim() : rawPath);
    const originalPath = parts ? this._decodeGitStatusPath(parts[0].trim()) : '';
    const action = this._mapGitAction(x, y);
    if (!pathText || !action) return null;
    return {
      path: this._normalizeGitPath(pathText),
      action,
      ...(originalPath ? { originalPath: this._normalizeGitPath(originalPath) } : {}),
    };
  }

  _mapGitAction(x, y) {
    if (x === 'D' || y === 'D') return 'D';
    if (x === 'R' || y === 'R') return 'R';
    if (x === 'A' || y === 'A' || x === '?' || y === '?') return 'A';
    if (x === 'C' || y === 'C') return 'A';
    if (x === 'M' || y === 'M') return 'M';
    return null;
  }

  _decodeGitStatusPath(filePath) {
    const text = String(filePath || '');
    if (!(text.startsWith('"') && text.endsWith('"'))) {
      return text;
    }

    try {
      return JSON.parse(text);
    } catch {
      return text.slice(1, -1);
    }
  }

  /**
   * Extract key timeline events from events.jsonl.
   * Returns array of { time, type, text } (newest first, max 20).
   */
  async _readTimeline(sessionDir) {
    const eventsPath = path.join(sessionDir, 'events.jsonl');
    try { await fs.promises.access(eventsPath); } catch { return []; }

    const events = [];

    return new Promise((resolve) => {
      const stream = fs.createReadStream(eventsPath, { encoding: 'utf8' });
      const rl = readline.createInterface({ input: stream, crlfDelay: Infinity });
      let userMsgCount = 0;

      rl.on('line', (line) => {
        try {
          const event = JSON.parse(line);
          const ts = event.timestamp;
          if (!ts) return;

          switch (event.type) {
            case 'session.start':
              events.push({ time: ts, type: 'start', text: 'Session started' });
              break;
            case 'session.resume':
              events.push({ time: ts, type: 'resume', text: 'Session resumed' });
              break;
            case 'user.message':
              userMsgCount++;
              if (userMsgCount <= 10) {
                const content = (event.data?.content || '').trim().split('\n')[0];
                const preview = content.length > 60 ? content.substring(0, 57) + '...' : content;
                events.push({ time: ts, type: 'user', text: preview });
              }
              break;
            case 'session.plan_changed':
              events.push({ time: ts, type: 'plan', text: `Plan ${event.data?.operation || 'updated'}` });
              break;
            case 'subagent.started':
              events.push({ time: ts, type: 'agent', text: `Sub-agent started: ${event.data?.description || 'task'}` });
              break;
            case 'subagent.completed':
              events.push({ time: ts, type: 'agent', text: 'Sub-agent completed' });
              break;
          }
        } catch { /* skip */ }
      });

      rl.on('close', () => {
        // Reverse for newest-first, cap at 20
        resolve(events.reverse().slice(0, 20));
      });
      rl.on('error', () => resolve([]));
    });
  }
}

module.exports = StatusService;
