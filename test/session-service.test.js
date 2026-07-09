import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
const fs = require('fs');
const path = require('path');
const os = require('os');
const SessionService = require('../src/session-service');

let tmpDir;
let svc;

beforeEach(async () => {
  tmpDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'deepsky-test-'));
  svc = new SessionService(tmpDir);
});

afterEach(async () => {
  await fs.promises.rm(tmpDir, { recursive: true, force: true });
});

async function createSession(id, yamlContent, extras = {}) {
  const dir = path.join(tmpDir, id);
  await fs.promises.mkdir(dir, { recursive: true });
  await fs.promises.writeFile(path.join(dir, 'workspace.yaml'), yamlContent, 'utf8');
  if (extras.deepskyCwd) {
    await fs.promises.writeFile(path.join(dir, '.deepsky-cwd'), extras.deepskyCwd, 'utf8');
  }
  if (extras.deepskyTitle) {
    await fs.promises.writeFile(path.join(dir, '.deepsky-title'), extras.deepskyTitle, 'utf8');
  }
  if (extras.events) {
    const lines = extras.events.map(event => JSON.stringify(event)).join('\n') + '\n';
    await fs.promises.writeFile(path.join(dir, 'events.jsonl'), lines, 'utf8');
  }
}

async function writeWorkspaceYaml(id, yamlContent) {
  const dir = path.join(tmpDir, id);
  await fs.promises.writeFile(path.join(dir, 'workspace.yaml'), yamlContent, 'utf8');
}

async function readWorkspaceYaml(id) {
  return fs.promises.readFile(path.join(tmpDir, id, 'workspace.yaml'), 'utf8');
}

async function setSessionModifiedTime(id, date) {
  const dir = path.join(tmpDir, id);
  const workspacePath = path.join(dir, 'workspace.yaml');
  const timestamp = date instanceof Date ? date : new Date(date);
  await fs.promises.utimes(workspacePath, timestamp, timestamp);
  await fs.promises.utimes(dir, timestamp, timestamp);
}

