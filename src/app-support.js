const fs = require('fs');
const path = require('path');
const SAFE_COMMAND_NAME_RE = /^[a-zA-Z0-9._-]+$/;
const UNSAFE_ARG_CHARS_RE = /[\0\r\n&|<>^]/;
const SESSION_BREAKING_LAUNCHER_ARGS = new Set([
  '--',
  '--mcp',
  '-p',
  '--prompt',
  '-i',
  '--interactive',
  '-r',
  '--resume',
  '--continue',
  '--connect',
  '--session-id',
]);

// Module-level cache for CLI path probes. resolveAgency/Copilot are called
// on every settings:get, every session creation, and every warm-up — which
// fires from pty:kill, so each Ctrl+W used to run 2x execSync('where ...').
// Beyond the perf cost (~30–60ms per shellout on Windows), the synchronous
// `where` child can EPIPE if its stdin pipe closes before Node finishes
// closing the parent end, surfacing as an "Uncaught Exception" dialog.
// These paths essentially never change while the app is running, so cache
// the result for the process lifetime. Test paths inject `deps`, which
// bypasses the cache entirely.
const _commandPathCache = new Map();
function _clearCommandPathCache() { _commandPathCache.clear(); }

// Cached login-shell PATH on macOS. Apps launched from Finder/Dock get the
// minimal launchd PATH (`/usr/bin:/bin:/usr/sbin:/sbin`) which is missing
// `/opt/homebrew/bin`, `~/.local/bin`, `$(npm prefix -g)/bin`, asdf/nvm/volta
// shims — i.e. exactly where users actually install the copilot CLI. So once,
// at startup, we shell out to the user's login shell and ask it to print PATH
// after their dotfiles have run. Result is stored here and used by
// buildAugmentedPath().
let _loginShellPath = null;
let _loginShellPathProbed = false;
function _clearLoginShellPathCache() {
  _loginShellPath = null;
  _loginShellPathProbed = false;
}

function isValidSessionId(sessionId) {
  return typeof sessionId === 'string' && /^[0-9a-f-]{36}$/i.test(sessionId);
}

function resolveCommandPath({
  names,
  candidates,
  fallbackCommand,
  execSyncImpl,
  existsSync = fs.existsSync,
  platform = process.platform,
}) {
  // On Windows we use `where <bin>`; on POSIX (darwin/linux) we use `command -v <bin>`
  // via /bin/sh so we don't depend on the user's shell. Both swallow exit code 1
  // (not-found) via try/catch.
  const isWin = platform === 'win32';
  for (const bin of names) {
    if (!SAFE_COMMAND_NAME_RE.test(bin)) continue;
    try {
      // stdio: ['ignore', 'pipe', 'ignore'] removes the stdin pipe entirely,
      // which is what was EPIPE-ing on Windows when cmd.exe closed before
      // Node's parent-side cleanup wrote its end-of-stream marker. The empty
      // try/catch above only catches synchronous throws — the EPIPE was
      // surfacing as an Electron uncaughtException dialog.
      const cmd = isWin
        ? `where ${bin}`
        // /bin/sh -c "command -v <bin>" is POSIX, prints absolute path on stdout
        // for executable on PATH, exits 1 if not found. We pipe through `head -n 1`
        // for parity with the where-style "first hit only" behavior.
        : `/bin/sh -c 'command -v ${bin} 2>/dev/null | head -n 1'`;
      const result = execSyncImpl(cmd, {
        encoding: 'utf8',
        timeout: 5000,
        stdio: ['ignore', 'pipe', 'ignore'],
      }).trim();
      const firstMatch = result.split(/\r?\n/)[0];
      if (firstMatch && existsSync(firstMatch)) {
        return { path: firstMatch, found: true };
      }
    } catch {}
  }

  for (const candidate of candidates) {
    if (candidate && existsSync(candidate)) {
      return { path: candidate, found: true };
    }
  }

  return { path: fallbackCommand, found: false };
}

function _pathDelimiter(platform) {
  return platform === 'win32' ? ';' : ':';
}

