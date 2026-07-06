const fs = require('fs');
const os = require('os');
const path = require('path');
const { performance } = require('perf_hooks');
const StatusService = require('../src/status-service');

const DEFAULT_SESSIONS = 64;
const DEFAULT_EVENTS_PER_SESSION = 2000;
const DEFAULT_PARALLELISM = 8;

function readNumberArg(name, defaultValue) {
  const prefix = `--${name}=`;
  const arg = process.argv.find(value => value.startsWith(prefix));
  if (!arg) return defaultValue;

  const parsed = Number(arg.slice(prefix.length));
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new Error(`--${name} must be a positive integer`);
  }
  return parsed;
}

function createMutationEvent(sessionIndex, eventIndex, repoRoot, touchedPath) {
  const absolutePath = path.win32.join(repoRoot, touchedPath);
  return {
    type: 'hook.start',
    timestamp: new Date(1780000000000 + eventIndex).toISOString(),
    data: {
      hookType: 'postToolUse',
      input: {
        sessionId: `bench-${sessionIndex}`,
        timestamp: 1780000000000 + eventIndex,
        cwd: repoRoot,
        toolName: 'apply_patch',
        toolArgs: `*** Begin Patch\n*** Update File: ${absolutePath}\n@@\n-old\n+new\n*** End Patch\n`,
        toolResult: {
          resultType: 'success',
          textResultForLlm: `Modified 1 file(s): ${absolutePath}`,
          toolTelemetry: {
            metrics: { linesAdded: 1, linesRemoved: 1 },
            restrictedProperties: {
              filePaths: JSON.stringify([absolutePath]),
              addedPaths: '[]',
              deletedPaths: '[]',
            },
          },
        },
      },
    },
  };
}

function createFillerEvent(sessionIndex, eventIndex) {
  if (eventIndex % 7 === 0) {
    return {
      type: 'assistant.message',
      timestamp: new Date(1780000000000 + eventIndex).toISOString(),
      data: {
        content: `Assistant event ${eventIndex} for session ${sessionIndex}`,
      },
    };
  }

  if (eventIndex % 5 === 0) {
    return {
      type: 'tool.execution_complete',
      timestamp: new Date(1780000000000 + eventIndex).toISOString(),
      data: {
        result: {
          content: 'Tool completed',
          detailedContent: `Large benchmark payload ${sessionIndex}-${eventIndex}`,
        },
      },
    };
  }

  return {
    type: 'user.message',
    timestamp: new Date(1780000000000 + eventIndex).toISOString(),
    data: {
      content: `User event ${eventIndex} for session ${sessionIndex}`,
    },
  };
}

async function createSyntheticSession(rootDir, repoRoot, sessionIndex, eventsPerSession) {
  const sessionId = `bench-${String(sessionIndex).padStart(4, '0')}`;
  const sessionDir = path.join(rootDir, sessionId);
  const touchedPath = `src/session-${sessionIndex}.js`;

  await fs.promises.mkdir(sessionDir, { recursive: true });
  await fs.promises.writeFile(
    path.join(sessionDir, 'workspace.yaml'),
    `cwd: ${repoRoot}\nsummary: benchmark session ${sessionIndex}\n`,
    'utf8'
  );
  await fs.promises.writeFile(
    path.join(sessionDir, 'plan.md'),
    '# Benchmark\n\n- [ ] Read session status\n',
    'utf8'
  );

  const lines = [];
  for (let i = 0; i < eventsPerSession; i++) {
    const event = i === eventsPerSession - 1
      ? createMutationEvent(sessionIndex, i, repoRoot, touchedPath)
      : createFillerEvent(sessionIndex, i);
    lines.push(JSON.stringify(event));
  }
  await fs.promises.writeFile(path.join(sessionDir, 'events.jsonl'), `${lines.join('\n')}\n`, 'utf8');

  return { sessionId, touchedPath };
}

function createExecFileMock(repoRoot, sessions) {
  const statusLines = [
    ...sessions.map(session => ` M ${session.touchedPath}`),
    ' M shared/repo-global-noise.js',
  ].join('\0');

  return async (command, args) => {
    if (command !== 'git') {
      throw new Error(`Unexpected command: ${command}`);
    }

    const [subcommand] = args;
    if (subcommand === 'rev-parse') {
      return { stdout: `${repoRoot}\n`, stderr: '' };
    }

    if (subcommand === 'status') {
      return { stdout: `${statusLines}\0`, stderr: '' };
    }

    if (subcommand === 'diff') {
      const filePath = args[args.length - 1];
      return {
        stdout: `diff --git a/${filePath} b/${filePath}\n@@ -1 +1 @@\n-old\n+new\n`,
        stderr: '',
      };
    }

    throw new Error(`Unexpected git subcommand: ${subcommand}`);
  };
}

async function runWithParallelism(items, parallelism, worker) {
  let next = 0;
  const results = [];
  const workers = Array.from({ length: Math.min(parallelism, items.length) }, async () => {
    while (next < items.length) {
      const index = next;
      next += 1;
      results[index] = await worker(items[index], index);
    }
  });

  await Promise.all(workers);
  return results;
}

function formatNumber(value) {
  return value.toLocaleString('en-US');
}

async function main() {
  const sessionCount = readNumberArg('sessions', DEFAULT_SESSIONS);
  const eventsPerSession = readNumberArg('events', DEFAULT_EVENTS_PER_SESSION);
  const parallelism = readNumberArg('parallelism', DEFAULT_PARALLELISM);
  const totalEvents = sessionCount * eventsPerSession;

  const rootDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'deepsky-status-bench-'));
  const repoRoot = 'C:\\bench\\repo';

  try {
    const setupStart = performance.now();
    const sessions = [];
    for (let i = 0; i < sessionCount; i++) {
      sessions.push(await createSyntheticSession(rootDir, repoRoot, i, eventsPerSession));
    }
    const setupMs = performance.now() - setupStart;

    const service = new StatusService(rootDir, {
      execFile: createExecFileMock(repoRoot, sessions),
    });

    const readStart = performance.now();
    const statuses = await runWithParallelism(
      sessions,
      parallelism,
      session => service.getSessionStatus(session.sessionId)
    );
    const readMs = performance.now() - readStart;

    const fileCount = statuses.reduce((total, status) => total + status.files.length, 0);
    const timelineCount = statuses.reduce((total, status) => total + status.timeline.length, 0);
    const expectedFiles = sessionCount;
    if (fileCount !== expectedFiles) {
      throw new Error(`Expected ${expectedFiles} session-scoped changed files, got ${fileCount}`);
    }

    console.log('StatusService benchmark');
    console.log(`sessions:       ${formatNumber(sessionCount)}`);
    console.log(`events/session: ${formatNumber(eventsPerSession)}`);
    console.log(`total events:   ${formatNumber(totalEvents)}`);
    console.log(`parallelism:    ${formatNumber(parallelism)}`);
    console.log(`setup:          ${setupMs.toFixed(1)} ms`);
    console.log(`read:           ${readMs.toFixed(1)} ms`);
    console.log(`throughput:     ${(totalEvents / (readMs / 1000)).toFixed(0)} events/sec`);
    console.log(`files found:    ${formatNumber(fileCount)}`);
    console.log(`timeline items: ${formatNumber(timelineCount)}`);
  } finally {
    await fs.promises.rm(rootDir, { recursive: true, force: true });
  }
}

main().catch(err => {
  console.error(err);
  process.exitCode = 1;
});
