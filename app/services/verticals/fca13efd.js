const crypto = require('crypto');
const Sentry = require('@sentry/node');
const logger = require('../../telemetry/logger');
const { buildPrompt } = require('../devin-session');
const { createDevinSession } = require('../devin-api');
const { canCreateSession, reserveSession } = require('../session-rate-limiter');
const { getCustomerConfig } = require('../../../config/customers');

/**
 * Gearbox Software — Playtest sign-up (slug fca13efd).
 *
 * Players apply for a Gearbox playtest wave from the studio homepage. A signup
 * is validated, placed in a cohort and given its build drop (depot branch,
 * NDA version, key window).
 *
 * Incident path: a failed signup is captured by Sentry and handed straight to a
 * Devin session through the Devin API. There is no Slack or Teams hop; the
 * remediation ends on Devin's pull request with the regression test passing.
 */
const CUSTOMER = 'fca13efd';
const SERVICE = 'gearbox-playtest-enrollment';
const ROUTE = 'POST /api/fca13efd/playtest-signups';
const CULPRIT = 'app/services/verticals/fca13efd.js — scheduleBuildDrop';
const TARGET_REPO = 'COG-GTM/event-driven-devin';
const DEVIN_COOLDOWN_MS = Number(process.env.GEARBOX_DEVIN_COOLDOWN_MS) || 10 * 60 * 1000;

const PROGRAMS = [
  { id: 'bl4-vault-of-the-damned', label: 'Borderlands 4: Mad Ellie and the Vault of the Damned', wave: 'Wave 3' },
  { id: 'homeworld-3', label: 'Homeworld 3', wave: 'Wave 2' },
];
const PLATFORMS = [
  { id: 'steam-deck', label: 'Steam Deck' },
  { id: 'pc-steam', label: 'PC (Steam)' },
  { id: 'pc-epic', label: 'PC (Epic Games Store)' },
  { id: 'ps5', label: 'PlayStation 5' },
  { id: 'xbox-series', label: 'Xbox Series X|S' },
];
const REGIONS = [
  { id: 'na', label: 'North America' },
  { id: 'eu', label: 'Europe' },
  { id: 'apac', label: 'Asia-Pacific' },
];

// The sign-up form moved to the platform-cert SKU ids when Steam Deck joined the
// playtest pool for the Vault of the Damned wave. Build drops are still keyed by
// the channel names the Focus playtest tooling used before the migration, where
// handheld PC testers shipped on the shared "pc-handheld" channel.
const BUILD_CHANNELS = {
  'pc-steam': { depotBranch: 'playtest_pc', ndaVersion: 'GBX-NDA-2026.2', keyWindowHours: 48 },
  'pc-epic': { depotBranch: 'playtest_pc', ndaVersion: 'GBX-NDA-2026.2', keyWindowHours: 48 },
  'pc-handheld': { depotBranch: 'playtest_pc_handheld', ndaVersion: 'GBX-NDA-2026.2', keyWindowHours: 48 },
  ps5: { depotBranch: 'playtest_ps5', ndaVersion: 'GBX-NDA-2026.2', keyWindowHours: 72 },
  'xbox-series': { depotBranch: 'playtest_xsx', ndaVersion: 'GBX-NDA-2026.2', keyWindowHours: 72 },
};

const REMEDIATION_DIRECTIVE = [
  `Investigate and fix ${TARGET_REPO}. Open a pull request against main; do not merge or deploy.`,
  'Gearbox Software "Sign up to playtest" (/fca13efd) returns HTTP 500 when a player applies with the pre-filled Steam Deck platform.',
  'Reproduce: POST /api/fca13efd/playtest-signups with platform "steam-deck" (program bl4-vault-of-the-damned, region na). PC (Steam), PS5 and Xbox succeed.',
  'Inspect app/services/verticals/fca13efd.js and app/routes/verticals/fca13efd.js.',
  'Find the root cause yourself; the stack trace points at the crash site, not at the cause.',
  'Write a failing regression test in tests/fca13efd-gearbox-playtest.test.js first, then fix, and update the planted-failure expectation after the fix.',
  'Run `npx jest tests/fca13efd-gearbox-playtest.test.js` and `npm run lint` and paste the passing output in the PR description.',
  'Keep every platform and program available; do not disable Sentry, swallow errors, remove Steam Deck, or fake a success response.',
].join('\n');

const MAX_STORED_SIGNUPS = 500;
const signups = new Map();
let lastDevinTriggerAt = 0;

const invalid = message => Object.assign(new Error(message), { name: 'ValidationError', status: 400, code: 'INVALID_PLAYTEST_SIGNUP' });
const byId = (list, id) => list.find(item => item.id === id);

function validateSignup(input) {
  if (!input || typeof input !== 'object') throw invalid('Complete the playtest sign-up form.');
  const displayName = typeof input.displayName === 'string' ? input.displayName.trim() : '';
  const email = typeof input.email === 'string' ? input.email.trim() : '';
  if (displayName.length < 2 || displayName.length > 32) throw invalid('Enter a display name between 2 and 32 characters.');
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || email.length > 254) throw invalid('Enter a valid email address.');
  if (!byId(PROGRAMS, input.program)) throw invalid('Choose a playtest.');
  if (!byId(PLATFORMS, input.platform)) throw invalid('Choose the platform you will play on.');
  if (!byId(REGIONS, input.region)) throw invalid('Choose your region.');
  if (input.ageConfirmed !== true) throw invalid('You must be 18 or older to join a Gearbox playtest.');
  if (input.ndaAccepted !== true) throw invalid('Accept the playtest NDA to continue.');
  return { displayName, email, program: input.program, platform: input.platform, region: input.region };
}