function _splitPathEntries(value, platform = process.platform) {
  return String(value || '')
    .split(_pathDelimiter(platform))
    .map(part => part.trim())
    .filter(Boolean);
}

function mergePathEntries(paths, platform = process.platform) {
  const seen = new Set();
  const merged = [];
  for (const value of paths) {
    for (const entry of _splitPathEntries(value, platform)) {
      const key = platform === 'win32' ? entry.toLowerCase() : entry;
      if (seen.has(key)) continue;
      seen.add(key);
      merged.push(entry);
    }
  }
  return merged.join(_pathDelimiter(platform));
}

function expandWindowsEnvVars(value, env = process.env) {
  return String(value || '').replace(/%([^%]+)%/g, (match, name) => {
    const foundKey = Object.keys(env).find(key => key.toLowerCase() === String(name).toLowerCase());
    return foundKey ? env[foundKey] : match;
  });
}

function _parseRegistryPathValue(output) {
  const text = String(output || '');
  const line = text.split(/\r?\n/).find(row => /\bPath\b/i.test(row) && /\bREG_(?:EXPAND_)?SZ\b/i.test(row));
  if (!line) return '';
  const match = line.match(/\bREG_(?:EXPAND_)?SZ\b\s+(.+)$/i);
  return match ? match[1].trim() : '';
}

function readWindowsPersistedPath(deps = {}) {
  const platform = deps.platform || process.platform;
  if (platform !== 'win32') return { userPath: '', machinePath: '' };
  if (typeof deps.readWindowsPersistedPath === 'function') {
    return deps.readWindowsPersistedPath();
  }
  const execFileSync = deps.execFileSync || (!deps.execSync ? require('child_process').execFileSync : null);
  if (!execFileSync) return { userPath: '', machinePath: '' };
  const env = deps.env || process.env;
  const pathApi = path.win32;
  const windowsDir = pathApi.isAbsolute(env.SystemRoot || '') ? env.SystemRoot
    : pathApi.isAbsolute(env.windir || '') ? env.windir
      : 'C:\\Windows';
  const regExe = pathApi.join(windowsDir, 'System32', 'reg.exe');
  const query = (key) => {
    try {
      return _parseRegistryPathValue(execFileSync(regExe, ['query', key, '/v', 'Path'], {
        encoding: 'utf8',
        timeout: 5000,
        stdio: ['ignore', 'pipe', 'ignore'],
      }));
    } catch {
      return '';
    }
  };
  return {
    userPath: query('HKCU\\Environment'),
    machinePath: query('HKLM\\SYSTEM\\CurrentControlSet\\Control\\Session Manager\\Environment'),
  };
}

function refreshWindowsProcessPath(deps = {}) {
  const platform = deps.platform || process.platform;
  const env = deps.env || process.env;
  if (platform !== 'win32') return { mutated: false, before: env.PATH || '', after: env.PATH || '' };
  const before = env.PATH || '';
  const { userPath, machinePath } = readWindowsPersistedPath({ ...deps, env, platform });
  const expandedUserPath = expandWindowsEnvVars(userPath, env);
  const expandedMachinePath = expandWindowsEnvVars(machinePath, env);
  const after = mergePathEntries([before, expandedUserPath, expandedMachinePath], platform);
  if (after && after !== before) {
    env.PATH = after;
    env.Path = after;
    return { mutated: true, before, after };
  }
  return { mutated: false, before, after: before };
}

function _macPosixCandidates(env, binName) {
  // Order matters: probe the locations most likely to hold a real, working
  // binary first so we exit early and skip slower disk checks.
  // /opt/homebrew/bin is Apple-Silicon Homebrew, /usr/local/bin is Intel
  // Homebrew + npm-global default, ~/.local/bin is the install-script default
  // for non-root users (`gh.io/copilot-install`).
  // Use path.posix.join so this produces forward-slash paths even when the
  // unit tests run on Windows (path.join would emit /Users\dev\.local\bin/...).
  const home = env.HOME || '';
  return [
    `/opt/homebrew/bin/${binName}`,
    `/usr/local/bin/${binName}`,
    home ? path.posix.join(home, '.local', 'bin', binName) : '',
    `/usr/bin/${binName}`,
  ];
}

