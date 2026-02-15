const { Terminal } = require('@xterm/xterm');
const { FitAddon } = require('@xterm/addon-fit');
const { WebLinksAddon } = require('@xterm/addon-web-links');

// State
const terminals = new Map();
let activeSessionId = null;
let allSessions = [];
let searchQuery = '';
let currentSidebarTab = 'active';
let originalInstructions = '';
let currentInstructions = '';
let currentTheme = 'mocha';
const openingSession = new Set();
let creatingSession = false;

// Theme palettes for xterm.js
const XTERM_THEMES = {
  mocha: {
    background: '#1e1e2e', foreground: '#cdd6f4', cursor: '#f5e0dc', cursorAccent: '#1e1e2e',
    selectionBackground: '#45475a', selectionForeground: '#cdd6f4',
    black: '#45475a', red: '#f38ba8', green: '#a6e3a1', yellow: '#f9e2af',
    blue: '#89b4fa', magenta: '#f5c2e7', cyan: '#94e2d5', white: '#bac2de',
    brightBlack: '#585b70', brightRed: '#f38ba8', brightGreen: '#a6e3a1', brightYellow: '#f9e2af',
    brightBlue: '#89b4fa', brightMagenta: '#f5c2e7', brightCyan: '#94e2d5', brightWhite: '#a6adc8'
  },
  latte: {
    background: '#eff1f5', foreground: '#4c4f69', cursor: '#dc8a78', cursorAccent: '#eff1f5',
    selectionBackground: '#acb0be', selectionForeground: '#4c4f69',
    black: '#5c5f77', red: '#d20f39', green: '#40a02b', yellow: '#df8e1d',
    blue: '#1e66f5', magenta: '#ea76cb', cyan: '#179299', white: '#acb0be',
    brightBlack: '#6c6f85', brightRed: '#d20f39', brightGreen: '#40a02b', brightYellow: '#df8e1d',
    brightBlue: '#1e66f5', brightMagenta: '#ea76cb', brightCyan: '#179299', brightWhite: '#bcc0cc'
  }
};

// DOM elements
const sessionList = document.getElementById('session-list');
const searchInput = document.getElementById('search');
const terminalContainer = document.getElementById('terminal-container');
const terminalTabs = document.getElementById('terminal-tabs');
const emptyState = document.getElementById('empty-state');
const btnNew = document.getElementById('btn-new');
const btnNewCenter = document.getElementById('btn-new-center');
const maxConcurrentInput = document.getElementById('max-concurrent');
const instructionsPanel = document.getElementById('instructions-panel');
const instructionsRendered = document.getElementById('instructions-rendered');
const btnInstructions = document.getElementById('btn-instructions');
const btnCloseInstructions = document.getElementById('btn-close-instructions');
const terminalArea = document.getElementById('terminal-area');
const settingsOverlay = document.getElementById('settings-overlay');
const btnSettings = document.getElementById('btn-settings');
const resourcePanel = document.getElementById('resource-panel');
const resourcePanelContent = document.getElementById('resource-panel-content');
const btnToggleResources = document.getElementById('btn-toggle-resources');
const notificationBadge = document.getElementById('notification-badge');
const notificationPanel = document.getElementById('notification-panel');
const notificationListEl = document.getElementById('notification-list');
const toastContainer = document.getElementById('toast-container');

const NOTIF_ICONS = { 'task-done': '✅', 'needs-input': '⏳', 'error': '❌', 'info': 'ℹ️' };

