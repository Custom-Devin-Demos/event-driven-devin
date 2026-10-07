const { v4: uuidv4 } = require('uuid');
const logger = require('../../telemetry/logger');
const { incrementMetric, recordTiming } = require('../../telemetry/datadog');
const { Sentry } = require('../../telemetry/sentry');
const { createSessionAndAlert } = require('../devin-session');
const jira = require('../jira');

const SERVICE = 'customer-a1eccdb6-continue-watching';
const ROUTE = '/api/a1eccdb6/continue-watching';
const REPO = 'COG-GTM/event-driven-devin';

const JIRA_PROJECT_KEY = process.env.A1ECCDB6_JIRA_PROJECT_KEY || 'JOAN';
const JIRA_ASSIGNEE_ACCOUNT_ID = process.env.A1ECCDB6_JIRA_ASSIGNEE_ACCOUNT_ID || '';
const SLACK_MEMBER_ID = process.env.A1ECCDB6_SLACK_MEMBER_ID || '';

const RAIL_LIMIT = 12;
const TICKET_DEDUPE_MS = 10 * 60 * 1000;

const CATALOG = {
  'ep-harbor-lights-s2e4': { title: 'Harbor Lights', subtitle: 'S2 E4 · The Long Tide', type: 'episode', durationSeconds: 3120, art: 'harbor' },
  'ep-harbor-lights-s2e3': { title: 'Harbor Lights', subtitle: 'S2 E3 · Undertow', type: 'episode', durationSeconds: 3060, art: 'harbor' },
  'movie-dunes-of-ash': { title: 'Dunes of Ash', subtitle: 'Movie · 2h 4m', type: 'movie', durationSeconds: 7440, art: 'dunes' },
  'ep-night-desk-s1e7': { title: 'The Night Desk', subtitle: 'S1 E7 · Late Edition', type: 'episode', durationSeconds: 2640, art: 'desk' },
  'special-new-year-live': { title: 'New Year Live', subtitle: 'Special · Replay', type: 'special', durationSeconds: 10800, art: 'live' },
  'ep-kitchen-wars-s5e1': { title: 'Kitchen Wars', subtitle: 'S5 E1 · Fire Round', type: 'episode', durationSeconds: 2580, art: 'kitchen' },
  'movie-orbiters': { title: 'Orbiters', subtitle: 'Movie · 1h 52m', type: 'movie', durationSeconds: 6720, art: 'orbit' },
  'ep-county-line-s3e9': { title: 'County Line', subtitle: 'S3 E9 · Crossing', type: 'episode', durationSeconds: 2820, art: 'county' },
};

function minutesAgo(minutes) {
  return new Date(Date.now() - minutes * 60 * 1000).toISOString();
}

function event(eventId, contentId, progressSeconds, ageMinutes, device) {
  return { eventId, contentId, progressSeconds, watchedAt: minutesAgo(ageMinutes), device };
}

// Watch-event log per profile, in the order the history service delivered it.
function watchLog(profileId) {
  if (profileId === 'alex') {
    return [
      event('a-101', 'movie-orbiters', 2210, 2880, 'roku'),
      event('a-102', 'ep-county-line-s3e9', 1460, 1500, 'ios'),
      event('a-103', 'ep-kitchen-wars-s5e1', 2010, 420, 'web'),
      event('a-104', 'ep-night-desk-s1e7', 640, 190, 'android-tv'),
      event('a-105', 'movie-dunes-of-ash', 4100, 95, 'roku'),
      event('a-106', 'ep-harbor-lights-s2e3', 980, 40, 'ios'),
      event('a-107', 'ep-harbor-lights-s2e3', 2730, 12, 'ios'),
    ];
  }
  if (profileId === 'sam') {
    const live = [
      event('s-201', 'movie-orbiters', 3900, 2700, 'web'),
      event('s-202', 'special-new-year-live', 5400, 1600, 'roku'),
      event('s-203', 'ep-harbor-lights-s2e3', 1200, 55, 'roku'),
      event('s-204', 'ep-night-desk-s1e7', 300, 48, 'ios'),
      event('s-205', 'ep-harbor-lights-s2e3', 2950, 30, 'roku'),
      event('s-206', 'ep-harbor-lights-s2e4', 610, 8, 'roku'),
    ];
    // Last hour of history re-delivered after the ingest outage was resolved.
    const replayed = live.filter((e) => Date.now() - Date.parse(e.watchedAt) <= 60 * 60 * 1000)
      .map((e) => ({ ...e, replayed: true }));
    return [...live, ...replayed];
  }
  return null;
}

