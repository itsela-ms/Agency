import { describe, it, expect } from 'vitest';

const { parseChangelog, getRecentChangelogReleases, isPrereleaseVersion } = require('../src/changelog-utils');

const SAMPLE_CHANGELOG = `# Changelog

## [1.2.0] - 2026-05-18

### Changed
- **Better visibility** for release notes
- \`Ctrl+Shift+T\` works again

### Fixed
- Sidebar restore uses full session inventory

## [1.2.0-beta.1] - 2026-05-17

### Fixed
- Beta-only fix

## [1.1.0] - 2026-05-04

### Added
- New About tab

## [1.0.0] - 2026-04-26

- Plain note before any explicit section
`;

describe('changelog-utils', () => {
  it('parses releases, sections, and bullet items', () => {
    const releases = parseChangelog(SAMPLE_CHANGELOG);
    expect(releases).toHaveLength(4);
    expect(releases[0]).toEqual({
      version: '1.2.0',
      date: '2026-05-18',
      sections: [
        {
          title: 'Changed',
          items: [
            '**Better visibility** for release notes',
            '`Ctrl+Shift+T` works again',
          ],
        },
        {
          title: 'Fixed',
          items: [
            'Sidebar restore uses full session inventory',
          ],
        },
      ],
    });
  });

  it('limits the recent release view without reordering entries', () => {
    const releases = getRecentChangelogReleases(SAMPLE_CHANGELOG, 2);
    expect(releases.map(release => release.version)).toEqual(['1.2.0', '1.1.0']);
  });

  it('creates a Notes section when bullets appear before a section heading', () => {
    const releases = parseChangelog(SAMPLE_CHANGELOG);
    expect(releases[3].sections).toEqual([
      {
        title: 'Notes',
        items: ['Plain note before any explicit section'],
      },
    ]);
  });

  it('filters prerelease entries from stable release views', () => {
    const releases = getRecentChangelogReleases(SAMPLE_CHANGELOG, 3, { currentVersion: '1.2.0' });
    expect(releases.map(release => release.version)).toEqual(['1.2.0', '1.1.0', '1.0.0']);
  });

  it('keeps only the matching prerelease entry in prerelease views', () => {
    const releases = getRecentChangelogReleases(SAMPLE_CHANGELOG, 3, { currentVersion: '1.2.0-beta.1' });
    expect(releases.map(release => release.version)).toEqual(['1.2.0', '1.2.0-beta.1', '1.1.0']);
  });

  it('detects prerelease versions', () => {
    expect(isPrereleaseVersion('1.2.0')).toBe(false);
    expect(isPrereleaseVersion('1.2.0-beta.1')).toBe(true);
  });
});
