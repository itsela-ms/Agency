import { describe, it, expect, beforeEach, afterEach } from 'vitest';
const fs = require('fs');
const path = require('path');
const os = require('os');
const SettingsService = require('../src/settings-service');

let tmpDir;
let svc;

beforeEach(async () => {
  tmpDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'deepsky-settings-'));
  svc = new SettingsService(tmpDir);
});

afterEach(async () => {
  await fs.promises.rm(tmpDir, { recursive: true, force: true });
});

describe('SettingsService', () => {
  describe('defaults', () => {
    it('promptForWorkdir defaults to false', () => {
      const settings = svc.get();
      expect(settings.promptForWorkdir).toBe(false);
    });

    it('maxConcurrent defaults to 5', () => {
      expect(svc.get().maxConcurrent).toBe(5);
    });

    it('theme defaults to mocha', () => {
      expect(svc.get().theme).toBe('mocha');
    });

    it('useAgencyCopilot defaults to false', () => {
      expect(svc.get().useAgencyCopilot).toBe(false);
    });

    it('custom launcher args default to empty strings', () => {
      expect(svc.get().copilotArgs).toBe('');
    });

    it('statusPanelSections defaults to null', () => {
      expect(svc.get().statusPanelSections).toBeNull();
    });

    it('sidebarHidden defaults to false', () => {
      expect(svc.get().sidebarHidden).toBe(false);
    });

    it('activeSessions defaults to an empty array', () => {
      expect(svc.get().activeSessions).toEqual([]);
    });
  });

  describe('update + persistence', () => {
    it('updates promptForWorkdir to false', async () => {
      await svc.update({ promptForWorkdir: false });
      expect(svc.get().promptForWorkdir).toBe(false);
    });

    it('persists promptForWorkdir across load', async () => {
      await svc.update({ promptForWorkdir: false });
      const svc2 = new SettingsService(tmpDir);
      await svc2.load();
      expect(svc2.get().promptForWorkdir).toBe(false);
    });

    it('persists useAgencyCopilot across load', async () => {
      await svc.update({ useAgencyCopilot: true });
      const svc2 = new SettingsService(tmpDir);
      await svc2.load();
      expect(svc2.get().useAgencyCopilot).toBe(true);
    });

    it('persists custom launcher args across load', async () => {
      await svc.update({ copilotArgs: '--agent squad' });
      const svc2 = new SettingsService(tmpDir);
      await svc2.load();
      expect(svc2.get().copilotArgs).toBe('--agent squad');
      expect(svc2.get().agencyCopilotArgs).toBeUndefined();
    });

    it('persists statusPanelSections across load', async () => {
      await svc.update({ statusPanelSections: { summary: true, generatedFiles: true } });
      const svc2 = new SettingsService(tmpDir);
      await svc2.load();
      expect(svc2.get().statusPanelSections).toEqual({ summary: true, generatedFiles: true });
    });

    it('persists sidebarHidden across load', async () => {
      await svc.update({ sidebarHidden: true });
      const svc2 = new SettingsService(tmpDir);
      await svc2.load();
      expect(svc2.get().sidebarHidden).toBe(true);
    });

    it('persists activeSessions across load', async () => {
      await svc.update({ activeSessions: ['session-a', 'session-b'] });
      const svc2 = new SettingsService(tmpDir);
      await svc2.load();
      expect(svc2.get().activeSessions).toEqual(['session-a', 'session-b']);
    });

    it('rejects unknown settings keys', async () => {
      await svc.update({ unknownKey: 'bad', promptForWorkdir: false });
      const settings = svc.get();
      expect(settings.unknownKey).toBeUndefined();
      expect(settings.promptForWorkdir).toBe(false);
    });
  });

  describe('load', () => {
    it('returns defaults when config file does not exist', async () => {
      const settings = await svc.load();
      expect(settings.promptForWorkdir).toBe(false);
      expect(settings.maxConcurrent).toBe(5);
    });

    it('merges saved settings with defaults on load', async () => {
      const configPath = path.join(tmpDir, 'session-gui-settings.json');
      await fs.promises.writeFile(configPath, JSON.stringify({ maxConcurrent: 3 }), 'utf8');
      await svc.load();
      expect(svc.get().maxConcurrent).toBe(3);
      expect(svc.get().promptForWorkdir).toBe(false); // default fills in
    });

    it('migrates malformed launcher args and removes the old agency-specific setting on load', async () => {
      const configPath = path.join(tmpDir, 'session-gui-settings.json');
      await fs.promises.writeFile(configPath, JSON.stringify({
        copilotArgs: '--model "gpt',
        agencyCopilotArgs: '--agent squad',
      }), 'utf8');

      await svc.load();

      expect(svc.get().copilotArgs).toBe('');
      expect(svc.get().agencyCopilotArgs).toBeUndefined();
      const saved = JSON.parse(await fs.promises.readFile(configPath, 'utf8'));
      expect(saved.copilotArgs).toBe('');
      expect(saved.agencyCopilotArgs).toBeUndefined();
    });

    it('migrates launcher args that would prevent new interactive sessions', async () => {
      const configPath = path.join(tmpDir, 'session-gui-settings.json');
      await fs.promises.writeFile(configPath, JSON.stringify({
        copilotArgs: '--mcp gateway',
      }), 'utf8');

      await svc.load();

      expect(svc.get().copilotArgs).toBe('');
      const saved = JSON.parse(await fs.promises.readFile(configPath, 'utf8'));
      expect(saved.copilotArgs).toBe('');
    });
  });

  describe('defaultWorkdir', () => {
    it('defaults to empty string', () => {
      expect(svc.get().defaultWorkdir).toBe('');
    });

    it('persists across load', async () => {
      await svc.update({ defaultWorkdir: 'C:\\Projects' });
      const svc2 = new SettingsService(tmpDir);
      await svc2.load();
      expect(svc2.get().defaultWorkdir).toBe('C:\\Projects');
    });

    it('can be cleared back to empty', async () => {
      await svc.update({ defaultWorkdir: '/some/path' });
      await svc.update({ defaultWorkdir: '' });
      expect(svc.get().defaultWorkdir).toBe('');
    });
  });
});
