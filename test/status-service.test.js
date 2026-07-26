import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
const fs = require('fs');
const path = require('path');
const os = require('os');
const StatusService = require('../src/status-service');

let tmpDir;
let svc;
let execFileMock;

beforeEach(async () => {
  tmpDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'deepsky-status-'));
  execFileMock = vi.fn(async () => ({ stdout: '', stderr: '' }));
  svc = new StatusService(tmpDir, { execFile: execFileMock });
});

afterEach(async () => {
  await fs.promises.rm(tmpDir, { recursive: true, force: true });
});

async function writePlan(sessionId, content) {
  const sessionDir = path.join(tmpDir, sessionId);
  await fs.promises.mkdir(sessionDir, { recursive: true });
  await fs.promises.writeFile(path.join(sessionDir, 'plan.md'), content, 'utf8');
  return sessionDir;
}

async function writeGeneratedFile(sessionId, relativePath, content = '') {
  const filePath = path.join(tmpDir, sessionId, 'files', ...relativePath.split('/'));
  await fs.promises.mkdir(path.dirname(filePath), { recursive: true });
  await fs.promises.writeFile(filePath, content, 'utf8');
  return filePath;
}

async function writeGeneratedDirectoryLink(sessionId, linkName, targetDir) {
  const linkPath = path.join(tmpDir, sessionId, 'files', linkName);
  await fs.promises.mkdir(path.dirname(linkPath), { recursive: true });
  const type = process.platform === 'win32' ? 'junction' : 'dir';
  await fs.promises.symlink(targetDir, linkPath, type);
  return linkPath;
}

async function writeSessionSummary(sessionId, content) {
  const sessionDir = path.join(tmpDir, sessionId);
  await fs.promises.mkdir(sessionDir, { recursive: true });
  await fs.promises.writeFile(path.join(sessionDir, 'session-summary.md'), content, 'utf8');
  return sessionDir;
}

async function writeWorkspace(sessionId, content) {
  const sessionDir = path.join(tmpDir, sessionId);
  await fs.promises.mkdir(sessionDir, { recursive: true });
  await fs.promises.writeFile(path.join(sessionDir, 'workspace.yaml'), content, 'utf8');
  return sessionDir;
}

async function writeFileMutationEvent(sessionId, {
  cwd = 'C:\\repo',
  filePaths = [],
  resultType = 'success',
  toolName = 'apply_patch',
} = {}) {
  const sessionDir = path.join(tmpDir, sessionId);
  await fs.promises.mkdir(sessionDir, { recursive: true });
  const event = {
    type: 'hook.start',
    data: {
      hookType: 'postToolUse',
      input: {
        cwd,
        toolName,
        toolArgs: filePaths.map(filePath => `*** Update File: ${filePath}`).join('\n'),
        toolResult: {
          resultType,
          toolTelemetry: {
            metrics: { linesAdded: 1, linesRemoved: 0 },
            restrictedProperties: {
              filePaths: JSON.stringify(filePaths),
              addedPaths: '[]',
              deletedPaths: '[]',
            },
          },
        },
      },
    },
  };
  await fs.promises.appendFile(path.join(sessionDir, 'events.jsonl'), `${JSON.stringify(event)}\n`, 'utf8');
}

async function writeEvents(sessionId, events) {
  const sessionDir = path.join(tmpDir, sessionId);
  await fs.promises.mkdir(sessionDir, { recursive: true });
  const lines = events.map(event => JSON.stringify(event)).join('\n') + '\n';
  await fs.promises.writeFile(path.join(sessionDir, 'events.jsonl'), lines, 'utf8');
}

