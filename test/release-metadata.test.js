import { describe, it, expect, beforeAll } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';
const { parseChangelog, isPrereleaseVersion } = require('../src/changelog-utils');

const PACKAGE_PATH = join(__dirname, '..', 'package.json');
const README_PATH = join(__dirname, '..', 'README.md');
const MAIN_PATH = join(__dirname, '..', 'src', 'main.js');
const CHANGELOG_PATH = join(__dirname, '..', 'CHANGELOG.md');

let pkg;
let readme;
let mainSource;
let changelog;

beforeAll(() => {
  pkg = JSON.parse(readFileSync(PACKAGE_PATH, 'utf8'));
  readme = readFileSync(README_PATH, 'utf8');
  mainSource = readFileSync(MAIN_PATH, 'utf8');
  changelog = readFileSync(CHANGELOG_PATH, 'utf8');
});

describe('release metadata regressions', () => {
  it('packages CHANGELOG.md with the app', () => {
    expect(pkg.build.files).toContain('CHANGELOG.md');
  });

  it('acquires the Electron single-instance lock', () => {
    expect(mainSource).toMatch(/requestSingleInstanceLock\(\)/);
    expect(mainSource).toMatch(/second-instance/);
  });

  it('documents macOS installation alongside Windows', () => {
    // README used to gate on Windows-only; with the macOS DMG build added,
    // both platforms must appear so users can find their installer.
    expect(readme).toMatch(/macOS/);
    expect(readme).toMatch(/\.dmg/i);
    expect(readme).toMatch(/Windows Installer/i);
  });

  it('documents the actual Windows installer filename', () => {
    expect(readme).toContain('DeepSky-Setup-x.x.x.exe');
  });

  it('does not duplicate release notes across adjacent prereleases of the same version', () => {
    const releases = parseChangelog(changelog);
    const releaseSignature = (release) => JSON.stringify(
      release.sections.map(section => ({
        title: section.title,
        items: section.items,
      }))
    );
    const baseVersion = (version) => String(version).split('-')[0];
    const duplicatePrereleasePairs = [];

    for (let i = 0; i < releases.length - 1; i += 1) {
      const current = releases[i];
      const previous = releases[i + 1];
      if (
        isPrereleaseVersion(current.version) &&
        isPrereleaseVersion(previous.version) &&
        baseVersion(current.version) === baseVersion(previous.version) &&
        releaseSignature(current) === releaseSignature(previous)
      ) {
        duplicatePrereleasePairs.push(`${current.version} duplicates ${previous.version}`);
      }
    }

    expect(
      duplicatePrereleasePairs,
      `Adjacent prereleases need distinct notes or an explicit reissue note: ${duplicatePrereleasePairs.join(', ')}`
    ).toEqual([]);
  });
});
