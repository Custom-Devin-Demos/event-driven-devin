const crypto = require('crypto');
const Sentry = require('@sentry/node');
const logger = require('../../telemetry/logger');
const { buildPrompt } = require('../devin-session');
const { createDevinSession } = require('../devin-api');
const { canCreateSession, reserveSession } = require('../session-rate-limiter');
const { getCustomerConfig } = require('../../../config/customers');

/**
 * Gearbox Entertainment on 2K — The Hunt charity registration (slug fca13efd).
 *
 * Clone of https://2k.com/studios/gearbox/. The "The Hunt is back on—register
 * now!" news tile opens Gearbox Gives' registration for The Hunt, a multi-game
 * Borderlands community scavenger hunt raising money for St. Jude Children's
 * Research Hospital. A registration is validated, assigned to its platform's
 * fundraising team and given a personal fundraising page.
 *
 * Incident path: a failed registration is captured by Sentry and handed straight
 * to a Devin session through the Devin API. There is no Slack or Teams hop; the
 * remediation ends on Devin's pull request with the regression test passing.
 */
const CUSTOMER = 'fca13efd';
const SERVICE = 'gearbox-gives-hunt-registration';
const ROUTE = 'POST /api/fca13efd/hunt-registrations';
const CULPRIT = 'app/services/verticals/fca13efd.js — createFundraisingPage';
const TARGET_REPO = 'COG-GTM/event-driven-devin';
const DEVIN_COOLDOWN_MS = Number(process.env.GEARBOX_DEVIN_COOLDOWN_MS) || 10 * 60 * 1000;

const EVENT = { id: 'the-hunt-nov-2026', label: 'The Hunt — Borderlands Community Charity Event (Nov 2026)', beneficiary: "St. Jude Children's Research Hospital" };
const PLATFORMS = [
  { id: 'steam', label: 'Steam' },
  { id: 'epic', label: 'Epic Games Store' },
  { id: 'ps5', label: 'PlayStation 5' },
  { id: 'xbox-series', label: 'Xbox Series X|S' },
];
const REGIONS = [
  { id: 'US', label: 'United States' },
  { id: 'CA', label: 'Canada' },
  { id: 'GB', label: 'United Kingdom' },
  { id: 'DE', label: 'Germany' },
  { id: 'FR', label: 'France' },
  { id: 'AU', label: 'Australia' },
];

// Registration moved to the 2K account platform ids (steam, epic, ps5, ...) when
// The Hunt went multi-game. Fundraising teams are still keyed by the platform
// channels Gearbox Gives used for the Borderlands 3 hunts, where Steam was "pc-steam".
const FUNDRAISING_TEAMS = {
  'pc-steam': { teamName: 'Team Steam', goalUsd: 60000 },
  epic: { teamName: 'Team Epic', goalUsd: 30000 },
  ps5: { teamName: 'Team PlayStation', goalUsd: 70000 },
  'xbox-series': { teamName: 'Team Xbox', goalUsd: 60000 },
};
const PERSONAL_GOAL_SHARE = 0.001;

const REMEDIATION_DIRECTIVE = [
  `Investigate and fix ${TARGET_REPO}. Open a pull request against main; do not merge or deploy.`,
  'Gearbox Entertainment on 2K (/fca13efd): registering for The Hunt charity event ("The Hunt is back on—register now!") returns HTTP 500 when the player keeps the pre-selected Steam platform.',
  'Reproduce: POST /api/fca13efd/hunt-registrations with {"registration":{"hunterName":"VaultHunter_77","email":"vaulthunter77@example.com","platform":"steam","region":"US","rulesAccepted":true}}. Epic Games Store, PlayStation 5 and Xbox Series X|S succeed.',
  'Inspect app/services/verticals/fca13efd.js and app/routes/verticals/fca13efd.js.',
  'Find the root cause yourself; the stack trace points at the crash site, not at the cause.',
  'Write a failing regression test in tests/fca13efd-gearbox-hunt.test.js first, then fix, and update the planted-failure expectation after the fix.',
  'Run `npx jest tests/fca13efd-gearbox-hunt.test.js` and `npm run lint` and paste the passing output in the PR description.',
  'Keep every platform and region available; do not disable Sentry, swallow errors, remove Steam, or fake a success response.',
].join('\n');