describe('StatusService timeline filtering', () => {
  it('hides internal lifecycle, plan, and sub-agent metadata from the side-panel timeline', async () => {
    await writeEvents('timeline-noise', [
      { type: 'session.start', timestamp: '2026-07-21T06:00:00.000Z' },
      { type: 'session.resume', timestamp: '2026-07-21T06:01:00.000Z' },
      { type: 'session.plan_changed', timestamp: '2026-07-21T06:02:00.000Z', data: { operation: 'updated' } },
      { type: 'subagent.started', timestamp: '2026-07-21T06:03:00.000Z', data: { description: 'QA pass' } },
      { type: 'subagent.completed', timestamp: '2026-07-21T06:04:00.000Z' },
      { type: 'assistant.message', timestamp: '2026-07-21T06:05:00.000Z', data: { content: 'Session resumed' } },
      { type: 'assistant.message', timestamp: '2026-07-21T06:06:00.000Z', data: { content: 'Plan updated' } },
      { type: 'assistant.message', timestamp: '2026-07-21T06:07:00.000Z', data: { content: 'Updated plan' } },
      { type: 'assistant.message', timestamp: '2026-07-21T06:08:00.000Z', data: { content: 'Sub-agent complete' } },
    ]);

    const status = await svc.getSessionStatus('timeline-noise');

    expect(status.timeline).toEqual([]);
  });

  it('keeps user prompts and meaningful assistant results in the side-panel timeline', async () => {
    await writeEvents('timeline-signal', [
      {
        type: 'user.message',
        timestamp: '2026-07-21T06:00:00.000Z',
        data: { content: '<current_datetime>ignore</current_datetime>\n\nCan you fix scrolling?' },
      },
      {
        type: 'assistant.message',
        timestamp: '2026-07-21T06:01:00.000Z',
        data: { content: 'I’ll inspect the scroll path first.' },
      },
      {
        type: 'assistant.message',
        timestamp: '2026-07-21T06:02:00.000Z',
        data: { content: 'Fixed locally and validated in the running app.' },
      },
      {
        type: 'user.message',
        timestamp: '2026-07-21T06:03:00.000Z',
        data: { transformedContent: '<system_reminder>noise</system_reminder>\n\nCreate UTs for this issue' },
      },
    ]);

    const status = await svc.getSessionStatus('timeline-signal');

    expect(status.timeline).toEqual([
      { time: '2026-07-21T06:03:00.000Z', type: 'user', text: 'Create UTs for this issue', fullText: 'Create UTs for this issue' },
      { time: '2026-07-21T06:02:00.000Z', type: 'assistant', text: 'Fixed locally and validated in the running app.' },
      { time: '2026-07-21T06:00:00.000Z', type: 'user', text: 'Can you fix scrolling?', fullText: 'Can you fix scrolling?' },
    ]);
  });

  it('truncates long user prompts in timeline entries while preserving full hover text', async () => {
    const prompt = 'x'.repeat(120);
    await writeEvents('timeline-long-prompt', [
      {
        type: 'user.message',
        timestamp: '2026-07-21T06:00:00.000Z',
        data: { content: prompt },
      },
    ]);

    const status = await svc.getSessionStatus('timeline-long-prompt');

    expect(status.timeline).toHaveLength(1);
    expect(status.timeline[0].text).toHaveLength(80);
    expect(status.timeline[0].text.endsWith('...')).toBe(true);
    expect(status.timeline[0].fullText).toBe(prompt);
  });
});

