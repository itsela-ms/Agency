const fs = require('fs');
const path = require('path');
const readline = require('readline');

const CACHE_FILE = 'session-resources.json';
const REBUILD_INTERVAL_MS = 10 * 60 * 1000;

// Patterns for extracting resources
const PR_URL_RE = /https?:\/\/[^\s"\\)]*\/pullrequest\/(\d+)/g;
const WI_URL_RE = /https?:\/\/[^\s"\\)]*\/_workitems\/edit\/(\d+)/g;
const GIT_URL_RE = /https?:\/\/(?:microsoft\.visualstudio\.com|dev\.azure\.com\/microsoft)\/(?:DefaultCollection\/)?(\w+)\/_git\/([^\s"\\);,]+)/g;
const WIKI_URL_RE = /https?:\/\/[^\s"\\)]*\/_wiki\/[^\s"\\)]+/g;
const PR_ID_TOOL_RE = /"pullRequestId"\s*:\s*(\d+)/g;
const WI_ID_TOOL_RE = /"workItemId"\s*:\s*(\d+)/g;

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
      if (cached) {
        try {
          const stat = await fs.promises.stat(sessionDir);
          if (stat.mtime.getTime() <= cached.indexedAt) continue;
        } catch { continue; }
      }

      const resources = await this._extractResources(sessionDir);
      this.cache[sessionId] = { resources, indexedAt: Date.now() };
      updated = true;
    }

    if (updated) await this._saveCache();
  }

  async _extractResources(sessionDir) {
    const eventsPath = path.join(sessionDir, 'events.jsonl');
    try { await fs.promises.access(eventsPath); } catch { return []; }

    const prs = new Map();       // prId -> { id, url?, repo? }
    const workItems = new Map(); // wiId -> { id, url? }
    const repos = new Set();     // repo URLs
    const wikiUrls = new Set();

    return new Promise((resolve) => {
      const stream = fs.createReadStream(eventsPath, { encoding: 'utf8' });
      const rl = readline.createInterface({ input: stream, crlfDelay: Infinity });

      rl.on('line', (line) => {
        // Search the raw line for efficiency (most patterns work across any field)
        let m;

        // PR URLs (includes PR ID + repo context)
        const prUrlRe = new RegExp(PR_URL_RE.source, 'g');
        while ((m = prUrlRe.exec(line)) !== null) {
          const prId = m[1];
          const url = m[0].replace(/[)}\]"\\]+$/, ''); // strip trailing junk
          const repoMatch = url.match(/_git\/([^/]+)\/pullrequest/);
          prs.set(prId, {
            id: prId,
            url,
            repo: repoMatch ? repoMatch[1] : null,
            type: 'pr'
          });
        }

        // PR IDs from tool calls
        const prIdRe = new RegExp(PR_ID_TOOL_RE.source, 'g');
        while ((m = prIdRe.exec(line)) !== null) {
          const prId = m[1];
          if (!prs.has(prId)) {
            prs.set(prId, { id: prId, url: null, repo: null, type: 'pr' });
          }
        }

        // Work item URLs
        const wiUrlRe = new RegExp(WI_URL_RE.source, 'g');
        while ((m = wiUrlRe.exec(line)) !== null) {
          const wiId = m[1];
          const url = m[0].replace(/[)}\]"\\]+$/, '');
          workItems.set(wiId, { id: wiId, url, type: 'workitem' });
        }

        // Work item IDs from tool calls
        const wiIdRe = new RegExp(WI_ID_TOOL_RE.source, 'g');
        while ((m = wiIdRe.exec(line)) !== null) {
          const wiId = m[1];
          if (!workItems.has(wiId)) {
            workItems.set(wiId, { id: wiId, url: null, type: 'workitem' });
          }
        }

        // Git repo URLs (exclude PR URLs)
        const gitUrlRe = new RegExp(GIT_URL_RE.source, 'g');
        while ((m = gitUrlRe.exec(line)) !== null) {
          let repoUrl = m[0].replace(/[)}\]"\\;,]+$/, '');
          if (!repoUrl.includes('/pullrequest/')) {
            repos.add(repoUrl);
          }
        }

        // Wiki URLs
        const wikiRe = new RegExp(WIKI_URL_RE.source, 'g');
        while ((m = wikiRe.exec(line)) !== null) {
          wikiUrls.add(m[0].replace(/[)}\]"\\]+$/, ''));
        }
      });

      rl.on('close', () => {
        const resources = [
          ...[...prs.values()],
          ...[...workItems.values()],
          ...[...repos].map(url => {
            const repoName = url.match(/_git\/(.+)/)?.[1] || url;
            return { type: 'repo', name: repoName, url };
          }),
          ...[...wikiUrls].map(url => ({ type: 'wiki', url }))
        ];
        resolve(resources);
      });

      rl.on('error', () => resolve([]));
    });
  }

  getResourcesForSession(sessionId) {
    return this.cache[sessionId]?.resources || [];
  }

  search(query) {
    const q = query.toLowerCase();
    const results = new Set();

    for (const [sessionId, entry] of Object.entries(this.cache)) {
      for (const r of entry.resources) {
        if (r.id && r.id.includes(q)) { results.add(sessionId); break; }
        if (r.url && r.url.toLowerCase().includes(q)) { results.add(sessionId); break; }
        if (r.name && r.name.toLowerCase().includes(q)) { results.add(sessionId); break; }
        if (r.repo && r.repo.toLowerCase().includes(q)) { results.add(sessionId); break; }
      }
    }

    return results;
  }
}

module.exports = ResourceIndexer;
