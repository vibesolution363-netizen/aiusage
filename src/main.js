'use strict';

const { app, BrowserWindow, ipcMain, screen, Tray, Menu, nativeImage, shell } = require('electron');
const path = require('path');
const fs = require('fs');

const claudeUsage = require('./services/claudeUsage');
const claudeLive = require('./services/claudeLive');
const openaiUsage = require('./services/openaiUsage');
const openaiLive = require('./services/openaiLive');
const geminiUsage = require('./services/geminiUsage');
const geminiLive = require('./services/geminiLive');
const { PLAN_PRICES } = require('./services/util');

// ---------- Constants ----------
const WIN_WIDTH = 260;
const WIN_HEIGHT = 480;
const COLLAPSED_HEIGHT = 116;
const SCREEN_MARGIN = 16;
// Width of the grab tab left peeking on screen when the dock is slid to the edge.
const HANDLE_W = 22;

const DEFAULT_SETTINGS = {
  window: { x: null, y: null, opacity: 0.92, peeked: false },
  currency: { code: 'MYR', rate: 4.71 },
  refreshInterval: 300000,
  activeTab: 'claude',
  // AI services shown as tabs. Claude is always present; the user adds the
  // rest (openai, gemini) via the "+" button in the dock.
  enabledServices: ['claude'],
  claude: {
    useLiveScrape: true,
    // Remember the claude.ai login across restarts (persistent cookie jar).
    // When false the session lives only until the app quits.
    rememberMe: true,
    // Optional override of internal endpoints tried in the claude.ai context.
    // {org} is replaced with the user's organization uuid. Empty = use defaults.
    usageEndpoints: [],
    manual: { enabled: false, sessionUsed: null, weeklyUsed: null, plan: 'Max' },
  },
  gemini: {
    useLiveScrape: true,
    // Remember the Google login across restarts (persistent cookie jar).
    rememberMe: true,
    // Page scraped inside the gemini.google.com context for "N% used" figures.
    // Override if Google moves the usage view. Empty = use the default app page.
    usageUrl: '',
    manual: { enabled: false, sessionUsed: null, weeklyUsed: null, plan: 'Pro' },
  },
  openai: {
    useLiveScrape: true,
    // Remember the chatgpt.com session across restarts (persistent cookie jar).
    rememberMe: true,
  },
  // Monthly subscription LIST prices per plan, shown in the cost footer. Flat
  // seat fees, not usage billing. Each entry is a number (USD — Claude/ChatGPT
  // bill in USD) or { "myr": N } for a ringgit-native price (Gemini in Malaysia).
  // Edit here if yours differ; `null` = no public price (e.g. Enterprise) and the
  // footer shows the plan only. (Defaults: services/util.js → PLAN_PRICES.)
  prices: JSON.parse(JSON.stringify(PLAN_PRICES)),
};

// ---------- State ----------
let win = null;
let tray = null;
let settings = JSON.parse(JSON.stringify(DEFAULT_SETTINGS));
let dragTimer = null;
let dragOffset = { x: 0, y: 0 };
let saveTimer = null;
let slideTimer = null;
let peeked = false;

// ---------- Paths ----------
// Portable apps keep their settings next to the .exe so "copy folder + run"
// preserves state. In dev we use the project's config/ folder.
function getDataDir() {
  if (!app.isPackaged) return path.join(__dirname, '..', 'config');
  if (process.env.PORTABLE_EXECUTABLE_DIR) {
    return path.join(process.env.PORTABLE_EXECUTABLE_DIR, 'AiUsageDock-data');
  }
  return path.join(path.dirname(app.getPath('exe')), 'AiUsageDock-data');
}

function getSettingsFile() {
  return path.join(getDataDir(), 'settings.json');
}

function getAssetPath(...p) {
  const base = app.isPackaged ? path.join(process.resourcesPath, 'app.asar.unpacked') : path.join(__dirname, '..');
  return path.join(base, 'assets', ...p);
}~

