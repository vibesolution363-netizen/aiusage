'use strict';

const u = require('./util');

/*
 * Gemini usage panel data.
 *
 * The usage percentages are REAL, never simulated:
 *   - source 'live'        : scraped from gemini.google.com (see geminiLive.js)
 *   - source 'manual'      : values the user typed from the Gemini "Usage limits" page
 *   - source 'unavailable' : signed in but the page couldn't be read
 *   - source 'setup'       : not signed in and no manual values yet
 *
 * Canonical value is USED fraction (0..1). Only the cost + sparkline trend are
 * estimated (clearly secondary); the sparkline ends at the real used value.
 */
function build({ live, manual, rate } = {}) {
  live = live || { authed: false, data: null };
  manual = manual || {};
  rate = rate || 4.71;

  const rng = u.rngFor('gemini');
  // Prefer the plan scraped live from the usage page (e.g. "Plus"), then any
  // manual override, then a sensible default.
  const plan = (live.plan && String(live.plan)) || (manual.plan && String(manual.plan)) || 'Pro';

  const liveData = live.data;
  const hasLive = !!(liveData && (liveData.session || liveData.weekly));

  let source;
  let sessionUsed = null;
  let weeklyUsed = null;
  let sessionReset = '';
  let weeklyReset = '';

  if (hasLive) {
    source = 'live';
    if (liveData.session) {
      sessionUsed = clamp01(liveData.session.used);
      sessionReset = resetText(liveData.session.resets);
    }
    if (liveData.weekly) {
      weeklyUsed = clamp01(liveData.weekly.used);
      weeklyReset = resetText(liveData.weekly.resets);
    }
  } else if (manual.enabled && (isNum(manual.sessionUsed) || isNum(manual.weeklyUsed))) {
    source = 'manual';
    if (isNum(manual.sessionUsed)) sessionUsed = clamp01(Number(manual.sessionUsed) / 100);
    if (isNum(manual.weeklyUsed)) weeklyUsed = clamp01(Number(manual.weeklyUsed) / 100);
  } else if (live.authed) {
    source = 'unavailable';
  } else {
    source = 'setup';
  }

  const NOTES = {
    live: 'Live · gemini.google.com',
    manual: 'Manual entry',
    unavailable: 'Connected — usage not readable yet',
    setup: 'Not connected — add your session key',
  };
  const STATES = { live: 'connected', manual: 'connected', unavailable: 'error', setup: 'nokey' };

  const metrics = [];
  if (sessionUsed != null) metrics.push(metricRow('session', 'CURRENT', sessionUsed, sessionReset, 'violet'));
  if (weeklyUsed != null) metrics.push(metricRow('weekly', 'WEEKLY', weeklyUsed, weeklyReset, 'indigo'));

  const needsSetup = metrics.length === 0;

  // Estimated, secondary info.
  const today = u.round(0.3 + rng() * 2.8, 2);
  const month = u.round(today * (10 + rng() * 18), 2);
  const sparkEnd = sessionUsed != null ? sessionUsed : weeklyUsed != null ? weeklyUsed : 0.35;

  return {
    service: 'gemini',
    name: 'Gemini',
    initial: '✦',
    plan,
    model: 'gemini-2.5-pro',
    modelText: 'Gemini 2.5 Pro',
    source,
    note: NOTES[source],
    state: STATES[source],
    simulated: false,
    needsSetup,
    canLogin: true,

    // Spec-required core shape (null when we genuinely don't have the value):
    session: sessionUsed != null ? { used: Math.round(sessionUsed * 1000), total: 1000, percent: round3(sessionUsed) } : null,
    weekly: weeklyUsed != null ? { used: Math.round(weeklyUsed * 7000), total: 7000, percent: round3(weeklyUsed) } : null,
    cost: {
      today,
      month,
      myr: u.round(month * rate, 2),
      todayMyr: u.round(today * rate, 2),
      estimated: true,
    },

    metrics,
    sparkline: u.makeSparklineTo(rng, 16, sparkEnd),
  };
}

function metricRow(key, label, used, resets, color) {
  const left = Math.round((1 - used) * 100);
  return {
    key,
    label,
    color,
    percent: round3(used),
    usedText: `${Math.round(used * 100)}% used`,
    leftText: `${left}% left`,
    resets: resets || '',
  };
}

// Live resets arrive as the human-readable text scraped from the page
// (e.g. "Resets at 11:22 AM"); show it as-is, lower-cased to match the dock.
function resetText(v) {
  if (!v) return '';
  const s = String(v).trim();
  return s.charAt(0).toLowerCase() + s.slice(1);
}

function clamp01(v) {
  const n = Number(v);
  if (!Number.isFinite(n)) return 0;
  return Math.max(0, Math.min(1, n));
}

function isNum(v) {
  return v != null && v !== '' && Number.isFinite(Number(v));
}

function round3(v) {
  return Math.round(v * 1000) / 1000;
}

module.exports = { build };
