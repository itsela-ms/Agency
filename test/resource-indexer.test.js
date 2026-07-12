import { describe, it, expect, beforeEach, afterEach } from 'vitest';
const fs = require('fs');
const path = require('path');
const os = require('os');
const ResourceIndexer = require('../src/resource-indexer');

let tmpDir;
let indexer;

beforeEach(async () => {
  tmpDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'deepsky-resources-'));
  indexer = new ResourceIndexer(tmpDir);
});

afterEach(async () => {
  indexer.stop();
  await fs.promises.rm(tmpDir, { recursive: true, force: true });
});

async function createSession(id, events = []) {
  const dir = path.join(tmpDir, id);
  await fs.promises.mkdir(dir, { recursive: true });
  const lines = events.map(event => JSON.stringify(event)).join('\n') + '\n';
  await fs.promises.writeFile(path.join(dir, 'events.jsonl'), lines, 'utf8');
  return dir;
}

function byType(resources, type) {
  return resources.filter(resource => resource.type === type);
}

describe('ResourceIndexer related resource detection', () => {
  it('extracts visible message resources but ignores URLs hidden inside tool output', async () => {
    const sessionDir = await createSession('visible-only', [
      {
        type: 'assistant.message',
        data: {
          content: [
            'Related PR: https://dev.azure.com/microsoft/WDATP/_git/DeepSky/pullrequest/123',
            'Work item: https://dev.azure.com/microsoft/OS/_workitems/edit/456',
            'Build: https://dev.azure.com/microsoft/WDATP/_build/results?buildId=789',
            'Repo: https://github.com/itsela-ms/DeepSky'
          ]
        }
      },
      {
        type: 'tool.execution_complete',
        data: {
          result: {
            content: [
              'Search result: https://dev.azure.com/microsoft/WDATP/_git/UnrelatedRepo',
              'Wiki result: https://dev.azure.com/microsoft/WDATP/_wiki/wikis/Wiki?pagePath=%2FNoisy',
              'Pipeline result: https://dev.azure.com/microsoft/WDATP/_build/results?buildId=999',
              'PR result: https://dev.azure.com/microsoft/WDATP/_git/OtherRepo/pullrequest/321'
            ].join('\n')
          }
        }
      },
      {
        type: 'assistant.message',
        data: {
          parentToolCallId: 'call-review-agent',
          content: "Hidden review output: https://dev.azure.com/microsoft/WDATP/_git/NoisyRepo']`"
        }
      },
      {
        type: 'assistant.message',
        data: {
          parentToolCallId: '',
          content: 'Hidden review output with falsy parent id: https://dev.azure.com/microsoft/WDATP/_git/FalsyParentRepo'
        }
      }
    ]);

    const resources = await indexer._extractResources(sessionDir);

    expect(byType(resources, 'pr').map(resource => resource.id)).toEqual(['123']);
    expect(byType(resources, 'workitem').map(resource => resource.id)).toEqual(['456']);
    expect(byType(resources, 'pipeline').map(resource => resource.id)).toEqual(['789']);
    expect(byType(resources, 'repo')).toEqual([
      { type: 'repo', name: 'itsela-ms/DeepSky', url: 'https://github.com/itsela-ms/DeepSky' }
    ]);
    expect(byType(resources, 'wiki')).toHaveLength(0);
  });

  it('cleans code punctuation around visible repository URLs', async () => {
    const sessionDir = await createSession('repo-punctuation', [
      {
        type: 'assistant.message',
        data: {
          content: "Relevant repo: ['https://dev.azure.com/microsoft/WDATP/_git/DeepSky']`"
        }
      }
    ]);

    const resources = await indexer._extractResources(sessionDir);

    expect(byType(resources, 'repo')).toEqual([
      {
        type: 'repo',
        name: 'DeepSky',
        url: 'https://dev.azure.com/microsoft/WDATP/_git/DeepSky'
      }
    ]);
  });

  it('ignores internal tool-call resource IDs and uses tool output only to update visible PR status', async () => {
    const sessionDir = await createSession('tool-ids', [
      {
        type: 'assistant.message',
        data: {
          content: 'Related PR: https://dev.azure.com/microsoft/WDATP/_git/DeepSky/pullrequest/123'
        }
      },
      {
        type: 'tool.call',
        data: {
          toolName: 'ado-mcp-repo_get_pull_request_by_id',
          input: { repositoryId: 'repo-id', pullRequestId: 321 }
        }
      },
      {
        type: 'tool.call',
        data: {
          toolName: 'ado-mcp-wit_get_work_item',
          input: { project: 'OS', workItemId: 654 }
        }
      },
      {
        type: 'tool.execution_complete',
        data: {
          result: {
            content: '{"pullRequestId":123,"status":"completed"} {"pullRequestId":321,"status":"completed"} https://dev.azure.com/microsoft/WDATP/_git/NoiseRepo'
          }
        }
      },
      {
        type: 'user.message',
        data: {
          content: 'This visible JSON-shaped text must not update PR status: {"pullRequestId":123,"status":"abandoned"}'
        }
      }
    ]);

    const resources = await indexer._extractResources(sessionDir);

    expect(byType(resources, 'pr')).toEqual([
      {
        id: '123',
        url: 'https://dev.azure.com/microsoft/WDATP/_git/DeepSky/pullrequest/123',
        repo: 'DeepSky',
        type: 'pr',
        state: 'completed'
      }
    ]);
    expect(byType(resources, 'workitem')).toHaveLength(0);
    expect(byType(resources, 'repo')).toHaveLength(0);
  });

  it('rebuilds old resource caches with the stricter indexer while preserving manual resources', async () => {
    await createSession('cached-session', [
      {
        type: 'assistant.message',
        data: {
          content: 'Related PR: https://dev.azure.com/microsoft/WDATP/_git/DeepSky/pullrequest/42'
        }
      }
    ]);
    await fs.promises.writeFile(
      path.join(tmpDir, 'session-resources.json'),
      JSON.stringify({
        'cached-session': {
          version: 2,
          indexedAt: Date.now() + 60_000,
          resources: [{ type: 'repo', name: 'NoisyRepo', url: 'https://dev.azure.com/microsoft/WDATP/_git/NoisyRepo' }],
          manualResources: [{ type: 'link', url: 'https://example.com/design-note', name: 'example.com/design-note' }],
          removedKeys: ['repo:https://dev.azure.com/microsoft/WDATP/_git/NoisyRepo']
        }
      }),
      'utf8'
    );

    await indexer._loadCache();
    await indexer.rebuildIfStale();

    const entry = indexer.cache['cached-session'];
    expect(entry.version).toBe(5);
    expect(entry.resources).toEqual([
      {
        id: '42',
        url: 'https://dev.azure.com/microsoft/WDATP/_git/DeepSky/pullrequest/42',
        repo: 'DeepSky',
        type: 'pr',
        state: null
      }
    ]);
    expect(entry.manualResources).toEqual([
      { type: 'link', url: 'https://example.com/design-note', name: 'example.com/design-note' }
    ]);
  });

  it('uses events file mtime to refresh active session resources', async () => {
    const sessionDir = await createSession('active-session', [
      {
        type: 'assistant.message',
        data: {
          content: 'First PR: https://dev.azure.com/microsoft/WDATP/_git/DeepSky/pullrequest/10'
        }
      }
    ]);

    await indexer.rebuildIfStale();
    expect(byType(indexer.cache['active-session'].resources, 'pr').map(resource => resource.id)).toEqual(['10']);

    const eventsPath = path.join(sessionDir, 'events.jsonl');
    await fs.promises.appendFile(
      eventsPath,
      `${JSON.stringify({
        type: 'assistant.message',
        data: {
          content: 'Second PR: https://dev.azure.com/microsoft/WDATP/_git/DeepSky/pullrequest/11'
        }
      })}\n`,
      'utf8'
    );
    const future = new Date(indexer.cache['active-session'].indexedAt + 60_000);
    await fs.promises.utimes(eventsPath, future, future);

    await indexer.rebuildIfStale();

    expect(byType(indexer.cache['active-session'].resources, 'pr').map(resource => resource.id)).toEqual(['10', '11']);
  });

  it('adds queried work item titles to visible work item resources', async () => {
    const sessionDir = await createSession('work-item-title', [
      {
        type: 'assistant.message',
        data: {
          content: 'Work item: https://dev.azure.com/microsoft/OS/_workitems/edit/456'
        }
      },
      {
        type: 'tool.execution_complete',
        data: {
          result: {
            content: JSON.stringify({
              id: 456,
              fields: {
                'System.WorkItemType': 'Bug',
                'System.Title': 'Investigate terminal scrolling regression when mouse tracking is enabled'
              }
            })
          }
        }
      }
    ]);

    const resources = await indexer._extractResources(sessionDir);

    expect(byType(resources, 'workitem')).toEqual([
      {
        id: '456',
        url: 'https://dev.azure.com/microsoft/OS/_workitems/edit/456',
        type: 'workitem',
        workItemType: 'Bug',
        title: 'Investigate terminal scrolling regression when mouse tracking is enabled'
      }
    ]);
  });

  it('clears auto resources when events.jsonl is removed while preserving manual resources', async () => {
    const sessionDir = await createSession('missing-events-session', [
      {
        type: 'assistant.message',
        data: {
          content: 'Related PR: https://dev.azure.com/microsoft/WDATP/_git/DeepSky/pullrequest/12'
        }
      }
    ]);

    const originalExtract = indexer._extractResources.bind(indexer);
    let extractCount = 0;
    indexer._extractResources = async (...args) => {
      extractCount += 1;
      return originalExtract(...args);
    };

    await indexer.rebuildIfStale();
    indexer.cache['missing-events-session'].manualResources = [
      { type: 'link', url: 'https://example.com/manual-note', name: 'example.com/manual-note' }
    ];

    await fs.promises.rm(path.join(sessionDir, 'events.jsonl'));
    await indexer.rebuildIfStale();

    expect(indexer.cache['missing-events-session'].resources).toEqual([]);
    expect(indexer.cache['missing-events-session'].manualResources).toEqual([
      { type: 'link', url: 'https://example.com/manual-note', name: 'example.com/manual-note' }
    ]);
    expect(extractCount).toBe(2);

    await indexer.rebuildIfStale();

    expect(extractCount).toBe(2);
  });

  it('keeps the cache stale when events change during extraction', async () => {
    const sessionDir = await createSession('race-session', [
      {
        type: 'assistant.message',
        data: {
          content: 'Initial PR: https://dev.azure.com/microsoft/WDATP/_git/DeepSky/pullrequest/20'
        }
      }
    ]);

    await indexer.rebuildIfStale();

    const eventsPath = path.join(sessionDir, 'events.jsonl');
    const staleTime = new Date(indexer.cache['race-session'].indexedAt + 60_000);
    await fs.promises.utimes(eventsPath, staleTime, staleTime);

    const originalExtractResources = indexer._extractResources.bind(indexer);
    let extractionCount = 0;
    indexer._extractResources = async (dir) => {
      extractionCount += 1;
      if (extractionCount === 1) {
        await fs.promises.appendFile(
          eventsPath,
          `${JSON.stringify({
            type: 'assistant.message',
            data: {
              content: 'Concurrent PR: https://dev.azure.com/microsoft/WDATP/_git/DeepSky/pullrequest/21'
            }
          })}\n`,
          'utf8'
        );
        const concurrentTime = new Date(staleTime.getTime() + 60_000);
        await fs.promises.utimes(eventsPath, concurrentTime, concurrentTime);
        return [
          {
            id: '20',
            url: 'https://dev.azure.com/microsoft/WDATP/_git/DeepSky/pullrequest/20',
            repo: 'DeepSky',
            type: 'pr',
            state: null
          }
        ];
      }
      return originalExtractResources(dir);
    };

    await indexer.rebuildIfStale();
    expect(byType(indexer.cache['race-session'].resources, 'pr').map(resource => resource.id)).toEqual(['20']);

    await indexer.rebuildIfStale();
    expect(extractionCount).toBe(2);
    expect(byType(indexer.cache['race-session'].resources, 'pr').map(resource => resource.id)).toEqual(['20', '21']);
  });

  it('parses GitHub repository URLs as manual repo resources', () => {
    expect(ResourceIndexer.parseUrlToResource('https://github.com/itsela-ms/DeepSky/releases/latest')).toEqual({
      type: 'repo',
      name: 'itsela-ms/DeepSky',
      url: 'https://github.com/itsela-ms/DeepSky'
    });
    expect(ResourceIndexer.parseUrlToResource('https://github.com/org/repo.with.dots.git')).toEqual({
      type: 'repo',
      name: 'org/repo.with.dots',
      url: 'https://github.com/org/repo.with.dots'
    });
    expect(ResourceIndexer.parseUrlToResource('https://github.com/org/repo.with.dots.')).toEqual({
      type: 'repo',
      name: 'org/repo.with.dots',
      url: 'https://github.com/org/repo.with.dots'
    });
  });

  it('normalizes sentence punctuation and ignores traversal-shaped GitHub URLs', async () => {
    const sessionDir = await createSession('github-edge-cases', [
      {
        type: 'assistant.message',
        data: {
          content: [
            'Related repo: https://github.com/itsela-ms/DeepSky.',
            'Ignore traversal: https://github.com/owner/../../../etc/passwd',
            'Ignore host traversal: https://github.com/../../../etc/passwd'
          ].join('\n')
        }
      }
    ]);

    const resources = await indexer._extractResources(sessionDir);

    expect(byType(resources, 'repo')).toEqual([
      {
        type: 'repo',
        name: 'itsela-ms/DeepSky',
        url: 'https://github.com/itsela-ms/DeepSky'
      }
    ]);
    expect(byType(resources, 'repo').map(resource => resource.url)).not.toContain('https://github.com/owner/..');
  });
});