// Initialize
async function init() {
  const settings = await window.api.getSettings();
  maxConcurrentInput.value = settings.maxConcurrent;
  if (settings.sidebarWidth) {
    document.getElementById('sidebar').style.width = settings.sidebarWidth + 'px';
  }
  applyTheme(settings.theme || 'mocha');

  // Restore last sidebar tab — must be set BEFORE refreshSessionList
  if (settings.lastActiveTab) {
    currentSidebarTab = settings.lastActiveTab;
    document.querySelectorAll('.sidebar-tab').forEach(t => {
      t.classList.toggle('active', t.dataset.tab === currentSidebarTab);
    });
  }

  await refreshSessionList();

  window.api.onPtyData((sessionId, data) => {
    const entry = terminals.get(sessionId);
    if (entry) entry.terminal.write(data);
  });

  window.api.onPtyExit((sessionId, exitCode) => {
    const entry = terminals.get(sessionId);
    if (entry) {
      entry.terminal.write(`\r\n\x1b[90m[Session ended with code ${exitCode}]\x1b[0m\r\n`);
    }
    updateTabStatus(sessionId, false);
    setTimeout(() => refreshSessionList(), 1000);
  });

  window.api.onPtyEvicted?.((sessionId) => {
    const entry = terminals.get(sessionId);
    if (entry) {
      entry.terminal.write('\r\n\x1b[90m[Session evicted to free capacity]\x1b[0m\r\n');
      entry.terminal.dispose();
      entry.wrapper.remove();
      terminals.delete(sessionId);
    }
    const tab = document.querySelector(`.tab[data-session-id="${sessionId}"]`);
    if (tab) tab.remove();
    if (activeSessionId === sessionId) {
      activeSessionId = null;
      const remaining = document.querySelectorAll('.tab');
      if (remaining.length > 0) switchToSession(remaining[remaining.length - 1].dataset.sessionId);
      else { emptyState.classList.remove('hidden'); updateResourcePanel(null); }
    }
    renderSessionList();
  });

  let resizeTimer = null;
  const resizeObserver = new ResizeObserver(() => {
    if (resizeTimer) clearTimeout(resizeTimer);
    resizeTimer = setTimeout(() => {
      resizeTimer = null;
      if (activeSessionId) {
        const entry = terminals.get(activeSessionId);
        if (entry && entry.fitAddon) {
          entry.fitAddon.fit();
          window.api.resizePty(activeSessionId, entry.terminal.cols, entry.terminal.rows);
        }
      }
    }, 50);
  });
  resizeObserver.observe(terminalContainer);

  // Sidebar tab switching
  document.querySelectorAll('.sidebar-tab').forEach(tab => {
    tab.addEventListener('click', () => {
      currentSidebarTab = tab.dataset.tab;
      document.querySelectorAll('.sidebar-tab').forEach(t => t.classList.remove('active'));
      tab.classList.add('active');
      renderSessionList();
      window.api.updateSettings({ lastActiveTab: currentSidebarTab });
    });
  });

  // Settings modal
  btnSettings.addEventListener('click', openSettings);
  settingsOverlay.querySelector('.settings-close').addEventListener('click', closeSettings);
  settingsOverlay.addEventListener('click', (e) => { if (e.target === settingsOverlay) closeSettings(); });

  // Theme switcher
  settingsOverlay.querySelectorAll('.theme-option').forEach(btn => {
    btn.addEventListener('click', () => {
      const theme = btn.dataset.theme;
      applyTheme(theme);
      window.api.updateSettings({ theme });
      settingsOverlay.querySelectorAll('.theme-option').forEach(b => b.classList.toggle('active', b.dataset.theme === theme));
    });
  });

  // Resource panel
  btnToggleResources.addEventListener('click', toggleResourcePanel);
  resourcePanel.querySelector('.resource-panel-close').addEventListener('click', () => {
    resourcePanel.classList.add('collapsed');
    btnToggleResources.classList.remove('active');
    fitActiveTerminal();
  });

  // Notifications
  document.getElementById('btn-notifications').addEventListener('click', toggleNotificationPanel);
  document.getElementById('btn-close-notifications').addEventListener('click', () => notificationPanel.classList.add('hidden'));
  document.getElementById('btn-mark-all-read').addEventListener('click', async () => {
    await window.api.markAllNotificationsRead();
    await refreshNotifications();
  });
  document.getElementById('btn-clear-notifications').addEventListener('click', async () => {
    await window.api.clearAllNotifications();
    await refreshNotifications();
  });

  document.addEventListener('click', (e) => {
    if (!notificationPanel.classList.contains('hidden') && 
        !notificationPanel.contains(e.target) && 
        !e.target.closest('#btn-notifications')) {
      notificationPanel.classList.add('hidden');
    }
  });

  window.api.onNotification((notification) => {
    showToast(notification);
    refreshNotifications();
  });

  window.api.onNotificationClick((notification) => {
    if (notification.sessionId) {
      openSession(notification.sessionId);
    }
  });

  await refreshNotifications();
}

function applyTheme(theme) {
  currentTheme = theme;
  document.documentElement.setAttribute('data-theme', theme);

  // Update existing terminals
  const xtermTheme = XTERM_THEMES[theme];
  for (const [, entry] of terminals) {
    entry.terminal.options.theme = xtermTheme;
  }

  // Update settings modal active state
  settingsOverlay.querySelectorAll('.theme-option').forEach(b => b.classList.toggle('active', b.dataset.theme === theme));
}

function openSettings() {
  settingsOverlay.classList.remove('hidden');
}

function closeSettings() {
  settingsOverlay.classList.add('hidden');
}

async function refreshSessionList() {
  allSessions = await window.api.listSessions();
  renderSessionList();
}

