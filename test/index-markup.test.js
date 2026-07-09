import { describe, it, expect, beforeAll } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';

const INDEX_PATH = join(__dirname, '..', 'src', 'index.html');

let html;

beforeAll(() => {
  html = readFileSync(INDEX_PATH, 'utf8');
});

describe('index.html accessibility regressions', () => {
  it('marks the settings modal as a dialog', () => {
    expect(html).toMatch(/id="settings-overlay"[^>]*aria-hidden="true"/);
    expect(html).toMatch(/class="settings-modal"[^>]*role="dialog"[^>]*aria-modal="true"/);
    expect(html).toMatch(/id="settings-title"/);
  });

  it('provides live regions for toasts and notification announcements', () => {
    expect(html).toMatch(/id="toast-container"[^>]*aria-live="polite"/);
    expect(html).toMatch(/id="notification-live-region"[^>]*aria-live="polite"/);
  });

  it('does not promise Ctrl+F on the sidebar search button', () => {
    expect(html).toContain('title="Search sessions"');
    expect(html).not.toContain('Search sessions (Ctrl+F)');
  });

  it('does not promise transcript content search in the sidebar placeholder', () => {
    expect(html).toContain('placeholder="Search titles, folders, tags & resources..."');
    expect(html).not.toContain('Search sessions, tags & content...');
  });

  it('includes a startup loading screen with live status text', () => {
    expect(html).toContain('id="startup-loading-screen"');
    expect(html).toContain('id="startup-loading-title"');
    expect(html).toContain('id="startup-loading-message"');
    expect(html).toContain('id="startup-loading-progress"');
    expect(html).toContain('id="startup-loading-progress-bar"');
    expect(html).toContain('id="startup-loading-progress-label"');
    expect(html).toMatch(/role="status"/);
    expect(html).toMatch(/role="progressbar"/);
    expect(html).toMatch(/aria-live="polite"/);
  });

  it('exposes one custom launcher argument field in settings', () => {
    expect(html).toContain('id="copilot-args"');
    expect(html).toContain('aria-labelledby="copilot-args-title"');
    expect(html).not.toContain('id="agency-copilot-args"');
    expect(html).not.toContain('aria-labelledby="agency-args-title"');
    expect(html).toContain('agency copilot');
    expect(html).toContain('--agent squad');
  });

  it('provides a one-off new-session options dialog for launcher and args', () => {
    expect(html).toContain('id="btn-new-options"');
    expect(html).toContain('aria-label="New session options"');
    expect(html).toContain('id="new-session-options-overlay"');
    expect(html).toContain('id="new-session-launcher-label"');
    expect(html).toContain('aria-labelledby="new-session-launcher-label"');
    expect(html).toContain('id="new-session-launcher-copilot-row"');
    expect(html).toContain('id="new-session-launcher-copilot-desc"');
    expect(html).toContain('aria-describedby="new-session-launcher-copilot-desc"');
    expect(html).toMatch(/id="new-session-options-overlay"[^>]*aria-hidden="true"/);
    expect(html).toMatch(/class="settings-modal new-session-options-modal"[^>]*role="dialog"[^>]*aria-modal="true"/);
    expect(html).toContain('id="new-session-launcher-copilot"');
    expect(html).toContain('id="new-session-launcher-agency"');
    expect(html).toContain('id="new-session-args"');
    expect(html).toContain('Start session');
    expect(html).toContain('do not change the global setting');
  });

  it('keeps the center empty-state button as the simple new-session path', () => {
    expect(html).toContain('id="btn-new-center"');
    expect(html).not.toMatch(/id="btn-new-center"[\s\S]{0,160}btn-new-options/);
  });

  it('labels the copy-on-select toggle for assistive technology', () => {
    expect(html).toContain('id="copy-on-select-title"');
    expect(html).toContain('aria-labelledby="copy-on-select-title"');
    expect(html).toContain('aria-describedby="copy-on-select-desc"');
  });

  it('labels the agency launcher toggle for assistive technology', () => {
    expect(html).toContain('id="agency-launcher-title"');
    expect(html).toContain('aria-labelledby="agency-launcher-title"');
    expect(html).toContain('aria-describedby="agency-launcher-desc"');
  });

  it('does not hide the visible session context from assistive technology', () => {
    const promptGhost = html.match(/<div id="terminal-prompt-ghost"[^>]*>/)?.[0] || '';
    expect(promptGhost).not.toContain('aria-hidden');
  });

  it('surfaces recent release notes and a full changelog action in the About tab', () => {
    expect(html).toContain('id="about-release-meta"');
    expect(html).toContain('id="about-open-brochure"');
    expect(html).toContain('id="about-open-changelog"');
    expect(html).toContain('Open brochure');
    expect(html).toContain('Open full changelog');
    expect(html).toContain('Recent release notes');
  });

  it('keeps the enhancement review iframe sandboxed away from the parent window', () => {
    expect(html).toContain('id="review-modal-iframe"');
    expect(html).toContain('sandbox="allow-scripts"');
    expect(html).not.toContain('sandbox="allow-same-origin"');
  });
});
