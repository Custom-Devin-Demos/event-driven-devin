const { v4: uuidv4 } = require('uuid');
const logger = require('../../telemetry/logger');
const { incrementMetric, recordTiming } = require('../../telemetry/datadog');
const { Sentry } = require('../../telemetry/sentry');
const { createSessionAndAlert } = require('../devin-session');
const { layoutForTheme, composeHeroBlock } = require('./ce9afcfc-layout');

/**
 * ce9afcfc — the invite screen a guest opens from an invite link in the app.
 * The screen is assembled server-side from the event the host created in the
 * composer and returned to the client as a render payload.
 */

const SLACK_MEMBER_ID = process.env.CE9AFCFC_SLACK_MEMBER_ID || 'U08S7AVJ478';

/**
 * Events in the demo account. `coverPhoto` holds whatever the host attached in
 * the composer.
 */
const EVENTS = {
  'sunset-rooftop-supper': {
    id: 'sunset-rooftop-supper',
    title: 'Sunset Rooftop Supper',
    emoji: '\u{1F307}',
    host: 'Sean D.',
    cohosts: ['Maya R.'],
    theme: 'photo',
    dayLine: 'Sat, Mar 14',
    timeLine: '6:30 PM',
    pill: 'Sat at 6:30pm',
    countdown: 'Tomorrow',
    venue: 'The Douglass',
    address: '1500 Mission St, San Francisco',
    accent: 'tangerine',
    capacity: 40,
    note: 'Bring a layer, the wind picks up after sunset. Cocktails on the north side.',
    coverPhoto: {
      url: 'https://images.unsplash.com/photo-1519671482749-fd09be7ccebf?w=1200&q=80',
      width: 1200,
      height: 800,
    },
    guests: [
      { name: 'Maya Rodriguez', status: 'Going', plusOnes: 1 },
      { name: 'Andre Willis', status: 'Going', plusOnes: 0 },
      { name: 'Priya Natarajan', status: 'Going', plusOnes: 0 },
      { name: 'Dan Cho', status: 'Maybe', plusOnes: 0 },
      { name: 'Lena Fischer', status: 'Maybe', plusOnes: 0 },
      { name: 'Tomas Alvarez', status: "Can't go", plusOnes: 0 },
      { name: 'Jess Okafor', status: 'Invited', plusOnes: 0 },
    ],
  },
  'dumpling-night-mine': {
    id: 'dumpling-night-mine',
    title: 'Dumpling Night @ Mine',
    emoji: '\u{1F95F}',
    host: 'Sean D.',
    cohosts: [],
    theme: 'marquee',
    dayLine: 'Sun, Mar 15',
    timeLine: '7:00 PM',
    pill: 'Sun at 7pm',
    countdown: 'In 2 days',
    venue: 'My place',
    address: 'Text me for the address',
    accent: 'tangerine',
    capacity: 12,
    note: 'Folding starts at seven, eating starts whenever. Bring wine or a friend, ideally both.',
    coverPhoto: null,
    guests: [
      { name: 'Andre Willis', status: 'Going', plusOnes: 1 },
      { name: 'Dan Cho', status: 'Going', plusOnes: 0 },
      { name: 'Ruth Levine', status: 'Going', plusOnes: 0 },
      { name: 'Priya Natarajan', status: 'Maybe', plusOnes: 0 },
      { name: 'Jess Okafor', status: 'Invited', plusOnes: 0 },
      { name: 'Marcus Bell', status: 'Invited', plusOnes: 0 },
    ],
  },
  'karaoke-comeback': {
    id: 'karaoke-comeback',
    title: 'Karaoke Comeback Tour',
    emoji: '\u{1F3A4}',
    host: 'Ruth L.',
    cohosts: [],
    theme: 'confetti',
    dayLine: 'Fri, Mar 20',
    timeLine: '8:00 PM',
    pill: 'Fri at 8pm',
    countdown: 'In 7 days',
    venue: 'The Mint',
    address: '1942 Market St, San Francisco',
    accent: 'violet',
    capacity: null,
    note: 'One song each before anyone is allowed a second. House rules.',
    coverPhoto: null,
    guests: [
      { name: 'Sean Dreifuss', status: 'Going', plusOnes: 0 },
      { name: 'Lena Fischer', status: 'Going', plusOnes: 0 },
      { name: 'Tomas Alvarez', status: 'Maybe', plusOnes: 0 },
      { name: 'Maya Rodriguez', status: 'Invited', plusOnes: 0 },
    ],
  },
  'ship-it-drinks': {
    id: 'ship-it-drinks',
    title: 'Ship It Drinks',
    emoji: '\u{1F680}',
    host: 'Andre W.',
    cohosts: ['Sean D.'],
    theme: 'photo',
    dayLine: 'Fri, Mar 27',
    timeLine: '5:30 PM',
    pill: 'Fri at 5:30pm',
    countdown: 'In 14 days',
    venue: 'Bar Part Time',
    address: '496 14th St, San Francisco',
    accent: 'violet',
    capacity: 60,
    note: 'We shipped it. Come celebrate before the next release branch cuts.',
    coverPhoto: {
      url: 'https://images.unsplash.com/photo-1514933651103-005eec06c04b?w=1200&q=80',
      width: 1200,
      height: 800,
    },
    guests: [
      { name: 'Sean Dreifuss', status: 'Going', plusOnes: 0 },
      { name: 'Priya Natarajan', status: 'Going', plusOnes: 1 },
      { name: 'Dan Cho', status: 'Maybe', plusOnes: 0 },
      { name: 'Ruth Levine', status: 'Invited', plusOnes: 0 },
    ],
  },
};