function renderSessionList() {
  const activeIds = new Set([...terminals.keys()]);

  let displayed;
  if (currentSidebarTab === 'active') {
    displayed = allSessions.filter(s => activeIds.has(s.id));
  } else {
    displayed = allSessions;
  }

  // Filter by search (title + tags + resources)
  if (searchQuery) {
    const q = searchQuery.toLowerCase();
    displayed = displayed.filter(s => {
      if (s.title.toLowerCase().includes(q)) return true;
      if (s.tags && s.tags.some(t => t.toLowerCase().includes(q))) return true;
      if (s.resources && s.resources.some(r =>
        (r.id && r.id.includes(q)) ||
        (r.url && r.url.toLowerCase().includes(q)) ||
        (r.name && r.name.toLowerCase().includes(q)) ||
        (r.repo && r.repo.toLowerCase().includes(q))
      )) return true;
      return false;
    });
  }

  sessionList.innerHTML = '';

  if (displayed.length === 0) {
    const emptyEl = document.createElement('div');
    emptyEl.className = 'empty-list';
    emptyEl.textContent = currentSidebarTab === 'active'
      ? 'No active sessions. Click a session in History or start a new one.'
      : searchQuery ? 'No sessions match your search.' : 'No sessions found.';
    sessionList.appendChild(emptyEl);
    return;
  }

  let lastDateLabel = '';
  for (const session of displayed) {
    if (currentSidebarTab === 'history') {
      const dateLabel = getDateLabel(session.updatedAt);
      if (dateLabel !== lastDateLabel) {
        const groupEl = document.createElement('div');
        groupEl.className = 'session-date-group';
        groupEl.textContent = dateLabel;
        sessionList.appendChild(groupEl);
        lastDateLabel = dateLabel;
      }
    }

    const el = document.createElement('div');
    el.className = 'session-item';
    if (session.id === activeSessionId) el.classList.add('active');
    if (activeIds.has(session.id)) el.classList.add('running');

    const timeStr = new Date(session.updatedAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });

    let tagsHtml = '';
    if (session.tags && session.tags.length > 0) {
      const visibleTags = session.tags.slice(0, 4);
      tagsHtml = '<div class="session-tags">' + visibleTags.map(t => {
        const cls = t.startsWith('repo:') ? 'tag repo' : t.startsWith('tool:') ? 'tag tool' : 'tag';
        const label = t.replace(/^(repo|tool):/, '');
        return `<span class="${cls}">${escapeHtml(label)}</span>`;
      }).join('') + (session.tags.length > 4 ? `<span class="tag">+${session.tags.length - 4}</span>` : '') + '</div>';
    }

    let resourcesHtml = '';
    if (session.resources && session.resources.length > 0) {
      const prs = session.resources.filter(r => r.type === 'pr');
      const wis = session.resources.filter(r => r.type === 'workitem');
      const badges = [];
      if (prs.length > 0) badges.push(`<span class="resource-badge pr" title="${escapeHtml(prs.map(p => 'PR ' + p.id + (p.repo ? ' (' + p.repo + ')' : '')).join('\n'))}">PR ${prs.map(p => p.id).join(', ')}</span>`);
      if (wis.length > 0) badges.push(`<span class="resource-badge wi" title="${escapeHtml(wis.map(w => 'WI ' + w.id).join('\n'))}">WI ${wis.map(w => w.id).join(', ')}</span>`);
      if (badges.length > 0) resourcesHtml = '<div class="session-resources">' + badges.join('') + '</div>';
    }

    el.innerHTML = `
      <div class="session-title">${escapeHtml(session.title)}</div>
      <div class="session-meta"><span>${timeStr}</span></div>
      ${tagsHtml}
      ${resourcesHtml}
    `;

    el.setAttribute('tabindex', '0');
    el.setAttribute('role', 'button');
    el.addEventListener('keydown', (e) => { if (e.key === 'Enter') openSession(session.id); });
    el.addEventListener('click', () => openSession(session.id));
    sessionList.appendChild(el);
  }

  window.api.getNotifications().then(notifications => {
    sessionList.querySelectorAll('.session-item').forEach((el, idx) => {
      const session = displayed[idx];
      if (!session) return;
      const unread = notifications.filter(n => !n.read && n.sessionId === session.id).length;
      if (unread > 0) {
        const badge = document.createElement('span');
        badge.className = 'session-notification-badge';
        badge.textContent = unread;
        const titleEl = el.querySelector('.session-title');
        if (titleEl) titleEl.appendChild(badge);
      }
    });
  });
}

async function openSession(sessionId) {
  if (terminals.has(sessionId)) {
    switchToSession(sessionId);
    return;
  }
  if (openingSession.has(sessionId)) return;
  openingSession.add(sessionId);

  try {
    await window.api.openSession(sessionId);
    createTerminal(sessionId);
    switchToSession(sessionId);

    const session = allSessions.find(s => s.id === sessionId);
    addTab(sessionId, session?.title || sessionId.substring(0, 8));
    renderSessionList();
  } finally {
    openingSession.delete(sessionId);
  }
}

async function newSession() {
  if (creatingSession) return;
  creatingSession = true;

  try {
    const sessionId = await window.api.newSession();
    createTerminal(sessionId);
    switchToSession(sessionId);
    addTab(sessionId, 'New Session');

    currentSidebarTab = 'active';
    document.querySelectorAll('.sidebar-tab').forEach(t => t.classList.toggle('active', t.dataset.tab === 'active'));

    setTimeout(() => refreshSessionList(), 2000);
  } finally {
    creatingSession = false;
  }
}

