const fs = require('fs');
const path = require('path');
const yaml = require('js-yaml');
const readline = require('readline');

class SessionService {
  constructor(sessionStateDir) {
    this.dir = sessionStateDir;
  }

  async listSessions() {
    const entries = await fs.promises.readdir(this.dir, { withFileTypes: true });
    const sessions = [];

    for (const entry of entries) {
      if (!entry.isDirectory()) continue;

      const sessionDir = path.join(this.dir, entry.name);
      const yamlPath = path.join(sessionDir, 'workspace.yaml');

      try {
        const yamlContent = await fs.promises.readFile(yamlPath, 'utf8');
        const meta = yaml.load(yamlContent);

        let title = null;
        let isCustomTitle = false;

        // Check for manual rename (takes priority, never overridden)
        const customTitlePath = path.join(sessionDir, '.deepsky-title');
        try {
          title = (await fs.promises.readFile(customTitlePath, 'utf8')).trim();
          isCustomTitle = !!title;
        } catch {
          // No custom title — fall through to auto-detection
        }

        if (!title) {
          title = meta.summary || null;
        }

        // If no summary, try to extract from first user message in events.jsonl
        if (!title) {
          title = await this._extractTitleFromEvents(sessionDir);
        }

        if (!title) {
          title = `Session ${entry.name.substring(0, 8)}`;
        }

        if (!isCustomTitle) {
          // Clean up titles that are raw prompts (quoted strings from knowledge queries)
          if (title.startsWith('"')) {
            title = title.replace(/^"/, '').replace(/"$/, '');
            if (title.startsWith("Use the 'knowledge-based-answer'")) {
              const match = title.match(/answer:\s*(.+)/);
              title = match ? match[1].substring(0, 60) : title.substring(0, 60);
            }
            if (title.startsWith('Follow the workflow')) {
              title = title.substring(0, 60);
            }
          }

          // Truncate long titles
          if (title.length > 70) {
            title = title.substring(0, 67) + '...';
          }
        }

        const stat = await fs.promises.stat(sessionDir);
        sessions.push({
          id: entry.name,
          title,
          cwd: meta.cwd || '',
          createdAt: meta.created_at || stat.birthtime.toISOString(),
          updatedAt: meta.updated_at || stat.mtime.toISOString(),
          lastModified: stat.mtime.getTime()
        });
      } catch {
        // Skip sessions with unreadable metadata
      }
    }

    // Sort by last modified, newest first
    sessions.sort((a, b) => b.lastModified - a.lastModified);
    return sessions;
  }

  async _extractTitleFromEvents(sessionDir) {
    const eventsPath = path.join(sessionDir, 'events.jsonl');
    try {
      await fs.promises.access(eventsPath);
    } catch {
      return null;
    }

    return new Promise((resolve) => {
      const stream = fs.createReadStream(eventsPath, { encoding: 'utf8' });
      const rl = readline.createInterface({ input: stream, crlfDelay: Infinity });
      let found = false;

      rl.on('line', (line) => {
        if (found) return;
        try {
          const event = JSON.parse(line);
          if (event.type === 'user.message' && event.data?.content) {
            found = true;
            let content = event.data.content;
            // Strip leading whitespace and take first line
            content = content.trim().split('\n')[0];
            // Truncate
            if (content.length > 70) {
              content = content.substring(0, 67) + '...';
            }
            resolve(content);
            rl.close();
            stream.destroy();
          }
        } catch {
          // skip malformed lines
        }
      });

      rl.on('close', () => {
        if (!found) resolve(null);
      });
    });
  }

  async cleanEmptySessions() {
    const entries = await fs.promises.readdir(this.dir, { withFileTypes: true });
    let cleaned = 0;

    for (const entry of entries) {
      if (!entry.isDirectory()) continue;

      const sessionDir = path.join(this.dir, entry.name);
      const eventsPath = path.join(sessionDir, 'events.jsonl');

      try {
        const eventsExist = await fs.promises.access(eventsPath).then(() => true).catch(() => false);

        if (!eventsExist) {
          // No events file at all — check if workspace.yaml has a summary
          const yamlPath = path.join(sessionDir, 'workspace.yaml');
          try {
            const yamlContent = await fs.promises.readFile(yamlPath, 'utf8');
            const meta = yaml.load(yamlContent);
            if (!meta.summary) {
              await fs.promises.rm(sessionDir, { recursive: true, force: true });
              cleaned++;
            }
          } catch {
            await fs.promises.rm(sessionDir, { recursive: true, force: true });
            cleaned++;
          }
          continue;
        }

        // Events file exists but may be empty
        const stat = await fs.promises.stat(eventsPath);
        if (stat.size === 0) {
          const yamlPath = path.join(sessionDir, 'workspace.yaml');
          try {
            const yamlContent = await fs.promises.readFile(yamlPath, 'utf8');
            const meta = yaml.load(yamlContent);
            if (!meta.summary) {
              await fs.promises.rm(sessionDir, { recursive: true, force: true });
              cleaned++;
            }
          } catch {
            await fs.promises.rm(sessionDir, { recursive: true, force: true });
            cleaned++;
          }
        }
      } catch {
        // Skip errors
      }
    }

    console.log(`Cleaned ${cleaned} empty sessions`);
    return cleaned;
  }
  async renameSession(sessionId, title) {
    const customTitlePath = path.join(this.dir, sessionId, '.deepsky-title');
    await fs.promises.writeFile(customTitlePath, title.trim(), 'utf8');
  }

  async deleteSession(sessionId) {
    const sessionDir = path.join(this.dir, sessionId);
    await fs.promises.rm(sessionDir, { recursive: true, force: true });
  }
}

module.exports = SessionService;
