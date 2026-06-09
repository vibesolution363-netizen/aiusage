'use strict';

/*
 * claudeLive.js — OPTION 1: best-effort live usage from claude.ai.
 *
 * Anthropic does not publish a REST endpoint for plan usage (session %, weekly
 * %). The web app calls internal endpoints from the claude.ai origin using the
 * logged-in session cookie. We reproduce that by:
 *
 *   1. Letting the user log in to claude.ai in a normal window that shares a
 *      persistent session partition ('persist:claude').
 *   2. Running the fetch FROM INSIDE a hidden claude.ai page (executeJavaScript)
 *      so cookies, CSRF and any Cloudflare context apply exactly like a browser.
 *   3. Trying a list of candidate endpoints and flexibly parsing usage numbers.
 *
 * Because the internal endpoint isn't documented (and changes), the candidate
 * list is overridable via settings.claude.usageEndpoints. If nothing parses,
 * we report authed=true / data=null and the caller falls back to manual entry.
 *
 * This module is main-process only (it requires electron).
 */

const { BrowserWindow, session } = require('electron');

// Two cookie jars: a persistent one (survives restarts → "Remember me") and an
// in-memory one (cleared when the app quits → login only for this run).
const PARTITION_PERSIST = 'persist:claude';
const PARTITION_SESSION = 'claude';
const BASE = 'https://claude.ai';

// When true we use the persistent partition. Synced from settings by main.js
// via setRemember(). Defaults to true to match the previous behaviour.
let remember = true;

function partitionName() {
  return remember ? PARTITION_PERSIST : PARTITION_SESSION;
}

// Switch between the persistent / in-memory cookie jars. If the choice changes
// we drop the worker so the next fetch rebuilds it against the right session.
function setRemember(value) {
  const next = value !== false;
  if (next !== remember) {
    remember = next;
    destroy();
  }
}

// {org} is replaced with the user's organization uuid (from /api/organizations).
const DEFAULT_ENDPOINTS = [
  '/api/usage_limit',
  '/api/organizations/{org}/usage',
  '/api/organizations/{org}/usage_limit',
  '/api/bootstrap/{org}/usage',
  '/api/account/usage',
];

let worker = null;

function ses() {
  return session.fromPartition(partitionName());
}

// Logged in if claude.ai has set a non-empty sessionKey cookie.
async function isAuthed() {
  try {
    const cookies = await ses().cookies.get({ url: BASE });
    return cookies.some((c) => c.name === 'sessionKey' && !!c.value);
  } catch {
    return false;
  }
}