function resolveCohort(signup) {
  const program = byId(PROGRAMS, signup.program);
  return { program, platform: signup.platform, region: signup.region, channel: BUILD_CHANNELS[signup.platform] };
}

function scheduleBuildDrop(cohort, now = new Date()) {
  const keysExpireAt = new Date(now.getTime() + cohort.channel.keyWindowHours * 3600 * 1000);
  return {
    wave: cohort.program.wave,
    depotBranch: cohort.channel.depotBranch,
    ndaVersion: cohort.channel.ndaVersion,
    keysExpireAt: keysExpireAt.toISOString(),
  };
}

function remember(id, record) {
  signups.set(id, record);
  if (signups.size > MAX_STORED_SIGNUPS) signups.delete(signups.keys().next().value);
}

async function triggerDevinFromSentry(error, { sentryEventId, context, identity = {} }) {
  const config = getCustomerConfig(CUSTOMER);
  if (!config.apiKey) {
    logger.warn('Devin service key not configured — skipping Sentry → Devin session', { service: SERVICE, customer: CUSTOMER });
    return null;
  }
  const now = Date.now();
  if (now - lastDevinTriggerAt < DEVIN_COOLDOWN_MS) {
    logger.info('Sentry → Devin session skipped — cooldown active', { service: SERVICE, sentryEventId });
    return null;
  }
  const capCheck = canCreateSession();
  if (!capCheck.allowed) {
    logger.warn('Sentry → Devin session skipped — global cap reached', { service: SERVICE, current: capCheck.current, max: capCheck.max });
    return null;
  }
  lastDevinTriggerAt = now;
  const releaseSlot = reserveSession();
  const tags = { route: ROUTE, service: SERVICE, customer: CUSTOMER, sentry_event_id: sentryEventId || 'unknown' };
  const prompt = buildPrompt({
    issueTitle: `${error.name}: ${error.message}`,
    culprit: CULPRIT, errorType: error.name, errorValue: error.message,
    customer: CUSTOMER, customerConfig: config, service: SERVICE,
    verticalLabel: config.label, level: 'error', platform: 'node',
    tags: Object.entries(tags).map(([key, value]) => ({ key, value })), extra: context,
    promptAppendix: REMEDIATION_DIRECTIVE,
  });
  logger.info('Sentry issue captured — triggering Devin session (no Slack)', { service: SERVICE, sentryEventId, signupId: context.signupId });
  try {
    const session = await createDevinSession(prompt, {
      apiKey: config.apiKey,
      userId: identity.devinUserId || config.devinUserId,
      orgId: identity.devinOrgId || config.devinOrgId,
      title: `Sentry: ${error.name} in ${SERVICE}`,
      repos: [TARGET_REPO],
    });
    logger.info('Devin session created from Sentry issue', { service: SERVICE, sessionId: session && session.sessionId, url: session && session.url });
    return session;
  } catch (err) {
    releaseSlot();
    lastDevinTriggerAt = 0;
    logger.error('Failed to create Devin session from Sentry issue', { service: SERVICE, error: err.message });
    return null;
  }
}

async function submitPlaytestSignup(data = {}, now = new Date()) {
  const signup = validateSignup(data.signup);
  let signupId;
  do signupId = `GBX-PT-${now.getUTCFullYear()}-${String(crypto.randomInt(0, 1e6)).padStart(6, '0')}`; while (signups.has(signupId));
  try {
    const cohort = resolveCohort(signup);
    const drop = scheduleBuildDrop(cohort, now);
    remember(signupId, { signup, drop });
    logger.info('Gearbox playtest signup accepted', { service: SERVICE, signupId, program: signup.program, platform: signup.platform, region: signup.region });
    return {
      success: true, signupId, program: cohort.program.label,
      platform: byId(PLATFORMS, signup.platform).label, region: byId(REGIONS, signup.region).label, ...drop,
    };
  } catch (error) {
    const context = { signupId, program: signup.program, platform: signup.platform, region: signup.region };
    const sentryEventId = Sentry.captureException(error, {
      tags: { route: ROUTE, service: SERVICE, customer: CUSTOMER, alert_path: 'instant' },
      extra: context,
    });
    logger.error('Gearbox playtest signup failed', { ...context, service: SERVICE, error: error.message });
    triggerDevinFromSentry(error, {
      sentryEventId, context,
      identity: { devinUserId: data.devinUserId, devinOrgId: data.devinOrgId },
    }).catch(err => logger.error('Sentry → Devin trigger failed', { service: SERVICE, error: err.message }));
    throw Object.assign(error, { status: 500, code: 'PLAYTEST_SIGNUP_FAILED', requestId: signupId });
  }
}

function resetDevinCooldown() {
  lastDevinTriggerAt = 0;
}

module.exports = {
  CUSTOMER, SERVICE, ROUTE, CULPRIT, TARGET_REPO, PROGRAMS, PLATFORMS, REGIONS, REMEDIATION_DIRECTIVE,
  validateSignup, resolveCohort, scheduleBuildDrop, submitPlaytestSignup, triggerDevinFromSentry, resetDevinCooldown,
};
