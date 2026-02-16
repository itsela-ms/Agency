const { autoUpdater } = require('electron-updater');
const { ipcMain } = require('electron');

class UpdateService {
  constructor(mainWindow) {
    this.mainWindow = mainWindow;
    this.status = 'idle'; // idle | checking | available | downloading | downloaded | not-available | error
    this.updateInfo = null;
    this.error = null;
    this.progress = null;

    autoUpdater.autoDownload = false;
    autoUpdater.autoInstallOnAppQuit = false;
    autoUpdater.allowPrerelease = true;

    autoUpdater.on('checking-for-update', () => {
      this.status = 'checking';
      this._send('update:status', { status: this.status });
    });

    autoUpdater.on('update-available', (info) => {
      this.status = 'available';
      this.updateInfo = { version: info.version, releaseDate: info.releaseDate, releaseNotes: info.releaseNotes };
      this._send('update:status', { status: this.status, info: this.updateInfo });
    });

    autoUpdater.on('update-not-available', (info) => {
      this.status = 'not-available';
      this.updateInfo = { version: info.version };
      this._send('update:status', { status: this.status, info: this.updateInfo });
    });

    autoUpdater.on('download-progress', (progress) => {
      this.status = 'downloading';
      this.progress = { percent: progress.percent, transferred: progress.transferred, total: progress.total };
      this._send('update:status', { status: this.status, progress: this.progress });
    });

    autoUpdater.on('update-downloaded', (info) => {
      this.status = 'downloaded';
      this.updateInfo = { version: info.version, releaseDate: info.releaseDate };
      this._send('update:status', { status: this.status, info: this.updateInfo });
    });

    autoUpdater.on('error', (err) => {
      this.status = 'error';
      this.error = err?.message || 'Unknown error';
      this._send('update:status', { status: this.status, error: this.error });
    });

    this._registerIpc();
  }

  _send(channel, data) {
    if (this.mainWindow && !this.mainWindow.isDestroyed()) {
      this.mainWindow.webContents.send(channel, data);
    }
  }

  _registerIpc() {
    ipcMain.handle('update:check', async () => {
      try {
        return await autoUpdater.checkForUpdates();
      } catch (err) {
        this.status = 'error';
        this.error = err?.message || 'Failed to check for updates';
        this._send('update:status', { status: this.status, error: this.error });
        return { status: 'error', error: this.error };
      }
    });

    ipcMain.handle('update:download', async () => {
      try {
        return await autoUpdater.downloadUpdate();
      } catch (err) {
        this.status = 'error';
        this.error = err?.message || 'Failed to download update';
        this._send('update:status', { status: this.status, error: this.error });
        return { status: 'error', error: this.error };
      }
    });

    ipcMain.handle('update:install', () => {
      autoUpdater.quitAndInstall(false, true);
    });

    ipcMain.handle('update:getStatus', () => {
      return { status: this.status, info: this.updateInfo, progress: this.progress, error: this.error };
    });
  }

  async checkOnStartup() {
    // Delay startup check by 5 seconds to not block app launch
    setTimeout(async () => {
      try {
        await autoUpdater.checkForUpdates();
      } catch {
        // Silent fail on startup — user can check manually
      }
    }, 5000);
  }
}

module.exports = UpdateService;