/**
 * Scenario directive appended to the Devin investigation prompt.
 *
 * The alert pipeline passes only a prompt to the Devin API, so the repository
 * to remediate has to be named explicitly here.
 */
const REMEDIATION_DIRECTIVE = [
  '*Repository to investigate and fix:* `COG-GTM/event-driven-devin`',
  '',
  'The failing code path is the invite screen guests open from an invite link:',
  '- Service: `app/services/verticals/ce9afcfc.js`',
  '- Layout rules: `app/services/verticals/ce9afcfc-layout.js`',
  '- Route: `app/routes/verticals/ce9afcfc.js`',
  '- Page: `app/public/verticals/ce9afcfc.html` (served at `/ce9afcfc`)',
  '',
  'Guests who open certain invites get a blank screen and cannot RSVP.',
  '',
  'Open a pull request against `main` with the fix.',
].join('\n');

const RSVP_STATUS_ORDER = { Going: 0, Maybe: 1, "Can't go": 2, Invited: 3 };

function goingCount(event) {
  return event.guests
    .filter((guest) => guest.status === 'Going')
    .reduce((sum, guest) => sum + 1 + guest.plusOnes, 0);
}

function maybeCount(event) {
  return event.guests.filter((guest) => guest.status === 'Maybe').length;
}

function spotsLeft(event) {
  return event.capacity === null ? null : Math.max(0, event.capacity - goingCount(event));
}

function orderedGuests(event) {
  return event.guests
    .slice()
    .sort((a, b) => RSVP_STATUS_ORDER[a.status] - RSVP_STATUS_ORDER[b.status]);
}

/**
 * Assemble the render payload for an invite screen.
 */
function buildInviteScreen(event) {
  const layout = layoutForTheme(event.theme);
  const hero = composeHeroBlock(event, layout);

  return {
    eventId: event.id,
    title: event.title,
    host: event.host,
    cohosts: event.cohosts,
    hero: hero.url,
    heroHeight: hero.height,
    heroAspectRatio: hero.aspectRatio,
    heroOverlayOpacity: hero.overlayOpacity,
    accent: hero.accent,
    dayLine: event.dayLine,
    timeLine: event.timeLine,
    countdown: event.countdown,
    venue: event.venue,
    address: event.address,
    note: event.note,
    capacity: event.capacity,
    spotsLeft: spotsLeft(event),
    goingCount: goingCount(event),
    maybeCount: maybeCount(event),
    guests: orderedGuests(event),
    shareLink: `https://partiful.com/e/${event.id}`,
    rsvpOpen: true,
  };
}

