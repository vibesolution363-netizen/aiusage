'use strict';

/*
 * openaiLive.js — best-effort live account info from chatgpt.com.
 *
 * Mirrors claudeLive.js / geminiLive.js. ChatGPT does NOT publish a usage-limit
 * page with percentages the way Gemini does, so there are no session/weekly
 * "% used" numbers to read. What we CAN read from a signed-in session is the
 * account plan (Free / Plus / Pro / Team / Enterprise) and connection state:
 *
 *   1. Let the user paste their chatgpt.com session cookie
 *      (__Secure-next-auth.session-token) into a persistent partition.
 *   2. From inside a hidden chatgpt.com page, fetch /api/auth/session to get the
 *      access token, then /backend-api/accounts/check to read the plan.
 *
 * This module is main-process only (it requires electron).
 */

const { BrowserWindow, session } = require('electron');

const PARTITION_PERSIST = 'persist:openai';
const PARTITION_SESSION = 'openai';
const BASE = 'https://chatgpt.com';
const SESSION_COOKIE = '__Secure-next-auth.session-token';

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

// Logged in if chatgpt.com has a non-empty next-auth session cookie. next-auth
// often chunks a long JWT token into ".0"/".1" and the prefix varies, so match
// any "next-auth.session-token" cookie. Query the whole partition jar (no url
// filter) to avoid domain/path filtering surprises.
async function isAuthed() {
  try {
    const cookies = await ses().cookies.get({});
    return cookies.some((c) => /next-auth\.session-token/i.test(c.name) && !!c.value);
  } catch {
    return false;
  }
}

// Open a real ChatGPT sign-in window on our partition. The user signs in once;
// the cookies land in our jar automatically (no copy/paste). Resolves with the
// auth state after the window is closed.
function openLogin() {
  const part = partitionName();
  return new Promise((resolve) => {
    const win = new BrowserWindow({
      width: 480,
      height: 760,
      title: 'Sign in — ChatGPT',
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
    // Poll while the window is open; the moment the session cookie appears we
    // auto-close the window and report success (no manual close needed).
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
    win.loadURL(`${BASE}/`);
    win.on('closed', async () => settle(await isAuthed()));
  });
}

// Parse a pasted cookie blob into { name, value } pairs. Accepts a full Cookie
// header ("a=1; b=2; …") or a lone session-token value (no "=").
function parseCookieBlob(raw) {
  const text = String(raw || '').trim();
  if (!text) return [];
  if (!text.includes('=')) return [{ name: SESSION_COOKIE, value: text }];
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

// Reuse an already-logged-in browser by importing its chatgpt.com cookies. The
// user pastes the session-token (or the whole Cookie header). Returns true if
// the result authenticates.
async function importSession(rawKey) {
  const pairs = parseCookieBlob(rawKey);
  if (!pairs.length) return false;
  const expirationDate = Math.floor(Date.now() / 1000) + 60 * 60 * 24 * 365;
  try {
    for (const { name, value } of pairs) {
      const isHost = name.startsWith('__Host-');
      const cookie = {
        url: BASE,
        name,
        value,
        path: '/',
        secure: isHost || name.startsWith('__Secure-'),
        httpOnly: name === SESSION_COOKIE,
        sameSite: 'lax',
        expirationDate,
      };
      if (!isHost) cookie.domain = '.chatgpt.com';
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

function ensureWorker() {
  if (worker && !worker.isDestroyed()) return Promise.resolve();
  worker = new BrowserWindow({
    show: false,
    webPreferences: {
      partition: partitionName(),
      contextIsolation: true,
      nodeIntegration: false,
      images: false,
    },
  });
  worker.on('closed', () => {
    worker = null;
  });
  return worker.loadURL(`${BASE}/`).catch(() => {});
}

// Self-contained script run inside the chatgpt.com page. Reads the access token
// from /api/auth/session, then the plan from /backend-api/accounts/check.
// Returns { authed, plan, raw }.
function buildScript() {
  return (
    '(async () => {' +
    'const out={authed:true,plan:null,raw:null};' +
    'function planFrom(blob){' +
    'if(/enterprise/.test(blob))return "Enterprise";' +
    'if(/team/.test(blob))return "Team";' +
    'if(/pro/.test(blob))return "Pro";' +
    'if(/plus/.test(blob))return "Plus";' +
    'if(/free/.test(blob))return "Free";return null;}' +
    'async function gj(u,h){try{const r=await fetch(u,{credentials:"include",headers:h||{accept:"application/json"}});' +
    'const t=await r.text();let j=null;try{j=JSON.parse(t);}catch(e){}return{status:r.status,j:j};}catch(e){return{status:0};}}' +
    'const s=await gj("/api/auth/session");' +
    'if(s.status===401||s.status===403){out.authed=false;return out;}' +
    'if(!s.j||Object.keys(s.j).length===0){out.authed=false;return out;}' +
    'const token=s.j.accessToken||null;' +
    'let blob=JSON.stringify(s.j).toLowerCase();' +
    'if(token){const a=await gj("/backend-api/accounts/check/v4-2023-04-08",{accept:"application/json",authorization:"Bearer "+token});' +
    'if(a.j){out.raw=a.j;blob+=JSON.stringify(a.j).toLowerCase();}}' +
    // Look at plan-bearing keys first to avoid matching unrelated words.
    'const planKeys=blob.match(/(plan_type|subscription_plan|account_plan|plan)["\\s:]+[a-z_]*(free|plus|pro|team|enterprise)/g);' +
    'out.plan=planFrom((planKeys?planKeys.join(" "):"")||blob);' +
    'return out;})()'
  );
}

// Returns { authed, plan, error? }
async function fetchUsage() {
  if (!(await isAuthed())) return { authed: false, plan: null };
  try {
    await ensureWorker();
    const result = await Promise.race([
      worker.webContents.executeJavaScript(buildScript(), true),
      new Promise((_, reject) => setTimeout(() => reject(new Error('openai live timeout')), 14000)),
    ]);
    return result || { authed: true, plan: null };
  } catch (err) {
    return { authed: true, plan: null, error: String((err && err.message) || err) };
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
};
