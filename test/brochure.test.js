import { describe, it, expect, beforeAll } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';

/**
 * Brochure validation tests.
 *
 * Ensures the brochure HTML stays in sync with the current DeepSky version,
 * has correct download links, accurate feature lists, and a mock that
 * reflects the latest UI capabilities.
 */

const PKG_PATH = join(__dirname, '..', 'package.json');
const CHANGELOG_PATH = join(__dirname, '..', 'CHANGELOG.md');
const LOCAL_BROCHURE_PATH = join(
  process.env.USERPROFILE || process.env.HOME,
  'OneDrive - Microsoft', 'Documents', 'deepsky-brochure.html'
);
const BROCHURE_PATH = join(__dirname, '..', 'docs', 'deepsky-brochure.html');

let brochure, pkg, changelog;
const brochureAvailable = (() => {
  try { readFileSync(BROCHURE_PATH); return true; } catch { return false; }
})();

// Skip only if the checked-in Pages brochure is absent.
const describeIfBrochure = brochureAvailable ? describe : describe.skip;

beforeAll(() => {
  pkg = JSON.parse(readFileSync(PKG_PATH, 'utf-8'));
  changelog = readFileSync(CHANGELOG_PATH, 'utf-8');
  if (brochureAvailable) {
    brochure = readFileSync(BROCHURE_PATH, 'utf-8');
  }
});

describeIfBrochure('Brochure exists', () => {
  it('brochure file is readable', () => {
    expect(brochure).not.toBeNull();
    expect(brochure.length).toBeGreaterThan(1000);
  });

  it('brochure is checked into the GitHub Pages docs folder, not only OneDrive', () => {
    expect(BROCHURE_PATH).toMatch(/docs[\\/]deepsky-brochure\.html$/);
    expect(BROCHURE_PATH).not.toBe(LOCAL_BROCHURE_PATH);
  });
});

