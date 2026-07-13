function parseChangelog(markdown) {
  if (!markdown || typeof markdown !== 'string') {
    return [];
  }

  const releases = [];
  let currentRelease = null;
  let currentSection = null;

  const ensureSection = (title = 'Notes') => {
    if (!currentRelease) {
      return null;
    }
    currentSection = { title, items: [] };
    currentRelease.sections.push(currentSection);
    return currentSection;
  };

  for (const rawLine of markdown.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line) {
      continue;
    }

    const releaseMatch = line.match(/^## \[(.+?)\] - (.+)$/);
    if (releaseMatch) {
      currentRelease = {
        version: releaseMatch[1].trim(),
        date: releaseMatch[2].trim(),
        sections: [],
      };
      releases.push(currentRelease);
      currentSection = null;
      continue;
    }

    if (!currentRelease) {
      continue;
    }

    const sectionMatch = line.match(/^### (.+)$/);
    if (sectionMatch) {
      ensureSection(sectionMatch[1].trim());
      continue;
    }

    const bulletMatch = line.match(/^- (.+)$/);
    if (bulletMatch) {
      const section = currentSection || ensureSection();
      section.items.push(bulletMatch[1].trim());
    }
  }

  return releases.filter(release => release.sections.some(section => section.items.length > 0));
}

function isPrereleaseVersion(version) {
  return String(version || '').includes('-');
}

function getRecentChangelogReleases(markdown, limit = 3, options = {}) {
  if (!Number.isFinite(limit) || limit <= 0) {
    return [];
  }

  const currentVersion = String(options.currentVersion || '').trim();
  const currentIsPrerelease = isPrereleaseVersion(currentVersion);
  return parseChangelog(markdown)
    .filter((release) => {
      if (!isPrereleaseVersion(release.version)) {
        return true;
      }
      return currentIsPrerelease && release.version === currentVersion;
    })
    .slice(0, limit);
}

module.exports = {
  parseChangelog,
  getRecentChangelogReleases,
  isPrereleaseVersion,
};
