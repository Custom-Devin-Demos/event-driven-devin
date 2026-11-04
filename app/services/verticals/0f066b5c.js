const { v4: uuidv4 } = require('uuid');
const logger = require('../../telemetry/logger');
const { incrementMetric, recordTiming } = require('../../telemetry/datadog');
const { Sentry } = require('../../telemetry/sentry');
const { createSessionAndAlert } = require('../devin-session');

const ROUTE = '/api/0f066b5c/swipes';
const SERVICE = 'bumble-match-service';
const SLACK_MEMBER_ID = process.env.BUMBLE_SLACK_MEMBER_ID || '';
const PHOTO_BASE = '/verticals/0f066b5c';

const SWIPE_DIRECTIONS = {
  pass: { label: 'Pass', createsMatch: false },
  like: { label: 'Like', createsMatch: true },
  superswipe: { label: 'SuperSwipe', createsMatch: true },
};

/**
 * Trust & Safety weights per verification method, used to rank and gate new
 * connections. Written for photo verification (2019) and the selfie-video flow.
 */
const VERIFICATION_TRUST = {
  photo: { trustWeight: 0.72, badge: 'Photo verified' },
  selfie_video: { trustWeight: 0.84, badge: 'Photo verified' },
};

const VIEWER = {
  id: 'mem_alex_r',
  name: 'Alex',
  age: 31,
  city: 'Brooklyn, NY',
  photo: `${PHOTO_BASE}/alex.jpg`,
  profileCompletion: 82,
  mode: 'Date',
  verification: { method: 'selfie_video', verifiedAt: '2026-06-14T18:20:00Z' },
};

const PEOPLE = [
  {
    id: 'mem_maya_k',
    name: 'Maya',
    age: 29,
    pronouns: 'she/her',
    job: 'Product Designer at a climate startup',
    education: 'Parsons School of Design',
    city: 'Williamsburg, Brooklyn',
    distance: '2 miles away',
    photo: `${PHOTO_BASE}/maya.jpg`,
    verification: { method: 'government_id', verifiedAt: '2026-10-28T15:02:00Z', badge: 'ID verified' },
    about: 'Weekend farmers-market regular, amateur ceramicist, will absolutely judge your coffee order.',
    lookingFor: 'A long-term relationship',
    basics: ['5\'7"', 'Active', 'Sometimes drinks', 'Wants kids', 'Virgo'],
    interests: ['Ceramics', 'Hiking', 'Natural wine', 'Live music', 'Design'],
    openingMove: 'What does your perfect Sunday in the city look like?',
    likedYou: true,
  },
  {
    id: 'mem_priya_s',
    name: 'Priya',
    age: 30,
    pronouns: 'she/her',
    job: 'Emergency Medicine Resident',
    education: 'Columbia University',
    city: 'Upper West Side, Manhattan',
    distance: '6 miles away',
    photo: `${PHOTO_BASE}/priya.jpg`,
    verification: { method: 'selfie_video', verifiedAt: '2026-09-02T11:40:00Z', badge: 'Photo verified' },
    about: 'Night shifts, early runs, and a very opinionated list of the best dumplings in Queens.',
    lookingFor: 'Long-term, open to short',
    basics: ['5\'5"', 'Active', 'Rarely drinks', 'Open to kids', 'Leo'],
    interests: ['Running', 'Dumplings', 'Podcasts', 'Travel', 'Board games'],
    openingMove: 'Pitch me your best weeknight date idea.',
    likedYou: true,
  },
  {
    id: 'mem_aisha_b',
    name: 'Aisha',
    age: 28,
    pronouns: 'she/her',
    job: 'Brand Strategist',
    education: 'NYU',
    city: 'Fort Greene, Brooklyn',
    distance: '3 miles away',
    photo: `${PHOTO_BASE}/aisha.jpg`,
    verification: { method: 'photo', verifiedAt: '2026-03-19T20:11:00Z', badge: 'Photo verified' },
    about: 'Gallery hopper, plant mom of 23, currently learning to make fresh pasta.',
    lookingFor: 'A relationship',
    basics: ['5\'6"', 'Sometimes active', 'Socially drinks', 'Not sure about kids', 'Pisces'],
    interests: ['Art', 'Cooking', 'Plants', 'Jazz', 'Brunch'],
    openingMove: 'What is a small thing that instantly makes your day better?',
    likedYou: false,
  },
  {
    id: 'mem_sam_t',
    name: 'Sam',
    age: 32,
    pronouns: 'he/him',
    job: 'Architect',
    education: 'Cornell University',
    city: 'Park Slope, Brooklyn',
    distance: '4 miles away',
    photo: `${PHOTO_BASE}/sam.jpg`,
    verification: { method: 'photo', verifiedAt: '2026-05-08T09:30:00Z', badge: 'Photo verified' },
    about: 'I sketch buildings on napkins and cook a mean Sunday ragu.',
    lookingFor: 'A long-term relationship',
    basics: ['6\'0"', 'Active', 'Socially drinks', 'Wants kids', 'Taurus'],
    interests: ['Architecture', 'Cooking', 'Cycling', 'Film', 'Coffee'],
    openingMove: 'Which NYC building would you live in if money were no object?',
    likedYou: true,
  },
];

