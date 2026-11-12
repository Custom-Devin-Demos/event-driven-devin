/* global setImmediate */

const { v4: uuidv4 } = require('uuid');
const logger = require('../../telemetry/logger');
const { incrementMetric } = require('../../telemetry/datadog');
const { Sentry } = require('../../telemetry/sentry');
const { createSessionAndAlert } = require('../devin-session');
const { getAccount } = require('./4491bcfa-accounts');
const {
  AccountError,
  getAccountProfile,
  getPublicCard,
  getLinkedPlatforms,
  getSecuritySettings,
} = require('./4491bcfa-profile');
const logs = require('./4491bcfa-logs');

const SLACK_MEMBER_ID_FALLBACK = process.env.C4491BCFA_SLACK_MEMBER_ID || '';
const SERVICE = 'ea-account-portal-web';
const PROFILE_ROUTE = '/api/accounts/:accountId/profile';
const ENUMERATION_THRESHOLD = 214;

// The signed-in portal session. It reuses the attacker session so that the
// presenter's Security view continues the enumeration run captured in the logs.
const SESSIONS = {
  [logs.ATTACKER_SESSION]: {
    sessionId: logs.ATTACKER_SESSION,
    ownerAccount: logs.OWNER_ACCOUNT,
    ip: logs.SOURCE_IP,
    signedInAt: logs.WINDOW_START,
  },
  sess_legit_7b19c0: {
    sessionId: 'sess_legit_7b19c0',
    ownerAccount: 'EA-100007',
    ip: '98.14.207.5',
    signedInAt: '2026-11-11T03:40:00Z',
  },
};

const PORTAL_SESSION_ID = logs.ATTACKER_SESSION;

// Friends of the portal owner. All are already in the seeded log window, so
// opening a friend's card or inspecting one never moves the detection count.
const FRIEND_IDS = ['EA-100042', 'EA-100067', 'EA-100118', 'EA-100153', 'EA-100188', 'EA-100201'];

// Distinct cross-account ids seen per session in the detection window, seeded
// from the access log so the live view that crosses the threshold fires once.
const crossAccountBySession = new Map();
crossAccountBySession.set(logs.ATTACKER_SESSION, new Set(logs.SEEDED_IDS));
const alertedSessions = new Set();

function resolveSession(sessionId) {
  return SESSIONS[sessionId] || null;
}

const REMEDIATION_DIRECTIVE = [
  '*Repository to investigate and fix:* `COG-GTM/event-driven-devin`',
  '',
  'A security monitor fired on the EA Account self-service portal (vertical `4491bcfa`, served at `/4491bcfa`).',
  'Treat this as a real broken-object-level-authorization (IDOR / CWE-639) incident and respond end to end:',
  '',
  '*1. Reproduce and confirm the alert is real.*',
  '- Run the app and request `GET /api/accounts/{accountId}/profile` for an account the caller does not own',
  '  (send header `x-ea-session: ' + logs.ATTACKER_SESSION + '`, which owns `' + logs.OWNER_ACCOUNT + '`).',
  '- Confirm it returns another player’s email, linked platforms and last-login IP with no 401/403.',
  '',
  '*2. Find the introducing commit.* Use `git log`/`git blame` on `app/services/verticals/4491bcfa-profile.js`'
    + ' and `app/routes/verticals/4491bcfa.js` to find the commit that removed the ownership check.',
  '',
  '*3. Scope the blast radius* from the gateway access log in `app/services/verticals/4491bcfa-logs.js`'
    + ' (helper `toLogLines()`): distinct accounts exposed, which fields, the source IP, the session id, and the time window.',
  '',
  '*4. Audit every `/api/accounts/*` endpoint* in `app/routes/verticals/4491bcfa.js` (profile, linked-platforms,'
    + ' security) for the same missing ownership check and fix all affected endpoints, not just `/profile`.',
  '',
  '*5. Fix* by enforcing ownership server-side before serializing: a caller requesting an account it does not own'
    + ' gets `403`; a request with no valid session gets `401`. Do not weaken the synthetic fixtures or the detection.',
  '',
  '*6. Add a regression test* proving another player’s account id returns `403`. Run'
    + ' `npx jest tests/4491bcfa-account-portal.test.js --runInBand` and `npm run lint`.',
  '',
  'Note: `GET /api/accounts/{accountId}/card` is the public player card used by the friends list. It returns only'
    + ' public fields and must stay readable cross-account; confirm it exposes no private fields rather than locking it down.',
  'The presenter Security view (`/4491bcfa?ops=1`) calls the profile endpoint cross-account; after the fix it should'
    + ' show `403` / BLOCKED there — do not change the page to hide the result.',
  '',
  '*7. Open a PR against `main`* with the fix and the regression test.',
  '',
  '*8. Post an incident summary in this alert’s Slack thread* with: timeline, impact, root cause, fix, and'
    + ' follow-up actions (revoke the offending session, block the source IP, notify affected players).',
].join('\n');

