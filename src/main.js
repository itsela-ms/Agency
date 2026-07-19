const { app, BrowserWindow, ipcMain, shell, Menu, dialog, clipboard, screen } = require('electron');
const path = require('path');
const fs = require('fs');
const os = require('os');
const {
  bootstrapMacEnvironment,
  calculateNotificationPosition,
  isValidSessionId,
  pickNotificationDisplay,
  parseLauncherArgs,
  resolveAgencyInfo,
  resolveBrochureInfo,
  resolveCopilotInfo,
  resolveCopilotPath,
} = require('./app-support');

// CRITICAL ORDERING: must run BEFORE any module-level code reads PATH or
// resolves copilot/agency binaries. On macOS, GUI launches from Finder/Dock
// inherit a minimal launchd PATH that lacks /opt/homebrew/bin, ~/.local/bin,
// etc. — so without this, resolveCopilotPath() below would fail to find
// `copilot` and node-pty spawns would fail with ENOENT for `node`/`git`/etc.
// On Windows this is a no-op.
bootstrapMacEnvironment();

// --- Smoke test mode (used by CI to verify the packaged .app actually runs).
// Triggered by `--smoke-test` arg or DEEPSKY_SMOKE_TEST=1 env var.
// Loads node-pty, spawns /bin/zsh -lc 'echo PTY_OK', waits for the marker,
// then exits with 0 on success / 1 on failure. Runs BEFORE app.whenReady so
// no window is created and the process self-terminates cleanly.
if (process.argv.includes('--smoke-test') || process.env.DEEPSKY_SMOKE_TEST === '1') {
  require('./smoke-test').run().then((ok) => {
    process.exit(ok ? 0 : 1);
  }).catch((err) => {
    console.error('[smoke-test] crashed:', err && err.stack || err);
    process.exit(1);
  });
  return;
}

const SessionService = require('./session-service');
const PtyManager = require('./pty-manager');
const TagIndexer = require('./tag-indexer');
const ResourceIndexer = require('./resource-indexer');
const { parseUrlToResource } = require('./resource-indexer');
const StatusService = require('./status-service');
const SettingsService = require('./settings-service');
const NotificationService = require('./notification-service');
const UpdateService = require('./update-service');
const {
  getSessionDirectoryAvailability,
  resolveGeneratedFilePath,
  resolveSessionDirectory,
  resolveSessionFilesDirectory,
} = require('./session-paths');
const { getNewSessionAvailability } = require('./session-state');

// Prevent Chromium GPU compositing artifacts(rectangular patches of wrong shade on dark backgrounds)
app.commandLine.appendSwitch('disable-gpu-compositing');

let mainWindow;
let updateService;
let lastRestoreTabShortcutAt = 0;

// Active notification popup windows, used for stacking
let activeNotifWindows = [];
// Maps BrowserWindow.id → notification object for click handling
const notifWindowData = new Map();

function showNotificationPopup(notification) {
  const preferredDisplay = pickNotificationDisplay(
    screen.getAllDisplays(),
    mainWindow && !mainWindow.isDestroyed() ? mainWindow.getBounds() : null
  ) || screen.getPrimaryDisplay();
  const { workArea } = preferredDisplay;
  const { x, y, width, height } = calculateNotificationPosition(workArea, activeNotifWindows.length);

  const notifWin = new BrowserWindow({
    width,
    height,
    x,
    y,
    frame: false,
    transparent: true,
    hasShadow: false,
    alwaysOnTop: true,
    skipTaskbar: true,
    resizable: false,
    movable: false,
    focusable: false,
    show: false,
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      preload: path.join(__dirname, 'notification-popup-preload.js'),
    },
  });

  notifWin.loadFile(path.join(__dirname, 'notification-popup.html'));

  notifWin.webContents.on('did-finish-load', () => {
    const theme = settingsService.get().theme || 'mocha';
    notifWin.webContents.send('notification:show', { ...notification, theme });
    notifWin.showInactive();
  });

  activeNotifWindows.push(notifWin);
  notifWindowData.set(notifWin.id, notification);

  const dismissTimer = setTimeout(() => {
    if (!notifWin.isDestroyed()) notifWin.close();
  }, 6000);

  notifWin.on('closed', () => {
    clearTimeout(dismissTimer);
    activeNotifWindows = activeNotifWindows.filter(w => w !== notifWin);
    notifWindowData.delete(notifWin.id);
  });
}