function createTerminal(sessionId) {
  const terminal = new Terminal({
    theme: XTERM_THEMES[currentTheme],
    fontFamily: "'Cascadia Code', 'Consolas', 'Courier New', monospace",
    fontSize: 14,
    lineHeight: 1.2,
    cursorBlink: true,
    cursorStyle: 'bar',
    scrollback: 10000,
    allowProposedApi: true
  });

  const fitAddon = new FitAddon();
  terminal.loadAddon(fitAddon);
  terminal.loadAddon(new WebLinksAddon((e, uri) => window.api.openExternal(uri)));

  const wrapper = document.createElement('div');
  wrapper.className = 'terminal-wrapper';
  wrapper.id = `term-${sessionId}`;
  terminalContainer.appendChild(wrapper);

  terminal.open(wrapper);
  fitAddon.fit();

  terminal.onData((data) => window.api.writePty(sessionId, data));
  terminal.onResize(({ cols, rows }) => window.api.resizePty(sessionId, cols, rows));

  terminals.set(sessionId, { terminal, fitAddon, wrapper });
}

function switchToSession(sessionId) {
  hideInstructions();

  if (activeSessionId && terminals.has(activeSessionId)) {
    terminals.get(activeSessionId).wrapper.classList.remove('visible');
  }

  activeSessionId = sessionId;

  const entry = terminals.get(sessionId);
  if (entry) {
    entry.wrapper.classList.add('visible');
    emptyState.classList.add('hidden');
    const currentId = sessionId;
    requestAnimationFrame(() => {
      if (activeSessionId !== currentId) return;
      entry.fitAddon.fit();
      entry.terminal.focus();
      window.api.resizePty(currentId, entry.terminal.cols, entry.terminal.rows);
    });
  }

  document.querySelectorAll('.tab').forEach(tab => {
    tab.classList.toggle('active', tab.dataset.sessionId === sessionId);
  });

  updateResourcePanel(sessionId);
  renderSessionList();
}

function addTab(sessionId, title) {
  if (document.querySelector(`.tab[data-session-id="${sessionId}"]`)) return;

  const tab = document.createElement('div');
  tab.className = 'tab active';
  tab.dataset.sessionId = sessionId;
  tab.setAttribute('tabindex', '0');
  tab.setAttribute('role', 'tab');

  const titleSpan = document.createElement('span');
  titleSpan.className = 'tab-title';
  titleSpan.textContent = title.length > 25 ? title.substring(0, 22) + '...' : title;
  titleSpan.title = title;

  const closeBtn = document.createElement('span');
  closeBtn.className = 'tab-close';
  closeBtn.textContent = '×';
  closeBtn.addEventListener('click', (e) => { e.stopPropagation(); closeTab(sessionId); });

  tab.appendChild(titleSpan);
  tab.appendChild(closeBtn);
  tab.addEventListener('click', () => switchToSession(sessionId));

  // Insert before the resource toggle button
  terminalTabs.insertBefore(tab, btnToggleResources);
}

async function closeTab(sessionId) {
  await window.api.killSession(sessionId);

  const entry = terminals.get(sessionId);
  if (entry) {
    entry.terminal.dispose();
    entry.wrapper.remove();
    terminals.delete(sessionId);
  }

  const tab = document.querySelector(`.tab[data-session-id="${sessionId}"]`);
  if (tab) tab.remove();

  if (activeSessionId === sessionId) {
    activeSessionId = null;
    const remainingTabs = document.querySelectorAll('.tab');
    if (remainingTabs.length > 0) {
      switchToSession(remainingTabs[remainingTabs.length - 1].dataset.sessionId);
    } else {
      emptyState.classList.remove('hidden');
      updateResourcePanel(null);
    }
  }

  renderSessionList();
}

function updateTabStatus(sessionId, alive) {
  const tab = document.querySelector(`.tab[data-session-id="${sessionId}"]`);
  if (tab) tab.style.opacity = alive ? '1' : '0.5';
}

// Resource panel
function toggleResourcePanel() {
  const collapsed = resourcePanel.classList.toggle('collapsed');
  btnToggleResources.classList.toggle('active', !collapsed);
  if (!collapsed && activeSessionId) updateResourcePanel(activeSessionId);
  // Refit terminal after panel toggle
  setTimeout(fitActiveTerminal, 250);
}