function fireSecurityAlert(session, distinctCount, identity, requestId) {
  const title = `SEC-HIGH: Possible account enumeration on /api/accounts/*/profile. `
    + `${distinctCount} distinct account IDs requested by 1 session in ${logs.WINDOW_MINUTES} min.`;

  logger.warn('EA Account enumeration threshold crossed — raising security alert', {
    requestId,
    service: SERVICE,
    sessionId: session.sessionId,
    sourceIp: session.ip,
    distinctAccounts: distinctCount,
  });

  Sentry.captureException(new Error(title), {
    tags: { route: PROFILE_ROUTE, service: SERVICE, alert_path: 'instant', cwe: 'CWE-639' },
    extra: { requestId, distinctAccounts: distinctCount, windowMinutes: logs.WINDOW_MINUTES },
  });

  createSessionAndAlert({
    issueTitle: title,
    issueUrl: `https://${process.env.SENTRY_ORG_SLUG || 'sentry-org'}.sentry.io/issues/?project=${process.env.SENTRY_PROJECT_ID || ''}&query=is%3Aunresolved`,
    culprit: 'app/services/verticals/4491bcfa.js — getProfile',
    errorType: 'BrokenObjectLevelAuthorization',
    errorValue: title,
    devinUserId: identity.devinUserId,
    devinEmail: identity.devinEmail,
    devinOrgId: identity.devinOrgId,
    service: SERVICE,
    verticalLabel: 'EA Account — Security',
    promptAppendix: REMEDIATION_DIRECTIVE,
    customer: '4491bcfa',
    skipVulnerablePr: true,
    slackMemberId: identity.devinEmail ? '' : SLACK_MEMBER_ID_FALLBACK,
    slackMemberIdFallback: SLACK_MEMBER_ID_FALLBACK,
    tags: [
      { key: 'route', value: PROFILE_ROUTE },
      { key: 'service', value: SERVICE },
      { key: 'cwe', value: 'CWE-639' },
      { key: 'alert_path', value: 'instant' },
      { key: 'source_ip', value: logs.SOURCE_IP },
      { key: 'session_id', value: logs.ATTACKER_SESSION },
      { key: 'distinct_accounts', value: String(distinctCount) },
      { key: 'window_minutes', value: String(logs.WINDOW_MINUTES) },
    ],
    extra: {
      requestId,
      distinctAccounts: distinctCount,
      windowMinutes: logs.WINDOW_MINUTES,
      windowStart: logs.WINDOW_START,
      exposedFields: ['email', 'linkedPlatforms', 'lastLogin.ip'],
      sampleExposedAccounts: logs.SEEDED_IDS.slice(0, 5),
    },
    level: 'error',
    platform: 'node',
    firstSeen: logs.WINDOW_START,
    lastSeen: new Date().toISOString(),
    count: String(distinctCount),
    shortId: '',
  }).catch((alertError) => {
    logger.error('Failed to raise EA Account security alert', { error: alertError.message, requestId });
  });
}

function trackEnumeration(session, accountId, identity, requestId) {
  if (!session || accountId === session.ownerAccount) return;
  let seen = crossAccountBySession.get(session.sessionId);
  if (!seen) {
    seen = new Set();
    crossAccountBySession.set(session.sessionId, seen);
  }
  seen.add(accountId);
  incrementMetric('ea_account.cross_account_read', { service: SERVICE });
  if (seen.size >= ENUMERATION_THRESHOLD && !alertedSessions.has(session.sessionId)) {
    alertedSessions.add(session.sessionId);
    setImmediate(() => fireSecurityAlert(session, seen.size, identity, requestId));
  }
}

function getProfile(data) {
  const requestId = `EA-${uuidv4().slice(0, 8).toUpperCase()}`;
  const session = resolveSession(data.sessionId);
  const profile = getAccountProfile(data.accountId, session);
  trackEnumeration(session, data.accountId, {
    devinUserId: data.devinUserId,
    devinEmail: data.devinEmail,
    devinOrgId: data.devinOrgId,
  }, requestId);
  return { success: true, requestId, profile };
}

function getCard(data) {
  const session = resolveSession(data.sessionId);
  return { success: true, card: getPublicCard(data.accountId, session) };
}

function getFriends(sessionId) {
  const session = resolveSession(sessionId);
  if (!session) throw new AccountError('Sign in to view friends', 401, 'NOT_AUTHENTICATED');
  return {
    success: true,
    friends: FRIEND_IDS.map((id) => getPublicCard(id, session)),
  };
}

function getMonitor() {
  const seen = crossAccountBySession.get(PORTAL_SESSION_ID);
  return {
    success: true,
    route: PROFILE_ROUTE,
    sessionId: PORTAL_SESSION_ID,
    sourceIp: logs.SOURCE_IP,
    windowMinutes: logs.WINDOW_MINUTES,
    threshold: ENUMERATION_THRESHOLD,
    distinctAccounts: seen ? seen.size : 0,
    alerted: alertedSessions.has(PORTAL_SESSION_ID),
  };
}

function getPlatforms(data) {
  const session = resolveSession(data.sessionId);
  return { success: true, ...getLinkedPlatforms(data.accountId, session) };
}

function getSecurity(data) {
  const session = resolveSession(data.sessionId);
  return { success: true, ...getSecuritySettings(data.accountId, session) };
}

function getPortalSession() {
  const session = SESSIONS[PORTAL_SESSION_ID];
  const account = getAccount(session.ownerAccount);
  return {
    success: true,
    session: { sessionId: session.sessionId, ownerAccount: session.ownerAccount },
    me: { accountId: account.accountId, displayName: account.displayName, eaId: account.eaId, avatarColor: account.avatarColor },
  };
}

module.exports = {
  SERVICE,
  PROFILE_ROUTE,
  PORTAL_SESSION_ID,
  ENUMERATION_THRESHOLD,
  FRIEND_IDS,
  resolveSession,
  trackEnumeration,
  getProfile,
  getCard,
  getFriends,
  getMonitor,
  getPlatforms,
  getSecurity,
  getPortalSession,
  AccountError,
  _resetEnumeration() {
    crossAccountBySession.clear();
    crossAccountBySession.set(logs.ATTACKER_SESSION, new Set(logs.SEEDED_IDS));
    alertedSessions.clear();
  },
};
