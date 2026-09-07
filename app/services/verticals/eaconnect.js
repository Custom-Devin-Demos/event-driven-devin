const { v4: uuidv4 } = require('uuid');
const logger = require('../../telemetry/logger');
const { incrementMetric, recordTiming } = require('../../telemetry/datadog');
const { createSessionAndAlert } = require('../devin-session');

/**
 * Networks an EA Connect account can be linked to. `brokerRegion` selects which
 * party-broker cluster brokers an invite addressed to that network.
 */
const NETWORKS = {
  ea: { label: 'EA Account', brokerRegion: 'global' },
  psn: { label: 'PlayStation Network', brokerRegion: 'global' },
  pc: { label: 'PC', brokerRegion: 'global' },
  switch: { label: 'Nintendo Switch Online', brokerRegion: 'global' },
  xbl: { label: 'Xbox Network', brokerRegion: 'xbl' },
};

/**
 * Party-broker clusters by region. Every `brokerRegion` referenced by a network
 * must resolve to an active cluster here before an invite can be brokered.
 */
const PARTY_BROKERS = {
  global: { id: 'eac-party-01', endpoint: 'party-global.eaconnect.internal', active: true },
  emea: { id: 'eac-party-04', endpoint: 'party-emea.eaconnect.internal', active: true },
  apac: { id: 'eac-party-05', endpoint: 'party-apac.eaconnect.internal', active: true },
};

/**
 * Demo friends list returned by the (stubbed) social graph service.
 */
const FRIENDS = {
  'shadow-ranger': { gamertag: 'ShadowRanger', network: 'psn', presence: 'online', title: 'EA SPORTS FC 27' },
  'vector-zero': { gamertag: 'VectorZero', network: 'xbl', presence: 'online', title: 'Battlefield 6' },
  'ratio-line': { gamertag: 'RatioLine', network: 'ea', presence: 'online', title: 'Online' },
  'echo-hollow': { gamertag: 'EchoHollow', network: 'ea', presence: 'busy', title: 'Busy' },
  'silent-m': { gamertag: 'Silent_m', network: 'ea', presence: 'offline', title: 'Offline' },
};

/**
 * Demo accounts allowed to send invites.
 */
const ACCOUNTS = {
  'EA-4471203': { displayName: 'Neil Kelly', network: 'ea' },
  'EA-9930188': { displayName: 'Jordan Reyes', network: 'psn' },
};

/**
 * Scenario directive appended to the Devin investigation prompt.
 *
 * The alert pipeline passes only a prompt to the Devin API, so the
 * repositories involved and the expected remediation have to be named here.
 */
const REMEDIATION_DIRECTIVE = [
  '*Repositories:*',
  '- Backend (source of the 500): `COG-GTM/event-driven-devin`',
  '  - Service: `app/services/verticals/eaconnect.js`',
  '  - Route: `app/routes/verticals/eaconnect.js` (`POST /api/eaconnect/party/invite`)',
  '- Android client: `neil-z-kelly/eaconnect-android` (Kotlin / Jetpack Compose)',
  '  - Party invite flow: `app/src/main/java/com/ea/connect/ui/PartyInviteScreen.kt`',
  '  - View model: `app/src/main/java/com/ea/connect/ui/PartyInviteViewModel.kt`',
  '  - API client: `app/src/main/java/com/ea/connect/data/EaConnectApi.kt`',
  '',
  '*Scope:* Diagnose the backend failure, but do NOT change the backend — the party',
  'broker outage is owned by another team. Fix the Android client instead: it currently',
  'renders the raw exception and stack trace to the player. Replace that with graceful',
  'error handling — a friendly, on-brand message explaining that party invites are',
  'temporarily unavailable, a Retry action, and a way back to the friends list — and',
  'surface the backend `error`/`message`/`requestId` fields only as subdued support details.',
  '',
  '*Deliverable:* Open a pull request against `main` in `neil-z-kelly/eaconnect-android`,',
  'with a single screen recording of the emulator attached that shows the before and',
  'after in one take:',
  '1. *Before* — the unfixed app: open the friends list, tap *Party Up* on an Xbox friend,',
  '   send the invite, and let the raw exception / stack trace stay on screen long enough',
  '   to read.',
  '2. *Fix* — apply your change and rebuild/reinstall the APK.',
  '3. *After* — repeat the same taps and hold on the graceful error state, showing the',
  '   friendly message, the Retry action, the way back to the friends list, and the',
  '   subdued support details.',
  'The recording is the proof the fix is real, so do not skip the before segment and do',
  'not stitch in a screenshot in place of a live run.',
  '',
  '*Verification target:* run this repo locally (`npm ci`, `PORT=3000 node app/server.js`)',
  'and build with `./gradlew assembleDebug -PeaconnectBaseUrl=http://10.0.2.2:3000` (the',
  'emulator default), which reproduces the same 500. Never point the app at the deployed',
  'backend, and never set `-PeaconnectDemoToken`: that token is the presenter build\'s, and',
  'sending it turns a verification tap into a production page.',
].join('\n');

