'use strict';

/*
 * Shared helpers for the usage services.
 *
 * Live per-account usage / rate-limit numbers are not exposed by the public
 * consumer APIs of these providers, so the dock shows realistic *estimated*
 * data. The numbers are seeded by the calendar day (stable within a day) with
 * a small per-refresh jitter so the widget feels alive without jumping around.
 */

// FNV-1a hash -> 32-bit seed
function hashSeed(str) {
  let h = 2166136261 >>> 0;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

// Deterministic PRNG
function mulberry32(a) {
  return function () {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function dayKey() {
  return new Date().toISOString().slice(0, 10);
}

// A PRNG seeded by (salt + today) so values are stable for the whole day.
function rngFor(salt) {
  return mulberry32(hashSeed(salt + '|' + dayKey()));
}

function clamp(v, min, max) {
  return Math.max(min, Math.min(max, v));
}

function round(v, d = 2) {
  const f = Math.pow(10, d);
  return Math.round(v * f) / f;
}

// Small live jitter applied at fetch time.
function jitter(value, amt = 0.015) {
  return clamp(value + (Math.random() - 0.5) * amt, 0.02, 0.99);
}

// Build a 0..1 trend line for the sparkline.
function makeSparkline(rng, n = 16, start = 0.4, vol = 0.22) {
  const arr = [];
  let v = clamp(start + rng() * 0.2, 0.1, 0.9);
  for (let i = 0; i < n; i++) {
    v = clamp(v + (rng() - 0.5) * vol, 0.06, 1);
    arr.push(round(v, 3));
  }
  return arr;
}

function formatResets(hoursFromNow) {
  const total = Math.max(0, Math.round(hoursFromNow * 60));
  const h = Math.floor(total / 60);
  const m = total % 60;
  if (h <= 0) return `resets in ${m}m`;
  return `resets in ${h}h ${m}m`;
}

// Format a "resets in …" string from an ISO timestamp (used by live data).
function formatResetsFromISO(iso) {
  if (!iso) return '';
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return '';
  const diffH = (t - Date.now()) / 3600000;
  if (diffH <= 0) return 'resets soon';
  return formatResets(diffH);
}

// Build a 0..1 trend that ends at `end` so the sparkline visually matches the
// current real usage value (rather than wandering off randomly).
function makeSparklineTo(rng, n = 16, end = 0.4) {
  const target = clamp(end, 0.02, 1);
  const arr = [];
  let v = clamp(target * (0.45 + rng() * 0.35), 0.05, 0.95);
  for (let i = 0; i < n - 1; i++) {
    const pull = (target - v) * 0.25; // drift toward target
    v = clamp(v + pull + (rng() - 0.5) * 0.16, 0.05, 1);
    arr.push(round(v, 3));
  }
  arr.push(round(target, 3));
  return arr;
}

// Best-effort connectivity probe. Returns true if the key is valid/reachable.
// Never throws — any failure (no key, network, 4xx) resolves to false.
async function pingEndpoint(url, headers, timeoutMs = 6000) {
  try {
    const res = await fetch(url, {
      method: 'GET',
      headers,
      signal: AbortSignal.timeout(timeoutMs),
    });
    return res.ok;
  } catch {
    return false;
  }
}

// Resolve the note shown under the panel based on key + connectivity state.
function statusNote(hasKey, connected) {
  if (!hasKey) return { note: 'Simulated — API key required', state: 'nokey' };
  if (connected) return { note: 'Estimated — API connected', state: 'connected' };
  return { note: 'Estimated — API key invalid / offline', state: 'error' };
}

// ----- Plan pricing -----
// Monthly subscription LIST prices per service + plan. These are the real
// published prices (flat seat fees, not usage billing), used for the cost footer
// instead of inventing numbers. They can change, so they're written to
// settings.json (settings.prices) as editable defaults; an override there wins.
//
// An entry is EITHER a number (interpreted as USD — Claude/ChatGPT bill in USD
// globally) OR an object { myr } for a price set natively in ringgit (Google
// prices Gemini regionally in MYR for Malaysia). `null` = no public price (e.g.
// custom Enterprise) → the footer shows the plan only.
//
// Gemini (Malaysia, one.google.com/intl/en_my/about/google-ai-plans):
//   Plus RM23.99 · Pro RM97.99 · Ultra from RM429.99 (Ultra 20x is RM979.90).
const PLAN_PRICES = {
  claude: { free: 0, pro: 20, max: 100, team: 30, enterprise: null },
  openai: { free: 0, plus: 20, pro: 200, team: 30, enterprise: null },
  gemini: {
    free: 0,
    plus: { myr: 23.99 },
    pro: { myr: 97.99 },
    advanced: { myr: 97.99 }, // legacy "Gemini Advanced" → now Google AI Pro
    ultra: { myr: 429.99 }, // base Ultra; override to 979.90 for Ultra 20x
  },
};

// Normalise a raw price entry (number = USD, { myr } = ringgit, { usd } = USD,
// null = unknown) into both currencies using the USD↔MYR `rate`.
function resolvePrice(raw, rate) {
  if (raw == null || raw === '') return { usd: null, myr: null };
  if (typeof raw === 'number') {
    return Number.isFinite(raw) ? { usd: raw, myr: round(raw * rate, 2) } : { usd: null, myr: null };
  }
  if (typeof raw === 'object') {
    if (raw.myr != null && raw.myr !== '') {
      const m = Number(raw.myr);
      return Number.isFinite(m) ? { usd: round(m / rate, 2), myr: round(m, 2) } : { usd: null, myr: null };
    }
    if (raw.usd != null && raw.usd !== '') {
      const d = Number(raw.usd);
      return Number.isFinite(d) ? { usd: round(d, 2), myr: round(d * rate, 2) } : { usd: null, myr: null };
    }
  }
  return { usd: null, myr: null };
}

// Raw price entry for a service+plan. `overrides` (settings.prices) wins over the
// built-in defaults; both matched case-insensitively against the plan label.
function planPriceRaw(service, plan, overrides) {
  const key = String(plan || '').toLowerCase();
  const ov = overrides && overrides[service];
  if (ov) {
    for (const k of Object.keys(ov)) {
      if (k.toLowerCase() === key) return ov[k];
    }
  }
  const table = PLAN_PRICES[service] || {};
  return key in table ? table[key] : null;
}

// Monthly USD price for a service+plan (back-derived from MYR-native entries).
function planPriceUsd(service, plan, overrides, rate = 4.71) {
  return resolvePrice(planPriceRaw(service, plan, overrides), rate).usd;
}

// Build the cost-footer shape from the plan price. Always honest: a real monthly
// list price (or null when unknown). No randomness. `currency` is the plan's
// NATIVE billing currency ('usd' or 'myr') so the UI can show the real figure
// rather than a back-derived one.
function planCost(service, plan, rate, overrides) {
  const raw = planPriceRaw(service, plan, overrides);
  const { usd, myr } = resolvePrice(raw, rate);
  let currency = null;
  if (myr != null) currency = raw && typeof raw === 'object' && raw.myr != null ? 'myr' : 'usd';
  return {
    plan,
    usd, // monthly USD price (converted for MYR-native plans), or null
    myr, // monthly MYR price (converted for USD-native plans), or null
    currency, // 'usd' | 'myr' | null — the plan's native billing currency
    period: 'month',
    listed: true, // a published price, not an estimate
  };
}

module.exports = {
  hashSeed,
  mulberry32,
  rngFor,
  clamp,
  round,
  jitter,
  makeSparkline,
  makeSparklineTo,
  formatResets,
  formatResetsFromISO,
  pingEndpoint,
  statusNote,
  PLAN_PRICES,
  planPriceUsd,
  planCost,
};