// ---------- Settings helpers ----------
function deepMerge(base, override) {
  const out = Array.isArray(base) ? base.slice() : Object.assign({}, base);
  for (const key of Object.keys(override || {})) {
    const ov = override[key];
    if (ov && typeof ov === 'object' && !Array.isArray(ov) && base[key] && typeof base[key] === 'object') {
      out[key] = deepMerge(base[key], ov);
    } else {
      out[key] = ov;
    }
  }
  return out;
}

function writeSettings() {
  try {
    fs.mkdirSync(getDataDir(), { recursive: true });
    fs.writeFileSync(getSettingsFile(), JSON.stringify(settings, null, 2));
  } catch (err) {
    console.error('Failed to write settings:', err.message);
  }
}

function scheduleSave() {
  if (saveTimer) clearTimeout(saveTimer);
  saveTimer = setTimeout(writeSettings, 400);
}

function loadSettings() {
  try {
    const raw = fs.readFileSync(getSettingsFile(), 'utf-8');
    settings = deepMerge(DEFAULT_SETTINGS, JSON.parse(raw));
  } catch {
    settings = JSON.parse(JSON.stringify(DEFAULT_SETTINGS));
    writeSettings();
  }
  syncRemember();
}

// Keep the live cookie jars in sync with each service's rememberMe preference.
function syncRemember() {
  claudeLive.setRemember(settings.claude && settings.claude.rememberMe !== false);
  geminiLive.setRemember(settings.gemini && settings.gemini.rememberMe !== false);
  openaiLive.setRemember(settings.openai && settings.openai.rememberMe !== false);
}

// ---------- Window position ----------
function topRightPosition() {
  const wa = screen.getPrimaryDisplay().workArea;
  return {
    x: wa.x + wa.width - WIN_WIDTH - SCREEN_MARGIN,
    y: wa.y + SCREEN_MARGIN,
  };
}

// Make sure a stored position is still on a connected display.
function isOnScreen(x, y) {
  if (!Number.isFinite(x) || !Number.isFinite(y)) return false;
  return screen.getAllDisplays().some((d) => {
    const b = d.bounds;
    return x >= b.x - WIN_WIDTH + 40 && x <= b.x + b.width - 40 && y >= b.y - 10 && y <= b.y + b.height - 40;
  });
}

function resolveStartPosition() {
  const { x, y } = settings.window;
  if (isOnScreen(x, y)) return { x, y };
  return topRightPosition();
}

// ---------- Browser window ----------
function createWindow() {
  const pos = resolveStartPosition();

  win = new BrowserWindow({
    width: WIN_WIDTH,
    height: WIN_HEIGHT,
    x: pos.x,
    y: pos.y,
    frame: false,
    transparent: true,
    backgroundColor: '#00000000',
    alwaysOnTop: true,
    resizable: false,
    skipTaskbar: true,
    maximizable: false,
    minimizable: false,
    fullscreenable: false,
    hasShadow: false,
    show: false,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
      preload: path.join(__dirname, 'preload.js'),
    },
  });

  win.setAlwaysOnTop(true, 'floating');
  win.setVisibleOnAllWorkspaces(true);
  win.setOpacity(clampOpacity(settings.window.opacity));
  win.loadFile(path.join(__dirname, 'renderer', 'index.html'));

  win.once('ready-to-show', () => {
    win.show();
    // Restore the "slid to edge" state from the previous session, if any.
    if (settings.window && settings.window.peeked) applyPeek(true, false);
  });

  // Slide out of the way automatically when the dock loses focus
  // (the user clicked another app, a browser, or the desktop).
  win.on('blur', () => {
    if (!win || !win.isVisible() || peeked || app.isQuitting) return;
    applyPeek(true, true);
    win.webContents.send('peek-changed', true);
  });

  // Open external links in the default browser, never inside the dock.
  win.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url);
    return { action: 'deny' };
  });

  win.on('closed', () => {
    win = null;
  });

  if (process.argv.includes('--devtools')) {
    win.webContents.openDevTools({ mode: 'detach' });
  }
}

function clampOpacity(v) {
  const n = Number(v);
  if (!Number.isFinite(n)) return 0.92;
  return Math.max(0.2, Math.min(1, n));
}

