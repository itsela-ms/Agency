const fs = require('fs');
const path = require('path');
const readline = require('readline');

const CACHE_FILE = 'session-resources.json';
const RESOURCE_INDEX_VERSION = 5;
const REBUILD_INTERVAL_MS = 10 * 60 * 1000;
const VISIBLE_TEXT_KEYS = new Set(['content', 'text', 'body', 'title', 'summary', 'markdown', 'message']);
const PR_STATUS_MAP = {
  '1': 'active',
  '2': 'abandoned',
  '3': 'completed',
  active: 'active',
  abandoned: 'abandoned',
  completed: 'completed'
};

// Patterns for extracting resources
const PR_URL_RE = /https?:\/\/[^\s"\\)]*\/pullrequest\/(\d+)/g;
const WI_URL_RE = /https?:\/\/[^\s"\\)]*\/_workitems\/edit\/(\d+)/g;
const GIT_URL_RE = /https?:\/\/(?:microsoft\.visualstudio\.com|dev\.azure\.com\/microsoft)\/(?:DefaultCollection\/)?(\w+)\/_git\/([^\s"'`\\)\]\};,]+)/g;
const WIKI_URL_RE = /https?:\/\/[^\s"\\)]*\/_wiki\/[^\s"\\)]+/g;
const PIPELINE_URL_RE = /https?:\/\/[^\s"\\)]*\/_build\/results\?buildId=(\d+)[^\s"\\)]*/g;
const PIPELINE_DEF_URL_RE = /https?:\/\/[^\s"\\)]*\/_build\?definitionId=(\d+)[^\s"\\)]*/g;
const RELEASE_URL_RE = /https?:\/\/[^\s"\\)]*\/_releaseProgress\?[^\s"\\)]*releaseId=(\d+)[^\s"\\)]*/g;
const GITHUB_REPO_URL_RE = /https?:\/\/github\.com\/[A-Za-z0-9](?:[A-Za-z0-9-]{0,37}[A-Za-z0-9])?\/[A-Za-z0-9_.-]+(?:\.git)?(?:[/?#][^\s"'`\\)\]\};,]*)?/g;
const PR_STATUS_RE = /"pullRequestId"\s*:\s*(\d+)[^}]*?"status"\s*:\s*"(active|completed|abandoned)"/gi;
const PR_STATUS_ESCAPED_RE = /\\?"pullRequestId\\?"\s*:\s*(\d+)[\s\S]{0,200}?\\?"status\\?"\s*:\s*(\d+|\\?"(?:active|completed|abandoned)\\?")/gi;

function stripTrailingUrlJunk(url) {
  return (url || '').replace(/[)}\]'"`\\;,]+$/, '');
}

function stripTrailingSentencePunctuation(url) {
  return (url || '').replace(/[.!?]+$/, '');
}

function normalizeRepoCandidateUrl(url) {
  return stripTrailingSentencePunctuation(
    stripTrailingUrlJunk(url).replace(/[?#].*$/, '').replace(/\/+$/, '')
  );
}

function normalizeGitHubRepoUrl(url) {
  url = normalizeRepoCandidateUrl(url);
  const github = url.match(/^https?:\/\/github\.com\/([^/]+)\/([^/]+)(?:\/.*)?$/i);
  if (!github) return null;

  const owner = github[1];
  const repo = stripTrailingSentencePunctuation(github[2].replace(/\.git$/i, ''));
  if (!owner || !repo || owner === '.' || owner === '..' || repo === '.' || repo === '..') {
    return null;
  }

  return `https://github.com/${owner}/${repo}`;
}

function normalizeRepoUrl(url) {
  url = normalizeRepoCandidateUrl(url);
  const githubUrl = normalizeGitHubRepoUrl(url);
  if (githubUrl) return githubUrl;
  // Canonicalize host variants to a consistent form
  url = url.replace(/microsoft\.visualstudio\.com/, 'dev.azure.com/microsoft');
  url = url.replace(/\/DefaultCollection\//, '/');
  // Strip path segments after /_git/RepoName
  const gitIdx = url.indexOf('/_git/');
  if (gitIdx !== -1) {
    const afterGit = url.substring(gitIdx + 6);
    const repoName = afterGit.split('/')[0];
    url = url.substring(0, gitIdx + 6) + repoName;
  }
  return url;
}

function repoNameFromUrl(url) {
  const github = normalizeRepoUrl(url).match(/^https?:\/\/github\.com\/([^/]+\/[^/]+)$/i);
  if (github) return github[1];
  return normalizeRepoUrl(url).match(/_git\/(.+)/)?.[1] || url;
}

function resourceKey(r) {
  if (r.id) return `${r.type}:${r.id}`;
  const url = r.type === 'repo' ? normalizeRepoUrl(r.url) : (r.url || '').replace(/[?#].*$/, '').replace(/\/+$/, '');
  return `${r.type}:${url}`;
}

function collectRenderableStrings(value, push, keyHint = '') {
  if (!value) return;

  if (typeof value === 'string') {
    if (!keyHint || VISIBLE_TEXT_KEYS.has(keyHint)) push(value);
    return;
  }

  if (Array.isArray(value)) {
    for (const item of value) collectRenderableStrings(item, push, keyHint);
    return;
  }

  if (typeof value === 'object') {
    for (const [key, nested] of Object.entries(value)) {
      collectRenderableStrings(nested, push, key);
    }
  }
}

function collectVisibleAssistantTexts(data, push) {
  if (!data) return;
  collectRenderableStrings(data.content, push, 'content');
  collectRenderableStrings(data.sections, push);
  collectRenderableStrings(data.parts, push);
  collectRenderableStrings(data.blocks, push);
}

function isChildAssistantMessage(data) {
  return !!data && typeof data === 'object' && Object.prototype.hasOwnProperty.call(data, 'parentToolCallId');
}

function collectVisibleResourceTexts(event) {
  const texts = [];
  const push = (text) => {
    const normalized = String(text || '').trim();
    if (normalized) texts.push(normalized);
  };

  if (event?.type === 'user.message') {
    push(event.data?.content);
    push(event.data?.transformedContent);
  } else if (event?.type === 'assistant.message' && !isChildAssistantMessage(event.data)) {
    collectVisibleAssistantTexts(event.data, push);
  }

  return texts;
}

function canUseEventForPrStatus(event) {
  return event?.type === 'tool.execution_complete';
}

function collectWorkItemMetadataCandidates(value, metadata) {
  if (!value) return;

  if (typeof value === 'string') {
    const trimmed = value.trim();
    if (!trimmed) return;
    if ((trimmed.startsWith('{') && trimmed.endsWith('}')) || (trimmed.startsWith('[') && trimmed.endsWith(']'))) {
      try {
        collectWorkItemMetadataCandidates(JSON.parse(trimmed), metadata);
      } catch {}
    }
    return;
  }

  if (Array.isArray(value)) {
    for (const item of value) collectWorkItemMetadataCandidates(item, metadata);
    return;
  }

  if (typeof value === 'object') {
    const id = value.id ?? value.workItemId;
    const title = value.fields?.['System.Title'] ?? value.fields?.System_Title;
    const workItemType = value.fields?.['System.WorkItemType'] ?? value.fields?.System_WorkItemType ?? value.workItemType;
    if (id !== undefined) {
      const existing = metadata.get(String(id)) || {};
      const next = { ...existing };
      if (typeof title === 'string' && title.trim()) next.title = title.trim();
      if (typeof workItemType === 'string' && workItemType.trim()) next.workItemType = workItemType.trim();
      if (next.title || next.workItemType) metadata.set(String(id), next);
    }
    for (const nested of Object.values(value)) {
      collectWorkItemMetadataCandidates(nested, metadata);
    }
  }
}

class ResourceIndexer {
  constructor(sessionStateDir) {
    this.sessionStateDir = sessionStateDir;
    this.cachePath = path.join(sessionStateDir, CACHE_FILE);
    this.cache = {};
    this._rebuildTimer = null;
  }

  async init() {
    await this._loadCache();
    await this.rebuildIfStale();
    this._startPeriodicRebuild();
  }

  async _loadCache() {
    try {
      const data = await fs.promises.readFile(this.cachePath, 'utf8');
      this.cache = JSON.parse(data);
    } catch {
      this.cache = {};
    }
  }

  async _saveCache() {
    try {
      await fs.promises.writeFile(this.cachePath, JSON.stringify(this.cache, null, 2), 'utf8');
    } catch {}
  }

  _startPeriodicRebuild() {
    this._rebuildTimer = setInterval(() => this.rebuildIfStale(), REBUILD_INTERVAL_MS);
  }

  stop() {
    if (this._rebuildTimer) clearInterval(this._rebuildTimer);
  }

  async rebuildIfStale() {
    const entries = await fs.promises.readdir(this.sessionStateDir, { withFileTypes: true });
    const currentIds = new Set(entries.filter(e => e.isDirectory()).map(e => e.name));
    let updated = false;

    // Prune orphaned cache entries
    for (const id of Object.keys(this.cache)) {
      if (!currentIds.has(id)) { delete this.cache[id]; updated = true; }
    }

    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const sessionId = entry.name;
      const sessionDir = path.join(this.sessionStateDir, sessionId);

      const cached = this.cache[sessionId];
      let eventsMtime = null;
      try {
        const stat = await fs.promises.stat(path.join(sessionDir, 'events.jsonl'));
        eventsMtime = stat.mtime.getTime();
      } catch (err) {
        if (err?.code !== 'ENOENT') continue;
      }
      if (cached?.version === RESOURCE_INDEX_VERSION) {
        if (eventsMtime === null && Array.isArray(cached.resources) && cached.resources.length === 0) continue;
        if (eventsMtime !== null && eventsMtime <= cached.indexedAt) continue;
      }

      const resources = await this._extractResources(sessionDir);
      this.cache[sessionId] = {
        ...cached,
        resources,
        indexedAt: eventsMtime ?? Date.now(),
        version: RESOURCE_INDEX_VERSION
      };
      updated = true;
    }

    if (updated) await this._saveCache();
  }

  async _extractResources(sessionDir) {
    const eventsPath = path.join(sessionDir, 'events.jsonl');
    try { await fs.promises.access(eventsPath); } catch { return []; }

    const prs = new Map();       // prId -> { id, url?, repo? }
    const workItems = new Map(); // wiId -> { id, url? }
    const workItemMetadata = new Map(); // wiId -> title/type from visible/queried WI metadata
    const repos = new Set();     // repo URLs
    const wikiUrls = new Set();
    const pipelines = new Map(); // buildId -> { id, url }
    const releases = new Map();  // releaseId -> { id, url }

    return new Promise((resolve) => {
      const stream = fs.createReadStream(eventsPath, { encoding: 'utf8' });
      const rl = readline.createInterface({ input: stream, crlfDelay: Infinity });

      rl.on('line', (line) => {
        let event;
        try { event = JSON.parse(line); } catch { return; }

        // Only visible user/assistant text creates URL resources. Tool output can
        // include large search/result payloads that are not intentionally related.
        const visibleTexts = collectVisibleResourceTexts(event);
        for (const text of visibleTexts) {
          let m;

          // PR URLs (includes PR ID + repo context)
          const prUrlRe = new RegExp(PR_URL_RE.source, 'g');
          while ((m = prUrlRe.exec(text)) !== null) {
            const prId = m[1];
            const url = stripTrailingUrlJunk(m[0]);
            const repoMatch = url.match(/_git\/([^/]+)\/pullrequest/);
            const existing = prs.get(prId);
            if (existing) {
              if (!existing.url) existing.url = url;
              if (!existing.repo && repoMatch) existing.repo = repoMatch[1];
            } else {
              prs.set(prId, {
                id: prId,
                url,
                repo: repoMatch ? repoMatch[1] : null,
                type: 'pr',
                state: null
              });
            }
          }

          // Work item URLs
          const wiUrlRe = new RegExp(WI_URL_RE.source, 'g');
          while ((m = wiUrlRe.exec(text)) !== null) {
            const wiId = m[1];
            const url = stripTrailingUrlJunk(m[0]);
            workItems.set(wiId, { id: wiId, url, type: 'workitem', ...workItemMetadata.get(wiId) });
          }

          // Git repo URLs (exclude PR URLs)
          const gitUrlRe = new RegExp(GIT_URL_RE.source, 'g');
          while ((m = gitUrlRe.exec(text)) !== null) {
            let repoUrl = stripTrailingUrlJunk(m[0]);
            if (!repoUrl.includes('/pullrequest/')) {
              repos.add(normalizeRepoUrl(repoUrl));
            }
          }

          const githubRepoRe = new RegExp(GITHUB_REPO_URL_RE.source, 'g');
          while ((m = githubRepoRe.exec(text)) !== null) {
            const repoUrl = normalizeGitHubRepoUrl(m[0]);
            if (repoUrl) repos.add(repoUrl);
          }

          // Wiki URLs
          const wikiRe = new RegExp(WIKI_URL_RE.source, 'g');
          while ((m = wikiRe.exec(text)) !== null) {
            wikiUrls.add(stripTrailingUrlJunk(m[0]));
          }

          // Pipeline URLs (build results)
          const pipelineRe = new RegExp(PIPELINE_URL_RE.source, 'g');
          while ((m = pipelineRe.exec(text)) !== null) {
            const buildId = m[1];
            if (!pipelines.has(buildId)) {
              pipelines.set(buildId, { id: buildId, url: stripTrailingUrlJunk(m[0]), type: 'pipeline' });
            }
          }
          const pipelineDefRe = new RegExp(PIPELINE_DEF_URL_RE.source, 'g');
          while ((m = pipelineDefRe.exec(text)) !== null) {
            const defId = `def-${m[1]}`;
            if (!pipelines.has(defId)) {
              pipelines.set(defId, { id: defId, url: stripTrailingUrlJunk(m[0]), type: 'pipeline' });
            }
          }

          // Release URLs
          const releaseRe = new RegExp(RELEASE_URL_RE.source, 'g');
          while ((m = releaseRe.exec(text)) !== null) {
            const releaseId = m[1];
            if (!releases.has(releaseId)) {
              releases.set(releaseId, { id: releaseId, url: stripTrailingUrlJunk(m[0]), type: 'release' });
            }
          }
        }

        if (canUseEventForPrStatus(event)) {
          let m;
          collectWorkItemMetadataCandidates(event.data, workItemMetadata);
          for (const [wiId, metadata] of workItemMetadata) {
            const existing = workItems.get(wiId);
            if (existing) {
              if (!existing.title && metadata.title) existing.title = metadata.title;
              if (!existing.workItemType && metadata.workItemType) existing.workItemType = metadata.workItemType;
            }
          }

          // PR status from tool payloads (e.g. "pullRequestId": 123, ..., "status": "Active")
          const prStatusRe = new RegExp(PR_STATUS_RE.source, 'gi');
          while ((m = prStatusRe.exec(line)) !== null) {
            const prId = m[1];
            const state = m[2].toLowerCase();
            const existing = prs.get(prId);
            if (existing) {
              existing.state = state;
            }
          }

          // PR status from escaped JSON in tool responses (e.g. \"status\":1 or \"status\":\"active\")
          const prStatusEscRe = new RegExp(PR_STATUS_ESCAPED_RE.source, 'gi');
          while ((m = prStatusEscRe.exec(line)) !== null) {
            const prId = m[1];
            const rawState = m[2].replace(/\\?"/g, '');
            const state = PR_STATUS_MAP[rawState.toLowerCase()];
            if (state) {
              const existing = prs.get(prId);
              if (existing) existing.state = state;
            }
          }
        }
      });

      rl.on('close', () => {
        const resources = [
          ...[...prs.values()],
          ...[...workItems.values()],
          ...[...repos].map(url => {
            const repoName = repoNameFromUrl(url);
            return { type: 'repo', name: repoName, url };
          }),
          ...[...wikiUrls].map(url => ({ type: 'wiki', url })),
          ...[...pipelines.values()],
          ...[...releases.values()]
        ];
        resolve(resources);
      });

      rl.on('error', () => resolve([]));
    });
  }

  getResourcesForSession(sessionId) {
    const entry = this.cache[sessionId];
    if (!entry) return [];
    const auto = entry.resources || [];
    const manual = entry.manualResources || [];
    const removed = new Set(entry.removedKeys || []);
    const seen = new Set();
    const merged = [];
    for (const r of [...auto, ...manual]) {
      const key = resourceKey(r);
      if (removed.has(key) || seen.has(key)) continue;
      seen.add(key);
      merged.push(r);
    }
    return merged;
  }

  async addManualResource(sessionId, resource) {
    if (!this.cache[sessionId]) {
      this.cache[sessionId] = { resources: [], indexedAt: 0, version: RESOURCE_INDEX_VERSION };
    }
    const entry = this.cache[sessionId];
    if (!entry.manualResources) entry.manualResources = [];
    if (!entry.removedKeys) entry.removedKeys = [];

    const key = resourceKey(resource);
    // Check for duplicates across auto + manual
    const allKeys = new Set([
      ...(entry.resources || []).map(resourceKey),
      ...entry.manualResources.map(resourceKey)
    ]);
    if (allKeys.has(key)) return { added: false, reason: 'duplicate' };

    // Un-remove if it was previously removed
    entry.removedKeys = entry.removedKeys.filter(k => k !== key);

    entry.manualResources.push(resource);
    await this._saveCache();
    return { added: true };
  }

  async removeResource(sessionId, key) {
    const entry = this.cache[sessionId];
    if (!entry) return;
    if (!entry.removedKeys) entry.removedKeys = [];
    if (!entry.removedKeys.includes(key)) entry.removedKeys.push(key);
    // Also remove from manual if it was manually added
    if (entry.manualResources) {
      entry.manualResources = entry.manualResources.filter(r => resourceKey(r) !== key);
    }
    await this._saveCache();
  }

  search(query) {
    const q = query.toLowerCase();
    const results = new Set();

    for (const [sessionId, entry] of Object.entries(this.cache)) {
      for (const r of entry.resources || []) {
        if (r.id && r.id.includes(q)) { results.add(sessionId); break; }
        if (r.url && r.url.toLowerCase().includes(q)) { results.add(sessionId); break; }
        if (r.name && r.name.toLowerCase().includes(q)) { results.add(sessionId); break; }
        if (r.title && r.title.toLowerCase().includes(q)) { results.add(sessionId); break; }
        if (r.workItemType && r.workItemType.toLowerCase().includes(q)) { results.add(sessionId); break; }
        if (r.repo && r.repo.toLowerCase().includes(q)) { results.add(sessionId); break; }
      }
    }

    return results;
  }
}

module.exports = ResourceIndexer;
module.exports.resourceKey = resourceKey;

module.exports.parseUrlToResource = function parseUrlToResource(url) {
  url = url.trim();
  let m;
  if ((m = url.match(/\/pullrequest\/(\d+)/))) {
    const repoMatch = url.match(/_git\/([^/]+)\/pullrequest/);
    return { type: 'pr', id: m[1], url, repo: repoMatch ? repoMatch[1] : null, state: null };
  }
  if ((m = url.match(/\/_workitems\/edit\/(\d+)/))) {
    return { type: 'workitem', id: m[1], url };
  }
  if ((m = url.match(/\/_build\/results\?buildId=(\d+)/))) {
    return { type: 'pipeline', id: m[1], url };
  }
  if ((m = url.match(/\/_build\?definitionId=(\d+)/))) {
    return { type: 'pipeline', id: `def-${m[1]}`, url };
  }
  if ((m = url.match(/releaseId=(\d+)/))) {
    return { type: 'release', id: m[1], url };
  }
  if (url.match(/_wiki\//)) {
    return { type: 'wiki', url };
  }
  if (url.match(/_git\//)) {
    url = normalizeRepoUrl(url);
    const repoName = repoNameFromUrl(url);
    return { type: 'repo', name: repoName, url };
  }
  const githubUrl = normalizeGitHubRepoUrl(url);
  if (githubUrl) {
    url = githubUrl;
    const repoName = repoNameFromUrl(url);
    return { type: 'repo', name: repoName, url };
  }
  // Generic link
  return { type: 'link', url, name: url.replace(/^https?:\/\//, '').split('/').slice(0, 3).join('/') };
};
