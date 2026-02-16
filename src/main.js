const { app, BrowserWindow, ipcMain, shell, Notification, Menu } = require('electron');
const path = require('path');
const fs = require('fs');
const SessionService = require('./session-service');
const PtyManager = require('./pty-manager');
const TagIndexer = require('./tag-indexer');
const ResourceIndexer = require('./resource-indexer');
const SettingsService = require('./settings-service');
const NotificationService = require('./notification-service');
const UpdateService = require('./update-service');

let mainWindow;
let updateService;
let sessionService;
let ptyManager;
let tagIndexer;
let resourceIndexer;
let settingsService;
let notificationService;
let ptyFlushTimer = null;

const COPILOT_PATH = resolveCopilotPath();
const SESSION_STATE_DIR = path.join(process.env.USERPROFILE, '.copilot', 'session-state');
const COPILOT_CONFIG_DIR = path.join(process.env.USERPROFILE, '.copilot');
const NOTIFICATIONS_DIR = path.join(COPILOT_CONFIG_DIR, 'notifications');
const INSTRUCTIONS_PATH = path.join(COPILOT_CONFIG_DIR, 'copilot-instructions.md');

function resolveCopilotPath() {
  const { execSync } = require('child_process');

  // 1. Check PATH (works regardless of install method)
  try {
    const result = execSync('where copilot.exe', { encoding: 'utf8', timeout: 5000 }).trim();
    const firstMatch = result.split(/\r?\n/)[0];
    if (firstMatch && fs.existsSync(firstMatch)) return firstMatch;
  } catch {}

  // 2. Known install locations
  const candidates = [
    path.join(process.env.LOCALAPPDATA || '', 'Microsoft', 'WinGet', 'Links', 'copilot.exe'),
    path.join(process.env.LOCALAPPDATA || '', 'Programs', 'copilot-cli', 'copilot.exe'),
    path.join(process.env.PROGRAMFILES || '', 'GitHub Copilot CLI', 'copilot.exe'),
  ];
  for (const p of candidates) {
    if (fs.existsSync(p)) return p;
  }

  // 3. Fall back to bare command name — let the OS resolve it at spawn time
  return 'copilot.exe';
}

function createWindow() {
  const theme = settingsService.get().theme || 'mocha';
  const bg = theme === 'latte' ? '#eff1f5' : '#1e1e2e';
  const fg = theme === 'latte' ? '#4c4f69' : '#cdd6f4';

  mainWindow = new BrowserWindow({
    width: 1400,
    height: 900,
    minWidth: 900,
    minHeight: 600,
    icon: path.join(__dirname, '..', 'deepsky.ico'),
    backgroundColor: bg,
    frame: false,
    titleBarStyle: 'hidden',
    titleBarOverlay: {
      color: bg,
      symbolColor: fg,
      height: 36
    },
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      preload: path.join(__dirname, 'preload.js')
    }
  });

  mainWindow.loadFile(path.join(__dirname, 'index.html'));

  mainWindow.webContents.on('will-navigate', (e) => e.preventDefault());
  mainWindow.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
}