// ---------- Edge slide (peek) ----------
// Work area of whichever display the window currently sits on.
function workAreaForWin() {
  const [x, y] = win.getPosition();
  const [w, h] = win.getSize();
  const d = screen.getDisplayNearestPoint({ x: x + Math.round(w / 2), y: y + Math.round(h / 2) });
  return d.workArea;
}

// Animate only the window's X so it slides horizontally (Y stays put).
function animateX(targetX) {
  if (slideTimer) clearInterval(slideTimer);
  const startX = win.getPosition()[0];
  const startT = Date.now();
  const dur = 200;
  slideTimer = setInterval(() => {
    if (!win) {
      clearInterval(slideTimer);
      slideTimer = null;
      return;
    }
    const t = Math.min(1, (Date.now() - startT) / dur);
    const ease = t < 0.5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2; // easeInOutQuad
    const y = win.getPosition()[1];
    win.setPosition(Math.round(startX + (targetX - startX) * ease), y);
    if (t >= 1) {
      clearInterval(slideTimer);
      slideTimer = null;
    }
  }, 8);
}

// Slide the dock off the right edge (only the grab tab remains) or back in.
function applyPeek(wantPeek, animate = true) {
  if (!win) return;
  peeked = !!wantPeek;
  const wa = workAreaForWin();
  const waRight = wa.x + wa.width;
  const targetX = peeked ? waRight - HANDLE_W : waRight - WIN_WIDTH;
  if (animate) animateX(targetX);
  else win.setPosition(targetX, win.getPosition()[1]);
  settings.window.peeked = peeked;
  scheduleSave();
}

// ---------- System tray ----------
function makeFallbackIcon() {
  // Raw BGRA bitmap (Windows) amber->red square, used if icon.png is missing.
  const size = 16;
  const buf = Buffer.alloc(size * size * 4);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const i = (y * size + x) * 4;
      const t = (x + y) / (2 * size);
      buf[i] = Math.round(11 + (68 - 11) * t); // B
      buf[i + 1] = Math.round(158 + (68 - 158) * t); // G
      buf[i + 2] = Math.round(245 + (239 - 245) * t); // R
      buf[i + 3] = 255; // A
    }
  }
  return nativeImage.createFromBitmap(buf, { width: size, height: size });
}

function loadTrayIcon() {
  try {
    const img = nativeImage.createFromPath(getAssetPath('icon.png'));
    if (!img.isEmpty()) return img.resize({ width: 16, height: 16 });
  } catch {
    /* fall through */
  }
  return makeFallbackIcon();
}

function toggleWindow() {
  if (!win) return createWindow();
  if (win.isVisible()) {
    win.hide();
  } else {
    win.show();
    win.focus();
  }
}

function createTray() {
  try {
    tray = new Tray(loadTrayIcon());
    tray.setToolTip('AI Usage Dock');
    const menu = Menu.buildFromTemplate([
      { label: 'Show / Hide', click: toggleWindow },
      { label: 'Refresh', click: () => win && win.webContents.send('tray-refresh') },
      { type: 'separator' },
      { label: 'Edit settings.json', click: openSettingsFile },
      { label: 'Open data folder', click: () => shell.openPath(getDataDir()) },
      { type: 'separator' },
      {
        label: 'Quit',
        click: () => {
          app.isQuitting = true;
          app.quit();
        },
      },
    ]);
    tray.setContextMenu(menu);
    tray.on('double-click', toggleWindow);
  } catch (err) {
    console.error('Failed to create tray:', err.message);
  }
}

function openSettingsFile() {
  fs.mkdirSync(getDataDir(), { recursive: true });
  if (!fs.existsSync(getSettingsFile())) writeSettings();
  shell.openPath(getSettingsFile());
}