const MAX_STORED_REGISTRATIONS = 500;
const registrations = new Map();
let lastDevinTriggerAt = 0;

const invalid = message => Object.assign(new Error(message), { name: 'ValidationError', status: 400, code: 'INVALID_HUNT_REGISTRATION' });
const byId = (list, id) => list.find(item => item.id === id);

function validateRegistration(input) {
  if (!input || typeof input !== 'object') throw invalid('Complete the registration form.');
  const hunterName = typeof input.hunterName === 'string' ? input.hunterName.trim() : '';
  const email = typeof input.email === 'string' ? input.email.trim() : '';
  if (hunterName.length < 2 || hunterName.length > 32) throw invalid('Enter a Vault Hunter name between 2 and 32 characters.');
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || email.length > 254) throw invalid('Enter a valid email address.');
  if (!byId(PLATFORMS, input.platform)) throw invalid('Choose the platform you will hunt on.');
  if (!byId(REGIONS, input.region)) throw invalid('Select your region.');
  if (input.rulesAccepted !== true) throw invalid('Accept the official rules to register.');
  return { hunterName, email, platform: input.platform, region: input.region };
}

function assignTeam(registration) {
  return { platform: registration.platform, region: registration.region, team: FUNDRAISING_TEAMS[registration.platform] };
}

function createFundraisingPage(assignment, registrationId) {
  return {
    teamName: assignment.team.teamName,
    teamGoalUsd: assignment.team.goalUsd,
    personalGoalUsd: Math.round(assignment.team.goalUsd * PERSONAL_GOAL_SHARE),
    fundraisingPage: `https://borderlands.2k.com/the-hunt/${registrationId.toLowerCase()}`,
  };
}

function remember(id, record) {
  registrations.set(id, record);
  if (registrations.size > MAX_STORED_REGISTRATIONS) registrations.delete(registrations.keys().next().value);
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
  logger.info('Sentry issue captured — triggering Devin session (no Slack)', { service: SERVICE, sentryEventId, registrationId: context.registrationId });
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

async function submitHuntRegistration(data = {}, now = new Date()) {
  const registration = validateRegistration(data.registration);
  let registrationId;
  do registrationId = `HUNT-${now.getUTCFullYear()}-${String(crypto.randomInt(0, 1e6)).padStart(6, '0')}`; while (registrations.has(registrationId));
  try {
    const assignment = assignTeam(registration);
    const page = createFundraisingPage(assignment, registrationId);
    remember(registrationId, { registration, page, at: now.toISOString() });
    logger.info('The Hunt registration accepted', { service: SERVICE, registrationId, platform: registration.platform, region: registration.region, team: page.teamName });
    return {
      success: true, registrationId, event: EVENT.label, beneficiary: EVENT.beneficiary,
      platform: byId(PLATFORMS, registration.platform).label, region: byId(REGIONS, registration.region).label, ...page,
    };
  } catch (error) {
    const context = { registrationId, event: EVENT.id, platform: registration.platform, region: registration.region };
    const sentryEventId = Sentry.captureException(error, {
      tags: { route: ROUTE, service: SERVICE, customer: CUSTOMER, alert_path: 'instant' },
      extra: context,
    });
    logger.error('The Hunt registration failed', { ...context, service: SERVICE, error: error.message });
    triggerDevinFromSentry(error, {
      sentryEventId, context,
      identity: { devinUserId: data.devinUserId, devinOrgId: data.devinOrgId },
    }).catch(err => logger.error('Sentry → Devin trigger failed', { service: SERVICE, error: err.message }));
    throw Object.assign(error, { status: 500, code: 'HUNT_REGISTRATION_FAILED', requestId: registrationId });
  }
}

function resetDevinCooldown() {
  lastDevinTriggerAt = 0;
}

module.exports = {
  CUSTOMER, SERVICE, ROUTE, CULPRIT, TARGET_REPO, EVENT, PLATFORMS, REGIONS, REMEDIATION_DIRECTIVE,
  validateRegistration, assignTeam, createFundraisingPage, submitHuntRegistration, triggerDevinFromSentry, resetDevinCooldown,
};
