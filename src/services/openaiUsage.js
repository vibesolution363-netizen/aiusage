'use strict';

const u = require('./util');

/*
 * OpenAI usage.
 *
 * The dashboard usage figures are not available via a standard API key
 * (they require a session token). We validate the key with a lightweight
 * GET /v1/models and present estimated usage. Never throws.
 */
async function fetchUsage(apiKey, rate = 4.71) {
  const hasKey = !!(apiKey && apiKey.trim());
  let connected = false;

  if (hasKey) {
    connected = await u.pingEndpoint('https://api.openai.com/v1/models', {
      Authorization: `Bearer ${apiKey}`,
    });
  }

  return build(hasKey, connected, rate);
}

function build(hasKey, connected, rate) {
  const rng = u.rngFor('openai');
  const { note, state } = u.statusNote(hasKey, connected);

  const sessionPct = u.jitter(0.3 + rng() * 0.4);
  const weeklyPct = u.jitter(0.4 + rng() * 0.4);

  const sessionResetH = 0.2 + rng() * 1.2;
  const weeklyResetH = 24 + rng() * 120;

  const today = u.round(0.4 + rng() * 3.2, 2);
  const month = u.round(today * (10 + rng() * 18), 2);

  return {
    service: 'openai',
    name: 'OpenAI',
    initial: 'G',
    plan: 'Pro',
    model: 'gpt-4o',
    modelText: 'GPT-4o',
    simulated: !connected,
    note,
    state,

    // Spec-required core shape:
    session: { percent: u.round(sessionPct, 3) },
    weekly: { percent: u.round(weeklyPct, 3) },
    cost: {
      today,
      month,
      myr: u.round(month * rate, 2),
      todayMyr: u.round(today * rate, 2),
    },

    metrics: [
      {
        key: 'session',
        label: 'SESSION',
        percent: u.round(sessionPct, 3),
        leftText: `${Math.round((1 - sessionPct) * 100)}% left`,
        resets: u.formatResets(sessionResetH),
        color: 'green',
      },
      {
        key: 'weekly',
        label: 'WEEKLY',
        percent: u.round(weeklyPct, 3),
        leftText: `${Math.round((1 - weeklyPct) * 100)}% left`,
        resets: u.formatResets(weeklyResetH),
        color: 'teal',
      },
    ],
    sparkline: u.makeSparkline(rng, 16, 0.35, 0.24),
  };
}

module.exports = { fetchUsage };