let sessionService;
let ptyManager;
let tagIndexer;
let resourceIndexer;
let settingsService;
let notificationService;
let statusService;
let ptyFlushTimer = null;
let enhanceStartSessionPromise = null;

const COPILOT_PATH = resolveCopilotPath();
const SESSION_STATE_DIR = path.join(os.homedir(), '.copilot', 'session-state');
const COPILOT_CONFIG_DIR = path.join(os.homedir(), '.copilot');
const NOTIFICATIONS_DIR = path.join(COPILOT_CONFIG_DIR, 'notifications');
const INSTRUCTIONS_PATH = path.join(COPILOT_CONFIG_DIR, 'copilot-instructions.md');
const INSTRUCTION_BACKUPS_DIR = path.join(COPILOT_CONFIG_DIR, 'instruction-backups');
const DEEPSKY_BROCHURE_URL = 'https://itsela-ms.github.io/DeepSky/deepsky-brochure.html';
const enhanceInstructions = require('./enhance-instructions-service');

function getNewSessionLauncher(settings) {
  return getNewSessionAvailability(getAugmentedSettings(settings)).launcher;
}

function getNewSessionSupport(settings) {
  return getNewSessionAvailability(getAugmentedSettings(settings));
}

function getLauncherArgsText(settings) {
  const value = settings.copilotArgs;
  return typeof value === 'string' ? value.trim() : '';
}

function getExplicitLauncherSupport(settings, launcher) {
  const augmented = getAugmentedSettings(settings);
  const resolvedLauncher = launcher === 'agency' ? 'agency' : 'copilot';

  if (resolvedLauncher === 'agency') {
    return augmented.agencyAvailable
      ? { launcher: 'agency', available: true, reason: '' }
      : { launcher: 'agency', available: false, reason: 'Agency is not installed on this machine.' };
  }

  return augmented.copilotAvailable
    ? { launcher: 'copilot', available: true, reason: '' }
    : { launcher: 'copilot', available: false, reason: 'GitHub Copilot CLI is not installed.' };
}

function resolveNewSessionLaunchRequest(request) {
  if (!request || typeof request === 'string') {
    const settings = settingsService.get();
    const sessionSupport = getNewSessionSupport(settings);
    const launcherArgs = getLauncherArgsText(settings);
    return {
      cwd: request || undefined,
      launcher: sessionSupport.launcher,
      launcherArgs,
      available: sessionSupport.available,
      reason: sessionSupport.reason,
      oneOff: false,
    };
  }

  if (typeof request !== 'object' || Array.isArray(request)) {
    throw new Error('Invalid new session request.');
  }

  const settings = settingsService.get();
  const requestedLauncher = request.launcher === 'agency' ? 'agency' : request.launcher === 'copilot' ? 'copilot' : null;
  const sessionSupport = requestedLauncher
    ? getExplicitLauncherSupport(settings, requestedLauncher)
    : getNewSessionSupport(settings);
  const hasOneOffArgs = Object.prototype.hasOwnProperty.call(request, 'launcherArgs');
  if (hasOneOffArgs && typeof request.launcherArgs !== 'string') {
    throw new Error('Custom launcher arguments must be a string.');
  }

  const launcherArgs = hasOneOffArgs ? request.launcherArgs.trim() : getLauncherArgsText(settings);

  parseLauncherArgs(launcherArgs);

  return {
    cwd: typeof request.cwd === 'string' && request.cwd.trim() ? request.cwd.trim() : undefined,
    launcher: sessionSupport.launcher,
    launcherArgs,
    available: sessionSupport.available,
    reason: sessionSupport.reason,
    oneOff: requestedLauncher !== null || hasOneOffArgs,
  };
}

function requireValidSessionId(sessionId) {
  if (!isValidSessionId(sessionId)) {
    throw new Error('Invalid session ID.');
  }
  return sessionId;
}

function getAugmentedSettings(settings) {
  return {
    ...settings,
    agencyAvailable: resolveAgencyInfo().found,
    copilotAvailable: resolveCopilotInfo().found,
  };
}

function dispatchRestoreTabShortcut() {
  if (!mainWindow || mainWindow.isDestroyed()) {
    return;
  }

  const now = Date.now();
  if (now - lastRestoreTabShortcutAt < 150) {
    return;
  }

  lastRestoreTabShortcutAt = now;
  mainWindow.webContents.send('shortcut:restore-tab');
}