// ---------- Usage fetching ----------
// Claude: try live claude.ai scrape (Option 1), then manual values (Option 2).
async function claudeData(rate) {
  const cfg = settings.claude || {};
  let live = { authed: false, data: null };
  if (cfg.useLiveScrape !== false) {
    try {
      live = await claudeLive.fetchUsage(cfg.usageEndpoints);
    } catch (err) {
      live = { authed: false, data: null, error: String((err && err.message) || err) };
    }
  } else {
    try {
      live.authed = await claudeLive.isAuthed();
    } catch {
      /* ignore */
    }
  }
  return claudeUsage.build({ live, manual: cfg.manual, rate, prices: settings.prices });
}

// Gemini: try live gemini.google.com scrape, then manual values.
async function geminiData(rate) {
  const cfg = settings.gemini || {};
  let live = { authed: false, data: null };
  if (cfg.useLiveScrape !== false) {
    try {
      live = await geminiLive.fetchUsage(cfg.usageUrl);
    } catch (err) {
      live = { authed: false, data: null, error: String((err && err.message) || err) };
    }
  } else {
    try {
      live.authed = await geminiLive.isAuthed();
    } catch {
      /* ignore */
    }
  }
  return geminiUsage.build({ live, manual: cfg.manual, rate, prices: settings.prices });
}

// ChatGPT: read plan + connection from a signed-in chatgpt.com session.
async function openaiData(rate) {
  const cfg = settings.openai || {};
  let live = { authed: false, plan: null };
  if (cfg.useLiveScrape !== false) {
    try {
      live = await openaiLive.fetchUsage();
    } catch (err) {
      live = { authed: false, plan: null, error: String((err && err.message) || err) };
    }
  } else {
    try {
      live.authed = await openaiLive.isAuthed();
    } catch {
      /* ignore */
    }
  }
  return openaiUsage.build({ live, rate, prices: settings.prices });
}

async function getUsage(service) {
  const rate = (settings.currency && settings.currency.rate) || 4.71;
  try {
    switch (service) {
      case 'claude':
        return await claudeData(rate);
      case 'openai':
        return await openaiData(rate);
      case 'gemini':
        return await geminiData(rate);
      case 'all': {
        const [claude, openai, gemini] = await Promise.all([
          claudeData(rate),
          openaiData(rate),
          geminiData(rate),
        ]);
        return { claude, openai, gemini };
      }
      default:
        return { error: 'unknown service: ' + service };
    }
  } catch (err) {
    return { error: String((err && err.message) || err) };
  }
}

// ---------- IPC ----------
ipcMain.handle('get-settings', () => settings);

ipcMain.handle('save-settings', (_e, partial) => {
  settings = deepMerge(settings, partial || {});
  syncRemember();
  writeSettings();
  return settings;
});

ipcMain.handle('set-opacity', (_e, value) => {
  const v = clampOpacity(value);
  if (win) win.setOpacity(v);
  settings.window.opacity = v;
  scheduleSave();
  return v;
});

ipcMain.handle('fetch-usage', (_e, service) => getUsage(service));

// ---- Claude live session ----
// Open a sign-in window and capture cookies automatically.
ipcMain.handle('claude-login', async (_e, remember) => {
  if (remember != null) {
    settings.claude.rememberMe = remember !== false;
    syncRemember();
    scheduleSave();
  }
  const authed = await claudeLive.openLogin();
  return { authed };
});

// Reuse an already-logged-in browser by importing its sessionKey cookie.
ipcMain.handle('claude-import-session', async (_e, key, remember) => {
  if (remember != null) {
    settings.claude.rememberMe = remember !== false;
    syncRemember();
    scheduleSave();
  }
  const authed = await claudeLive.importSession(key);
  return { authed };
});

ipcMain.handle('claude-logout', async () => {
  await claudeLive.clearSession();
  return { authed: false };
});

ipcMain.handle('claude-status', async () => {
  let authed = false;
  try {
    authed = await claudeLive.isAuthed();
  } catch {
    /* ignore */
  }
  return { authed };
});

// ---- Gemini live session ----
// Open a sign-in window and capture cookies automatically.
ipcMain.handle('gemini-login', async (_e, remember) => {
  if (remember != null) {
    settings.gemini.rememberMe = remember !== false;
    syncRemember();
    scheduleSave();
  }
  const authed = await geminiLive.openLogin();
  return { authed };
});

