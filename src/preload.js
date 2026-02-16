const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('api', {
  // Sessions
  listSessions: () => ipcRenderer.invoke('sessions:list'),
  renameSession: (sessionId, title) => ipcRenderer.invoke('session:rename', sessionId, title),
  openSession: (sessionId) => ipcRenderer.invoke('session:open', sessionId),
  newSession: () => ipcRenderer.invoke('session:new'),
  killSession: (sessionId) => ipcRenderer.invoke('pty:kill', sessionId),

  // PTY I/O
  writePty: (sessionId, data) => ipcRenderer.send('pty:write', { sessionId, data }),
  resizePty: (sessionId, cols, rows) => ipcRenderer.send('pty:resize', { sessionId, cols, rows }),
  onPtyData: (callback) => {
    const listener = (event, payload) => callback(payload.sessionId, payload.data);
    ipcRenderer.on('pty:data', listener);
    return () => ipcRenderer.removeListener('pty:data', listener);
  },
  onPtyExit: (callback) => {
    const listener = (event, payload) => callback(payload.sessionId, payload.exitCode);
    ipcRenderer.on('pty:exit', listener);
    return () => ipcRenderer.removeListener('pty:exit', listener);
  },
  onPtyEvicted: (callback) => {
    const listener = (event, sessionId) => callback(sessionId);
    ipcRenderer.on('pty:evicted', listener);
    return () => ipcRenderer.removeListener('pty:evicted', listener);
  },

  // Active sessions
  getActiveSessions: () => ipcRenderer.invoke('pty:active'),

  // Settings
  getSettings: () => ipcRenderer.invoke('settings:get'),
  updateSettings: (settings) => ipcRenderer.invoke('settings:update', settings),

  // Instructions
  readInstructions: () => ipcRenderer.invoke('instructions:read'),
  writeInstructions: (content) => ipcRenderer.invoke('instructions:write', content),

  // Shell
  openExternal: (url) => ipcRenderer.invoke('shell:openExternal', url),

  // App info
  getVersion: () => ipcRenderer.invoke('app:getVersion'),
  getChangelog: () => ipcRenderer.invoke('app:getChangelog'),

  // Updates
  checkForUpdates: () => ipcRenderer.invoke('update:check'),
  downloadUpdate: () => ipcRenderer.invoke('update:download'),
  installUpdate: () => ipcRenderer.invoke('update:install'),
  getUpdateStatus: () => ipcRenderer.invoke('update:getStatus'),
  onUpdateStatus: (callback) => {
    const listener = (event, data) => callback(data);
    ipcRenderer.on('update:status', listener);
    return () => ipcRenderer.removeListener('update:status', listener);
  },

  // Notifications
  getNotifications: () => ipcRenderer.invoke('notifications:getAll'),
  getUnreadCount: () => ipcRenderer.invoke('notifications:getUnreadCount'),
  markNotificationRead: (id) => ipcRenderer.invoke('notifications:markRead', id),
  markAllNotificationsRead: () => ipcRenderer.invoke('notifications:markAllRead'),
  dismissNotification: (id) => ipcRenderer.invoke('notifications:dismiss', id),
  clearAllNotifications: () => ipcRenderer.invoke('notifications:clearAll'),
  onNotification: (callback) => {
    const listener = (event, notification) => callback(notification);
    ipcRenderer.on('notification:new', listener);
    return () => ipcRenderer.removeListener('notification:new', listener);
  },
  onNotificationClick: (callback) => {
    const listener = (event, notification) => callback(notification);
    ipcRenderer.on('notification:click', listener);
    return () => ipcRenderer.removeListener('notification:click', listener);
  },
});