const PROFILES = {
  alex: { id: 'alex', name: 'Alex', color: '#069de0' },
  sam: { id: 'sam', name: 'Sam', color: '#f5a524', note: 'Watch history restored from replay' },
};

function toTile(watch) {
  const item = CATALOG[watch.contentId];
  return {
    contentId: watch.contentId,
    title: item.title,
    subtitle: item.subtitle,
    type: item.type,
    art: item.art,
    progressSeconds: watch.progressSeconds,
    durationSeconds: item.durationSeconds,
    watchedAt: watch.watchedAt,
    device: watch.device,
  };
}

function buildContinueWatching(events) {
  const seenEventIds = new Set();
  const tilesByEventId = new Map();
  const eventIdByTitle = new Map();

  events.forEach((watch) => {
    if (seenEventIds.has(watch.eventId)) {
      const tile = tilesByEventId.get(watch.eventId);
      tile.progressSeconds = Math.max(tile.progressSeconds, watch.progressSeconds);
      return;
    }
    seenEventIds.add(watch.eventId);
    const previousEventId = eventIdByTitle.get(watch.contentId);
    if (previousEventId) tilesByEventId.delete(previousEventId);
    tilesByEventId.set(watch.eventId, toTile(watch));
    eventIdByTitle.set(watch.contentId, watch.eventId);
  });

  return [...tilesByEventId.values()].reverse().slice(0, RAIL_LIMIT).map((tile) => ({
    ...tile,
    percentComplete: Math.round((tile.progressSeconds / tile.durationSeconds) * 100),
  }));
}

function validationError(message, code) {
  const error = new Error(message);
  error.name = 'ValidationError';
  error.code = code;
  error.statusCode = 400;
  return error;
}

/* ------------------------------------------------------------------ */
/*  Jira + Devin                                                       */
/* ------------------------------------------------------------------ */

const text = (value, marks) => (marks ? { type: 'text', text: String(value), marks } : { type: 'text', text: String(value) });
const link = (label, href) => text(label, [{ type: 'link', attrs: { href } }]);
const strong = (value) => text(value, [{ type: 'strong' }]);
const code = (value) => text(value, [{ type: 'code' }]);
const para = (...content) => ({ type: 'paragraph', content });
const heading = (value, level = 3) => ({ type: 'heading', attrs: { level }, content: [text(value)] });
const bullets = (items) => ({
  type: 'bulletList',
  content: items.map((content) => ({ type: 'listItem', content: [para(...content)] })),
});
const ordered = (items) => ({
  type: 'orderedList',
  content: items.map((content) => ({ type: 'listItem', content: [para(...content)] })),
});
const codeBlock = (value, language = 'text') => ({ type: 'codeBlock', attrs: { language }, content: [text(value)] });

function sentryIssueUrl(eventId) {
  const org = process.env.SENTRY_ORG_SLUG || 'sentry-org';
  const project = process.env.SENTRY_PROJECT_ID || '';
  return `https://${org}.sentry.io/issues/?project=${project}&query=${eventId || 'is%3Aunresolved'}`;
}

function trimStack(stack) {
  const root = `${process.cwd()}/`;
  return String(stack || '').split('\n').slice(0, 8).map((line) => line.split(root).join('')).join('\n');
}