function updateResourcePanel(sessionId) {
  if (resourcePanel.classList.contains('collapsed')) return;

  if (!sessionId) {
    resourcePanelContent.innerHTML = '<div class="resource-empty">Open a session to see its resources</div>';
    return;
  }

  const session = allSessions.find(s => s.id === sessionId);
  const resources = session?.resources || [];

  if (resources.length === 0) {
    resourcePanelContent.innerHTML = '<div class="resource-empty">No linked resources for this session</div>';
    return;
  }

  const prs = resources.filter(r => r.type === 'pr');
  const wis = resources.filter(r => r.type === 'workitem');
  const repos = resources.filter(r => r.type === 'repo');
  const wikis = resources.filter(r => r.type === 'wiki');

  let html = '';

  if (prs.length > 0) {
    html += '<div class="resource-section"><div class="resource-section-title">Pull Requests</div>';
    for (const pr of prs) {
      const label = pr.repo ? `${pr.repo} #${pr.id}` : `PR #${pr.id}`;
      const url = pr.url || '#';
      html += `<a class="resource-link" href="${escapeHtml(url)}" target="_blank" title="${escapeHtml(url)}">
        <span class="resource-icon">⎇</span>
        <span class="resource-label"><span class="resource-id">${escapeHtml(pr.id)}</span> ${pr.repo ? escapeHtml(pr.repo) : ''}</span>
      </a>`;
    }
    html += '</div>';
  }

  if (wis.length > 0) {
    html += '<div class="resource-section"><div class="resource-section-title">Work Items</div>';
    for (const wi of wis) {
      const url = wi.url || '#';
      html += `<a class="resource-link" href="${escapeHtml(url)}" target="_blank" title="${escapeHtml(url)}">
        <span class="resource-icon">📋</span>
        <span class="resource-label"><span class="resource-id">${escapeHtml(wi.id)}</span></span>
      </a>`;
    }
    html += '</div>';
  }

  if (repos.length > 0) {
    html += '<div class="resource-section"><div class="resource-section-title">Repositories</div>';
    for (const repo of repos) {
      html += `<a class="resource-link" href="${escapeHtml(repo.url)}" target="_blank" title="${escapeHtml(repo.url)}">
        <span class="resource-icon">📦</span>
        <span class="resource-label">${escapeHtml(repo.name)}</span>
      </a>`;
    }
    html += '</div>';
  }

  if (wikis.length > 0) {
    html += '<div class="resource-section"><div class="resource-section-title">Wiki Pages</div>';
    for (const wiki of wikis) {
      let name;
      try { name = decodeURIComponent(wiki.url.split('/').pop() || wiki.url); }
      catch { name = wiki.url.split('/').pop() || wiki.url; }
      html += `<a class="resource-link" href="${escapeHtml(wiki.url)}" target="_blank" title="${escapeHtml(wiki.url)}">
        <span class="resource-icon">📄</span>
        <span class="resource-label">${escapeHtml(name)}</span>
      </a>`;
    }
    html += '</div>';
  }

  resourcePanelContent.innerHTML = html;

  // Open links in external browser
  resourcePanelContent.querySelectorAll('a.resource-link').forEach(a => {
    a.addEventListener('click', (e) => {
      e.preventDefault();
      const href = a.getAttribute('href');
      if (href && href !== '#') window.api.openExternal(href);
    });
  });
}

function fitActiveTerminal() {
  if (activeSessionId && terminals.has(activeSessionId)) {
    const entry = terminals.get(activeSessionId);
    entry.fitAddon.fit();
    window.api.resizePty(activeSessionId, entry.terminal.cols, entry.terminal.rows);
  }
}

// Instructions panel
async function showInstructions() {
  const content = await window.api.readInstructions();
  originalInstructions = content;
  currentInstructions = content;

  renderMarkdown(content);

  instructionsPanel.classList.remove('hidden');
  terminalArea.style.display = 'none';
}