describe('StatusService next step summaries', () => {
  it('keeps concise checkbox steps unchanged', async () => {
    await writePlan('short-steps', [
      '# Test Plan',
      '',
      '## Next Steps',
      '- [ ] Engage source tenant admin',
      '- [ ] Roll traffic to AME',
    ].join('\n'));

    const status = await svc.getSessionStatus('short-steps');
    expect(status.nextSteps.map(step => step.text)).toEqual([
      'Engage source tenant admin',
      'Roll traffic to AME',
    ]);
  });

  it('summarizes verbose checkbox steps to six words or fewer', async () => {
    await writePlan('verbose-steps', [
      '# Test Plan',
      '',
      '## Next Steps',
      '- [ ] Engage the Source Tenant Admin by posting in the support Teams channel with all app details',
      '- [ ] Download the `AppMigration` PowerShell artifacts from the latest successful pipeline build',
    ].join('\n'));

    const status = await svc.getSessionStatus('verbose-steps');
    expect(status.nextSteps.map(step => step.text)).toEqual([
      'Engage the Source Tenant Admin',
      'Download the AppMigration PowerShell artifacts',
    ]);
    expect(status.nextSteps.every(step => step.text.split(/\s+/).length <= 6)).toBe(true);
  });

  it('summarizes numbered fallback steps to six words or fewer', async () => {
    await writePlan('numbered-steps', [
      '# Test Plan',
      '',
      '## Next Steps',
      '1. **Acquire the AME token and prepare destination migration** - extra details go here',
      '2. **Soft-delete Corp source app after bake** - more details',
    ].join('\n'));

    const status = await svc.getSessionStatus('numbered-steps');
    expect(status.nextSteps.map(step => step.text)).toEqual([
      'Acquire the AME token and prepare',
      'Soft-delete Corp source app after bake',
    ]);
    expect(status.nextSteps.every(step => step.text.split(/\s+/).length <= 6)).toBe(true);
  });

  it('skips empty checkbox items after summarization', async () => {
    await writePlan('empty-steps', [
      '# Test Plan',
      '',
      '## Next Steps',
      '- [ ]    ',
      '- [ ] Roll traffic to AME',
    ].join('\n'));

    const status = await svc.getSessionStatus('empty-steps');
    expect(status.nextSteps).toHaveLength(1);
    expect(status.nextSteps[0]).toMatchObject({
      text: 'Roll traffic to AME',
      current: true,
      done: false,
    });
  });

  it('preserves unicode characters in summarized steps', async () => {
    await writePlan('unicode-steps', [
      '# Test Plan',
      '',
      '## Next Steps',
      '- [ ] Mettre à jour résumé partagé',
      '- [ ] Validate café migration readiness',
    ].join('\n'));

    const status = await svc.getSessionStatus('unicode-steps');
    expect(status.nextSteps.map(step => step.text)).toEqual([
      'Mettre à jour résumé partagé',
      'Validate café migration readiness',
    ]);
  });
});

describe('StatusService generated files', () => {
  it('returns only user-targeted reports from the session files folder', async () => {
    await writeGeneratedFile('generated-files', 'reports/validation.html', '<html></html>');
    await writeGeneratedFile('generated-files', 'notes/output.json', '{"ok":true}');
    await writeGeneratedFile('generated-files', 'exports/brief.pdf', 'pdf');

    const status = await svc.getSessionStatus('generated-files');
    expect(status.generatedFiles.map(file => file.path)).toEqual([
      'files/reports/validation.html',
      'files/exports/brief.pdf',
    ]);
  });

  it('prioritizes html files ahead of other generated files', async () => {
    await writeGeneratedFile('generated-priority', 'artifact.json', '{}');
    await writeGeneratedFile('generated-priority', 'preview.html', '<html></html>');

    const status = await svc.getSessionStatus('generated-priority');
    expect(status.generatedFiles[0]).toMatchObject({
      name: 'preview.html',
      ext: 'html',
    });
  });

  it('skips symlinked directories when discovering generated files', async () => {
    const outsideDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'deepsky-generated-link-'));
    await fs.promises.writeFile(path.join(outsideDir, 'outside.html'), '<html>outside</html>', 'utf8');
    await writeGeneratedFile('generated-safe', 'reports/inside.html', '<html>inside</html>');
    await writeGeneratedDirectoryLink('generated-safe', 'linked-outside', outsideDir);

    const status = await svc.getSessionStatus('generated-safe');
    expect(status.generatedFiles.map(file => file.path)).toEqual(['files/reports/inside.html']);

    await fs.promises.rm(outsideDir, { recursive: true, force: true });
  });
});

