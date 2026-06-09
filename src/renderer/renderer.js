'use strict';

/* global window, document */

const api = window.electronAPI;

const FULL_HEIGHT = 480;
const COLLAPSED_HEIGHT = 116;

// Primary colour used for each service's sparkline + overview bar.
const SVC_COLOR = { claude: 'amber', openai: 'green', gemini: 'violet' };

// Service catalog. Claude is permanent; the rest are opt-in via the "+" button.
const SERVICES = {
  claude: { label: 'Claude' },
  openai: { label: 'ChatGPT' },
  gemini: { label: 'Gemini' },
};
const ADDABLE = ['openai', 'gemini'];

const state = {
  settings: null,
  data: {}, // { claude, openai, gemini }
  activeTab: 'claude',
  enabledServices: ['claude'], // tabs the user has chosen to show
  collapsed: false,
  peeked: false,
  loading: false,
};

// ---------- DOM refs ----------
const el = {
  dock: document.getElementById('dock'),
  titlebar: document.getElementById('titlebar'),
  clock: document.getElementById('clock'),
  settingsBtn: document.getElementById('settingsBtn'),
  refreshBtn: document.getElementById('refreshBtn'),
  collapseBtn: document.getElementById('collapseBtn'),
  slideBtn: document.getElementById('slideBtn'),
  peekHandle: document.getElementById('peekHandle'),
  closeBtn: document.getElementById('closeBtn'),
  tabs: document.getElementById('tabs'),
  tabList: document.getElementById('tabList'),
  addTabBtn: document.getElementById('addTabBtn'),
  addMenu: document.getElementById('addMenu'),
  updated: document.getElementById('updated'),
  source: document.getElementById('source'),
  panel: document.getElementById('panel'),
  opacity: document.getElementById('opacity'),
  opacityValue: document.getElementById('opacityValue'),

  // overlay — Claude session
  overlay: document.getElementById('overlay'),
  overlayClose: document.getElementById('overlayClose'),
  btnClaudeLogin: document.getElementById('btnClaudeLogin'),
  claudeLoginStatus: document.getElementById('claudeLoginStatus'),
  setRemember: document.getElementById('setRemember'),
  setSessionKey: document.getElementById('setSessionKey'),
  btnImportSession: document.getElementById('btnImportSession'),
  importStatus: document.getElementById('importStatus'),
  btnOpenClaude: document.getElementById('btnOpenClaude'),
  btnLogout: document.getElementById('btnLogout'),
  btnSaveSettings: document.getElementById('btnSaveSettings'),

  // overlay — Gemini session
  btnGeminiLogin: document.getElementById('btnGeminiLogin'),
  geminiLoginStatus: document.getElementById('geminiLoginStatus'),
  setGeminiRemember: document.getElementById('setGeminiRemember'),
  setGeminiSessionKey: document.getElementById('setGeminiSessionKey'),
  btnGeminiImportSession: document.getElementById('btnGeminiImportSession'),
  geminiImportStatus: document.getElementById('geminiImportStatus'),
  btnOpenGemini: document.getElementById('btnOpenGemini'),
  btnGeminiLogout: document.getElementById('btnGeminiLogout'),

  // overlay — ChatGPT session
  btnOpenaiLogin: document.getElementById('btnOpenaiLogin'),
  openaiLoginStatus: document.getElementById('openaiLoginStatus'),
  setOpenaiRemember: document.getElementById('setOpenaiRemember'),
  setOpenaiSessionKey: document.getElementById('setOpenaiSessionKey'),
  btnOpenaiImportSession: document.getElementById('btnOpenaiImportSession'),
  openaiImportStatus: document.getElementById('openaiImportStatus'),
  btnOpenChatgpt: document.getElementById('btnOpenChatgpt'),
  btnOpenaiLogout: document.getElementById('btnOpenaiLogout'),
};

const CLAUDE_USAGE_URL = 'https://claude.ai/settings/usage';
const GEMINI_USAGE_URL = 'https://gemini.google.com/usage';
const OPENAI_USAGE_URL = 'https://chatgpt.com';

// ---------- Helpers ----------
function pad2(n) {
  return String(n).padStart(2, '0');
}

function fmtTime(date) {
  return `${pad2(date.getHours())}:${pad2(date.getMinutes())}`;
}

