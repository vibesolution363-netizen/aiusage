'use strict';

/*
 * geminiLive.js — best-effort live usage from gemini.google.com.
 *
 * Mirrors claudeLive.js, but Google does NOT expose a clean JSON usage endpoint
 * the way claude.ai does (/api/usage_limit). The Gemini web app talks to
 * obfuscated `batchexecute` RPCs, and the "Usage limits" panel only renders
 * after the user opens it. So instead of fetching JSON we:
 *
 *   1. Let the user sign in to their Google account in a normal window that
 *      shares a persistent session partition ('persist:gemini').
 *   2. Load the usage page inside a hidden gemini.google.com window and read
 *      the "N% used" figures straight from the rendered DOM text.
 *
 * Because Google changes its UI, the page we read is overridable via
 * settings.gemini.usageUrl. When nothing parses we report authed=true /
 * data=null and the caller falls back to manual entry (always accurate).
 *
 * This module is main-process only (it requires electron).
 */

const { BrowserWindow, session } = require('electron');

// Two cookie jars: persistent ("Remember me") and in-memory (this run only).
const PARTITION_PERSIST = 'persist:gemini';
const PARTITION_SESSION = 'gemini';
const BASE = 'https://gemini.google.com';
const DEFAULT_USAGE_URL = 'https://gemini.google.com/usage';

let remember = true;

function partitionName() {
  return remember ? PARTITION_PERSIST : PARTITION_SESSION;
}

function setRemember(value) {
  const next = value !== false;
  if (next !== remember) {
    remember = next;
    destroy();
  }
}

let worker = null;

function ses() {
  return session.fromPartition(partitionName());
}

// Logged in if Google has set its primary auth cookie for this session.
async function isAuthed() {
  try {
    const cookies = await ses().cookies.get({ url: BASE });
    return cookies.some((c) => (c.name === '__Secure-1PSID' || c.name === 'SID') && !!c.value);
  } catch {
    return false;
  }
}

// Open a real Google sign-in window on our partition. The user signs in once;
// the cookies land in our jar automatically (no copy/paste). Resolves with the
// auth state after the window is closed.
function openLogin() {
  const part = partitionName();
  return new Promise((resolve) => {
    const win = new BrowserWindow({
      width: 480,
      height: 760,
      title: 'Sign in — Google',
      autoHideMenuBar: true,
      backgroundColor: '#0a0e1a',
      webPreferences: { partition: part, contextIsolation: true, nodeIntegration: false },
    });
    win.webContents.setWindowOpenHandler(() => ({
      action: 'allow',
      overrideBrowserWindowOptions: { webPreferences: { partition: part } },
    }));
    let settled = false;
    const settle = (authed) => {
      if (settled) return;
      settled = true;
      clearInterval(timer);
      resolve(authed);
    };
    // Poll while the window is open; the moment the Google auth cookie appears
    // we auto-close the window and report success (no manual close needed).
    const timer = setInterval(async () => {
      if (win.isDestroyed()) return;
      let authed = false;
      try {
        authed = await isAuthed();
      } catch {
        /* ignore */
      }
      if (authed) {
        settle(true);
        if (!win.isDestroyed()) win.close();
      }
    }, 1200);
    win.loadURL(`${BASE}/app`);
    win.on('closed', async () => settle(await isAuthed()));
  });
}

// Parse a pasted cookie blob into { name, value } pairs. Accepts either a full
// Cookie header / document.cookie string ("a=1; b=2; …") or a lone
// __Secure-1PSID value (no "=").
function parseCookieBlob(raw) {
  const text = String(raw || '').trim();
  if (!text) return [];
  if (!text.includes('=')) return [{ name: '__Secure-1PSID', value: text }];
  return text
    .split(/;\s*/)
    .map((part) => {
      const i = part.indexOf('=');
      if (i < 0) return null;
      const name = part.slice(0, i).trim();
      const value = part.slice(i + 1).trim();
      return name ? { name, value } : null;
    })
    .filter(Boolean);
}