// Reuse an already-logged-in browser by importing its __Secure-1PSID cookie.
ipcMain.handle('gemini-import-session', async (_e, key, remember) => {
  if (remember != null) {
    settings.gemini.rememberMe = remember !== false;
    syncRemember();
    scheduleSave();
  }
  const authed = await geminiLive.importSession(key);
  return { authed };
});

ipcMain.handle('gemini-logout', async () => {
  await geminiLive.clearSession();
  return { authed: false };
});

ipcMain.handle('gemini-status', async () => {
  let authed = false;
  try {
    authed = await geminiLive.isAuthed();
  } catch {
    /* ignore */
  }
  return { authed };
});

// ---- ChatGPT (OpenAI) live session ----
// Open a sign-in window and capture cookies automatically.
ipcMain.handle('openai-login', async (_e, remember) => {
  if (remember != null) {
    settings.openai.rememberMe = remember !== false;
    syncRemember();
    scheduleSave();
  }
  const authed = await openaiLive.openLogin();
  return { authed };
});

// Reuse an already-logged-in browser by importing its session-token cookie.
ipcMain.handle('openai-import-session', async (_e, key, remember) => {
  if (remember != null) {
    settings.openai.rememberMe = remember !== false;
    syncRemember();
    scheduleSave();
  }
  const authed = await openaiLive.importSession(key);
  return { authed };
});

ipcMain.handle('openai-logout', async () => {
  await openaiLive.clearSession();
  return { authed: false };
});

ipcMain.handle('openai-status', async () => {
  let authed = false;
  try {
    authed = await openaiLive.isAuthed();
  } catch {
    /* ignore */
  }
  return { authed };
});

ipcMain.handle('resize-window', (_e, height) => {
  if (!win) return false;
  const [x, y] = win.getPosition();
  const h = Math.max(COLLAPSED_HEIGHT, Math.min(900, Math.round(Number(height) || WIN_HEIGHT)));
  win.setBounds({ x, y, width: WIN_WIDTH, height: h });
  return true;
});

ipcMain.on('set-peek', (_e, wantPeek) => applyPeek(wantPeek, true));

ipcMain.on('drag-start', (_e, offset) => {
  dragOffset = offset && Number.isFinite(offset.x) ? offset : { x: 0, y: 0 };
  if (dragTimer) clearInterval(dragTimer);
  dragTimer = setInterval(() => {
    if (!win) return;
    const p = screen.getCursorScreenPoint();
    win.setPosition(p.x - dragOffset.x, p.y - dragOffset.y);
  }, 8);
});

ipcMain.on('drag-end', () => {
  if (dragTimer) {
    clearInterval(dragTimer);
    dragTimer = null;
  }
  if (win) {
    const [x, y] = win.getPosition();
    settings.window.x = x;
    settings.window.y = y;
    scheduleSave();
  }
});

ipcMain.on('close-app', () => {
  app.isQuitting = true;
  app.quit();
});

ipcMain.on('minimize-app', () => {
  if (win) win.hide();
});

ipcMain.on('open-settings-file', openSettingsFile);

ipcMain.on('open-external', (_e, url) => {
  if (url && /^https?:\/\//i.test(url)) shell.openExternal(url);
});

// ---------- App lifecycle ----------
const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (win) {
      win.show();
      win.focus();
    } else {
      createWindow();
    }
  });

  app.whenReady().then(() => {
    loadSettings();
    createWindow();
    createTray();
  });

  // Keep running in the tray when the window is hidden/closed.
  app.on('window-all-closed', () => {
    /* intentionally do not quit — the tray keeps the app alive */
  });

  app.on('activate', () => {
    if (!win) createWindow();
  });

  app.on('before-quit', () => {
    app.isQuitting = true;
    if (win && !win.isDestroyed() && !peeked) {
      const [x, y] = win.getPosition();
      settings.window.x = x;
      settings.window.y = y;
    }
    claudeLive.destroy();
    geminiLive.destroy();
    openaiLive.destroy();
    writeSettings();
  });
}