function renderMarkdown(md, changedLineNumbers) {
  const changedSet = new Set(changedLineNumbers || []);
  const lines = md.replace(/\r\n/g, '\n').split('\n');

  // First pass: collect headers for TOC
  const headers = [];
  let inCB = false;
  for (let i = 0; i < lines.length; i++) {
    if (lines[i].startsWith('```')) { inCB = !inCB; continue; }
    if (inCB) continue;
    const m3 = lines[i].match(/^(#{1,3}) (.+)$/);
    if (m3) {
      const level = m3[1].length;
      const text = m3[2].replace(/\*\*/g, '').replace(/\*/g, '');
      const id = 'sec-' + text.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '');
      headers.push({ level, text, id, lineNum: i });
    }
  }

  // Build TOC
  let toc = '<nav class="instructions-toc"><div class="toc-title">Contents</div><ul>';
  for (const h of headers) {
    const indent = h.level === 1 ? '' : h.level === 2 ? 'toc-l2' : 'toc-l3';
    toc += `<li class="${indent}"><a href="#${h.id}">${escapeHtml(h.text)}</a></li>`;
  }
  toc += '</ul></nav>';

  // Second pass: render content grouped into collapsible sections
  // Each h1/h2 starts a new <details> section; h3 stays inside the current one
  let html = toc;
  let inCodeBlock = false;
  let codeBlockContent = '';
  let codeBlockStartLine = -1;
  let listItems = [];
  let openDetails = 0; // nesting depth of open <details>

  function flushList() {
    if (listItems.length === 0) return;
    const anyChanged = listItems.some(li => changedSet.has(li.lineNum));
    const cls = anyChanged ? ' class="changed-line"' : '';
    html += `<ul${cls}>` + listItems.map(li => `<li>${processInline(li.text)}</li>`).join('') + '</ul>';
    listItems = [];
  }

  function processInline(text) {
    const codeSpans = [];
    text = text
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/`([^`]+)`/g, (match, code) => {
        codeSpans.push(`<code>${code}</code>`);
        return `\x00CODE${codeSpans.length - 1}\x00`;
      })
      .replace(/\*\*\*(.+?)\*\*\*/g, '<strong><em>$1</em></strong>')
      .replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
      .replace(/\*(.+?)\*/g, '<em>$1</em>')
      .replace(/\x00CODE(\d+)\x00/g, (_, i) => codeSpans[parseInt(i)]);
    return text;
  }

  function closeOpenDetails() {
    flushList();
    while (openDetails > 0) { html += '</div></details>'; openDetails--; }
  }

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const changed = changedSet.has(i);
    const cls = changed ? ' class="changed-line"' : '';

    // Code block toggle
    if (line.startsWith('```')) {
      if (inCodeBlock) {
        const anyChanged = changedSet.has(codeBlockStartLine) || changedSet.has(i);
        const ccls = anyChanged ? ' class="changed-line"' : '';
        html += `<pre${ccls}><code>${codeBlockContent.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').trim()}</code></pre>`;
        inCodeBlock = false;
        codeBlockContent = '';
      } else {
        flushList();
        inCodeBlock = true;
        codeBlockStartLine = i;
        codeBlockContent = '';
      }
      continue;
    }
    if (inCodeBlock) { codeBlockContent += line + '\n'; continue; }

    // List items
    if (/^[-*] /.test(line)) {
      listItems.push({ text: line.replace(/^[-*] /, ''), lineNum: i });
      continue;
    } else {
      flushList();
    }

    // Empty line
    if (line.trim() === '') { html += '\n'; continue; }

    // Headers — h1/h2 start collapsible sections
    const headerInfo = headers.find(h => h.lineNum === i);
    if (headerInfo) {
      if (headerInfo.level <= 2) {
        closeOpenDetails();
        const tag = headerInfo.level === 1 ? 'h1' : 'h2';
        html += `<details class="section-collapse" open><summary${cls}><${tag} id="${headerInfo.id}">${processInline(headerInfo.text)}</${tag}></summary><div class="section-body">`;
        openDetails++;
      } else {
        flushList();
        html += `<h3 id="${headerInfo.id}"${cls}>${processInline(headerInfo.text)}</h3>`;
      }
      continue;
    }

    // HR
    if (/^---+$/.test(line)) { html += '<hr>'; continue; }

    // Blockquote
    if (line.startsWith('> ')) { html += `<blockquote${cls}>${processInline(line.slice(2))}</blockquote>`; continue; }

    // Table rows
    if (line.startsWith('|') && line.endsWith('|')) {
      let tableRows = [{ line, lineNum: i }];
      while (i + 1 < lines.length && lines[i + 1].startsWith('|') && lines[i + 1].endsWith('|')) {
        i++;
        tableRows.push({ line: lines[i], lineNum: i });
      }
      const anyChanged = tableRows.some(r => changedSet.has(r.lineNum));
      const tcls = anyChanged ? ' class="changed-line"' : '';
      let table = `<table${tcls}>`;
      tableRows.forEach((row, ri) => {
        const cells = row.line.split('|').filter(c => c.trim());
        if (cells.every(c => /^[-:]+$/.test(c.trim()))) return;
        const tag = ri === 0 ? 'th' : 'td';
        table += '<tr>' + cells.map(c => `<${tag}>${processInline(c.trim())}</${tag}>`).join('') + '</tr>';
      });
      table += '</table>';
      html += table;
      continue;
    }

    // Paragraph
    html += `<p${cls}>${processInline(line)}</p>`;
  }
  closeOpenDetails();

  instructionsRendered.innerHTML = html;

  // TOC click — smooth scroll
  instructionsRendered.querySelectorAll('.instructions-toc a').forEach(a => {
    a.addEventListener('click', (e) => {
      e.preventDefault();
      const id = a.getAttribute('href').slice(1);
      const target = instructionsRendered.querySelector('#' + id);
      if (target) {
        // Make sure parent details is open
        const details = target.closest('details');
        if (details && !details.open) details.open = true;
        target.scrollIntoView({ behavior: 'smooth', block: 'start' });
      }
    });
  });

  // Fade out change highlights — handled by CSS animation now
}

function hideInstructions() {
  instructionsPanel.classList.add('hidden');
  terminalArea.style.display = '';
}