/**
 * Render the invite screen a guest opens from an invite link.
 */
async function renderInviteScreen(data) {
  const startTime = Date.now();
  const requestId = uuidv4();
  const event = EVENTS[data.eventId];

  if (!event) {
    const validationError = new Error('That invite link does not point at an event.');
    validationError.name = 'ValidationError';
    validationError.code = 'UNKNOWN_EVENT';
    validationError.statusCode = 400;
    throw validationError;
  }

  logger.info('Rendering invite screen', {
    requestId,
    eventId: event.id,
    theme: event.theme,
    service: 'ce9afcfc-api',
    route: '/api/ce9afcfc/invite-screen',
  });

  try {
    await new Promise((resolve) => { setTimeout(resolve, 70 + Math.random() * 110); });

    const screen = buildInviteScreen(event);
    const duration = Date.now() - startTime;

    incrementMetric('ce9afcfc.invite_screen_rendered', {
      route: '/api/ce9afcfc/invite-screen',
      theme: event.theme,
    });
    recordTiming('ce9afcfc.invite_screen_latency', duration, {
      route: '/api/ce9afcfc/invite-screen',
    });

    return screen;
  } catch (error) {
    const duration = Date.now() - startTime;

    incrementMetric('ce9afcfc.invite_screen_failure', {
      route: '/api/ce9afcfc/invite-screen',
      errorClass: error.name,
      theme: event.theme,
    });
    recordTiming('ce9afcfc.invite_screen_latency', duration, {
      route: '/api/ce9afcfc/invite-screen',
      error: 'true',
    });

    logger.error('Invite screen failed to render', {
      requestId,
      eventId: event.id,
      theme: event.theme,
      error: error.message,
      errorClass: error.name,
      durationMs: duration,
      service: 'ce9afcfc-api',
    });

    Sentry.captureException(error, {
      tags: {
        route: '/api/ce9afcfc/invite-screen',
        service: 'ce9afcfc-api',
        theme: event.theme,
      },
      extra: {
        requestId,
        eventId: event.id,
        invitedCount: event.guests.length,
      },
    });

    createSessionAndAlert({
      issueTitle: `${error.name}: ${error.message}`,
      issueUrl: `https://${process.env.SENTRY_ORG_SLUG || 'sentry-org'}.sentry.io/issues/?project=${process.env.SENTRY_PROJECT_ID || ''}&query=is%3Aunresolved`,
      culprit: 'app/services/verticals/ce9afcfc-layout.js \u2014 composeHeroBlock',
      errorType: error.name || 'Error',
      errorValue: error.message,
      devinUserId: data.devinUserId,
      devinEmail: data.devinEmail,
      devinOrgId: data.devinOrgId,
      service: 'ce9afcfc-api',
      verticalLabel: 'Partiful \u2014 Invite Screen',
      promptAppendix: REMEDIATION_DIRECTIVE,
      customer: 'ce9afcfc',
      slackMemberId: data.devinEmail ? '' : SLACK_MEMBER_ID,
      slackMemberIdFallback: SLACK_MEMBER_ID,
      tags: [
        { key: 'route', value: '/api/ce9afcfc/invite-screen' },
        { key: 'service', value: 'ce9afcfc-api' },
        { key: 'eventId', value: event.id },
        { key: 'theme', value: event.theme },
      ],
      extra: {
        requestId,
        eventId: event.id,
        theme: event.theme,
        invitedCount: event.guests.length,
        goingCount: goingCount(event),
      },
      level: 'error',
      platform: 'node',
      firstSeen: '',
      lastSeen: new Date().toISOString(),
      count: '',
      shortId: '',
      project: 'event-driven-devin',
      release: process.env.SENTRY_RELEASE || 'ce9afcfc@1.0.0',
      environment: process.env.DD_ENV || 'prod',
      triggeredRule: '',
    }).catch((err) => {
      logger.error('Failed to trigger Devin session', { error: err.message, requestId });
    });

    throw error;
  }
}

module.exports = {
  renderInviteScreen,
  buildInviteScreen,
  REMEDIATION_DIRECTIVE,
  EVENTS,
};