function createWindow() {
  const theme = settingsService.get().theme || 'mocha';
  const bg = theme === 'latte' ? '#eff1f5' : '#1e1e2e';
  const fg = theme === 'latte' ? '#4c4f69' : '#cdd6f4';

  const winOptions = {
    width: 1400,
    height: 900,
    minWidth: 900,
    minHeight: 600,
    icon: path.join(__dirname, '..', 'deepsky.ico'),
    backgroundColor: bg,
    frame: false,
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      preload: path.join(__dirname, 'preload.js')
    }
  };

  winOptions.titleBarStyle = 'hidden';
  winOptions.titleBarOverlay = { color: bg, symbolColor: fg, height: 36 };

  mainWindow = new BrowserWindow(winOptions);

  mainWindow.loadFile(path.join(__dirname, 'index.html'));

  // Restore persisted zoom level
  const zoomFactor = settingsService.get().zoomFactor || 1.0;
  mainWindow.webContents.on('did-finish-load', () => {
    mainWindow.webContents.setZoomFactor(zoomFactor);
  });
  mainWindow.webContents.on('before-input-event', (event, input) => {
    const key = String(input.key || '').toLowerCase();
    const isRestoreShortcut = (input.control || input.meta) && input.shift && (input.code === 'KeyT' || key === 't');
    if (!isRestoreShortcut || input.type !== 'keyDown') return;
    event.preventDefault();
    dispatchRestoreTabShortcut();
  });

  mainWindow.webContents.on('will-navigate', (e) => e.preventDefault());
  mainWindow.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
}

const hasSingleInstanceLock = app.requestSingleInstanceLock();