const MATCHES = [
  {
    id: 'mch_jordan_l',
    name: 'Jordan',
    age: 30,
    photo: `${PHOTO_BASE}/jordan.jpg`,
    expiresInHours: 18,
    lastMessage: 'Thursday at 7:30 works! Lilia on N 10th?',
    unread: true,
    messages: [
      { from: 'viewer', text: 'Okay your Opening Move answer about the best bagel in Brooklyn was bold.' },
      { from: 'match', text: 'I stand by it. Want to settle it in person?' },
      { from: 'viewer', text: 'Deal. Dinner Thursday?' },
      { from: 'match', text: 'Thursday at 7:30 works! Lilia on N 10th?' },
    ],
    upcomingDate: { venue: 'Lilia', address: '567 Union Ave, Brooklyn, NY', startsAt: '2026-11-05T19:30:00-05:00' },
  },
];

function findProfile(profileId) {
  return PEOPLE.find((p) => p.id === profileId) || null;
}

function getAppState() {
  return {
    success: true,
    viewer: VIEWER,
    people: PEOPLE.map((p) => Object.fromEntries(Object.entries(p).filter(([key]) => key !== 'likedYou'))),
    likedYouCount: PEOPLE.filter((p) => p.likedYou).length,
    likedYouIds: PEOPLE.filter((p) => p.likedYou).map((p) => p.id),
    matches: MATCHES,
  };
}

/**
 * Connection trust score used by the match gate. Both members must clear the
 * Trust & Safety floor before a match (and chat) is opened.
 */
function scoreConnectionTrust(viewer, candidate) {
  const viewerTrust = VERIFICATION_TRUST[viewer.verification.method];
  const candidateTrust = VERIFICATION_TRUST[candidate.verification.method];
  const score = Math.min(viewerTrust.trustWeight, candidateTrust.trustWeight);
  return { score: Number(score.toFixed(2)), cleared: score >= 0.6 };
}

async function processSwipe(swipeData) {
  const startTime = Date.now();
  const swipeId = `swp_${uuidv4().replace(/-/g, '').slice(0, 12)}`;
  const { profile, direction, requestId } = swipeData;

  try {
    if (!SWIPE_DIRECTIONS[direction].createsMatch) {
      incrementMetric('swipe.pass', { route: ROUTE });
      return { success: true, swipeId, outcome: 'passed', profileId: profile.id };
    }

    const trust = scoreConnectionTrust(VIEWER, profile);
    const isMatch = trust.cleared && (profile.likedYou || direction === 'superswipe');

    recordTiming('swipe.latency', Date.now() - startTime, { route: ROUTE, direction });
    incrementMetric('swipe.success', { route: ROUTE, direction, matched: String(isMatch) });

    if (!isMatch) {
      return { success: true, swipeId, outcome: 'liked', profileId: profile.id };
    }

    return {
      success: true,
      swipeId,
      outcome: 'matched',
      trustScore: trust.score,
      match: {
        id: `mch_${uuidv4().replace(/-/g, '').slice(0, 10)}`,
        profileId: profile.id,
        name: profile.name,
        photo: profile.photo,
        openingMove: profile.openingMove,
        expiresInHours: 24,
      },
    };
  } catch (error) {
    const duration = Date.now() - startTime;
    const method = profile.verification.method;

    incrementMetric('swipe.failure', { route: ROUTE, errorClass: error.name, verification_method: method });
    recordTiming('swipe.latency', duration, { route: ROUTE, error: 'true' });

    logger.error('Bumble match creation failed', {
      swipeId,
      requestId,
      error: error.message,
      errorClass: error.name,
      durationMs: duration,
      profileId: profile.id,
      direction,
      verificationMethod: method,
      service: SERVICE,
    });

    Sentry.captureException(error, {
      tags: {
        route: ROUTE, service: SERVICE, source: 'bumble-people-deck', alert_path: 'instant',
      },
      extra: {
        swipeId, profileId: profile.id, direction, verificationMethod: method,
      },
    });

    createSessionAndAlert({
      issueTitle: `${error.name}: ${error.message}`,
      issueUrl: `https://${process.env.SENTRY_ORG_SLUG || 'sentry-org'}.sentry.io/issues/?project=${process.env.SENTRY_PROJECT_ID || ''}&query=is%3Aunresolved`,
      culprit: 'app/services/verticals/0f066b5c.js \u2014 scoreConnectionTrust',
      errorType: error.name || 'Error',
      errorValue: error.message,
      customer: '0f066b5c',
      devinUserId: swipeData.devinUserId,
      devinEmail: swipeData.devinEmail,
      devinOrgId: swipeData.devinOrgId,
      slackMemberIdFallback: SLACK_MEMBER_ID,
      service: SERVICE,
      verticalLabel: 'Bumble \u2014 People deck match creation',
      tags: [
        { key: 'route', value: ROUTE },
        { key: 'service', value: SERVICE },
        { key: 'direction', value: String(direction) },
        { key: 'verification_method', value: String(method) },
      ],
      extra: {
        swipeId, profileId: profile.id, verificationMethod: method, verifiedAt: profile.verification.verifiedAt,
      },
      level: 'error',
      platform: 'node',
      firstSeen: '',
      lastSeen: new Date().toISOString(),
      count: '',
      shortId: '',
      project: 'event-driven-devin',
      release: process.env.SENTRY_RELEASE || `${SERVICE}@2026.11.1`,
      environment: process.env.DD_ENV || 'prod',
      triggeredRule: '',
    }).catch((err) => {
      logger.error('Failed to trigger Devin session from Bumble match error', { error: err.message });
    });

    error.swipeId = swipeId;
    throw error;
  }
}

module.exports = {
  processSwipe,
  getAppState,
  findProfile,
  scoreConnectionTrust,
  SWIPE_DIRECTIONS,
  VERIFICATION_TRUST,
  VIEWER,
  PEOPLE,
  MATCHES,
};