function money(n) {
  return Number(n || 0).toFixed(2);
}

function primaryPercent(d) {
  return (d.metrics && d.metrics[0] && d.metrics[0].percent) || 0;
}

function numOrNull(v) {
  if (v === '' || v == null) return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

// ---------- Templates ----------
function sparkline(values, color) {
  const w = 224;
  const h = 40;
  const pad = 3;
  const n = values.length;
  const xs = (i) => pad + (i * (w - 2 * pad)) / (n - 1);
  const ys = (v) => h - pad - v * (h - 2 * pad);

  let line = '';
  values.forEach((v, i) => {
    line += (i ? 'L' : 'M') + xs(i).toFixed(1) + ' ' + ys(v).toFixed(1) + ' ';
  });
  const area = `${line}L ${xs(n - 1).toFixed(1)} ${h} L ${xs(0).toFixed(1)} ${h} Z`;

  return (
    `<svg class="spark" viewBox="0 0 ${w} ${h}" preserveAspectRatio="none">` +
    `<path class="spark-area ${color}" d="${area}" />` +
    `<path class="spark-line ${color}" d="${line.trim()}" />` +
    `</svg>`
  );
}

function metricRow(m) {
  return (
    `<div class="metric">` +
    `<div class="metric-top">` +
    `<span class="metric-label"><span class="dot ${m.color}"></span>${m.label}</span>` +
    `<span class="metric-value">${m.usedText}</span>` +
    `</div>` +
    `<div class="bar"><div class="bar-fill ${m.color}" data-w="${Math.round(m.percent * 100)}"></div></div>` +
    `<div class="metric-reset">${m.resets || ''}</div>` +
    `</div>`
  );
}

function costFooter(d) {
  const c = d.cost || {};
  const hasToday = c.today != null;
  const est = c.estimated ? 'est. ' : '';
  const top = hasToday ? `${est}$${money(c.today)} today` : `${est}$${money(c.month)} this month`;
  const sub = hasToday ? `$${money(c.month)} / 30d` : `seat · monthly`;
  return (
    `<div class="cost">` +
    `<div class="cost-left"><span>${top}</span><span>${sub}</span></div>` +
    `<div class="cost-right">RM ${money(c.myr)}</div>` +
    `</div>`
  );
}

// "Not configured" call-to-action (Claude / Gemini / ChatGPT live services).
const SITE_LABEL = {
  gemini: 'gemini.google.com',
  openai: 'chatgpt.com',
  claude: 'claude.ai → Usage',
};
function setupBlock(d) {
  const site = SITE_LABEL[d.service] || 'claude.ai → Usage';
  return (
    `<div class="setup">` +
    `<div class="setup-msg">${d.note}</div>` +
    `<button class="cta" data-act="setup">Add session key</button>` +
    `<a class="cta-link" data-act="opensite">Open ${site} ↗</a>` +
    `</div>`
  );
}

function renderService(d) {
  const planClass = (d.plan || '').toLowerCase();
  const sparkColor = SVC_COLOR[d.service] || 'amber';

  const head =
    `<div class="svc-head">` +
    `<div class="svc-logo ${d.service}">${d.initial}</div>` +
    `<div class="svc-name">${d.name}</div>` +
    `<span class="badge ${planClass}">${d.plan}</span>` +
    `</div>`;

  // Claude with no usable numbers → show the setup CTA instead of bars.
  if (d.needsSetup) {
    return `<div class="panel">${head}${setupBlock(d)}<div class="model-line">model · ${d.model}</div></div>`;
  }

  // Connected but no usage bars (e.g. ChatGPT) → show an info note in place
  // of the metric rows.
  const body = d.metrics.length
    ? d.metrics.map(metricRow).join('')
    : d.infoMsg
    ? `<div class="setup-msg">${d.infoMsg}</div>`
    : '';

  return (
    `<div class="panel">` +
    head +
    body +
    `<div class="spark-wrap"><div class="spark-cap">Usage trend</div>${sparkline(d.sparkline, sparkColor)}</div>` +
    costFooter(d) +
    `<div class="model-line">model · ${d.model}</div>` +
    `</div>`
  );
}

function renderAll(all) {
  const svcs = ['claude', 'openai', 'gemini'].map((k) => all[k]).filter(Boolean);
  if (!svcs.length) return `<div class="state-msg">No data yet…</div>`;

  const rows = svcs
    .map((d) => {
      const pct = primaryPercent(d);
      const color = (d.metrics && d.metrics[0] && d.metrics[0].color) || SVC_COLOR[d.service] || 'amber';
      const right = d.needsSetup ? '—' : `${Math.round(pct * 100)}%`;
      return (
        `<div class="all-row">` +
        `<div class="svc-logo ${d.service}">${d.initial}</div>` +
        `<div class="all-mid">` +
        `<div class="all-name"><b>${d.name}</b><span>${right}</span></div>` +
        `<div class="bar"><div class="bar-fill ${color}" data-w="${Math.round(pct * 100)}"></div></div>` +
        `</div></div>`
      );
    })
    .join('');

  const avg = svcs.reduce((s, d) => s + primaryPercent(d), 0) / svcs.length;
  const onCells = Math.round(avg * 10);
  const cells = Array.from({ length: 10 }, (_, i) => `<div class="cell ${i < onCells ? 'on' : ''}"></div>`).join('');

  const totalMonth = svcs.reduce((s, d) => s + ((d.cost && d.cost.month) || 0), 0);
  const totalMyr = svcs.reduce((s, d) => s + ((d.cost && d.cost.myr) || 0), 0);

  return (
    `<div class="panel">` +
    rows +
    `<div class="cells-cap">Token capacity · avg</div>` +
    `<div class="cells">${cells}</div>` +
    `<div class="cost total">` +
    `<div class="cost-left"><span>Total spend (est.)</span><span>$${money(totalMonth)} / 30d</span></div>` +
    `<div class="cost-right">RM ${money(totalMyr)}</div>` +
    `</div></div>`
  );
}

// Animate progress bars from 0 -> target after injection.
function animateBars() {
  requestAnimationFrame(() => {
    el.panel.querySelectorAll('.bar-fill[data-w]').forEach((bar) => {
      bar.style.width = `${bar.getAttribute('data-w')}%`;
    });
  });
}

const SITE_URL = { gemini: GEMINI_USAGE_URL, openai: OPENAI_USAGE_URL, claude: CLAUDE_USAGE_URL };

// Wire up the per-panel action buttons (setup CTA + open-site link).
function bindPanelActions() {
  el.panel.querySelectorAll('[data-act]').forEach((node) => {
    const act = node.getAttribute('data-act');
    node.addEventListener('click', async () => {
      if (act === 'setup') {
        openSettings();
      } else if (act === 'opensite') {
        api.openExternal(SITE_URL[state.activeTab] || CLAUDE_USAGE_URL);
      }
    });
  });
}

// ---------- Rendering ----------
function renderActive() {
  const tab = state.activeTab;

  if (tab === 'all') {
    el.panel.innerHTML = renderAll(state.data);
    el.source.textContent = '';
    el.source.className = 'source';
  } else {
    const d = state.data[tab];
    if (!d) {
      el.panel.innerHTML = `<div class="state-msg">Loading ${tab}…</div>`;
      return;
    }
    el.panel.innerHTML = renderService(d);
    el.source.textContent = d.note || '';
    el.source.className = `source ${d.state || ''}`;
  }

  bindPanelActions();
  animateBars();
}

// ---------- Data ----------
async function refresh() {
  if (state.loading) return;
  state.loading = true;
  el.refreshBtn.classList.add('spinning');
  try {
    const all = await api.fetchUsage('all');
    if (all && !all.error) {
      state.data = all;
      el.updated.textContent = `Updated ${fmtTime(new Date())}`;
    } else if (all && all.error) {
      el.updated.textContent = 'Update failed — cached';
    }
    renderActive();
  } catch (err) {
    el.updated.textContent = 'Offline — cached data';
  } finally {
    el.refreshBtn.classList.remove('spinning');
    state.loading = false;
  }
}

// ---------- Tabs ----------
// Build a tab button for each enabled service. Non-Claude tabs carry a small
// "×" so the user can remove them again.
function renderTabs() {
  el.tabList.innerHTML = state.enabledServices
    .map((id) => {
      const svc = SERVICES[id];
      if (!svc) return '';
      const active = id === state.activeTab ? ' active' : '';
      const remove = id === 'claude' ? '' : `<span class="tab-remove" data-remove="${id}" title="Remove">×</span>`;
      return `<button class="tab${active}" data-tab="${id}">${svc.label}${remove}</button>`;
    })
    .join('');

  // Hide "+" once every available service has been added.
  const remaining = ADDABLE.filter((id) => !state.enabledServices.includes(id));
  el.addTabBtn.style.display = remaining.length ? '' : 'none';
}

function renderAddMenu() {
  const remaining = ADDABLE.filter((id) => !state.enabledServices.includes(id));
  el.addMenu.innerHTML = remaining.length
    ? remaining.map((id) => `<button class="add-item" data-add="${id}">+ ${SERVICES[id].label}</button>`).join('')
    : `<div class="add-empty">All added</div>`;
}

function toggleAddMenu(show) {
  const open = show == null ? el.addMenu.hidden : show;
  if (open) renderAddMenu();
  el.addMenu.hidden = !open;
}

function persistServices() {
  if (state.settings) {
    api.saveSettings({ enabledServices: state.enabledServices, activeTab: state.activeTab });
  }
}

function addService(id) {
  if (!SERVICES[id] || state.enabledServices.includes(id)) return;
  state.enabledServices.push(id);
  toggleAddMenu(false);
  setActiveTab(id, false);
  renderTabs();
  persistServices();
}

function removeService(id) {
  if (id === 'claude') return;
  state.enabledServices = state.enabledServices.filter((s) => s !== id);
  if (state.activeTab === id) state.activeTab = 'claude';
  renderTabs();
  renderActive();
  persistServices();
}

function setActiveTab(tab, save = true) {
  state.activeTab = tab;
  renderTabs();
  renderActive();
  if (save && state.settings) {
    api.saveSettings({ activeTab: tab });
  }
}

// ---------- Collapse ----------
function setCollapsed(collapsed) {
  state.collapsed = collapsed;
  el.dock.classList.toggle('collapsed', collapsed);
  el.collapseBtn.textContent = collapsed ? '▸' : '▾';
  api.resizeWindow(collapsed ? COLLAPSED_HEIGHT : FULL_HEIGHT);
}

// ---------- Slide to edge (peek) ----------
// When peeked, the dock slides off the right edge and only a small tab remains.
let peekTimer = null;

// Toggle the visual "peeked" state (tab shown, chrome stripped). When the dock
// is sliding out we defer adding the class until the slide finishes, so the
// panel keeps its background during the ~200ms animation.
function applyPeekClass(peeked, animated) {
  state.peeked = peeked;
  if (peekTimer) {
    clearTimeout(peekTimer);
    peekTimer = null;
  }
  if (peeked) {
    peekTimer = setTimeout(() => el.dock.classList.add('peeked'), animated ? 210 : 0);
  } else {
    el.dock.classList.remove('peeked');
  }
}

// User-initiated slide (button / tab): drive the window in main, then animate.
function setPeeked(peeked) {
  api.setPeek(peeked);
  applyPeekClass(peeked, true);
}

// ---------- Opacity ----------
function applyOpacity(value, persist) {
  const pct = Math.max(20, Math.min(100, Math.round(value)));
  el.opacity.value = String(pct);
  el.opacityValue.textContent = `${pct}%`;
  if (persist) api.setOpacity(pct / 100);
}

// ---------- Settings overlay ----------
function claudeCfg() {
  return (state.settings && state.settings.claude) || {};
}

function geminiCfg() {
  return (state.settings && state.settings.gemini) || {};
}

function openaiCfg() {
  return (state.settings && state.settings.openai) || {};
}

// Show current connection state in a service's import-status line.
async function showStatus(statusEl, statusFn) {
  statusEl.textContent = 'checking…';
  statusEl.className = 'login-status';
  try {
    const { authed } = await statusFn();
    statusEl.textContent = authed ? 'Connected ✓' : 'Not connected';
    statusEl.className = `login-status ${authed ? 'ok' : 'no'}`;
  } catch {
    statusEl.textContent = 'Not connected';
    statusEl.className = 'login-status no';
  }
}

function openSettings() {
  el.setRemember.checked = claudeCfg().rememberMe !== false;
  el.setSessionKey.value = '';
  el.setGeminiRemember.checked = geminiCfg().rememberMe !== false;
  el.setGeminiSessionKey.value = '';
  el.setOpenaiRemember.checked = openaiCfg().rememberMe !== false;
  el.setOpenaiSessionKey.value = '';

  el.claudeLoginStatus.textContent = '';
  el.geminiLoginStatus.textContent = '';
  el.openaiLoginStatus.textContent = '';

  el.overlay.hidden = false;
  showStatus(el.importStatus, api.claudeStatus);
  showStatus(el.geminiImportStatus, api.geminiStatus);
  showStatus(el.openaiImportStatus, api.openaiStatus);
}

function closeSettings() {
  el.overlay.hidden = true;
}

// Import a pasted session key for one service. Shared by Claude + Gemini.
async function importSession({ btn, input, status, remember, apiImport }) {
  const key = input.value.trim();
  if (!key) {
    status.textContent = 'Paste a key first';
    status.className = 'login-status no';
    return;
  }
  btn.textContent = 'Checking…';
  btn.disabled = true;
  try {
    const { authed } = await apiImport(key, remember.checked);
    status.textContent = authed ? 'Connected ✓' : 'Invalid or expired key';
    status.className = `login-status ${authed ? 'ok' : 'no'}`;
    if (authed) {
      input.value = '';
      await refresh();
    }
  } finally {
    btn.textContent = 'Use this session';
    btn.disabled = false;
  }
}

// Open a sign-in window and capture the session automatically. Shared by all
// three services.
async function loginCapture({ btn, status, remember, apiLogin }) {
  const label = btn.textContent;
  btn.textContent = 'Opening…';
  btn.disabled = true;
  status.textContent = 'waiting for sign-in…';
  status.className = 'login-status';
  try {
    const { authed } = await apiLogin(remember.checked);
    status.textContent = authed ? 'Connected ✓' : 'Not connected';
    status.className = `login-status ${authed ? 'ok' : 'no'}`;
    if (authed) await refresh();
  } finally {
    btn.textContent = label;
    btn.disabled = false;
  }
}

async function saveSettingsForm() {
  const merged = await api.saveSettings({
    claude: { rememberMe: el.setRemember.checked },
    gemini: { rememberMe: el.setGeminiRemember.checked },
    openai: { rememberMe: el.setOpenaiRemember.checked },
  });
  if (merged) state.settings = merged;
  closeSettings();
  await refresh();
}

// ---------- Clock ----------
function tickClock() {
  el.clock.textContent = fmtTime(new Date());
}

// ---------- Drag ----------
function bindDrag() {
  el.titlebar.addEventListener('mousedown', (e) => {
    if (e.button !== 0) return;
    if (e.target.closest('.no-drag')) return;
    api.startDrag({ x: e.clientX, y: e.clientY });
    const onUp = () => {
      api.endDrag();
      window.removeEventListener('mouseup', onUp);
    };
    window.addEventListener('mouseup', onUp);
  });
}

// ---------- Events ----------
function bindEvents() {
  bindDrag();

  el.tabList.addEventListener('click', (e) => {
    const rm = e.target.closest('.tab-remove');
    if (rm) {
      e.stopPropagation();
      removeService(rm.dataset.remove);
      return;
    }
    const btn = e.target.closest('.tab');
    if (btn) setActiveTab(btn.dataset.tab);
  });

  el.addTabBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    toggleAddMenu();
  });

  el.addMenu.addEventListener('click', (e) => {
    const item = e.target.closest('.add-item');
    if (item) addService(item.dataset.add);
  });

  // Close the add menu when clicking anywhere else.
  document.addEventListener('click', (e) => {
    if (!el.addMenu.hidden && !el.addMenu.contains(e.target) && e.target !== el.addTabBtn) {
      toggleAddMenu(false);
    }
  });

  el.refreshBtn.addEventListener('click', refresh);
  el.collapseBtn.addEventListener('click', () => setCollapsed(!state.collapsed));
  el.slideBtn.addEventListener('click', () => setPeeked(true));
  el.peekHandle.addEventListener('click', () => setPeeked(false));
  el.closeBtn.addEventListener('click', () => api.hideApp());
  el.settingsBtn.addEventListener('click', openSettings);

  el.opacity.addEventListener('input', (e) => applyOpacity(Number(e.target.value), true));

  // Overlay
  el.overlayClose.addEventListener('click', closeSettings);
  el.btnSaveSettings.addEventListener('click', saveSettingsForm);

  // Claude session
  el.btnClaudeLogin.addEventListener('click', () =>
    loginCapture({
      btn: el.btnClaudeLogin,
      status: el.claudeLoginStatus,
      remember: el.setRemember,
      apiLogin: api.claudeLogin,
    })
  );
  el.btnOpenClaude.addEventListener('click', () => api.openExternal(CLAUDE_USAGE_URL));
  el.btnImportSession.addEventListener('click', () =>
    importSession({
      btn: el.btnImportSession,
      input: el.setSessionKey,
      status: el.importStatus,
      remember: el.setRemember,
      apiImport: api.claudeImportSession,
    })
  );
  el.btnLogout.addEventListener('click', async () => {
    await api.claudeLogout();
    await showStatus(el.importStatus, api.claudeStatus);
    await refresh();
  });

  // Gemini session
  el.btnGeminiLogin.addEventListener('click', () =>
    loginCapture({
      btn: el.btnGeminiLogin,
      status: el.geminiLoginStatus,
      remember: el.setGeminiRemember,
      apiLogin: api.geminiLogin,
    })
  );
  el.btnOpenGemini.addEventListener('click', () => api.openExternal(GEMINI_USAGE_URL));
  el.btnGeminiImportSession.addEventListener('click', () =>
    importSession({
      btn: el.btnGeminiImportSession,
      input: el.setGeminiSessionKey,
      status: el.geminiImportStatus,
      remember: el.setGeminiRemember,
      apiImport: api.geminiImportSession,
    })
  );
  el.btnGeminiLogout.addEventListener('click', async () => {
    await api.geminiLogout();
    await showStatus(el.geminiImportStatus, api.geminiStatus);
    await refresh();
  });

  // ChatGPT session
  el.btnOpenaiLogin.addEventListener('click', () =>
    loginCapture({
      btn: el.btnOpenaiLogin,
      status: el.openaiLoginStatus,
      remember: el.setOpenaiRemember,
      apiLogin: api.openaiLogin,
    })
  );
  el.btnOpenChatgpt.addEventListener('click', () => api.openExternal(OPENAI_USAGE_URL));
  el.btnOpenaiImportSession.addEventListener('click', () =>
    importSession({
      btn: el.btnOpenaiImportSession,
      input: el.setOpenaiSessionKey,
      status: el.openaiImportStatus,
      remember: el.setOpenaiRemember,
      apiImport: api.openaiImportSession,
    })
  );
  el.btnOpenaiLogout.addEventListener('click', async () => {
    await api.openaiLogout();
    await showStatus(el.openaiImportStatus, api.openaiStatus);
    await refresh();
  });

  api.onTrayRefresh(() => refresh());

  // Main auto-slides the dock away when it loses focus.
  api.onPeekChanged((peeked) => applyPeekClass(peeked, true));
}

// ---------- Init ----------
async function init() {
  state.settings = await api.getSettings();

  const op = (state.settings.window && state.settings.window.opacity) || 0.92;
  applyOpacity(op * 100, false);

  // Restore the slid-to-edge state (main positioned the window already).
  if (state.settings.window && state.settings.window.peeked) applyPeekClass(true, false);

  bindEvents();
  tickClock();
  setInterval(tickClock, 15000);

  // Enabled services: always keep Claude first, keep only known services.
  const saved = Array.isArray(state.settings.enabledServices) ? state.settings.enabledServices : [];
  const enabled = ['claude', ...saved.filter((id) => id !== 'claude' && SERVICES[id])];
  state.enabledServices = [...new Set(enabled)];

  // Fall back to Claude if the saved tab is no longer one of the visible tabs.
  const wanted = state.settings.activeTab || 'claude';
  setActiveTab(state.enabledServices.includes(wanted) ? wanted : 'claude', false);

  await refresh();
  const interval = Math.max(30000, Number(state.settings.refreshInterval) || 300000);
  setInterval(refresh, interval);
}

window.addEventListener('DOMContentLoaded', init);