function resolveCopilotPath(deps = {}) {
  return resolveCopilotInfo(deps).path;
}

function resolveCopilotInfo(deps = {}) {
  const cacheable = deps._cacheable === true
    || (!deps.execSync && !deps.existsSync && !deps.env);
  if (cacheable && _commandPathCache.has('copilot')) {
    return _commandPathCache.get('copilot');
  }
  const { execSync } = deps.execSync ? deps : require('child_process');
  const env = deps.env || process.env;
  const platform = deps.platform || process.platform;

  let names;
  let candidates;
  if (platform === 'win32') {
    names = ['copilot.exe', 'copilot.cmd'];
    candidates = [
      path.join(env.LOCALAPPDATA || '', 'Microsoft', 'WinGet', 'Links', 'copilot.exe'),
      path.join(env.LOCALAPPDATA || '', 'Programs', 'copilot-cli', 'copilot.exe'),
      path.join(env.PROGRAMFILES || '', 'GitHub Copilot CLI', 'copilot.exe'),
    ];
  } else {
    names = ['copilot'];
    candidates = _macPosixCandidates(env, 'copilot');
  }

  let result = resolveCommandPath({
    names,
    candidates,
    fallbackCommand: 'copilot',
    execSyncImpl: execSync,
    existsSync: deps.existsSync || fs.existsSync,
    platform,
  });
  if (!result.found && platform === 'win32' && !deps._skipWindowsPathRefresh) {
    refreshWindowsProcessPath({ ...deps, env, platform });
    result = resolveCommandPath({
      names,
      candidates,
      fallbackCommand: 'copilot',
      execSyncImpl: execSync,
      existsSync: deps.existsSync || fs.existsSync,
      platform,
    });
    if (result.found) result.recoveredFromPathRefresh = true;
  }
  if (cacheable && result.found) _commandPathCache.set('copilot', result);
  return result;
}

function resolveAgencyInfo(deps = {}) {
  const cacheable = !deps.execSync && !deps.existsSync && !deps.env;
  if (cacheable && _commandPathCache.has('agency')) {
    return _commandPathCache.get('agency');
  }
  const { execSync } = deps.execSync ? deps : require('child_process');
  const env = deps.env || process.env;
  const platform = deps.platform || process.platform;

  let names;
  let candidates;
  if (platform === 'win32') {
    names = [];
    candidates = [
      path.join(env.APPDATA || '', 'agency', 'CurrentVersion', 'agency.exe'),
      path.join(env.LOCALAPPDATA || '', 'agency', 'CurrentVersion', 'agency.exe'),
    ];
  } else {
    names = ['agency'];
    candidates = _macPosixCandidates(env, 'agency');
  }

  const result = resolveCommandPath({
    names,
    candidates,
    fallbackCommand: 'agency',
    execSyncImpl: execSync,
    existsSync: deps.existsSync || fs.existsSync,
    platform,
  });
  if (cacheable) _commandPathCache.set('agency', result);
  return result;
}

function parseLauncherArgs(value = '') {
  if (typeof value !== 'string') {
    throw new Error('Custom launcher arguments must be a string.');
  }

  const args = [];
  let current = '';
  let quote = null;
  let tokenStarted = false;

  for (const ch of value.trim()) {
    if (quote) {
      if (ch === quote) {
        quote = null;
      } else {
        current += ch;
      }
      tokenStarted = true;
      continue;
    }

    if (ch === '"' || ch === "'") {
      quote = ch;
      tokenStarted = true;
      continue;
    }

    if (/\s/.test(ch)) {
      if (tokenStarted) {
        args.push(current);
        current = '';
        tokenStarted = false;
      }
      continue;
    }

    current += ch;
    tokenStarted = true;
  }

  if (quote) {
    throw new Error('Custom launcher arguments contain an unclosed quote.');
  }
  if (tokenStarted) args.push(current);

  for (const arg of args) {
    if (UNSAFE_ARG_CHARS_RE.test(arg)) {
      throw new Error('Custom launcher arguments cannot contain shell control characters.');
    }
    const flag = arg.includes('=') ? arg.slice(0, arg.indexOf('=')) : arg;
    if (SESSION_BREAKING_LAUNCHER_ARGS.has(flag)) {
      throw new Error(`Custom launcher arguments cannot include ${flag}; it changes or prevents DeepSky's new interactive session creation.`);
    }
  }

  return args;
}