describe('StatusService git file tracking', () => {
  it('returns only git status changes touched by the session', async () => {
    await writeWorkspace('git-files', 'cwd: C:\\repo\nsummary: repo session');
    await writeFileMutationEvent('git-files', {
      filePaths: [
        'C:\\repo\\src\\app.js',
        'C:\\repo\\reports\\output.html',
        'C:\\repo\\new.txt',
        'C:\\repo\\stale.txt',
      ],
    });
    execFileMock
      .mockResolvedValueOnce({ stdout: 'C:\\repo\n', stderr: '' })
      .mockResolvedValueOnce({ stdout: ' M src/app.js\n M unrelated.js\nA  reports/output.html\nR  old.txt -> new.txt\n D stale.txt\n', stderr: '' })
      .mockResolvedValueOnce({ stdout: 'diff --git a/src/app.js b/src/app.js\n@@ -1 +1 @@\n-old\n+new\n', stderr: '' })
      .mockResolvedValueOnce({ stdout: 'diff --git a/reports/output.html b/reports/output.html\nnew file mode 100644\n', stderr: '' })
      .mockResolvedValueOnce({ stdout: 'diff --git a/old.txt b/new.txt\nsimilarity index 98%\nrename from old.txt\nrename to new.txt\n', stderr: '' })
      .mockResolvedValueOnce({ stdout: 'diff --git a/stale.txt b/stale.txt\ndeleted file mode 100644\n', stderr: '' });

    const status = await svc.getSessionStatus('git-files');
    expect(status.files).toEqual([
      { path: 'src/app.js', action: 'M', diff: 'diff --git a/src/app.js b/src/app.js\n@@ -1 +1 @@\n-old\n+new' },
      { path: 'reports/output.html', action: 'A', diff: 'diff --git a/reports/output.html b/reports/output.html\nnew file mode 100644' },
      { path: 'new.txt', action: 'R', diff: 'diff --git a/old.txt b/new.txt\nsimilarity index 98%\nrename from old.txt\nrename to new.txt' },
      { path: 'stale.txt', action: 'D', diff: 'diff --git a/stale.txt b/stale.txt\ndeleted file mode 100644' },
    ]);
  });

  it('does not show repo-global dirty files when the session did not touch them', async () => {
    await writeWorkspace('repo-noise', 'cwd: C:\\repo\nsummary: repo session');
    execFileMock.mockResolvedValueOnce({ stdout: 'C:\\repo\n', stderr: '' });

    const status = await svc.getSessionStatus('repo-noise');
    expect(status.files).toEqual([]);
    expect(execFileMock).toHaveBeenCalledTimes(1);
  });

  it('refreshes cached status when events are appended without changing workspace metadata', async () => {
    await writeWorkspace('events-cache', 'cwd: C:\\repo\nsummary: repo session');
    execFileMock.mockResolvedValueOnce({ stdout: 'C:\\repo\n', stderr: '' });

    const first = await svc.getSessionStatus('events-cache');
    expect(first.files).toEqual([]);

    await new Promise(resolve => setTimeout(resolve, 15));
    await writeFileMutationEvent('events-cache', {
      filePaths: ['C:\\repo\\src\\fresh.js'],
    });
    execFileMock
      .mockResolvedValueOnce({ stdout: 'C:\\repo\n', stderr: '' })
      .mockResolvedValueOnce({ stdout: ' M src/fresh.js\n', stderr: '' })
      .mockResolvedValueOnce({ stdout: 'diff --git a/src/fresh.js b/src/fresh.js\n', stderr: '' });

    const second = await svc.getSessionStatus('events-cache');
    expect(second.files).toEqual([{ path: 'src/fresh.js', action: 'M', diff: 'diff --git a/src/fresh.js b/src/fresh.js' }]);
  });

  it('ignores failed mutation tool events when filtering repo changes', async () => {
    await writeWorkspace('failed-mutation', 'cwd: C:\\repo\nsummary: repo session');
    await writeFileMutationEvent('failed-mutation', {
      filePaths: ['C:\\repo\\src\\failed.js'],
      resultType: 'error',
    });
    execFileMock.mockResolvedValueOnce({ stdout: 'C:\\repo\n', stderr: '' });

    const status = await svc.getSessionStatus('failed-mutation');
    expect(status.files).toEqual([]);
    expect(execFileMock).toHaveBeenCalledTimes(1);
  });

  it('falls back to the session cwd for malformed event cwd values', async () => {
    await writeWorkspace('malformed-event-cwd', 'cwd: C:\\repo\nsummary: repo session');
    await writeFileMutationEvent('malformed-event-cwd', {
      cwd: {},
      filePaths: ['src/fallback.js'],
    });
    execFileMock
      .mockResolvedValueOnce({ stdout: 'C:\\repo\n', stderr: '' })
      .mockResolvedValueOnce({ stdout: ' M src/fallback.js\n', stderr: '' })
      .mockResolvedValueOnce({ stdout: 'diff --git a/src/fallback.js b/src/fallback.js\n', stderr: '' });

    const status = await svc.getSessionStatus('malformed-event-cwd');
    expect(status.files).toEqual([{ path: 'src/fallback.js', action: 'M', diff: 'diff --git a/src/fallback.js b/src/fallback.js' }]);
  });

  it('parses null-delimited git status paths without C-quote mangling', async () => {
    const tabbedPath = 'src/a\tb.js';
    await writeWorkspace('null-status', 'cwd: C:\\repo\nsummary: repo session');
    await writeFileMutationEvent('null-status', {
      filePaths: [`C:\\repo\\${tabbedPath}`],
    });
    execFileMock
      .mockResolvedValueOnce({ stdout: 'C:\\repo\n', stderr: '' })
      .mockResolvedValueOnce({ stdout: ` M ${tabbedPath}\0 M shared/repo-global-noise.js\0`, stderr: '' })
      .mockResolvedValueOnce({ stdout: `diff --git a/${tabbedPath} b/${tabbedPath}\n`, stderr: '' });

    const status = await svc.getSessionStatus('null-status');
    expect(status.files).toEqual([{ path: tabbedPath, action: 'M', diff: `diff --git a/${tabbedPath} b/${tabbedPath}` }]);
  });

  it('reads diff previews from the repository root when session cwd is a subdirectory', async () => {
    await writeWorkspace('subdir-diff', 'cwd: C:\\repo\\src\nsummary: repo session');
    await writeFileMutationEvent('subdir-diff', {
      cwd: 'C:\\repo\\src',
      filePaths: ['C:\\repo\\package.json'],
    });
    execFileMock
      .mockResolvedValueOnce({ stdout: 'C:\\repo\n', stderr: '' })
      .mockResolvedValueOnce({ stdout: ' M package.json\0', stderr: '' })
      .mockResolvedValueOnce({ stdout: 'diff --git a/package.json b/package.json\n', stderr: '' });

    const status = await svc.getSessionStatus('subdir-diff');
    expect(status.files).toEqual([{ path: 'package.json', action: 'M', diff: 'diff --git a/package.json b/package.json' }]);
    expect(execFileMock).toHaveBeenNthCalledWith(3, 'git', ['diff', '--no-ext-diff', '--', 'package.json'], expect.objectContaining({ cwd: 'C:\\repo' }));
  });

  it('returns no file changes when session cwd is not a git repo', async () => {
    await writeWorkspace('non-git-files', 'cwd: C:\\repo\nsummary: repo session');
    execFileMock.mockRejectedValueOnce(new Error('not a git repo'));

    const status = await svc.getSessionStatus('non-git-files');
    expect(status.files).toEqual([]);
  });

  it('refreshes cached status after explicit invalidation', async () => {
    await writeWorkspace('cache-reset', 'cwd: C:\\repo-a\nsummary: repo session');
    await writeFileMutationEvent('cache-reset', {
      cwd: 'C:\\repo-a',
      filePaths: ['C:\\repo-a\\src\\old.js'],
    });
    execFileMock
      .mockResolvedValueOnce({ stdout: 'C:\\repo-a\n', stderr: '' })
      .mockResolvedValueOnce({ stdout: ' M src/old.js\n', stderr: '' })
      .mockResolvedValueOnce({ stdout: 'diff --git a/src/old.js b/src/old.js\n', stderr: '' });

    const first = await svc.getSessionStatus('cache-reset');
    expect(first.files).toEqual([{ path: 'src/old.js', action: 'M', diff: 'diff --git a/src/old.js b/src/old.js' }]);

    await writeWorkspace('cache-reset', 'cwd: C:\\repo-b\nsummary: repo session');
    await writeFileMutationEvent('cache-reset', {
      cwd: 'C:\\repo-b',
      filePaths: ['C:\\repo-b\\src\\new.js'],
    });
    execFileMock
      .mockResolvedValueOnce({ stdout: 'C:\\repo-b\n', stderr: '' })
      .mockResolvedValueOnce({ stdout: ' M src/new.js\n', stderr: '' })
      .mockResolvedValueOnce({ stdout: 'diff --git a/src/new.js b/src/new.js\n', stderr: '' });

    svc.invalidateSession('cache-reset');
    const second = await svc.getSessionStatus('cache-reset');
    expect(second.files).toEqual([{ path: 'src/new.js', action: 'M', diff: 'diff --git a/src/new.js b/src/new.js' }]);
  });

  it('prefers the newer workspace cwd over an older DeepSky override when collecting git status', async () => {
    const sessionDir = await writeWorkspace('cwd-priority', 'cwd: C:\\repo-old\nsummary: repo session');
    await fs.promises.writeFile(path.join(sessionDir, '.deepsky-cwd'), 'C:\\repo-override', 'utf8');
    await new Promise(resolve => setTimeout(resolve, 15));
    await writeWorkspace('cwd-priority', 'cwd: C:\\repo-new\nsummary: repo session');
    await writeFileMutationEvent('cwd-priority', {
      cwd: 'C:\\repo-new',
      filePaths: ['C:\\repo-new\\src\\current.js'],
    });

    execFileMock
      .mockResolvedValueOnce({ stdout: 'C:\\repo-new\n', stderr: '' })
      .mockResolvedValueOnce({ stdout: ' M src/current.js\n', stderr: '' })
      .mockResolvedValueOnce({ stdout: 'diff --git a/src/current.js b/src/current.js\n', stderr: '' });

    const status = await svc.getSessionStatus('cwd-priority');
    expect(status.files).toEqual([{ path: 'src/current.js', action: 'M', diff: 'diff --git a/src/current.js b/src/current.js' }]);
    expect(execFileMock).toHaveBeenNthCalledWith(1, 'git', ['rev-parse', '--show-toplevel'], expect.objectContaining({ cwd: 'C:\\repo-new' }));
  });
});

describe('StatusService summary extraction', () => {
  it('reads only the Summary block from plain session-summary format', async () => {
    await writeSessionSummary('plain-summary', [
      'Summary:',
      'DeepSky now shows generated files in session status. It keeps the summary short and readable.',
      '',
      'Key Context:',
      '- noisy internal details should not show up',
      '',
      'Resume Prompt:',
      'Do more implementation work later.',
    ].join('\n'));

    const status = await svc.getSessionStatus('plain-summary');
    expect(status.summary).toMatchObject({
      text: 'DeepSky now shows generated files in session status. It keeps the summary short and readable.',
      source: 'session-summary',
    });
  });

  it('limits summary text to one or two natural sentences', async () => {
    await writeSessionSummary('long-summary', [
      'Summary:',
      'DeepSky now keeps session summaries concise and readable for the status panel. It avoids showing implementation-heavy details in the default view. A third sentence should be dropped.',
    ].join('\n'));

    const status = await svc.getSessionStatus('long-summary');
    expect(status.summary.text).toBe(
      'DeepSky now keeps session summaries concise and readable for the status panel. It avoids showing implementation-heavy details in the default view.'
    );
  });
});
