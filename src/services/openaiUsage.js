'use strict';

const u = require('./util');

/*
 * ChatGPT (OpenAI) panel data.
 *
 * Unlike Claude/Gemini, ChatGPT does not publish a usage-limits page with
 * percentages, so there are no real session/weekly numbers to show. What is
 * real here is the connection state and the account plan, read live from a
 * signed-in chatgpt.com session (see openaiLive.js):
 *   - source 'connected' : signed in; plan known, usage % not published
 *   - source 'setup'     : not signed in
 *
 * The cost + sparkline are estimated, clearly secondary.
 */
function build({ live, rate, prices } = {}) {
  live = live || { authed: false };
  rate = rate || 4.71;

  const rng = u.rngFor('openai');
  const authed = !!live.authed;
  const plan = (live.plan && String(live.plan)) || (authed ? 'Plus' : 'Free');

  const source = authed ? 'connected' : 'setup';
  const NOTES = {
    connected: 'Live · chatgpt.com',
    setup: 'Not connected — add your session key',
  };
  const STATES = { connected: 'connected', setup: 'nokey' };

  // ChatGPT exposes no usage percentages → no metric bars, ever.
  const needsSetup = !authed;
  const infoMsg = authed ? 'Connected ✓ — ChatGPT does not publish usage %' : '';

  return {
    service: 'openai',
    name: 'ChatGPT',
    initial: 'O',
    plan,
    model: 'gpt-4o',
    modelText: 'GPT-4o',
    source,
    note: NOTES[source],
    state: STATES[source],
    simulated: false,
    needsSetup,
    canLogin: true,
    infoMsg,

    session: null,
    weekly: null,
    cost: u.planCost('openai', plan, rate, prices),

    metrics: [],
    sparkline: u.makeSparkline(rng, 16, 0.35, 0.2),
  };
}

module.exports = { build };