/**
 * Free-text fields flow into Slack alert cards and the Devin investigation
 * prompt, so callers must not be able to smuggle markup or instructions in.
 */
function sanitizeText(value, maxLength = 80) {
  return String(value == null ? '' : value)
    .replace(/[\r\n\t]+/g, ' ')
    .replace(/[`*_~<>|@#\\]/g, '')
    .replace(/\s{2,}/g, ' ')
    .trim()
    .slice(0, maxLength);
}

/**
 * Owner shown on the EA Connect alert card. The Android client is
 * unauthenticated, so the demo owner is fixed here rather than taken from the
 * request.
 */
const OWNER_EMAIL = 'neil.kelly@cognition.ai';

/**
 * Kill switch. The deployment has no EA Connect-specific host configuration, so
 * this is a code constant — flipping it is a merge. False keeps the intentional
 * 500 and drops the Slack card and the Devin session.
 */
const alerting = { enabled: true };

/**
 * Only the presenter's build alerts. The Android client sends this token when
 * it is built with `-PeaconnectDemoToken`, which the debug build a triggered
 * session produces does not set — so a session that reaches the deployed
 * endpoint while verifying its fix gets the intentional 500 and nothing else,
 * instead of paging and spawning another session. The value is not a secret:
 * the guard works because triggered builds send no token at all.
 */
const DEMO_TOKEN = 'eaconnect-presenter-demo';

/**
 * The token is the loop guard, so presenter taps are deliberately unthrottled:
 * every invite from the demo build pages, and nothing else can.
 */
function alertBlockReason(demoToken) {
  if (!alerting.enabled) return 'EA Connect alerting is switched off';
  if (String(demoToken || '') !== DEMO_TOKEN) {
    return 'request did not carry the presenter demo token';
  }
  return null;
}

/**
 * The invite endpoint is unauthenticated, so a Devin identity in the request
 * body is never honoured — sessions are always created as the customer's
 * configured identity.
 */
function resolveDevinIdentity(data) {
  const requestedOrgId = String(data.devinOrgId || '').trim();

  if (requestedOrgId) {
    logger.warn('Ignoring caller-supplied Devin identity for EA Connect party invite', {
      requestedOrgId,
      service: 'customer-eaconnect-party-invite',
    });
  }

  return { devinOrgId: undefined, devinUserId: undefined, devinEmail: OWNER_EMAIL };
}

function findAccount(accountId) {
  const key = String(accountId || '').replace(/\s+/g, '').toUpperCase();
  const account = ACCOUNTS[key];
  if (!account) {
    const error = new Error('EA account not found.');
    error.name = 'AccountNotFound';
    error.code = 'ACCOUNT_NOT_FOUND';
    error.statusCode = 404;
    throw error;
  }
  return account;
}

function findFriend(friendId) {
  const friend = FRIENDS[String(friendId || '').trim().toLowerCase()];
  if (!friend) {
    const error = new Error('That player is not on your friends list.');
    error.name = 'FriendNotFound';
    error.code = 'FRIEND_NOT_FOUND';
    error.statusCode = 404;
    throw error;
  }
  return friend;
}

function resolveNetwork(networkCode) {
  return NETWORKS[networkCode] || NETWORKS.ea;
}

/**
 * A player who is offline or in Do Not Disturb cannot be pulled into a party.
 */
function assertInvitable(friend) {
  if (friend.presence !== 'online') {
    const error = new Error(`${friend.gamertag} is ${friend.presence} and cannot be invited right now.`);
    error.name = 'FriendUnavailable';
    error.code = 'FRIEND_UNAVAILABLE';
    error.statusCode = 409;
    throw error;
  }
}

/**
 * Resolve the party-broker cluster that brokers invites onto this network.
 */
function resolvePartyBroker(network, networkCode) {
  const broker = PARTY_BROKERS[network.brokerRegion];
  if (!broker || !broker.active) {
    const brokerId = broker ? broker.id : `eac-party-${network.brokerRegion}`;
    const error = new Error(
      `Cross-platform party broker is unavailable: cluster ${brokerId} for network ${networkCode.toUpperCase()} is not registered`,
    );
    error.name = 'PartyBrokerUnavailable';
    error.code = 'PARTY_BROKER_UNAVAILABLE';
    error.statusCode = 500;
    throw error;
  }
  return broker;
}

/**
 * Open a party lobby and hand the invite to the friend's network broker.
 */
function brokerInvite(inviteId, friend, networkCode) {
  const network = resolveNetwork(networkCode);
  const broker = resolvePartyBroker(network, networkCode);
  return {
    broker: broker.id,
    network: network.label,
    partyId: `PTY-${inviteId.replace(/-/g, '').slice(0, 10).toUpperCase()}`,
  };
}

function buildInviteReceipt(inviteId, account, friend, game, party) {
  return {
    inviteId,
    partyId: party.partyId,
    status: 'sent',
    from: { displayName: account.displayName },
    to: { gamertag: friend.gamertag, network: party.network },
    game,
    partySize: 2,
    expiresInSeconds: 120,
    brokerCluster: party.broker,
  };
}

/**
 * Sends a cross-platform EA Connect party invite to a friend.
 */
async function sendPartyInvite(data) {
  const startTime = Date.now();
  const inviteId = uuidv4();

  const game = sanitizeText(data.game);
  const friendId = sanitizeText(data.friendId, 40);
  const client = sanitizeText(data.client, 40) || 'unknown';

  if (!game || !friendId) {
    const validationError = new Error('Pick a friend and a game to send a party invite.');
    validationError.name = 'ValidationError';
    validationError.code = 'INVALID_INVITE_REQUEST';
    validationError.statusCode = 400;
    throw validationError;
  }

  logger.info('Sending EA Connect party invite', {
    inviteId,
    friendId,
    game,
    service: 'customer-eaconnect-party-invite',
    route: '/api/eaconnect/party/invite',
  });

  try {
    await new Promise((resolve) => setTimeout(resolve, 120 + Math.random() * 180));

    const account = findAccount(data.accountId);
    const friend = findFriend(friendId);
    assertInvitable(friend);
    const party = brokerInvite(inviteId, friend, friend.network);
    const result = buildInviteReceipt(inviteId, account, friend, game, party);

    const duration = Date.now() - startTime;
    incrementMetric('eaconnect_party_invite.success', {
      route: '/api/eaconnect/party/invite',
      network: friend.network,
    });
    recordTiming('eaconnect_party_invite.latency', duration, { route: '/api/eaconnect/party/invite' });

    return result;
  } catch (error) {
    const duration = Date.now() - startTime;

    incrementMetric('eaconnect_party_invite.failure', {
      route: '/api/eaconnect/party/invite',
      errorClass: error.name,
    });
    recordTiming('eaconnect_party_invite.latency', duration, {
      route: '/api/eaconnect/party/invite',
      error: 'true',
    });

    if (error.statusCode && error.statusCode < 500) {
      logger.warn('EA Connect party invite rejected', {
        inviteId,
        error: error.message,
        errorClass: error.name,
        durationMs: duration,
        service: 'customer-eaconnect-party-invite',
      });
      throw error;
    }

    logger.error('EA Connect party invite failed', {
      inviteId,
      error: error.message,
      errorClass: error.name,
      durationMs: duration,
      friendId,
      game,
      service: 'customer-eaconnect-party-invite',
    });

    // Deliberately not reported to Sentry: this vertical raises its own branded
    // alert and Devin session below, and a Sentry issue would fan the same 500
    // out to the generic webhook path as a second, unguarded card and session.

    const blockReason = alertBlockReason(data.demoToken);
    if (blockReason) {
      logger.warn(`Suppressing EA Connect alert — ${blockReason}`, {
        inviteId,
        client,
        service: 'customer-eaconnect-party-invite',
      });
      throw error;
    }

    createSessionAndAlert({
      issueTitle: `${error.name}: ${sanitizeText(error.message, 200)}`,
      issueUrl: `https://${process.env.SENTRY_ORG_SLUG || 'sentry-org'}.sentry.io/issues/?project=${process.env.SENTRY_PROJECT_ID || ''}&query=is%3Aunresolved`,
      culprit: 'app/services/verticals/eaconnect.js \u2014 resolvePartyBroker',
      errorType: error.name || 'Error',
      errorValue: error.message,
      ...resolveDevinIdentity(data),
      service: 'customer-eaconnect-party-invite',
      verticalLabel: 'EA Connect Party Invite (Android)',
      promptAppendix: REMEDIATION_DIRECTIVE,
      customer: 'eaconnect',
      tags: [
        { key: 'route', value: '/api/eaconnect/party/invite' },
        { key: 'service', value: 'customer-eaconnect-party-invite' },
        { key: 'client', value: client },
        { key: 'game', value: game },
      ],
      extra: { inviteId, friendId, game },
      level: 'error',
      platform: 'node',
      firstSeen: '',
      lastSeen: new Date().toISOString(),
      count: '',
      shortId: '',
      project: 'event-driven-devin',
      release: process.env.SENTRY_RELEASE || 'customer-eaconnect-party-invite@1.0.0',
      environment: process.env.DD_ENV || 'prod',
      triggeredRule: '',
    }).catch((err) => {
      logger.error('Failed to create Devin session for EA Connect party invite error', {
        error: err.message,
        inviteId,
      });
    });

    throw error;
  }
}

module.exports = {
  sendPartyInvite,
  alerting,
  REMEDIATION_DIRECTIVE,
  NETWORKS,
  PARTY_BROKERS,
  FRIENDS,
};
