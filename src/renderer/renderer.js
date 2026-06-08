'use strict';

/* global window, document */

const api = window.electronAPI;

const FULL_HEIGHT = 480;
const COLLAPSED_HEIGHT = 116;

// Primary colour used for each service's sparkline + overview bar.
const SVC_COLOR = { claude: 'amber', openai: 'green', copilot: 'blue' };

const state = {
  settings: null,
  data: {}, // { claude, openai, copilot }
  activeTab: 'claude',
  collapsed: false,
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
  closeBtn: document.getElementById('closeBtn'),
  tabs: document.getElementById('tabs'),
  updated: document.getElementById('updated'),
  source: document.getElementById('source'),
  panel: document.getElementById('panel'),
  opacity: document.getElementById('opacity'),
  opacityValue: document.getElementById('opacityValue'),

  // overlay
  overlay: document.getElementById('overlay'),
  overlayClose: document.getElementById('overlayClose'),
  setLive: document.getElementById('setLive'),
  btnLogin: document.getElementById('btnLogin'),
  loginStatus: document.getElementById('loginStatus'),
  btnOpenClaude: document.getElementById('btnOpenClaude'),
  btnLogout: document.getElementById('btnLogout'),
  setManual: document.getElementById('setManual'),
  setSession: document.getElementById('setSession'),
  setWeekly: document.getElementById('setWeekly'),
  setPlan: document.getElementById('setPlan'),
  btnSaveSettings: document.getElementById('btnSaveSettings'),
};

const CLAUDE_USAGE_URL = 'https://claude.ai/settings/usage';

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
    `<span class="metric-value">${m.leftText}</span>` +
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

// Claude "not configured" call-to-action.
function setupBlock(d) {
  return (
    `<div class="setup">` +
    `<div class="setup-msg">${d.note}</div>` +
    `<button class="cta" data-act="login">Log in to Claude</button>` +
    `<button class="cta ghost" data-act="manual">Enter usage manually</button>` +
    `<a class="cta-link" data-act="openclaude">Open claude.ai → Usage ↗</a>` +
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

  // API-key warning (OpenAI / Copilot).
  const warn =
    d.state === 'nokey'
      ? `<div class="warn">⚠ API key not set<a id="warnLink">settings.json</a></div>`
      : '';

  return (
    `<div class="panel">` +
    warn +
    head +
    d.metrics.map(metricRow).join('') +
    `<div class="spark-wrap"><div class="spark-cap">Usage trend</div>${sparkline(d.sparkline, sparkColor)}</div>` +
    costFooter(d) +
    `<div class="model-line">model · ${d.model}</div>` +
    `</div>`
  );
}

function renderAll(all) {
  const svcs = ['claude', 'openai', 'copilot'].map((k) => all[k]).filter(Boolean);
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

// Wire up the per-panel action buttons (Claude setup CTA + warn link).
function bindPanelActions() {
  el.panel.querySelectorAll('[data-act]').forEach((node) => {
    const act = node.getAttribute('data-act');
    node.addEventListener('click', async () => {
      if (act === 'login') {
        node.textContent = 'Opening login…';
        await api.claudeLogin();
        await refresh();
      } else if (act === 'manual') {
        openSettings();
      } else if (act === 'openclaude') {
        api.openExternal(CLAUDE_USAGE_URL);
      }
    });
  });
  const link = document.getElementById('warnLink');
  if (link) link.addEventListener('click', () => api.openSettingsFile());
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
function setActiveTab(tab, save = true) {
  state.activeTab = tab;
  el.tabs.querySelectorAll('.tab').forEach((b) => {
    b.classList.toggle('active', b.dataset.tab === tab);
  });
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

// ---------- Opacity ----------
function applyOpacity(value, persist) {
  const pct = Math.max(20, Math.min(100, Math.round(value)));
  el.opacity.value = String(pct);
  el.opacityValue.textContent = `${pct}%`;
  if (persist) api.setOpacity(pct / 100);
}

// ---------- Settings overlay ----------
function claudeCfg() {
  return (state.settings && state.settings.claude) || { manual: {} };
}

async function updateLoginStatus() {
  el.loginStatus.textContent = 'checking…';
  el.loginStatus.className = 'login-status';
  try {
    const { authed } = await api.claudeStatus();
    el.loginStatus.textContent = authed ? 'Connected ✓' : 'Not connected';
    el.loginStatus.className = `login-status ${authed ? 'ok' : 'no'}`;
  } catch {
    el.loginStatus.textContent = 'Not connected';
    el.loginStatus.className = 'login-status no';
  }
}

function openSettings() {
  const c = claudeCfg();
  const m = c.manual || {};
  el.setLive.checked = c.useLiveScrape !== false;
  el.setManual.checked = !!m.enabled;
  el.setSession.value = m.sessionUsed == null ? '' : m.sessionUsed;
  el.setWeekly.value = m.weeklyUsed == null ? '' : m.weeklyUsed;
  el.setPlan.value = m.plan || 'Max';
  el.overlay.hidden = false;
  updateLoginStatus();
}

function closeSettings() {
  el.overlay.hidden = true;
}

async function saveSettingsForm() {
  const claude = {
    useLiveScrape: el.setLive.checked,
    manual: {
      enabled: el.setManual.checked,
      sessionUsed: numOrNull(el.setSession.value),
      weeklyUsed: numOrNull(el.setWeekly.value),
      plan: (el.setPlan.value || 'Max').trim() || 'Max',
    },
  };
  const merged = await api.saveSettings({ claude });
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

  el.tabs.addEventListener('click', (e) => {
    const btn = e.target.closest('.tab');
    if (btn) setActiveTab(btn.dataset.tab);
  });

  el.refreshBtn.addEventListener('click', refresh);
  el.collapseBtn.addEventListener('click', () => setCollapsed(!state.collapsed));
  el.closeBtn.addEventListener('click', () => api.hideApp());
  el.settingsBtn.addEventListener('click', openSettings);

  el.opacity.addEventListener('input', (e) => applyOpacity(Number(e.target.value), true));

  // Overlay
  el.overlayClose.addEventListener('click', closeSettings);
  el.btnSaveSettings.addEventListener('click', saveSettingsForm);
  el.btnOpenClaude.addEventListener('click', () => api.openExternal(CLAUDE_USAGE_URL));
  el.btnLogin.addEventListener('click', async () => {
    el.btnLogin.textContent = 'Opening…';
    await api.claudeLogin();
    el.btnLogin.textContent = 'Log in to Claude';
    el.setLive.checked = true;
    await updateLoginStatus();
  });
  el.btnLogout.addEventListener('click', async () => {
    await api.claudeLogout();
    await updateLoginStatus();
  });

  api.onTrayRefresh(() => refresh());
}

// ---------- Init ----------
async function init() {
  state.settings = await api.getSettings();

  const op = (state.settings.window && state.settings.window.opacity) || 0.92;
  applyOpacity(op * 100, false);

  bindEvents();
  tickClock();
  setInterval(tickClock, 15000);

  setActiveTab(state.settings.activeTab || 'claude', false);

  await refresh();
  const interval = Math.max(30000, Number(state.settings.refreshInterval) || 300000);
  setInterval(refresh, interval);
}

window.addEventListener('DOMContentLoaded', init);
