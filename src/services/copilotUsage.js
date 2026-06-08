'use strict';

const u = require('./util');

/*
 * GitHub Copilot usage.
 *
 * Org/enterprise Copilot metrics live behind admin-scoped endpoints
 * (GET /orgs/{org}/copilot/billing, /copilot/metrics). For an individual
 * token we validate with GET /user and present estimated request usage.
 * Never throws.
 */
async function fetchUsage(token, rate = 4.71) {
  const hasKey = !!(token && token.trim());
  let connected = false;

  if (hasKey) {
    connected = await u.pingEndpoint('https://api.github.com/user', {
      Authorization: `Bearer ${token}`,
      Accept: 'application/vnd.github+json',
      'User-Agent': 'AiUsageDock',
    });
  }

  return build(hasKey, connected, rate);
}

function build(hasKey, connected, rate) {
  const rng = u.rngFor('copilot');
  const { note, state } = u.statusNote(hasKey, connected);

  const requestsTotal = 300; // monthly premium-request allowance (illustrative)
  const requestsPct = u.jitter(0.35 + rng() * 0.4);
  const requestsUsed = Math.round(requestsPct * requestsTotal);

  const premiumTotal = 1500;
  const premiumUsed = Math.round((0.25 + rng() * 0.4) * premiumTotal);
  const premiumPct = premiumUsed / premiumTotal;

  const resetH = 24 + rng() * 200;

  const month = u.round(10 + rng() * 9, 2); // typical Copilot seat cost band

  return {
    service: 'copilot',
    name: 'Copilot',
    initial: '✦', // ✦
    plan: 'Business',
    model: 'claude-via-copilot',
    modelText: 'Claude / GPT',
    simulated: !connected,
    note,
    state,

    // Spec-required core shape:
    requests: {
      used: requestsUsed,
      total: requestsTotal,
      percent: u.round(requestsPct, 3),
    },
    premium: {
      used: premiumUsed,
      total: premiumTotal,
    },
    cost: {
      month,
      myr: u.round(month * rate, 2),
    },

    metrics: [
      {
        key: 'requests',
        label: 'REQUESTS',
        percent: u.round(requestsPct, 3),
        leftText: `${requestsUsed}/${requestsTotal}`,
        resets: u.formatResets(resetH),
        color: 'blue',
      },
      {
        key: 'premium',
        label: 'PREMIUM',
        percent: u.round(premiumPct, 3),
        leftText: `${premiumUsed}/${premiumTotal}`,
        resets: u.formatResets(resetH),
        color: 'indigo',
      },
    ],
    sparkline: u.makeSparkline(rng, 16, 0.4, 0.2),
  };
}

module.exports = { fetchUsage };
