'use strict';

const { app, BrowserWindow, ipcMain, screen, Tray, Menu, nativeImage, shell } = require('electron');
const path = require('path');
const fs = require('fs');

const claudeUsage = require('./services/claudeUsage');
const claudeLive = require('./services/claudeLive');
const openaiUsage = require('./services/openaiUsage');
const copilotUsage = require('./services/copilotUsage');

// ---------- Constants ----------
const WIN_WIDTH = 260;
const WIN_HEIGHT = 480;
const COLLAPSED_HEIGHT = 116;
const SCREEN_MARGIN = 16;

const DEFAULT_SETTINGS = {
  window: { x: null, y: null, opacity: 0.92 },
  apiKeys: { anthropic: '', openai: '', github: '' },
  currency: { code: 'MYR', rate: 4.71 },
  refreshInterval: 300000,
  activeTab: 'claude',
  claude: {
    useLiveScrape: true,
    // Optional override of internal endpoints tried in the claude.ai context.
    // {org} is replaced with the user's organization uuid. Empty = use defaults.
    usageEndpoints: [],
    manual: { enabled: false, sessionUsed: null, weeklyUsed: null, plan: 'Max' },
  },
};

// ---------- State ----------
let win = null;
let tray = null;
let settings = JSON.parse(JSON.stringify(DEFAULT_SETTINGS));
let dragTimer = null;
let dragOffset = { x: 0, y: 0 };
let saveTimer = null;

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
}

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

  win.once('ready-to-show', () => win.show());

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
  return claudeUsage.build({ live, manual: cfg.manual, rate });
}

async function getUsage(service) {
  const keys = settings.apiKeys || {};
  const rate = (settings.currency && settings.currency.rate) || 4.71;
  try {
    switch (service) {
      case 'claude':
        return await claudeData(rate);
      case 'openai':
        return await openaiUsage.fetchUsage(keys.openai, rate);
      case 'copilot':
        return await copilotUsage.fetchUsage(keys.github, rate);
      case 'all': {
        const [claude, openai, copilot] = await Promise.all([
          claudeData(rate),
          openaiUsage.fetchUsage(keys.openai, rate),
          copilotUsage.fetchUsage(keys.github, rate),
        ]);
        return { claude, openai, copilot };
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

// ---- Claude live session (Option 1) ----
ipcMain.handle('claude-login', async () => {
  const authed = await claudeLive.openLogin();
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

ipcMain.handle('resize-window', (_e, height) => {
  if (!win) return false;
  const [x, y] = win.getPosition();
  const h = Math.max(COLLAPSED_HEIGHT, Math.min(900, Math.round(Number(height) || WIN_HEIGHT)));
  win.setBounds({ x, y, width: WIN_WIDTH, height: h });
  return true;
});

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
    if (win && !win.isDestroyed()) {
      const [x, y] = win.getPosition();
      settings.window.x = x;
      settings.window.y = y;
    }
    claudeLive.destroy();
    writeSettings();
  });
}