app.whenReady().then(async () => {
  settingsService = new SettingsService(COPILOT_CONFIG_DIR);
  await settingsService.load();

  const copilotExe = settingsService.get().copilotPath || COPILOT_PATH;
  sessionService = new SessionService(SESSION_STATE_DIR);
  ptyManager = new PtyManager(copilotExe, settingsService);

  tagIndexer = new TagIndexer(SESSION_STATE_DIR);
  await tagIndexer.init();

  resourceIndexer = new ResourceIndexer(SESSION_STATE_DIR);
  await resourceIndexer.init();

  await sessionService.cleanEmptySessions();

  notificationService = new NotificationService(NOTIFICATIONS_DIR);

  // Forward notifications to renderer + show OS notification
  // Registered before .start() so _scanExisting() events aren't dropped (bug #8)
  notificationService.on('notification', (notification) => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('notification:new', notification);
    }

    // System tray notification
    const ICONS = { 'task-done': '✅', 'needs-input': '⏳', 'error': '❌', 'info': 'ℹ️' };
    const icon = ICONS[notification.type] || 'ℹ️';
    const osNotif = new Notification({
      title: `${icon} ${notification.title}`,
      body: notification.body || '',
      silent: notification.type === 'info',
    });
    osNotif.on('click', () => {
      if (mainWindow) {
        mainWindow.show();
        mainWindow.focus();
        if (notification.sessionId) {
          mainWindow.webContents.send('notification:click', notification);
        }
      }
    });
    osNotif.show();
  });

  notificationService.start();

  // Custom menu without 'paste' — xterm's custom key handler owns Ctrl+V.
  // The default Electron menu fires webContents.paste() before keydown reaches
  // the renderer, causing a double-paste.
  Menu.setApplicationMenu(Menu.buildFromTemplate([
    { label: 'Edit', submenu: [{ role: 'copy' }, { role: 'selectAll' }] },
    { label: 'View', submenu: [{ role: 'toggleDevTools' }, { role: 'reload' }, { role: 'forceReload' }] },
  ]));

  createWindow();

  updateService = new UpdateService(mainWindow);
  mainWindow.webContents.on('did-finish-load', () => {
    updateService.checkOnStartup();
  });

  // IPC: Open/resume a session
  ipcMain.handle('session:open', (event, sessionId) => {
    return ptyManager.openSession(sessionId);
  });

  // IPC: Start a new session
  ipcMain.handle('session:new', () => {
    return ptyManager.newSession();
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
  ipcMain.handle('settings:get', () => {
    return settingsService.get();
  });

  // IPC: Update settings
  ipcMain.handle('settings:update', async (event, partial) => {
    const updated = await settingsService.update(partial);
    ptyManager.updateSettings(updated);

    // Update window chrome for theme changes
    if (partial.theme && mainWindow && !mainWindow.isDestroyed()) {
      const bg = partial.theme === 'latte' ? '#eff1f5' : '#1e1e2e';
      const fg = partial.theme === 'latte' ? '#4c4f69' : '#cdd6f4';
      mainWindow.setTitleBarOverlay({ color: bg, symbolColor: fg });
      mainWindow.setBackgroundColor(bg);
    }

    return updated;
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

  // IPC: Open external URL
  ipcMain.handle('shell:openExternal', (event, url) => {
    if (url && (url.startsWith('http://') || url.startsWith('https://'))) {
      shell.openExternal(url);
    }
  });

  // IPC: Notifications
  ipcMain.handle('notifications:getAll', () => notificationService.getAll());
  ipcMain.handle('notifications:getUnreadCount', () => notificationService.getUnreadCount());
  ipcMain.handle('notifications:markRead', (event, id) => notificationService.markRead(id));
  ipcMain.handle('notifications:markAllRead', () => notificationService.markAllRead());
  ipcMain.handle('notifications:dismiss', (event, id) => notificationService.dismiss(id));
  ipcMain.handle('notifications:clearAll', () => notificationService.clearAll());

  // IPC: App info
  ipcMain.handle('app:getVersion', () => app.getVersion());
  ipcMain.handle('app:getChangelog', () => {
    try {
      return fs.readFileSync(path.join(__dirname, '..', 'CHANGELOG.md'), 'utf-8');
    } catch { return ''; }
  });

  // Auto-notify on session exit
  ptyManager.on('exit', (sessionId, exitCode) => {
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

  // IPC: Get session list (with tags and resources) — also caches for notification titles
  let allSessionsCache = [];
  ipcMain.handle('sessions:list', async () => {
    const sessions = await sessionService.listSessions();
    allSessionsCache = sessions.map(s => ({
      ...s,
      tags: tagIndexer.getTagsForSession(s.id),
      resources: resourceIndexer.getResourcesForSession(s.id)
    }));
    return allSessionsCache;
  });

  ipcMain.handle('session:rename', async (event, sessionId, title) => {
    await sessionService.renameSession(sessionId, title);
  });

  // Forward pty output to renderer — batch at 16ms intervals to prevent IPC flooding
  const ptyDataBuffers = new Map(); // sessionId -> string[]

  function flushPtyData() {
    ptyFlushTimer = null;
    if (!mainWindow || mainWindow.isDestroyed()) {
      ptyDataBuffers.clear();
      return;
    }
    for (const [sessionId, chunks] of ptyDataBuffers) {
      mainWindow.webContents.send('pty:data', { sessionId, data: chunks.join('') });
    }
    ptyDataBuffers.clear();
  }

  ptyManager.on('data', (sessionId, data) => {
    if (!ptyDataBuffers.has(sessionId)) ptyDataBuffers.set(sessionId, []);
    ptyDataBuffers.get(sessionId).push(data);
    if (!ptyFlushTimer) {
      ptyFlushTimer = setTimeout(flushPtyData, 16);
    }
  });
});

app.on('window-all-closed', () => {
  tagIndexer.stop();
  resourceIndexer.stop();
  notificationService.stop();
  if (ptyFlushTimer) { clearTimeout(ptyFlushTimer); ptyFlushTimer = null; }
  ptyManager.killAll();
  app.quit();
});