// Probe the user's login shell PATH on macOS. Cached for process lifetime.
// `execSync` injectable for tests; returns the PATH string (may be empty),
// or null if probing isn't applicable / failed.
function getLoginShellPath(deps = {}) {
  const platform = deps.platform || process.platform;
  if (platform !== 'darwin') return null;
  if (_loginShellPathProbed && !deps.execSync) return _loginShellPath;

  const { execSync } = deps.execSync ? deps : require('child_process');
  const env = deps.env || process.env;
  const shell = env.SHELL || '/bin/zsh';
  // Only allow well-known shells — we're piping this into a shell invocation
  // so resist any chance of injection via $SHELL.
  const ALLOWED_SHELLS = new Set([
    '/bin/zsh', '/bin/bash', '/bin/sh', '/bin/dash', '/bin/ksh',
    '/usr/local/bin/zsh', '/usr/local/bin/bash',
    '/opt/homebrew/bin/zsh', '/opt/homebrew/bin/bash',
  ]);
  const safeShell = ALLOWED_SHELLS.has(shell) ? shell : '/bin/zsh';
  let result = null;
  try {
    const out = execSync(`${safeShell} -l -c 'printf %s "$PATH"'`, {
      encoding: 'utf8',
      timeout: 5000,
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    result = (out || '').trim() || null;
  } catch {
    result = null;
  }
  if (!deps.execSync) {
    _loginShellPath = result;
    _loginShellPathProbed = true;
  }
  return result;
}

// Compose an augmented PATH for spawning subprocesses on macOS. Prepends the
// user's login-shell PATH and known install dirs so spawned children can
// always find `copilot`, `node`, `git`, `brew` etc. — even when the app was
// launched from Finder/Dock with the minimal launchd PATH. No-op on Windows
// (PATH is already correct there) and on Linux (where Finder-equivalent
// launchers tend to inherit a usable PATH; user can install copilot to
// /usr/local/bin/ or ~/.local/bin/ both already standard).
function buildAugmentedPath(currentPath, deps = {}) {
  const platform = deps.platform || process.platform;
  if (platform !== 'darwin') return currentPath || '';

  const env = deps.env || process.env;
  const sep = ':';
  const segments = [];
  const loginPath = getLoginShellPath({ ...deps, platform });
  if (loginPath) segments.push(loginPath);
  // Hardcoded fallback dirs in case login shell didn't yield anything (e.g.,
  // user uses fish but we wouldn't shell out to it). Order matches the
  // candidate priority in _macPosixCandidates. Use path.posix.join so tests
  // running on Windows still produce forward-slash POSIX paths.
  const home = env.HOME || '';
  segments.push('/opt/homebrew/bin');
  segments.push('/usr/local/bin');
  if (home) segments.push(path.posix.join(home, '.local', 'bin'));
  segments.push('/usr/bin');
  segments.push('/bin');
  if (currentPath) segments.push(currentPath);

  // De-dupe while preserving order so the highest-priority hit wins.
  const seen = new Set();
  const merged = [];
  for (const segment of segments) {
    if (!segment) continue;
    for (const dir of segment.split(sep)) {
      if (!dir || seen.has(dir)) continue;
      seen.add(dir);
      merged.push(dir);
    }
  }
  return merged.join(sep);
}

// Called once at app startup from src/main.js BEFORE any module reads
// process.env.PATH or resolves the copilot/agency binaries. Mutates
// process.env.PATH in place on macOS so the rest of the app sees a
// "Terminal-like" PATH. On other platforms it's a no-op.
function bootstrapMacEnvironment(deps = {}) {
  const platform = deps.platform || process.platform;
  if (platform !== 'darwin') return { mutated: false };
  const env = deps.env || process.env;
  const before = env.PATH || '';
  const augmented = buildAugmentedPath(before, { ...deps, env, platform });
  if (augmented && augmented !== before) {
    env.PATH = augmented;
    return { mutated: true, before, after: augmented };
  }
  return { mutated: false, before, after: before };
}

function resolveBrochureInfo(deps = {}) {
  const existsSync = deps.existsSync || fs.existsSync;
  const env = deps.env || process.env;
  const homeDir = deps.homeDir || env.USERPROFILE || env.HOME || '';
  const documentsPath = deps.documentsPath || '';
  const appPath = deps.appPath || '';
  const candidates = [
    appPath ? path.join(appPath, 'deepsky-brochure.html') : '',
    documentsPath ? path.join(documentsPath, 'deepsky-brochure.html') : '',
    homeDir ? path.join(homeDir, 'OneDrive - Microsoft', 'Documents', 'deepsky-brochure.html') : '',
    homeDir ? path.join(homeDir, 'Documents', 'deepsky-brochure.html') : '',
  ].filter(Boolean);

  const seen = new Set();
  for (const candidate of candidates) {
    if (seen.has(candidate)) continue;
    seen.add(candidate);
    if (existsSync(candidate)) {
      return { path: candidate, found: true };
    }
  }

  return {
    path: candidates[0] || null,
    found: false,
  };
}

function pickNotificationDisplay(displays, mainWindowBounds) {
  if (!Array.isArray(displays) || displays.length === 0) return null;
  if (!mainWindowBounds) return displays[0];

  const centerX = mainWindowBounds.x + (mainWindowBounds.width / 2);
  const centerY = mainWindowBounds.y + (mainWindowBounds.height / 2);

  const containing = displays.find((display) => {
    const bounds = display?.bounds || display?.workArea;
    if (!bounds) return false;
    return centerX >= bounds.x &&
      centerX < (bounds.x + bounds.width) &&
      centerY >= bounds.y &&
      centerY < (bounds.y + bounds.height);
  });
  if (containing) return containing;

  let best = displays[0];
  let bestDistance = Number.POSITIVE_INFINITY;
  for (const display of displays) {
    const bounds = display?.bounds || display?.workArea;
    if (!bounds) continue;
    const displayCenterX = bounds.x + (bounds.width / 2);
    const displayCenterY = bounds.y + (bounds.height / 2);
    const distance = Math.hypot(displayCenterX - centerX, displayCenterY - centerY);
    if (distance < bestDistance) {
      best = display;
      bestDistance = distance;
    }
  }

  return best;
}

function calculateNotificationPosition(workArea, activeCount) {
  const NOTIF_WIDTH = 360;
  const NOTIF_HEIGHT = 100;
  const PADDING = 20;
  const STACK_GAP = 8;
  const stackOffset = activeCount * (NOTIF_HEIGHT + STACK_GAP);
  return {
    width: NOTIF_WIDTH,
    height: NOTIF_HEIGHT,
    x: Math.round(workArea.x + workArea.width - NOTIF_WIDTH - PADDING),
    y: Math.round(workArea.y + workArea.height - NOTIF_HEIGHT - PADDING - stackOffset),
  };
}

module.exports = {
  bootstrapMacEnvironment,
  buildAugmentedPath,
  calculateNotificationPosition,
  expandWindowsEnvVars,
  getLoginShellPath,
  isValidSessionId,
  mergePathEntries,
  pickNotificationDisplay,
  parseLauncherArgs,
  readWindowsPersistedPath,
  refreshWindowsProcessPath,
  resolveCommandPath,
  resolveAgencyInfo,
  resolveBrochureInfo,
  resolveCopilotInfo,
  resolveCopilotPath,
  _clearCommandPathCache,
  _clearLoginShellPathCache,
};