// Import/export instructions
async function exportInstructions() {
  const content = currentInstructions || await window.api.readInstructions();
  const blob = new Blob([content], { type: 'text/markdown' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = 'copilot-instructions.md';
  a.click();
  URL.revokeObjectURL(url);
}

function importInstructions(mode) {
  const input = document.createElement('input');
  input.type = 'file';
  input.accept = '.md,.txt,.markdown';
  input.addEventListener('change', async () => {
    const file = input.files?.[0];
    if (!file) return;
    const text = await file.text();

    if (mode === 'override') {
      currentInstructions = text;
      await window.api.writeInstructions(text);
      renderMarkdown(text);
    } else {
      // Merge — append non-duplicate lines
      const existingLines = new Set(
        currentInstructions.split('\n')
          .map(l => l.trim())
          .filter(l => l && l !== '---' && !l.match(/^#{1,6}\s/) && l !== '```')
      );
      const newLines = text.split('\n');
      const toAdd = [];
      newLines.forEach(line => {
        if (line.trim() && !existingLines.has(line.trim())) {
          toAdd.push(line);
        }
      });
      if (toAdd.length > 0) {
        const merged = currentInstructions.trimEnd() + '\n\n' + toAdd.join('\n') + '\n';
        currentInstructions = merged;
        await window.api.writeInstructions(merged);
        renderMarkdown(merged);
      }
    }
  });
  input.click();
}

btnInstructions.addEventListener('click', showInstructions);
btnCloseInstructions.addEventListener('click', hideInstructions);

// Import/export
document.getElementById('btn-export-instructions').addEventListener('click', exportInstructions);
document.getElementById('btn-import-instructions').addEventListener('click', () => {
  showImportMenu();
});

function showImportMenu() {
  // Remove existing menu if any
  document.querySelectorAll('.import-menu').forEach(el => el.remove());

  const btn = document.getElementById('btn-import-instructions');
  const rect = btn.getBoundingClientRect();
  const menu = document.createElement('div');
  menu.className = 'import-menu';
  menu.style.top = (rect.bottom + 4) + 'px';
  menu.style.right = (window.innerWidth - rect.right) + 'px';
  menu.innerHTML = `
    <button class="import-menu-item" data-mode="merge">
      <span class="import-menu-icon">⊕</span>
      <span><strong>Merge</strong><br><span class="import-menu-desc">Add new lines, keep existing</span></span>
    </button>
    <button class="import-menu-item" data-mode="override">
      <span class="import-menu-icon">⟳</span>
      <span><strong>Override</strong><br><span class="import-menu-desc">Replace everything</span></span>
    </button>
  `;
  document.body.appendChild(menu);

  menu.querySelectorAll('.import-menu-item').forEach(item => {
    item.addEventListener('click', () => {
      importInstructions(item.dataset.mode);
      menu.remove();
    });
  });

  // Close on click outside
  const closeMenu = (e) => {
    if (!menu.contains(e.target) && e.target !== btn) {
      menu.remove();
      document.removeEventListener('click', closeMenu, true);
    }
  };
  setTimeout(() => document.addEventListener('click', closeMenu, true), 0);
}

// Date helpers
function getDateLabel(dateStr) {
  const date = new Date(dateStr);
  const now = new Date();
  const diff = now - date;
  const days = Math.floor(diff / (1000 * 60 * 60 * 24));
  if (days === 0) return 'Today';
  if (days === 1) return 'Yesterday';
  if (days < 7) return `${days} days ago`;
  if (days < 30) return `${Math.floor(days / 7)} weeks ago`;
  return date.toLocaleDateString(undefined, { month: 'short', year: 'numeric' });
}

function escapeHtml(str) {
  const div = document.createElement('div');
  div.textContent = str;
  return div.innerHTML;
}

// Sidebar resize
const resizeHandle = document.getElementById('resize-handle');
const sidebar = document.getElementById('sidebar');
let isResizing = false;

resizeHandle.addEventListener('mousedown', () => {
  isResizing = true;
  resizeHandle.classList.add('dragging');
  document.body.style.cursor = 'col-resize';
  document.body.style.userSelect = 'none';
});

document.addEventListener('mousemove', (e) => {
  if (!isResizing) return;
  const newWidth = Math.max(200, Math.min(450, e.clientX));
  sidebar.style.width = newWidth + 'px';
});

document.addEventListener('mouseup', () => {
  if (isResizing) {
    isResizing = false;
    resizeHandle.classList.remove('dragging');
    document.body.style.cursor = '';
    document.body.style.userSelect = '';

    const width = parseInt(sidebar.style.width, 10);
    if (width) window.api.updateSettings({ sidebarWidth: width });

    fitActiveTerminal();
  }
});

// Events
searchInput.addEventListener('input', (e) => { searchQuery = e.target.value; renderSessionList(); });
btnNew.addEventListener('click', newSession);
btnNewCenter.addEventListener('click', newSession);

maxConcurrentInput.addEventListener('change', (e) => {
  const val = parseInt(e.target.value, 10);
  if (val >= 1 && val <= 20) window.api.updateSettings({ maxConcurrent: val });
});

// Notification functions
function toggleNotificationPanel() {
  notificationPanel.classList.toggle('hidden');
}

async function refreshNotifications() {
  const notifications = await window.api.getNotifications();
  const unread = notifications.filter(n => !n.read).length;

  // Update badge
  if (unread > 0) {
    notificationBadge.textContent = unread > 99 ? '99+' : unread;
    notificationBadge.classList.remove('hidden');
  } else {
    notificationBadge.classList.add('hidden');
  }

  // Update dropdown list
  if (notifications.length === 0) {
    notificationListEl.innerHTML = '<div class="notification-empty">No notifications</div>';
    return;
  }

  notificationListEl.innerHTML = notifications
    .sort((a, b) => new Date(b.timestamp) - new Date(a.timestamp))
    .map(n => {
      const icon = NOTIF_ICONS[n.type] || 'ℹ️';
      const cls = n.read ? '' : ' unread';
      const time = formatNotifTime(n.timestamp);
      return `<div class="notification-item${cls}" data-id="${n.id}" data-session="${escapeHtml(n.sessionId || '')}">
        <div class="notification-icon">${icon}</div>
        <div class="notification-content">
          <div class="notification-title">${escapeHtml(n.title)}</div>
          ${n.body ? `<div class="notification-body">${escapeHtml(n.body)}</div>` : ''}
          <div class="notification-time">${time}</div>
        </div>
        <button class="notification-dismiss" data-dismiss="${n.id}" title="Dismiss">✕</button>
      </div>`;
    }).join('');

  // Wire up click handlers
  notificationListEl.querySelectorAll('.notification-item').forEach(el => {
    el.addEventListener('click', async (e) => {
      if (e.target.closest('.notification-dismiss')) return;
      const id = parseInt(el.dataset.id);
      const sessionId = el.dataset.session;
      await window.api.markNotificationRead(id);
      if (sessionId) openSession(sessionId);
      notificationPanel.classList.add('hidden');
      refreshNotifications();
    });
  });

  notificationListEl.querySelectorAll('.notification-dismiss').forEach(btn => {
    btn.addEventListener('click', async (e) => {
      e.stopPropagation();
      const id = parseInt(btn.dataset.dismiss);
      await window.api.dismissNotification(id);
      refreshNotifications();
    });
  });
}

function formatNotifTime(timestamp) {
  const d = new Date(timestamp);
  const now = new Date();
  const diffMs = now - d;
  const diffMin = Math.floor(diffMs / 60000);
  if (diffMin < 1) return 'just now';
  if (diffMin < 60) return `${diffMin}m ago`;
  const diffHr = Math.floor(diffMin / 60);
  if (diffHr < 24) return `${diffHr}h ago`;
  return d.toLocaleDateString();
}

function showToast(notification) {
  const icon = NOTIF_ICONS[notification.type] || 'ℹ️';
  const toast = document.createElement('div');
  toast.className = 'toast';
  toast.innerHTML = `
    <div class="toast-icon">${icon}</div>
    <div class="toast-content">
      <div class="toast-title">${escapeHtml(notification.title)}</div>
      ${notification.body ? `<div class="toast-body">${escapeHtml(notification.body)}</div>` : ''}
    </div>`;

  toast.addEventListener('click', () => {
    if (notification.sessionId) openSession(notification.sessionId);
    toast.classList.add('toast-out');
    setTimeout(() => toast.remove(), 300);
  });

  toastContainer.appendChild(toast);

  // Auto-dismiss after 6 seconds
  setTimeout(() => {
    if (toast.parentNode) {
      toast.classList.add('toast-out');
      setTimeout(() => toast.remove(), 300);
    }
  }, 6000);
}

// Keyboard shortcuts
document.addEventListener('keydown', (e) => {
  if (e.ctrlKey && e.key === 'n') { e.preventDefault(); newSession(); }

  if (e.ctrlKey && e.key === 'Tab') {
    e.preventDefault();
    const tabs = [...document.querySelectorAll('.tab')];
    if (tabs.length < 2) return;
    const i = tabs.findIndex(t => t.dataset.sessionId === activeSessionId);
    const next = e.shiftKey ? (i - 1 + tabs.length) % tabs.length : (i + 1) % tabs.length;
    switchToSession(tabs[next].dataset.sessionId);
  }

  if (e.ctrlKey && e.key === 'w') {
    e.preventDefault();
    if (document.activeElement?.tagName === 'INPUT' || document.activeElement?.tagName === 'TEXTAREA') return;
    if (activeSessionId) closeTab(activeSessionId);
  }

  if (e.key === 'Escape') {
    if (!notificationPanel.classList.contains('hidden')) {
      notificationPanel.classList.add('hidden');
    } else if (!settingsOverlay.classList.contains('hidden')) {
      closeSettings();
    } else if (!instructionsPanel.classList.contains('hidden')) {
      hideInstructions();
    } else if (document.activeElement === searchInput) {
      searchInput.value = '';
      searchQuery = '';
      renderSessionList();
      if (activeSessionId && terminals.has(activeSessionId)) terminals.get(activeSessionId).terminal.focus();
    }
  }
});

init();