function buildJiraDescription({
  error, requestId, profile, events, sentryEventId, sentryUrl,
}) {
  const replayed = events.filter((e) => e.replayed);
  return {
    type: 'doc',
    version: 1,
    content: [
      heading('Error'),
      para(code(`${error.name}: ${error.message}`)),
      bullets([
        [strong('Culprit: '), code('app/services/verticals/a1eccdb6.js'), text(' — '), code('buildContinueWatching')],
        [strong('Route: '), code(`POST ${ROUTE}`)],
        [strong('Service: '), code(SERVICE)],
        [strong('Sentry event: '), sentryEventId ? link(sentryEventId, sentryUrl) : text('n/a')],
        [strong('Request ID: '), code(requestId)],
      ]),
      heading('Stack trace'),
      codeBlock(trimStack(error.stack), 'javascript'),
      heading('Business impact'),
      bullets([
        [text(`Profile ${profile.name} gets an error screen instead of the Continue Watching rail on Home, so they cannot resume anything they were watching.`)],
        [text('Every profile whose watch history was re-delivered after the ingest outage is likely affected; normal live traffic loads fine.')],
        [text('Continue Watching is the first rail on Home and drives most resume plays.')],
      ]),
      heading('Context'),
      bullets([
        [strong('Profile: '), text(`${profile.name} (${profile.id})`)],
        [strong('Watch events in history: '), text(`${events.length} (${replayed.length} re-delivered by the replay of the last hour)`)],
        [strong('Titles involved in the replay window: '), text([...new Set(replayed.map((e) => CATALOG[e.contentId].title))].join(', ') || 'none')],
      ]),
      heading('Steps to reproduce'),
      ordered([
        [text('Open '), code('/a1eccdb6'), text('.')],
        [text('Choose the '), strong('Sam'), text(' profile on "Who\'s watching?".')],
        [text('Observe the "Continue Watching couldn\'t load" error and the Sentry event above. The '), strong('Alex'), text(' profile loads normally.')],
      ]),
      heading('Expected vs actual'),
      bullets([
        [strong('Expected: '), text('The rail loads with one tile per title, newest watch first, showing the latest progress.')],
        [strong('Actual: '), text(`The request fails with ${error.name} and no rail is returned.`)],
      ]),
      heading('Acceptance criteria'),
      bullets([
        [text('Sam\'s Continue Watching rail loads after the replay, with each title shown once, newest first, at its latest progress.')],
        [text('Building the rail from the same history twice (or with any events re-delivered) gives the same result.')],
        [text('A regression test reproduces the replayed history and fails before the fix.')],
        [text('Alex\'s rail is unchanged.')],
      ]),
      heading('Repository'),
      para(link(REPO, `https://github.com/${REPO}`)),
    ],
  };
}

const REMEDIATION_DIRECTIVE = [
  `*Repository to investigate and fix:* \`${REPO}\``,
  '',
  'The failing code path is the streaming demo\'s Continue Watching rail:',
  '- Service: `app/services/verticals/a1eccdb6.js` (`buildContinueWatching`)',
  '- Route: `app/routes/verticals/a1eccdb6.js`',
  '- Page: `app/public/verticals/a1eccdb6.html` (served at `/a1eccdb6`)',
  '',
  '*Full remediation loop - complete every step:*',
  '1. Read the Jira ticket linked above (Jira REST API with `JIRA_EMAIL`/`JIRA_API_TOKEN`, or the Atlassian MCP). Comment that investigation has started with a link to this Devin session and transition it to *In Progress*.',
  '2. Reproduce locally: start the app and run `curl -s -X POST localhost:3000/api/a1eccdb6/continue-watching -H "Content-Type: application/json" -d \'{"profileId":"sam"}\'`. Confirm the error and stack trace match the ticket; `{"profileId":"alex"}` should succeed.',
  '3. Run the baseline tests: `npx jest tests/a1eccdb6-continue-watching.test.js --runInBand`.',
  '4. Find and fix the root cause, not the symptom (do not just catch the error or drop events). The rail must show each title once, newest watch first, at its latest progress, and must give the same result no matter how many times any event is delivered.',
  '5. Add a regression test that replays a profile\'s recent history and fails before your fix and passes after it. Keep the existing tests green.',
  '6. Validate: `npm test` and `npm run lint` must pass. Start the app and verify in the browser that `/a1eccdb6` loads Continue Watching for both Sam and Alex.',
  '7. Open a pull request against `main` whose title starts with the Jira key, whose description links the Jira ticket and explains the root cause, and whose body ends with the exact line `Devin-Org: engineering`. Do not merge it.',
  '8. Comment the PR link, root cause and fix summary on the Jira ticket using the REST v2 comment API (`POST /rest/api/2/issue/<KEY>/comment`; v3 has returned false permission errors) and transition the ticket to *In Review*.',
  '9. Wait for CI and Devin Review on the PR, address every comment with follow-up commits, and repeat step 6 until CI is green.',
].join('\n');