if (!hasSingleInstanceLock) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (!mainWindow || mainWindow.isDestroyed()) return;
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.show();
    mainWindow.focus();
  });

  app.whenReady().then(async () => {
  settingsService = new SettingsService(COPILOT_CONFIG_DIR);
  await settingsService.load();

  await fs.promises.mkdir(SESSION_STATE_DIR, { recursive: true });

  const copilotExe = settingsService.get().copilotPath || COPILOT_PATH;
  sessionService = new SessionService(SESSION_STATE_DIR);
  ptyManager = new PtyManager(copilotExe, settingsService, undefined, { agencyPath: resolveAgencyInfo().path });

  tagIndexer = new TagIndexer(SESSION_STATE_DIR);
  await tagIndexer.init();

  resourceIndexer = new ResourceIndexer(SESSION_STATE_DIR);
  await resourceIndexer.init();

  statusService = new StatusService(SESSION_STATE_DIR);

  await sessionService.cleanEmptySessions();

  notificationService = new NotificationService(NOTIFICATIONS_DIR);

  // Forward notifications to renderer + show OS notification
  // Registered before .start() so _scanExisting() events aren't dropped (bug #8)
  notificationService.on('notification', (notification) => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('notification:new', notification);
    }

    // Show notification popup pinned to primary display
    showNotificationPopup(notification);
  });

  notificationService.start();

  // Custom menu without 'paste' or 'copy' — xterm's custom key handler owns
  // Ctrl+C / Ctrl+V / Cmd+C / Cmd+V.  The default Electron menu fires
  // webContents.copy()/paste() before keydown reaches the renderer, which
  // interferes with xterm's canvas-based selection model.
  const menuTemplate = [];
  menuTemplate.push(
    {
      label: 'Edit',
      submenu: [
        {
          label: 'Restore Closed Tab',
          accelerator: 'CommandOrControl+Shift+T',
          click: () => dispatchRestoreTabShortcut(),
        },
        { type: 'separator' },
        { role: 'selectAll' },
      ]
    },
    { label: 'View', submenu: [{ role: 'toggleDevTools' }, { role: 'reload' }, { role: 'forceReload' }] },
  );
  Menu.setApplicationMenu(Menu.buildFromTemplate(menuTemplate));

  createWindow();

  updateService = new UpdateService(mainWindow, settingsService);
  mainWindow.webContents.on('did-finish-load', () => {
    updateService.checkOnStartup();
  });

  // IPC: Open/resume a session
  ipcMain.handle('session:open', async (event, sessionId) => {
    sessionId = requireValidSessionId(sessionId);
    const [cwd, launcher, launcherArgs] = await Promise.all([
      sessionService.getCwd(sessionId),
      sessionService.getLauncher(sessionId),
      sessionService.getLauncherArgs(sessionId),
    ]);
    return ptyManager.openSession(sessionId, cwd || undefined, launcher, launcherArgs);
  });

  // IPC: Start a new session
  // Returns { sessionId, bufferedData, exitCode } — bufferedData is any
  // pre-warm or cold-start output accumulated before the renderer can create
  // the terminal. The renderer writes it to xterm AFTER createTerminal, then
  // applies exitCode if the CLI already exited, avoiding lost startup output
  // and dead tabs caused by pty events racing the IPC return.
  ipcMain.handle('session:new', async (event, request) => {
    const launchRequest = resolveNewSessionLaunchRequest(request);
    if (!launchRequest.available) {
      throw new Error(launchRequest.reason);
    }

    const { cwd, launcher, launcherArgs, oneOff } = launchRequest;
    // Try pre-warmed standby for instant startup
    const claimed = oneOff ? null : ptyManager.claimStandby(cwd || undefined, launcher);
    if (claimed) {
      if (cwd) await sessionService.saveCwd(claimed.id, cwd);
      await sessionService.saveLauncher(claimed.id, launcher);
      await sessionService.saveLauncherArgs(claimed.id, launcherArgs);
      scheduleWarmUp();
      return {
        sessionId: claimed.id,
        bufferedData: claimed.bufferedData.length > 0 ? claimed.bufferedData.join('') : '',
      };
    }

    // Cold start fallback
    const sessionId = await ptyManager.newSession(cwd || undefined, launcher, [], launcherArgs);
    pendingColdStarts.set(sessionId, { chunks: ptyDataBuffers.get(sessionId) || [], exitCode: null });
    ptyDataBuffers.delete(sessionId);
    let pending;
    try {
      if (cwd) {
        await sessionService.saveCwd(sessionId, cwd);
      }
      await sessionService.saveLauncher(sessionId, launcher);
      await sessionService.saveLauncherArgs(sessionId, launcherArgs);
      pending = pendingColdStarts.get(sessionId);
    } catch (error) {
      ptyManager.kill(sessionId);
      throw error;
    } finally {
      pendingColdStarts.delete(sessionId);
    }
    scheduleWarmUp();
    return {
      sessionId,
      bufferedData: pending?.chunks.length ? pending.chunks.join('') : '',
      exitCode: pending?.exitCode ?? null,
    };
  });

  // IPC: Pick a directory (native OS dialog)
  ipcMain.handle('dialog:pickDirectory', async (event, defaultPath) => {
    const result = await dialog.showOpenDialog(mainWindow, {
      title: 'Choose working directory',
      defaultPath: defaultPath || os.homedir(),
      properties: ['openDirectory'],
    });
    if (result.canceled || !result.filePaths.length) return null;
    return result.filePaths[0];
  });

  // IPC: Change working directory of a session (save + clean restart)
  const cwdChangingSessions = new Set();
  ipcMain.handle('session:changeCwd', async (event, sessionId, cwd) => {
    sessionId = requireValidSessionId(sessionId);
    if (typeof cwd !== 'string' || !cwd.trim()) {
      throw new Error('Invalid working directory.');
    }
    const previousCwd = await sessionService.getCwd(sessionId);
    const [launcher, launcherArgs] = await Promise.all([
      sessionService.getLauncher(sessionId),
      sessionService.getLauncherArgs(sessionId),
    ]);
    await sessionService.saveCwd(sessionId, cwd);
    statusService.invalidateSession(sessionId);
    cwdChangingSessions.add(sessionId);
    try {
      return await ptyManager.restartSession(sessionId, cwd, launcher, launcherArgs);
    } catch (error) {
      if (!previousCwd) {
        await sessionService.clearCwd(sessionId);
      } else {
        await sessionService.saveCwd(sessionId, previousCwd);
      }
      statusService.invalidateSession(sessionId);
      try {
        ptyManager.openSession(sessionId, previousCwd, launcher, launcherArgs);
      } catch (restoreError) {
        error.message = `${error.message} (failed to restore previous session: ${restoreError.message})`;
      }
      throw error;
    } finally {
      cwdChangingSessions.delete(sessionId);
    }
  });

  // IPC: Write to a session's pty
  ipcMain.on('pty:write', (event, { sessionId, data }) => {
    try { ptyManager.write(sessionId, data); } catch {}
  });

  // IPC: Resize a session's pty
  ipcMain.on('pty:resize', (event, { sessionId, cols, rows }) => {
    try { ptyManager.resize(sessionId, cols, rows); } catch {}
  });

  // IPC: Kill a session's pty
  ipcMain.handle('pty:kill', (event, sessionId) => {
    ptyManager.kill(sessionId);
  });

  // IPC: Get settings
  ipcMain.handle('settings:get', async () => {
    return getAugmentedSettings(settingsService.get());
  });

  // IPC: Update settings
  ipcMain.handle('settings:update', async (event, partial) => {
    const sanitized = { ...partial };
    if (sanitized.useAgencyCopilot && !resolveAgencyInfo().found) {
      sanitized.useAgencyCopilot = false;
    }
    if ('copilotArgs' in sanitized) {
      sanitized.copilotArgs = typeof sanitized.copilotArgs === 'string' ? sanitized.copilotArgs.trim() : '';
      parseLauncherArgs(sanitized.copilotArgs);
    }
    delete sanitized.agencyCopilotArgs;
    const launchSettingsChanged = 'useAgencyCopilot' in sanitized || 'defaultWorkdir' in sanitized || 'promptForWorkdir' in sanitized || 'copilotArgs' in sanitized;
    const updated = await settingsService.update(sanitized);
    ptyManager.updateSettings(updated, launchSettingsChanged);
    if (launchSettingsChanged) {
      scheduleWarmUp();
    }

    // Update window chrome for theme changes
    if (sanitized.theme && mainWindow && !mainWindow.isDestroyed()) {
      const bg = sanitized.theme === 'latte' ? '#eff1f5' : '#1e1e2e';
      const fg = sanitized.theme === 'latte' ? '#4c4f69' : '#cdd6f4';
      mainWindow.setTitleBarOverlay({ color: bg, symbolColor: fg });
      mainWindow.setBackgroundColor(bg);
    }

    return getAugmentedSettings(updated);
  });

  // IPC: Zoom
  const ZOOM_MIN = 0.75;
  const ZOOM_MAX = 1.5;
  const ZOOM_STEP = 0.05;

  ipcMain.handle('zoom:get', () => mainWindow.webContents.getZoomFactor());

  ipcMain.handle('zoom:set', async (event, direction) => {
    const current = mainWindow.webContents.getZoomFactor();
    let next;
    if (direction === 'in') next = Math.min(current + ZOOM_STEP, ZOOM_MAX);
    else if (direction === 'out') next = Math.max(current - ZOOM_STEP, ZOOM_MIN);
    else if (direction === 'reset') next = 1.0;
    else next = Math.min(Math.max(Number(direction) || 1.0, ZOOM_MIN), ZOOM_MAX);
    next = Math.round(next * 100) / 100;
    mainWindow.webContents.setZoomFactor(next);
    await settingsService.update({ zoomFactor: next });
    return next;
  });

  // IPC: Get active sessions
  ipcMain.handle('pty:active', () => {
    return ptyManager.getActiveSessions();
  });

  // IPC: Read instructions file
  ipcMain.handle('instructions:read', async () => {
    try {
      return await fs.promises.readFile(INSTRUCTIONS_PATH, 'utf8');
    } catch {
      return '';
    }
  });

  // IPC: Write instructions file
  ipcMain.handle('instructions:write', async (event, content) => {
    await fs.promises.writeFile(INSTRUCTIONS_PATH, content, 'utf8');
  });

  // IPC: Enhance instructions — backup-first contract
  // Always snapshot current state BEFORE returning. The renderer must wait
  // for this to succeed before launching the enhancement session.
  ipcMain.handle('enhance:backup', async () => {
    return await enhanceInstructions.createBackup();
  });

  ipcMain.handle('enhance:listBackups', async () => {
    return await enhanceInstructions.listBackups();
  });

  ipcMain.handle('enhance:getBackupHtml', async (_event, timestamp) => {
    return await enhanceInstructions.getBackupHtml(timestamp);
  });

  ipcMain.handle('enhance:rollback', async (_event, timestamp) => {
    return await enhanceInstructions.rollback(timestamp);
  });

  ipcMain.handle('enhance:apply', async (_event, timestamp) => {
    return await enhanceInstructions.applyProposed(timestamp);
  });

  ipcMain.handle('enhance:discard', async (_event, timestamp) => {
    return await enhanceInstructions.discardProposed(timestamp);
  });

  ipcMain.handle('enhance:startSession', async () => {
    // ONE atomic flow:
    //  1. Backup current state (immutable snapshot at instruction-backups/<ts>/)
    //     and create a paired writable proposal folder (instruction-proposals/<ts>/).
    //  2. Write the full multi-kb prompt into the proposal folder.
    //  3. Spawn a NEW Copilot/agency session with `-i "<one-line command>"` baked
    //     into the spawn arguments. The CLI receives the prompt as a process arg —
    //     no PTY-write timing, no escape-sequence assumptions.
    if (enhanceStartSessionPromise) {
      throw new Error('Instructions enhancement is already starting.');
    }

    enhanceStartSessionPromise = (async () => {
      const backup = await enhanceInstructions.createBackup();
      const { promptFilePath } = await enhanceInstructions.writeEnhancePrompt(backup.backupDir, backup.proposalDir);

      const promptFileForwardSlash = promptFilePath.replace(/\\/g, '/');
      const oneLineCommand = `Read the file at ${promptFileForwardSlash} and execute the instructions inside it exactly as written.`;

      const sessionSupport = getNewSessionSupport(settingsService.get());
      if (!sessionSupport.available) {
        throw new Error(sessionSupport.reason);
      }
      const launcher = sessionSupport.launcher;
      const launcherArgs = getLauncherArgsText(settingsService.get(), launcher);
      const sessionId = await ptyManager.newSession(undefined, launcher, ['-i', oneLineCommand], launcherArgs);
      await sessionService.saveLauncher(sessionId, launcher);
      await sessionService.saveLauncherArgs(sessionId, launcherArgs);
      scheduleWarmUp();

      return { sessionId, backup };
    })();

    try {
      return await enhanceStartSessionPromise;
    } finally {
      enhanceStartSessionPromise = null;
    }
  });

  // IPC: Clipboard (main process owns clipboard — not available in sandboxed preloads)
  ipcMain.handle('clipboard:read', () => clipboard.readText());
  ipcMain.handle('clipboard:write', (_, text) => clipboard.writeText(text));

  // IPC: Open external URL
  ipcMain.handle('shell:openExternal', (event, url) => {
    let parsed;
    try {
      parsed = new URL(url);
    } catch {
      return;
    }
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return;
    shell.openExternal(parsed.href);
  });

  // IPC: Notifications
  ipcMain.handle('notifications:getAll', () => notificationService.getAll());
  ipcMain.handle('notifications:getUnreadCount', () => notificationService.getUnreadCount());
  ipcMain.handle('notifications:markRead', (event, id) => notificationService.markRead(id));
  ipcMain.handle('notifications:markAllRead', () => notificationService.markAllRead());
  ipcMain.handle('notifications:dismiss', (event, id) => notificationService.dismiss(id));
  ipcMain.handle('notifications:clearAll', () => notificationService.clearAll());

  // IPC: Notification popup interactions
  ipcMain.on('notification-popup:click', (event) => {
    const win = BrowserWindow.fromWebContents(event.sender);
    const notification = win ? notifWindowData.get(win.id) : null;
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.show();
      mainWindow.focus();
      if (notification?.sessionId) {
        mainWindow.webContents.send('notification:click', notification);
      }
    }
    if (win && !win.isDestroyed()) win.close();
  });

  ipcMain.on('notification-popup:dismiss', (event) => {
    const win = BrowserWindow.fromWebContents(event.sender);
    if (win && !win.isDestroyed()) win.close();
  });

  // IPC: App info
  ipcMain.handle('app:getVersion', () => app.getVersion());
  ipcMain.handle('app:getChangelog', () => {
    const candidates = [
      path.join(app.getAppPath(), 'CHANGELOG.md'),
      path.join(__dirname, '..', 'CHANGELOG.md'),
    ];
    for (const candidate of candidates) {
      try {
        return fs.readFileSync(candidate, 'utf-8');
      } catch {}
    }
    return '';
  });
  ipcMain.handle('app:getBrochureAvailability', () => {
    const brochureInfo = resolveBrochureInfo({
      appPath: app.getAppPath(),
      documentsPath: app.getPath('documents'),
    });
    return { available: true, localAvailable: brochureInfo.found };
  });
  ipcMain.handle('app:openBrochure', async () => {
    const brochureInfo = resolveBrochureInfo({
      appPath: app.getAppPath(),
      documentsPath: app.getPath('documents'),
    });
    if (!brochureInfo.found || !brochureInfo.path) {
      await shell.openExternal(DEEPSKY_BROCHURE_URL);
      return { ok: true, fallback: 'online' };
    }

    const error = await shell.openPath(brochureInfo.path);
    return error ? { ok: false, error } : { ok: true };
  });

  // Auto-notify on session exit
  ptyManager.on('exit', (sessionId, exitCode) => {
    // Suppress exit handling during cwd change (session will be respawned)
    if (cwdChangingSessions.has(sessionId)) return;
    const pending = pendingColdStarts.get(sessionId);
    if (pending) {
      pending.exitCode = exitCode;
      if (ptyDataBuffers.has(sessionId)) {
        pending.chunks.push(...ptyDataBuffers.get(sessionId));
        ptyDataBuffers.delete(sessionId);
      }
      return;
    }

    // Flush any remaining buffered data before signalling exit
    if (ptyDataBuffers.has(sessionId) && mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('pty:data', { sessionId, data: ptyDataBuffers.get(sessionId).join('') });
      ptyDataBuffers.delete(sessionId);
    }
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('pty:exit', { sessionId, exitCode });
    }
    // Push a notification for session exit
    const session = allSessionsCache.find(s => s.id === sessionId);
    const title = session?.title || sessionId.substring(0, 8);
    notificationService.push({
      type: exitCode === 0 ? 'task-done' : 'error',
      title: exitCode === 0 ? `Session ended: ${title}` : `Session error: ${title}`,
      body: `Exited with code ${exitCode}`,
      sessionId,
    });
  });

  ptyManager.on('evicted', (sessionId) => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('pty:evicted', sessionId);
    }
  });

  let allSessionsCache = [];
  const mergeSessionsCache = (sessions) => {
    const merged = new Map(allSessionsCache.map(session => [session.id, session]));
    sessions.forEach(session => merged.set(session.id, session));
    allSessionsCache = [...merged.values()];
  };
  const normalizeSessionListScope = (options = {}) => {
    const scope = String(options?.scope || '').trim().toLowerCase();
    if (scope === 'history') return 'history';
    if (scope === 'all') return 'all';
    return 'active';
  };
  const sessionMatchesSidebarSearch = (session, query) => {
    if (session.title?.toLowerCase().includes(query)) return true;
    if (session.cwd?.toLowerCase().includes(query)) return true;
    if (session.tags?.some(tag => tag.toLowerCase().includes(query))) return true;
    if (session.resources?.some(resource =>
      String(resource.id || '').toLowerCase().includes(query) ||
      String(resource.url || '').toLowerCase().includes(query) ||
      String(resource.name || '').toLowerCase().includes(query) ||
      String(resource.repo || '').toLowerCase().includes(query)
    )) {
      return true;
    }
    return false;
  };

  const hydrateSessionsCache = async (options = {}) => {
    const scope = normalizeSessionListScope(options);
    const sessions = await sessionService.listSessions(
      scope === 'history' ? { scope: 'history' } : scope === 'all' ? { scope: 'all' } : undefined
    );
    const hydratedSessions = sessions.map(s => ({
      ...s,
      tags: tagIndexer.getTagsForSession(s.id),
      resources: resourceIndexer.getResourcesForSession(s.id)
    }));

    if (scope === 'history') {
      mergeSessionsCache(hydratedSessions);
      return hydratedSessions;
    }

    allSessionsCache = hydratedSessions;
    return hydratedSessions;
  };

  // IPC: Get session list (with tags and resources) — also caches for notification titles
  ipcMain.handle('sessions:list', hydrateSessionsCache);

  ipcMain.handle('sessions:search', async (event, query) => {
    const needle = String(query || '').trim().toLowerCase();
    if (!needle) return [];

    const [sessions, contentMatches] = await Promise.all([
      hydrateSessionsCache(),
      sessionService.searchSessions(needle)
    ]);
    const contentMatchIds = new Set(contentMatches.map(match => match.id));

    return sessions
      .filter(session => contentMatchIds.has(session.id) || sessionMatchesSidebarSearch(session, needle));
  });

  ipcMain.handle('session:getLastUserPrompt', async (event, sessionId, options) => {
    sessionId = requireValidSessionId(sessionId);
    return sessionService.getLastUserPrompt(sessionId, options);
  });

  ipcMain.handle('session:rename', async (event, sessionId, title) => {
    sessionId = requireValidSessionId(sessionId);
    await sessionService.renameSession(sessionId, title);
  });

  ipcMain.handle('session:updateCwdMetadata', async (event, sessionId, cwd) => {
    sessionId = requireValidSessionId(sessionId);
    if (typeof cwd !== 'string' || !cwd.trim()) {
      throw new Error('Invalid working directory.');
    }
    await sessionService.saveCwd(sessionId, cwd);
    statusService.invalidateSession(sessionId);
  });

  ipcMain.handle('session:delete', async (event, sessionId) => {
    sessionId = requireValidSessionId(sessionId);
    ptyManager.kill(sessionId);
    statusService.invalidateSession(sessionId);
    await sessionService.deleteSession(sessionId);
  });

  ipcMain.handle('resource:add', async (event, sessionId, url) => {
    const resource = parseUrlToResource(url);
    return resourceIndexer.addManualResource(sessionId, resource);
  });

  ipcMain.handle('resource:remove', async (event, sessionId, key) => {
    await resourceIndexer.removeResource(sessionId, key);
  });

  // IPC: Get session status (intent, summary, plan, timeline, files)
  ipcMain.handle('session:getStatus', async (event, sessionId) => {
    sessionId = requireValidSessionId(sessionId);
    return statusService.getSessionStatus(sessionId);
  });

  ipcMain.handle('session:getDirectoryAvailability', async (event, sessionId) => (
    getSessionDirectoryAvailability(SESSION_STATE_DIR, sessionId)
  ));

  ipcMain.handle('session:openDirectory', async (event, sessionId) => {
    try {
      const sessionDir = await resolveSessionDirectory(SESSION_STATE_DIR, sessionId);
      const error = await shell.openPath(sessionDir);
      return error ? { ok: false, error } : { ok: true };
    } catch (error) {
      return { ok: false, error: error.message || 'Session directory no longer exists.' };
    }
  });

  ipcMain.handle('session:openFilesDirectory', async (event, sessionId) => {
    try {
      const filesDir = await resolveSessionFilesDirectory(SESSION_STATE_DIR, sessionId);
      const error = await shell.openPath(filesDir);
      return error ? { ok: false, error } : { ok: true };
    } catch (error) {
      return { ok: false, error: error.message || 'Session files directory no longer exists.' };
    }
  });

  ipcMain.handle('session:openGeneratedFile', async (event, sessionId, relativePath) => {
    try {
      const targetRealPath = await resolveGeneratedFilePath(SESSION_STATE_DIR, sessionId, relativePath);
      const error = await shell.openPath(targetRealPath);
      return error ? { ok: false, error } : { ok: true };
    } catch (error) {
      return { ok: false, error: error.message || 'Generated file no longer exists.' };
    }
  });

  // Forward pty output to renderer — batch at 16ms intervals to prevent IPC flooding
  const ptyDataBuffers = new Map(); // sessionId -> string[]
  const pendingColdStarts = new Map(); // sessionId -> { chunks: string[], exitCode: number|null }

  function flushPtyData() {
    ptyFlushTimer = null;
    if (!mainWindow || mainWindow.isDestroyed()) {
      ptyDataBuffers.clear();
      return;
    }
    for (const [sessionId, chunks] of ptyDataBuffers) {
      const pending = pendingColdStarts.get(sessionId);
      if (pending) {
        pending.chunks.push(...chunks);
        continue;
      }
      mainWindow.webContents.send('pty:data', { sessionId, data: chunks.join('') });
    }
    ptyDataBuffers.clear();
  }

  ptyManager.on('data', (sessionId, data) => {
    const pending = pendingColdStarts.get(sessionId);
    if (pending) {
      pending.chunks.push(data);
      return;
    }
    if (!ptyDataBuffers.has(sessionId)) ptyDataBuffers.set(sessionId, []);
    ptyDataBuffers.get(sessionId).push(data);
    if (!ptyFlushTimer) {
      ptyFlushTimer = setTimeout(flushPtyData, 16);
    }
  });

  // Pre-warm a standby session for instant new-session creation
  let warmUpTimer = null;
  function scheduleWarmUp() {
    if (warmUpTimer) {
      clearTimeout(warmUpTimer);
    }
    warmUpTimer = setTimeout(() => {
      warmUpTimer = null;
      const settings = settingsService.get();
      if (settings.promptForWorkdir) return;
      const sessionSupport = getNewSessionSupport(settings);
      if (!sessionSupport.available) return;
      const cwd = settings.defaultWorkdir || undefined;
      ptyManager.warmUp(cwd, sessionSupport.launcher);
    }, 3000);
  }
  scheduleWarmUp();
  });

  app.on('window-all-closed', () => {
  tagIndexer.stop();
  resourceIndexer.stop();
  notificationService.stop();
  if (ptyFlushTimer) { clearTimeout(ptyFlushTimer); ptyFlushTimer = null; }
  ptyManager.killAll();
  app.quit();
  });
}