// Open a real login window on our partition. The user signs in once; the
// cookies land in our jar automatically (no copy/paste). Resolves with the
// auth state after the window is closed.
function openLogin() {
  const part = partitionName();
  return new Promise((resolve) => {
    const win = new BrowserWindow({
      width: 460,
      height: 760,
      title: 'Sign in — claude.ai',
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
    win.loadURL(`${BASE}/login`);
    win.on('closed', async () => settle(await isAuthed()));
  });
}

async function clearSession() {
  destroy();
  try {
    await ses().clearStorageData();
  } catch {
    /* ignore */
  }
}

// Reuse an already-logged-in browser session without opening a login window:
// the user pastes the `sessionKey` cookie value from their browser (DevTools →
// Application → Cookies → claude.ai → sessionKey) and we set it on our jar.
// Returns true if the key authenticates against claude.ai.
async function importSession(rawKey) {
  const value = String(rawKey || '').trim();
  if (!value) return false;
  // One year out so the persistent jar keeps it across restarts; claude.ai will
  // reject it sooner if the real session expires, and we fall back gracefully.
  const expirationDate = Math.floor(Date.now() / 1000) + 60 * 60 * 24 * 365;
  try {
    await ses().cookies.set({
      url: BASE,
      name: 'sessionKey',
      value,
      domain: '.claude.ai',
      path: '/',
      secure: true,
      httpOnly: true,
      sameSite: 'lax',
      expirationDate,
    });
    destroy(); // rebuild the worker so the new cookie is in effect
    return await isAuthed();
  } catch {
    return false;
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

// Self-contained script run inside the claude.ai page. Returns a
// JSON-serializable result object.
function buildScript(endpoints) {
  return (
    '(async () => {' +
    'const out={authed:true,tried:[],data:null,endpoint:null,raw:null,plan:null};' +
    'function pick(o,ks){for(const k of ks){if(o&&o[k]!=null)return o[k];}return null;}' +
    'function usedFrom(o){if(!o||typeof o!=="object")return null;' +
    'let u=pick(o,["utilization","used_percent","usedPercent","percent_used","percentUsed","percent","pct_used"]);' +
    'if(u!=null){let v=Number(u);if(v>1)v=v/100;return Math.max(0,Math.min(1,v));}' +
    'const used=pick(o,["used","used_tokens","usage","count","consumed"]);' +
    'const limit=pick(o,["limit","total","cap","max","allowed","quota"]);' +
    'if(used!=null&&limit){return Math.max(0,Math.min(1,Number(used)/Number(limit)));}' +
    'const rem=pick(o,["remaining","left","remaining_tokens"]);' +
    'if(rem!=null&&limit){return Math.max(0,Math.min(1,1-Number(rem)/Number(limit)));}' +
    'return null;}' +
    'function resetFrom(o){return pick(o,["resets_at","resetsAt","reset_at","expires_at","expiresAt","reset","next_reset"]);}' +
    'function parse(j){if(!j||typeof j!=="object")return null;let s=null,w=null;' +
    'for(const k of Object.keys(j)){const lk=k.toLowerCase();const uu=usedFrom(j[k]);if(uu==null)continue;' +
    'if(s==null&&/(^|_)(5|five|hour|session|hourly|rolling)/.test(lk)){s={used:uu,resets:resetFrom(j[k])};}' +
    'else if(w==null&&/(7|seven|day|week)/.test(lk)){w={used:uu,resets:resetFrom(j[k])};}}' +
    'if(!s&&j.session){const uu=usedFrom(j.session);if(uu!=null)s={used:uu,resets:resetFrom(j.session)};}' +
    'if(!w&&j.weekly){const uu=usedFrom(j.weekly);if(uu!=null)w={used:uu,resets:resetFrom(j.weekly)};}' +
    'if(!s&&!w){const uu=usedFrom(j);if(uu!=null)s={used:uu,resets:resetFrom(j)};}' +
    'if(!s&&!w)return null;return{session:s,weekly:w};}' +
    'async function gj(u){try{const r=await fetch(u,{credentials:"include",headers:{accept:"application/json"}});' +
    'const t=await r.text();let j=null;try{j=JSON.parse(t);}catch(e){}out.tried.push({u:u,status:r.status});' +
    'return{ok:r.ok,status:r.status,j:j};}catch(e){out.tried.push({u:u,err:String(e)});return{ok:false};}}' +
    'let org=null;const orgs=await gj("/api/organizations");' +
    'if(orgs.status===401||orgs.status===403){out.authed=false;return out;}' +
    'if(orgs.j&&Array.isArray(orgs.j)&&orgs.j[0]){org=orgs.j[0].uuid||(orgs.j[0].organization&&orgs.j[0].organization.uuid)||null;}' +
    // Best-effort plan from the org capabilities/raw JSON (e.g. "claude_pro").
    'try{const b=JSON.stringify(orgs.j||"").toLowerCase();' +
    'if(/max_20x|max_5x|claude_max/.test(b))out.plan="Max";' +
    'else if(/claude_pro|raven_pro/.test(b))out.plan="Pro";' +
    'else if(/claude_team/.test(b))out.plan="Team";' +
    'else if(/claude_enterprise|enterprise/.test(b))out.plan="Enterprise";' +
    'else if(/claude_free|"free"/.test(b))out.plan="Free";}catch(e){}' +
    'const cands=' +
    JSON.stringify(endpoints) +
    ';for(const c of cands){if(c.indexOf("{org}")>=0&&!org)continue;const u=c.replace("{org}",org||"");' +
    'const r=await gj(u);if(r.ok&&r.j){const d=parse(r.j);if(d){out.raw=r.j;out.data=d;out.endpoint=u;break;}}}' +
    'return out;})()'
  );
}

// Returns { authed, data: { session:{used,resets}, weekly:{used,resets} } | null, endpoint?, error? }
async function fetchUsage(endpoints) {
  const list = endpoints && endpoints.length ? endpoints : DEFAULT_ENDPOINTS;
  if (!(await isAuthed())) return { authed: false, data: null };
  let timer = null;
  try {
    await ensureWorker();
    const result = await Promise.race([
      worker.webContents.executeJavaScript(buildScript(list), true),
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error('claude live timeout')), 14000);
      }),
    ]);
    return result || { authed: true, data: null };
  } catch (err) {
    return { authed: true, data: null, error: String((err && err.message) || err) };
  } finally {
    // Clear the race timeout so it doesn't linger holding a closure, then recycle
    // the hidden worker so the heavy claude.ai SPA isn't left resident between
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
  clearSession,
  importSession,
  setRemember,
  fetchUsage,
  destroy,
  buildScript,
  PARTITION_PERSIST,
  PARTITION_SESSION,
  DEFAULT_ENDPOINTS,
};