describe('SessionService', () => {
  describe('saveCwd', () => {
    it('writes cwd into workspace.yaml', async () => {
      await svc.saveCwd('sess-1', '/my/project');
      const content = await readWorkspaceYaml('sess-1');
      expect(content).toContain('cwd: /my/project');
    });

    it('creates session directory if it does not exist', async () => {
      await svc.saveCwd('new-sess', 'C:\\Users\\test');
      const exists = await fs.promises.access(path.join(tmpDir, 'new-sess')).then(() => true).catch(() => false);
      expect(exists).toBe(true);
    });

    it('trims whitespace from cwd', async () => {
      await svc.saveCwd('sess-trim', '  /trimmed/path  ');
      const content = await readWorkspaceYaml('sess-trim');
      expect(content).toContain('cwd: /trimmed/path');
    });

    it('overwrites existing workspace cwd', async () => {
      await svc.saveCwd('sess-overwrite', '/old/path');
      await svc.saveCwd('sess-overwrite', '/new/path');
      const content = await readWorkspaceYaml('sess-overwrite');
      expect(content).toContain('cwd: /new/path');
    });

    it('removes the legacy override file after writing workspace cwd', async () => {
      await createSession('sess-migrate', 'cwd: /yaml/path\nsummary: test', { deepskyCwd: '/legacy' });
      await svc.saveCwd('sess-migrate', '/workspace/path');
      await expect(fs.promises.access(path.join(tmpDir, 'sess-migrate', '.deepsky-cwd'))).rejects.toThrow();
    });

    it('rejects invalid session ids', async () => {
      await expect(svc.saveCwd('..\\escape', '/nope')).rejects.toThrow('Invalid session ID.');
    });
  });

  describe('clearCwd', () => {
    it('removes cwd from workspace.yaml and clears the legacy override file', async () => {
      await createSession('376fedd7-eec9-429e-a4b9-5fb252880d42', 'cwd: /yaml/path\nsummary: test', { deepskyCwd: '/override' });
      await svc.clearCwd('376fedd7-eec9-429e-a4b9-5fb252880d42');
      await expect(fs.promises.access(path.join(tmpDir, '376fedd7-eec9-429e-a4b9-5fb252880d42', '.deepsky-cwd'))).rejects.toThrow();
      await expect(svc.getCwd('376fedd7-eec9-429e-a4b9-5fb252880d42')).resolves.toBe('');
    });
  });

  describe('getCwd', () => {
    it('returns .deepsky-cwd content when it exists', async () => {
      await createSession('sess-cwd', 'cwd: /yaml/path\nsummary: test', { deepskyCwd: '/override/path' });
      const cwd = await svc.getCwd('sess-cwd');
      expect(cwd).toBe('/override/path');
    });

    it('.deepsky-cwd takes priority over workspace.yaml cwd', async () => {
      await createSession('sess-priority', 'cwd: /yaml/path\nsummary: test', { deepskyCwd: '/deepsky/path' });
      const cwd = await svc.getCwd('sess-priority');
      expect(cwd).toBe('/deepsky/path');
    });

    it('falls back to workspace.yaml cwd when .deepsky-cwd is absent', async () => {
      await createSession('sess-yaml', 'cwd: /yaml/fallback\nsummary: test');
      const cwd = await svc.getCwd('sess-yaml');
      expect(cwd).toBe('/yaml/fallback');
    });

    it('returns empty string when neither .deepsky-cwd nor workspace.yaml cwd exist', async () => {
      await createSession('sess-empty', 'summary: no cwd');
      const cwd = await svc.getCwd('sess-empty');
      expect(cwd).toBe('');
    });

    it('returns empty string when session directory does not exist', async () => {
      const cwd = await svc.getCwd('nonexistent');
      expect(cwd).toBe('');
    });

    it('ignores empty .deepsky-cwd and falls back to yaml', async () => {
      await createSession('sess-empty-file', 'cwd: /yaml/path\nsummary: test', { deepskyCwd: '   ' });
      const cwd = await svc.getCwd('sess-empty-file');
      expect(cwd).toBe('/yaml/path');
    });

    it('prefers newer workspace cwd over an older DeepSky override', async () => {
      await createSession('sess-cwd-fresh-workspace', 'cwd: /original\nsummary: test', { deepskyCwd: '/old-override' });
      await new Promise(resolve => setTimeout(resolve, 15));
      await writeWorkspaceYaml('sess-cwd-fresh-workspace', 'cwd: /workspace-new\nsummary: test');

      const cwd = await svc.getCwd('sess-cwd-fresh-workspace');
      expect(cwd).toBe('/workspace-new');
    });
  });

  describe('launcher metadata', () => {
    it('persists launcher args independently of launcher choice', async () => {
      await svc.saveLauncher('launcher-args', 'agency');
      await svc.saveLauncherArgs('launcher-args', '--agent squad');

      await expect(svc.getLauncher('launcher-args')).resolves.toBe('agency');
      await expect(svc.getLauncherArgs('launcher-args')).resolves.toBe('--agent squad');
    });

    it('returns empty launcher args for older sessions', async () => {
      await createSession('old-launcher-session', 'summary: old');
      await expect(svc.getLauncherArgs('old-launcher-session')).resolves.toBe('');
    });

    it('drops malformed persisted launcher args so old sessions can reopen', async () => {
      await createSession('bad-launcher-args', 'summary: old');
      await fs.promises.writeFile(path.join(tmpDir, 'bad-launcher-args', '.deepsky-launcher-args'), '--agent "squad', 'utf8');

      await expect(svc.getLauncherArgs('bad-launcher-args')).resolves.toBe('');
      await expect(fs.promises.access(path.join(tmpDir, 'bad-launcher-args', '.deepsky-launcher-args'))).rejects.toThrow();
    });

    it('does not delete launcher args when reading metadata fails', async () => {
      await createSession('locked-launcher-args', 'summary: old');
      const argsPath = path.join(tmpDir, 'locked-launcher-args', '.deepsky-launcher-args');
      await fs.promises.writeFile(argsPath, '--agent squad', 'utf8');
      const readError = new Error('locked');
      readError.code = 'EACCES';
      const readFile = vi.spyOn(fs.promises, 'readFile').mockImplementation(async (file, ...args) => {
        if (file === argsPath) throw readError;
        return fs.readFileSync(file, ...args);
      });

      try {
        await expect(svc.getLauncherArgs('locked-launcher-args')).resolves.toBe('');
      } finally {
        readFile.mockRestore();
      }
      await expect(fs.promises.readFile(argsPath, 'utf8')).resolves.toBe('--agent squad');
    });
  });

  describe('listSessions cwd resolution', () => {
    it('returns an empty list when the session-state directory does not exist yet', async () => {
      const missingDir = path.join(tmpDir, 'missing-session-state');
      const missingSvc = new SessionService(missingDir);
      await expect(missingSvc.listSessions()).resolves.toEqual([]);
    });

    it('uses .deepsky-cwd override in session listing', async () => {
      await createSession('list-1', 'cwd: /yaml/dir\nsummary: test session', { deepskyCwd: '/override/dir' });
      const sessions = await svc.listSessions();
      const sess = sessions.find(s => s.id === 'list-1');
      expect(sess.cwd).toBe('/override/dir');
    });

    it('uses workspace.yaml cwd when no .deepsky-cwd', async () => {
      await createSession('list-2', 'cwd: /yaml/only\nsummary: yaml session');
      const sessions = await svc.listSessions();
      const sess = sessions.find(s => s.id === 'list-2');
      expect(sess.cwd).toBe('/yaml/only');
    });

    it('returns empty cwd when neither source has cwd', async () => {
      await createSession('list-3', 'summary: no cwd session');
      const sessions = await svc.listSessions();
      const sess = sessions.find(s => s.id === 'list-3');
      expect(sess.cwd).toBe('');
    });

    it('uses the newer workspace cwd when Copilot changes cwd after a DeepSky override', async () => {
      await createSession('list-fresh-workspace', 'cwd: /original\nsummary: test session', { deepskyCwd: '/old-override' });
      await new Promise(resolve => setTimeout(resolve, 15));
      await writeWorkspaceYaml('list-fresh-workspace', 'cwd: /workspace-new\nsummary: test session');

      const sessions = await svc.listSessions();
      const sess = sessions.find(s => s.id === 'list-fresh-workspace');
      expect(sess.cwd).toBe('/workspace-new');
    });
  });

  describe('listSessions title resolution', () => {
    it('prefers workspace.yaml name when present', async () => {
      await createSession('title-name', 'name: Renamed Session\nsummary: Old summary');
      const sessions = await svc.listSessions();
      const sess = sessions.find(s => s.id === 'title-name');
      expect(sess.title).toBe('Renamed Session');
    });

    it('falls back to summary when name is absent', async () => {
      await createSession('title-summary', 'summary: Summary title');
      const sessions = await svc.listSessions();
      const sess = sessions.find(s => s.id === 'title-summary');
      expect(sess.title).toBe('Summary title');
    });

    it('prefers a newer workspace name over an older legacy DeepSky title', async () => {
      await createSession('title-manual', 'name: Copilot Rename\nsummary: Summary title', {
        deepskyTitle: 'Manual DeepSky Rename'
      });
      await new Promise(resolve => setTimeout(resolve, 15));
      await writeWorkspaceYaml('title-manual', 'name: New Workspace Name\nsummary: Summary title');
      const sessions = await svc.listSessions();
      const sess = sessions.find(s => s.id === 'title-manual');
      expect(sess.title).toBe('New Workspace Name');
    });
  });

  describe('listSessions history scope', () => {
    it('only returns sessions from the last three months when using history scope', async () => {
      const recentDate = new Date();
      recentDate.setDate(recentDate.getDate() - 14);
      const oldDate = new Date();
      oldDate.setMonth(oldDate.getMonth() - 4);

      await createSession('history-recent', 'summary: recent history');
      await createSession('history-old', 'summary: old history');
      await setSessionModifiedTime('history-recent', recentDate);
      await setSessionModifiedTime('history-old', oldDate);

      const sessions = await svc.listSessions({ scope: 'history' });
      expect(sessions.map(session => session.id)).toContain('history-recent');
      expect(sessions.map(session => session.id)).not.toContain('history-old');
    });

    it('caps history scope to the newest 500 sessions', async () => {
      const recentBase = new Date();
      recentBase.setDate(recentBase.getDate() - 7);

      for (let index = 0; index < 505; index += 1) {
        const id = `history-cap-${String(index).padStart(3, '0')}`;
        await createSession(id, `summary: capped history ${index}`);
        const modifiedAt = new Date(recentBase.getTime() + index * 1000);
        await setSessionModifiedTime(id, modifiedAt);
      }

      const sessions = await svc.listSessions({ scope: 'history' });
      expect(sessions).toHaveLength(500);
      expect(sessions[0].id).toBe('history-cap-504');
      expect(sessions.at(-1).id).toBe('history-cap-005');
      expect(sessions.map(session => session.id)).not.toContain('history-cap-004');
    }, 15000);
  });

  describe('renameSession', () => {
    it('writes the session name into workspace.yaml', async () => {
      await createSession('rename-workspace', 'summary: Old summary');
      await svc.renameSession('rename-workspace', 'Renamed in DeepSky');
      const content = await readWorkspaceYaml('rename-workspace');
      expect(content).toContain('name: Renamed in DeepSky');
    });

    it('removes the legacy .deepsky-title file after writing workspace name', async () => {
      await createSession('rename-migrate', 'summary: Old summary', { deepskyTitle: 'Legacy title' });
      await svc.renameSession('rename-migrate', 'Renamed in DeepSky');
      await expect(fs.promises.access(path.join(tmpDir, 'rename-migrate', '.deepsky-title'))).rejects.toThrow();
    });

    it('serializes workspace updates so rename and cwd changes do not clobber each other', async () => {
      await createSession('metadata-queue', 'summary: Old summary');
      await Promise.all([
        svc.renameSession('metadata-queue', 'Queued Rename'),
        svc.saveCwd('metadata-queue', 'C:\\repo\\queued'),
      ]);

      const content = await readWorkspaceYaml('metadata-queue');
      expect(content).toContain('name: Queued Rename');
      expect(content).toContain('cwd: C:\\repo\\queued');
    });
  });

  describe('saveCwd + getCwd roundtrip', () => {
    it('getCwd returns what saveCwd wrote', async () => {
      await createSession('roundtrip', 'summary: test');
      await svc.saveCwd('roundtrip', 'C:\\Users\\test\\project');
      const cwd = await svc.getCwd('roundtrip');
      expect(cwd).toBe('C:\\Users\\test\\project');
    });

    it('saveCwd updates cwd returned by listSessions', async () => {
      await createSession('roundtrip-list', 'cwd: /old\nsummary: test');
      await svc.saveCwd('roundtrip-list', '/updated');
      const sessions = await svc.listSessions();
      const sess = sessions.find(s => s.id === 'roundtrip-list');
      expect(sess.cwd).toBe('/updated');
    });
  });

  describe('_loadSession cache', () => {
    // The cache avoids re-parsing workspace.yaml / streaming events.jsonl for
    // sessions that haven't changed between polls. These tests verify both the
    // fingerprint-based fast path AND the explicit invalidation on mutations.
    it('returns the same object reference on consecutive listSessions when nothing changes', async () => {
      await createSession('cache-stable', 'name: Cached Name\nsummary: test');
      const first = await svc.listSessions();
      const second = await svc.listSessions();
      const a = first.find(s => s.id === 'cache-stable');
      const b = second.find(s => s.id === 'cache-stable');
      expect(a).toBe(b); // identity == proves the cache hit
    });

    it('invalidates the cache after renameSession', async () => {
      await createSession('cache-rename', 'name: Original\nsummary: test');
      const first = await svc.listSessions();
      const initial = first.find(s => s.id === 'cache-rename');
      expect(initial.title).toBe('Original');

      await svc.renameSession('cache-rename', 'Renamed');
      const second = await svc.listSessions();
      const updated = second.find(s => s.id === 'cache-rename');
      expect(updated.title).toBe('Renamed');
      expect(updated).not.toBe(initial); // cache miss → fresh object
    });

    it('invalidates the cache after saveCwd', async () => {
      await createSession('cache-cwd', 'cwd: /old\nname: t\nsummary: test');
      const first = await svc.listSessions();
      expect(first.find(s => s.id === 'cache-cwd').cwd).toBe('/old');

      await svc.saveCwd('cache-cwd', '/new');
      const second = await svc.listSessions();
      expect(second.find(s => s.id === 'cache-cwd').cwd).toBe('/new');
    });

    it('invalidates the cache after clearCwd', async () => {
      await createSession('cache-clear', 'cwd: /old\nname: t\nsummary: test');
      const first = await svc.listSessions();
      expect(first.find(s => s.id === 'cache-clear').cwd).toBe('/old');

      await svc.clearCwd('cache-clear');
      const second = await svc.listSessions();
      expect(second.find(s => s.id === 'cache-clear').cwd).toBe('');
    });

    it('invalidates the cache after deleteSession', async () => {
      await createSession('cache-delete', 'name: ToDelete\nsummary: test');
      const first = await svc.listSessions();
      expect(first.some(s => s.id === 'cache-delete')).toBe(true);

      await svc.deleteSession('cache-delete');
      const second = await svc.listSessions();
      expect(second.some(s => s.id === 'cache-delete')).toBe(false);
    });

    it('detects external workspace.yaml changes (mtime-based invalidation)', async () => {
      await createSession('cache-external', 'name: Before\nsummary: test');
      const first = await svc.listSessions();
      expect(first.find(s => s.id === 'cache-external').title).toBe('Before');

      // Simulate an external write (Copilot updating workspace.yaml on its own).
      // Bump mtime explicitly to defeat sub-millisecond mtime resolution edge cases.
      await writeWorkspaceYaml('cache-external', 'name: After\nsummary: test');
      const future = new Date(Date.now() + 5000);
      await fs.promises.utimes(path.join(tmpDir, 'cache-external', 'workspace.yaml'), future, future);

      const second = await svc.listSessions();
      expect(second.find(s => s.id === 'cache-external').title).toBe('After');
    });
  });

  describe('launcher persistence', () => {
    it('defaults launcher to copilot when unset', async () => {
      await createSession('launcher-default', 'summary: launcher default');
      const launcher = await svc.getLauncher('launcher-default');
      expect(launcher).toBe('copilot');
    });

    it('persists agency launcher across load', async () => {
      await svc.saveLauncher('launcher-agency', 'agency');
      const launcher = await svc.getLauncher('launcher-agency');
      expect(launcher).toBe('agency');
    });

    it('normalizes unknown launcher values back to copilot', async () => {
      await svc.saveLauncher('launcher-invalid', 'something-else');
      const launcher = await svc.getLauncher('launcher-invalid');
      expect(launcher).toBe('copilot');
    });

    it('rejects invalid session ids when reading launcher', async () => {
      await expect(svc.getLauncher('..\\not-a-session')).rejects.toThrow('Invalid session ID.');
    });
  });

  describe('searchSessions', () => {
    it('returns an empty list when the session-state directory does not exist yet', async () => {
      const missingDir = path.join(tmpDir, 'missing-session-state');
      const missingSvc = new SessionService(missingDir);
      await expect(missingSvc.searchSessions('anything')).resolves.toEqual([]);
    });

    it('finds matches in event transcript content', async () => {
      await createSession('search-hit', 'summary: first session', {
        events: [
          { type: 'user.message', data: { content: 'Looking at deployment statistics for the session' } }
        ]
      });
      await createSession('search-miss', 'summary: second session', {
        events: [
          { type: 'user.message', data: { content: 'Nothing relevant here' } }
        ]
      });

      const matches = await svc.searchSessions('statistics');
      expect(matches.map(match => match.id)).toContain('search-hit');
      expect(matches.map(match => match.id)).not.toContain('search-miss');
    });

    it('returns a preview for nested event payload matches', async () => {
      await createSession('nested-hit', 'summary: investigate rollout', {
        events: [
          {
            type: 'assistant.message',
            data: {
              sections: [
                { title: 'Result', body: 'The multitarget publish completed successfully in EU3 yesterday.' }
              ]
            }
          }
        ]
      });

      const matches = await svc.searchSessions('eu3');
      expect(matches).toHaveLength(1);
      expect(matches[0].id).toBe('nested-hit');
      expect(matches[0].preview.toLowerCase()).toContain('eu3');
    });

    it('does not match hidden assistant tool request metadata', async () => {
      await createSession('search-hidden-tool', 'summary: hidden tool request', {
        events: [
          {
            type: 'assistant.message',
            data: {
              content: '',
              toolRequests: [
                {
                  name: 'searchSessions',
                  arguments: {
                    query: 'phantom-keyword'
                  }
                }
              ]
            }
          }
        ]
      });

      const matches = await svc.searchSessions('phantom-keyword');
      expect(matches.map(match => match.id)).not.toContain('search-hidden-tool');
    });
  });

  describe('getLastUserPrompt', () => {
    it('returns the most recent user prompt from the transcript', async () => {
      await createSession('last-prompt', 'summary: prompt tracking', {
        events: [
          { type: 'user.message', data: { content: 'First prompt' } },
          { type: 'assistant.message', data: { content: 'Working on it' } },
          { type: 'user.message', data: { transformedContent: 'Second prompt with more detail' } }
        ]
      });

      const prompt = await svc.getLastUserPrompt('last-prompt');
      expect(prompt).toBe('Second prompt with more detail');
    });

    it('truncates to 160 chars by default but returns the full prompt with { full: true }', async () => {
      const long = 'q'.repeat(500);
      await createSession('full-prompt', 'summary: full prompt', {
        events: [{ type: 'user.message', data: { content: long } }]
      });

      const truncated = await svc.getLastUserPrompt('full-prompt');
      expect(truncated.length).toBe(160);
      expect(truncated.endsWith('...')).toBe(true);

      const full = await svc.getLastUserPrompt('full-prompt', { full: true });
      expect(full).toBe(long);
      expect(full.length).toBe(500);
    });
  });

  describe('lastAssistantHasPR', () => {
    it('is true when the latest assistant.message contains a GitHub PR URL', async () => {
      await createSession('pr-github', 'summary: github pr', {
        events: [
          { type: 'user.message', data: { content: 'open a pr' } },
          { type: 'assistant.message', data: { content: 'Opened https://github.com/owner/repo/pull/42 for review' } }
        ]
      });
      const [s] = await svc.listSessions();
      expect(s.lastAssistantHasPR).toBe(true);
    });

    it('is true when the latest assistant.message contains an Azure DevOps PR URL', async () => {
      await createSession('pr-ado', 'summary: ado pr', {
        events: [
          { type: 'user.message', data: { content: 'open a pr' } },
          { type: 'assistant.message', data: { content: 'Opened https://dev.azure.com/foo/_git/bar/pullrequest/77 for review' } }
        ]
      });
      const [s] = await svc.listSessions();
      expect(s.lastAssistantHasPR).toBe(true);
    });

    it('is false when only an earlier assistant.message had the PR URL', async () => {
      await createSession('pr-earlier', 'summary: stale pr', {
        events: [
          { type: 'user.message', data: { content: 'open a pr' } },
          { type: 'assistant.message', data: { content: 'Opened https://github.com/o/r/pull/1 for review' } },
          { type: 'user.message', data: { content: 'now do something else' } },
          { type: 'assistant.message', data: { content: 'OK, refactored utils.js — no PR yet, want me to open one?' } }
        ]
      });
      const [s] = await svc.listSessions();
      expect(s.lastAssistantHasPR).toBe(false);
    });

    it('is false when the latest assistant message has no PR but a tool.execution_complete after it mentions one (PR text in tool output should not count)', async () => {
      await createSession('pr-tool-only', 'summary: tool pr', {
        events: [
          { type: 'user.message', data: { content: 'look at this PR' } },
          { type: 'assistant.message', data: { content: 'Looking now — give me a moment.' } },
          { type: 'tool.execution_complete', data: { result: { content: 'https://github.com/o/r/pull/9' } } }
        ]
      });
      const [s] = await svc.listSessions();
      expect(s.lastAssistantHasPR).toBe(false);
    });

    it('is false for sessions with no events.jsonl', async () => {
      await createSession('pr-no-events', 'summary: no events');
      const [s] = await svc.listSessions();
      expect(s.lastAssistantHasPR).toBe(false);
    });
  });

  describe('cleanEmptySessions', () => {
    it('returns zero when the session-state directory does not exist yet', async () => {
      const missingDir = path.join(tmpDir, 'missing-session-state');
      const missingSvc = new SessionService(missingDir);
      await expect(missingSvc.cleanEmptySessions()).resolves.toBe(0);
    });
  });
});