function buildPromptAppendix(issue, sentryEventId) {
  const header = issue
    ? [`*Jira ticket:* ${issue.key} - ${issue.url}`]
    : ['*Jira ticket:* not created (Jira unavailable) - skip the Jira steps below.'];
  if (sentryEventId) header.push(`*Sentry event ID:* \`${sentryEventId}\``);
  return [...header, '', REMEDIATION_DIRECTIVE].join('\n');
}

async function fileJiraTicket(context) {
  if (!jira.isConfigured()) {
    logger.warn('Jira not configured — skipping a1eccdb6 ticket', { requestId: context.requestId });
    return null;
  }
  try {
    const issue = await jira.createIssue({
      projectKey: JIRA_PROJECT_KEY,
      issueType: 'Bug',
      summary: `[Peacock] Continue Watching fails to load after watch-history replay (profile ${context.profile.name})`,
      description: buildJiraDescription(context),
      labels: ['devin-triage', 'a1eccdb6'],
      ...(JIRA_ASSIGNEE_ACCOUNT_ID ? { assigneeAccountId: JIRA_ASSIGNEE_ACCOUNT_ID } : {}),
    });
    logger.info('a1eccdb6 Jira ticket created', { key: issue.key, requestId: context.requestId });
    return issue;
  } catch (error) {
    logger.error('Failed to create a1eccdb6 Jira ticket', {
      requestId: context.requestId,
      error: error.message,
      status: error.response?.status,
      data: error.response?.data,
    });
    return null;
  }
}

async function linkSessionOnTicket(issue, alertResult) {
  const sessionUrl = alertResult?.session?.url;
  if (!issue || !sessionUrl) return;
  try {
    await jira.addComment(issue.key, `Devin is investigating this issue: ${sessionUrl}`);
  } catch (error) {
    logger.warn('Failed to comment Devin session on Jira ticket', { key: issue.key, error: error.message });
  }
}

const recentTickets = new Map();

function recentTicket(signature) {
  const hit = recentTickets.get(signature);
  if (hit && Date.now() - hit.at < TICKET_DEDUPE_MS) return hit;
  recentTickets.delete(signature);
  return null;
}

/* ------------------------------------------------------------------ */
/*  Continue Watching                                                  */
/* ------------------------------------------------------------------ */

function listProfiles() {
  return Object.values(PROFILES);
}

