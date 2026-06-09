'use strict';

const u = require('./util');

/*
 * Claude usage panel data.
 *
 * The usage percentages are REAL, never simulated:
 *   - source 'live'   : pulled from claude.ai (see claudeLive.js)
 *   - source 'manual' : values the user typed from claude.ai → Settings → Usage
 *   - source 'unavailable' : logged in but the endpoint couldn't be read
 *   - source 'setup'  : not logged in and no manual values yet
 *
 * Canonical value is USED fraction (0..1). "left" is always 100 - used.
 * Only the cost + sparkline trend are estimated (clearly secondary), and the
 * sparkline is shaped to end at the real used value.
 */
function build({ live, manual, rate, prices } = {}) {
  live = live || { authed: false, data: null };
  manual = manual || {};
  rate = rate || 4.71;

  const rng = u.rngFor('claude');
  // Prefer the plan detected live from claude.ai, then any manual override.
  const plan = (live.plan && String(live.plan)) || (manual.plan && String(manual.plan)) || 'Max';

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
      sessionReset = u.formatResetsFromISO(liveData.session.resets);
    }
    if (liveData.weekly) {
      weeklyUsed = clamp01(liveData.weekly.used);
      weeklyReset = u.formatResetsFromISO(liveData.weekly.resets);
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
    live: 'Live · claude.ai',
    manual: 'Manual entry',
    unavailable: 'Connected — usage not readable yet',
    setup: 'Not connected — add your session key',
  };
  const STATES = { live: 'connected', manual: 'connected', unavailable: 'error', setup: 'nokey' };

  const metrics = [];
  if (sessionUsed != null) metrics.push(metricRow('session', 'SESSION', sessionUsed, sessionReset, 'amber'));
  if (weeklyUsed != null) metrics.push(metricRow('weekly', 'WEEKLY', weeklyUsed, weeklyReset, 'violet'));

  const needsSetup = metrics.length === 0;

  const sparkEnd = sessionUsed != null ? sessionUsed : weeklyUsed != null ? weeklyUsed : 0.4;

  return {
    service: 'claude',
    name: 'Claude',
    initial: 'C',
    plan,
    model: 'claude-sonnet-4-6',
    modelText: 'Sonnet 4.6',
    source,
    note: NOTES[source],
    state: STATES[source],
    simulated: false,
    needsSetup,
    canLogin: true,

    // Spec-required core shape (null when we genuinely don't have the value):
    session: sessionUsed != null ? { used: Math.round(sessionUsed * 1000), total: 1000, percent: round3(sessionUsed) } : null,
    weekly: weeklyUsed != null ? { used: Math.round(weeklyUsed * 7000), total: 7000, percent: round3(weeklyUsed) } : null,
    cost: u.planCost('claude', plan, rate, prices),

    metrics,
    sparkline: u.makeSparklineTo(rng, 16, sparkEnd),
    endpoint: live.endpoint || null,
  };
}

function metricRow(key, label, used, resets, color) {
  const left = Math.round((1 - used) * 100);
  return {
    key,
    label,
    color,
    percent: round3(used), // used fraction → bar fill width
    usedText: `${Math.round(used * 100)}% used`, // what the dock shows on the right (matches claude.ai)
    leftText: `${left}% left`, // kept for reference / alt display
    resets: resets || '',
  };
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