// Reuse an already-logged-in browser by importing its Google auth cookies. The
// user pastes their gemini.google.com cookies (DevTools → Network → any request
// → Request Headers → Cookie, or Application → Cookies). Google auth needs more
// than one cookie (__Secure-1PSID, __Secure-1PSIDTS, __Secure-1PSIDCC, …), so we
// set every pair provided. Returns true if the result authenticates.
async function importSession(rawKey) {
  const pairs = parseCookieBlob(rawKey);
  if (!pairs.length) return false;
  // One year out so the persistent jar keeps them across restarts; Google will
  // reject them sooner if the real session expires, and we fall back gracefully.
  const expirationDate = Math.floor(Date.now() / 1000) + 60 * 60 * 24 * 365;
  try {
    for (const { name, value } of pairs) {
      // __Host- cookies must omit domain and use path "/"; __Secure- (and the
      // host-prefixed ones) must be secure. Everything else goes on .google.com.
      const isHost = name.startsWith('__Host-');
      const cookie = {
        url: BASE,
        name,
        value,
        path: '/',
        secure: isHost || name.startsWith('__Secure-'),
        sameSite: 'no_restriction',
        expirationDate,
      };
      if (!isHost) cookie.domain = '.google.com';
      try {
        await ses().cookies.set(cookie);
      } catch {
        /* skip cookies the jar rejects, keep going */
      }
    }
    destroy(); // rebuild the worker so the new cookies are in effect
    return await isAuthed();
  } catch {
    return false;
  }
}

async function clearSession() {
  destroy();
  try {
    await ses().clearStorageData();
  } catch {
    /* ignore */
  }
}

function ensureWorker(usageUrl) {
  if (worker && !worker.isDestroyed()) return worker.loadURL(usageUrl).catch(() => {});
  worker = new BrowserWindow({
    show: false,
    webPreferences: {
      partition: partitionName(),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  worker.on('closed', () => {
    worker = null;
  });
  return worker.loadURL(usageUrl).catch(() => {});
}

// Self-contained script run inside the gemini.google.com page. Polls for the
// usage figures (the SPA renders late) and scrapes "N% used" + reset text from
// the rendered DOM. Returns a JSON-serializable result object.
function buildScript() {
  return (
    '(async () => {' +
    'const out={authed:true,data:null,raw:null,plan:null};' +
    'const sleep=(ms)=>new Promise(r=>setTimeout(r,ms));' +
    'function scrape(){' +
    'if(/accounts\\.google\\.com/.test(location.href)){out.authed=false;return true;}' +
    'const text=(document.body&&document.body.innerText)||"";' +
    'const pcts=[];const re=/(\\d{1,3})\\s*%\\s*used/gi;let m;' +
    'while((m=re.exec(text))!==null){pcts.push(Math.max(0,Math.min(1,Number(m[1])/100)));}' +
    'const resets=[];const lines=text.split(/\\n+/);' +
    'for(const ln of lines){if(/reset/i.test(ln)){resets.push(ln.trim());}}' +
    'if(!pcts.length)return false;' +
    // Plan badge sits right after the "Usage limits" heading (e.g. PLUS). Match
    // it there so the "AI Pro" upgrade banner lower down does not fool us.
    'const pm=text.match(/usage limits[\\s\\u00a0]*\\n?[\\s\\u00a0]*(free|plus|pro|ultra|advanced)\\b/i);' +
    'if(pm){out.plan=pm[1].charAt(0).toUpperCase()+pm[1].slice(1).toLowerCase();}' +
    'out.raw=text.slice(0,600);' +
    'const s={used:pcts[0],resets:resets[0]||null};' +
    'const w=pcts.length>1?{used:pcts[1],resets:resets[1]||resets[0]||null}:null;' +
    'out.data={session:s,weekly:w};return true;}' +
    'for(let i=0;i<40;i++){if(scrape())break;await sleep(300);}' +
    'return out;})()'
  );
}

// Returns { authed, data: { session:{used,resets}, weekly:{used,resets} } | null, error? }
async function fetchUsage(usageUrl) {
  const url = usageUrl && String(usageUrl).trim() ? String(usageUrl).trim() : DEFAULT_USAGE_URL;
  if (!(await isAuthed())) return { authed: false, data: null };
  let timer = null;
  try {
    await ensureWorker(url);
    const result = await Promise.race([
      worker.webContents.executeJavaScript(buildScript(), true),
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error('gemini live timeout')), 16000);
      }),
    ]);
    return result || { authed: true, data: null };
  } catch (err) {
    return { authed: true, data: null, error: String((err && err.message) || err) };
  } finally {
    // Clear the race timeout so it doesn't linger holding a closure, then recycle
    // the hidden worker so the gemini.google.com page isn't left resident between
    // refreshes (bounds memory over long uptime).
    if (timer) clearTimeout(timer);
    destroy();
  }
}

function destroy() {
  try {
    if (worker && !worker.isDestroyed()) worker.destroy();
  } catch {
    /* ignore */
  }
  worker = null;
}

module.exports = {
  isAuthed,
  openLogin,
  importSession,
  clearSession,
  setRemember,
  fetchUsage,
  destroy,
  buildScript,
  PARTITION_PERSIST,
  PARTITION_SESSION,
  DEFAULT_USAGE_URL,
};