describeIfBrochure('Version consistency', () => {
  it('download button uses a versionless latest-release link', () => {
    expect(brochure).toContain('https://github.com/itsela-ms/DeepSky/releases/latest');
    expect(brochure).not.toMatch(/DeepSky-Setup-.*\.exe/);
  });

  it('download button text avoids version labels', () => {
    expect(brochure).toMatch(/Download Latest/);
    expect(brochure).not.toMatch(/Download v\d+\.\d+\.\d+/);
  });

  it('"What\'s New" heading avoids version labels', () => {
    expect(brochure).toMatch(/What's New<\/h2>/);
    expect(brochure).not.toMatch(/What's New in .*v\d+\.\d+\.\d+/);
  });
});

describeIfBrochure('Download links', () => {
  it('download link points to itsela-ms/DeepSky (primary repo)', () => {
    expect(brochure).toContain('github.com/itsela-ms/DeepSky/releases/latest');
  });

  it('download link does not embed a specific release tag', () => {
    expect(brochure).not.toMatch(/\/download\/v\d+\.\d+\.\d+(?:-[A-Za-z0-9.-]+)?\//);
  });

  it('GitHub repo link points to itsela-ms/DeepSky', () => {
    expect(brochure).toMatch(/href="https:\/\/github\.com\/itsela-ms\/DeepSky"/);
  });

  it('releases link points to itsela-ms/DeepSky/releases', () => {
    expect(brochure).toContain('github.com/itsela-ms/DeepSky/releases');
  });

  it('no references to itsela_microsoft (old migration target)', () => {
    expect(brochure).not.toContain('itsela_microsoft');
  });
});

describeIfBrochure('Feature list completeness', () => {
  const requiredFeatures = [
    { keyword: 'sidebar', desc: 'Visual sidebar' },
    { keyword: 'grouping', desc: 'Session grouping' },
    { keyword: 'directory', desc: 'Working directory' },
    { keyword: 'status badge', desc: 'Live status badges' },
    { keyword: 'terminal', desc: 'Multi-tab terminal' },
    { keyword: 'notification', desc: 'Notifications' },
    { keyword: 'Status panel', desc: 'Session Status panel' },
    { keyword: 'theme', desc: 'Catppuccin themes' },
    { keyword: 'tab scroll', desc: 'Tab scroll indicators' },
    { keyword: 'tagging', desc: 'Smart session tagging' },
    { keyword: 'keyboard', desc: 'Keyboard shortcuts' },
    { keyword: 'auto-update', desc: 'Silent auto-updates' },
  ];

  for (const { keyword, desc } of requiredFeatures) {
    it(`lists ${desc}`, () => {
      expect(brochure.toLowerCase()).toContain(keyword.toLowerCase());
    });
  }
});

describeIfBrochure('"What\'s New" section accuracy', () => {
  it('brochure keeps the heading generic even when changelog has prerelease versions', () => {
    const changelogMatch = changelog.match(/##\s*\[(\d+\.\d+\.\d+(?:-[A-Za-z0-9.-]+)?)\]/);
    expect(changelogMatch).not.toBeNull();
    expect(brochure).toContain("What's New</h2>");
  });
});

describeIfBrochure('No beta wording', () => {
  it('does not mention beta or prerelease versions anywhere in brochure copy', () => {
    expect(brochure).not.toMatch(/\bbeta\b/i);
    expect(brochure).not.toMatch(/\bprerelease\b|\bpre-release\b/i);
    expect(brochure).not.toMatch(/v\d+\.\d+\.\d+-[A-Za-z0-9.-]+/);
  });
});

describeIfBrochure('Interactive mock reflects features', () => {
  it('mock has sidebar with Active and History tabs', () => {
    expect(brochure).toContain('data-tab="active"');
    expect(brochure).toContain('data-tab="history"');
  });

  it('mock has search input', () => {
    expect(brochure).toMatch(/mock-search.*Search titles, folders, tags .* resources/i);
  });

  it('mock has session status badges (Working, Waiting, Idle)', () => {
    expect(brochure).toContain('mb-working');
    expect(brochure).toContain('mb-waiting');
    expect(brochure).toContain('mb-idle');
  });

  it('mock shows the outline-only Active-list working-directory affordance', () => {
    expect(brochure).toContain('mock-session-cwd');
    expect(brochure).toMatch(/\.mock-session-cwd\s*\{[\s\S]*?color:\s*var\(--yellow\)/);
    expect(brochure).toMatch(/\.mock-session-cwd\s*\{[\s\S]*?background:\s*none/);
  });

  it('mock has tab bar', () => {
    expect(brochure).toContain('mock-tabbar');
    expect(brochure).toContain('tabBar');
  });

  it('mock has terminal with realistic content', () => {
    expect(brochure).toContain('mock-terminal');
    expect(brochure).toContain('copilot');
  });

  it('mock has status panel with Ctrl+I button', () => {
    expect(brochure).toContain('statusBtn');
    expect(brochure).toMatch(/Ctrl\+I/i);
  });

  it('mock has notification bell with badge', () => {
    expect(brochure).toContain('mock-bell');
    expect(brochure).toContain('bellBadge');
  });

  it('mock has toast notification', () => {
    expect(brochure).toContain('mock-toast');
  });

  it('mock has resource/status panel with PR, Repo, Work Item', () => {
    expect(brochure).toContain('ri-pr');
    expect(brochure).toContain('ri-repo');
    expect(brochure).toContain('ri-wi');
  });

  it('mock has session dot indicators (green, yellow, off)', () => {
    expect(brochure).toContain('dot-green');
    expect(brochure).toContain('dot-yellow');
    expect(brochure).toContain('dot-off');
  });
});

describeIfBrochure('Motion accessibility', () => {
  it('honors reduced-motion preferences for CSS and scripted mock animation', () => {
    expect(brochure).toMatch(/prefers-reduced-motion:\s*reduce/);
    expect(brochure).toMatch(/matchMedia\(['"]\(prefers-reduced-motion:\s*reduce\)['"]\)/);
  });
});

describeIfBrochure('Keyboard shortcuts section', () => {
  it('has a keyboard shortcuts section', () => {
    expect(brochure).toMatch(/Keyboard Shortcuts/i);
  });

  const shortcuts = [
    'Ctrl+N', 'Ctrl+W', 'Ctrl+Tab', 'Ctrl+Shift+Tab', 'Ctrl+Shift+T',
    'Ctrl+I', 'Ctrl+F', 'Escape',
    'Ctrl+C', 'Ctrl+V', 'Shift+Enter',
    'Ctrl+=', 'Ctrl+-', 'Ctrl+0',
  ];

  for (const shortcut of shortcuts) {
    it(`lists ${shortcut}`, () => {
      expect(brochure).toContain(shortcut);
    });
  }
});

describeIfBrochure('About section link', () => {
  it('links to an About and changelog section from the hero area', () => {
    expect(brochure).toContain('href="#about-section"');
  });

  it('includes an About and changelog section', () => {
    expect(brochure).toContain('id="about-section"');
    expect(brochure).toMatch(/About\s*&amp;\s*Changelog/i);
    expect(brochure).toMatch(/Settings\s*&rarr;\s*About/i);
  });
});

describeIfBrochure('Prerequisite info', () => {
  it('mentions GitHub Copilot CLI prerequisite', () => {
    expect(brochure).toMatch(/prerequisite/i);
    expect(brochure).toContain('winget install github.copilot');
  });
});

describeIfBrochure('No stale content', () => {
  it('does not reference removed features (resource panel as standalone)', () => {
    // Resource panel was merged into Status panel in v0.8.0
    // Only check in the feature list section, not in mock JS comments
    const featureSection = brochure.match(/<ul class="feature-list">([\s\S]*?)<\/ul>/);
    if (featureSection) {
      expect(featureSection[1]).not.toMatch(/Resource panel/i);
    }
  });

  it('does not contain placeholder or TODO markers in visible text', () => {
    // Strip HTML tags, script blocks, and CSS to check only visible content + comments
    const withoutScripts = brochure.replace(/<script[\s\S]*?<\/script>/gi, '');
    const withoutStyles = withoutScripts.replace(/<style[\s\S]*?<\/style>/gi, '');
    const textContent = withoutStyles.replace(/<[^>]*>/g, '');
    expect(textContent).not.toMatch(/\bTODO\b|\bFIXME\b|\bPLACEHOLDER\b|\bXXX\b/i);
  });
});