async function loadContinueWatching(data) {
  const startTime = Date.now();
  const requestId = `CW-${uuidv4().slice(0, 8).toUpperCase()}`;
  const profile = PROFILES[data.profileId];
  if (!profile) throw validationError('Choose a profile to continue watching.', 'CW_PROFILE_REQUIRED');

  const events = watchLog(profile.id);
  logger.info('Building Continue Watching rail', {
    requestId, profileId: profile.id, events: events.length, service: SERVICE, route: ROUTE,
  });

  try {
    const items = buildContinueWatching(events);
    incrementMetric('continue_watching.success', { route: ROUTE, profile: profile.id });
    recordTiming('continue_watching.latency', Date.now() - startTime, { route: ROUTE });
    return { success: true, requestId, profile, items };
  } catch (error) {
    const duration = Date.now() - startTime;
    incrementMetric('continue_watching.failure', { route: ROUTE, profile: profile.id, errorClass: error.name });
    recordTiming('continue_watching.latency', duration, { route: ROUTE, error: 'true' });
    logger.error('Continue Watching rail failed', {
      requestId, error: error.message, errorClass: error.name, durationMs: duration, profileId: profile.id, service: SERVICE,
    });

    error.requestId = requestId;
    error.code = 'CW_RAIL_FAILED';
    const signature = `${profile.id}:${error.name}:${error.message}`;
    const previous = recentTicket(signature);
    if (previous) {
      error.sentryEventId = previous.sentryEventId;
      error.jira = previous.jira;
      throw error;
    }

    const sentryEventId = Sentry.captureException(error, {
      tags: {
        route: ROUTE, service: SERVICE, profile_id: profile.id, alert_path: 'instant',
      },
      extra: { requestId, events: events.length, replayed: events.filter((e) => e.replayed).length },
    });
    const sentryUrl = sentryIssueUrl(sentryEventId);
    const issue = await fileJiraTicket({
      error, requestId, profile, events, sentryEventId, sentryUrl,
    });
    const jiraRef = issue ? { key: issue.key, url: issue.url } : null;
    recentTickets.set(signature, { at: Date.now(), sentryEventId, jira: jiraRef });

    createSessionAndAlert({
      title: issue ? `${issue.key}: Continue Watching fails after watch-history replay` : 'Continue Watching fails after watch-history replay',
      issueTitle: `${error.name}: ${error.message}`,
      issueUrl: sentryUrl,
      culprit: 'app/services/verticals/a1eccdb6.js — buildContinueWatching',
      errorType: error.name || 'Error',
      errorValue: error.message,
      devinUserId: data.devinUserId,
      devinEmail: data.devinEmail,
      devinOrgId: data.devinOrgId,
      service: SERVICE,
      verticalLabel: 'Streaming — Continue Watching',
      promptAppendix: buildPromptAppendix(issue, sentryEventId),
      customer: 'a1eccdb6',
      ...(SLACK_MEMBER_ID ? { slackMemberId: SLACK_MEMBER_ID, slackMemberIdFallback: SLACK_MEMBER_ID } : {}),
      tags: [
        { key: 'route', value: ROUTE },
        { key: 'service', value: SERVICE },
        { key: 'profile_id', value: profile.id },
        ...(issue ? [{ key: 'jira', value: issue.key }] : []),
      ],
      extra: {
        requestId, jiraKey: issue?.key || '', jiraUrl: issue?.url || '',
      },
      level: 'error',
      platform: 'node',
      firstSeen: '',
      lastSeen: new Date().toISOString(),
      count: '',
      shortId: '',
      project: 'event-driven-devin',
      release: process.env.SENTRY_RELEASE || `${SERVICE}@1.0.0`,
      environment: process.env.DD_ENV || 'prod',
      triggeredRule: '',
    })
      .then((result) => linkSessionOnTicket(issue, result))
      .catch((alertError) => {
        logger.error('Failed to create Devin session for a1eccdb6 error', { error: alertError.message, requestId });
      });

    error.sentryEventId = sentryEventId;
    error.jira = jiraRef;
    throw error;
  }
}

module.exports = {
  loadContinueWatching,
  listProfiles,
  buildContinueWatching,
  buildJiraDescription,
  buildPromptAppendix,
  watchLog,
  CATALOG,
  PROFILES,
  REMEDIATION_DIRECTIVE,
  JIRA_PROJECT_KEY,
};
