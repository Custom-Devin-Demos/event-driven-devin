const { v4: uuidv4 } = require('uuid');
const logger = require('../../telemetry/logger');
const { incrementMetric, recordTiming } = require('../../telemetry/datadog');
const { Sentry } = require('../../telemetry/sentry');
const { createSessionAndAlert } = require('../devin-session');

const ROUTE = '/api/73575564/register';
const SERVICE = 'event-registration-api';

/**
 * Participation passes, keyed by pass id. `segments` lists the parts of the
 * day the pass admits to; every segment needs a place before the request is
 * queued for approval.
 */
const PASS_CONFIGS = {
  'full-day': { label: '終日参加', segments: ['keynote', 'sessions', 'reception'] },
  keynote:    { label: '基調講演のみ', segments: ['keynote'] },
  sessions:   { label: '午後セッションのみ', segments: ['sessions'] },
};

/**
 * Room capacity and requests held so far for each part of the day.
 */
const SEGMENT_CAPACITY = {
  keynote:  { label: '基調講演（10:00-11:50）', capacity: 420, held: 371 },
  sessions: { label: '事例・技術セッション（13:10-16:40）', capacity: 360, held: 298 },
};

const EVENT = {
  id: 'merge-tokyo-2026',
  title: 'Merge Tokyo 2026',
  startsAt: '2026-11-24T10:00:00+09:00',
  registrationClosesAt: '2026-11-23T17:00:00+09:00',
};

/**
 * Retrieve the pass for a pass id, falling back to the full-day pass for ids
 * that have since been retired.
 */
function getPassConfig(passId) {
  return PASS_CONFIGS[passId] || PASS_CONFIGS['full-day'];
}

/**
 * Hold a place in every segment of the pass. A segment with no room left
 * puts the whole request on the waiting list.
 */
function holdSegments(pass) {
  let waitlisted = false;
  const holds = pass.segments.map((segmentId) => {
    const segment = SEGMENT_CAPACITY[segmentId];
    const remaining = segment.capacity - segment.held;
    if (remaining <= 0) waitlisted = true;
    return { segmentId, label: segment.label, remaining: Math.max(remaining - 1, 0) };
  });
  return { holds, status: waitlisted ? 'waitlisted' : 'pending-approval' };
}

/**
 * Submit a participation request for the event.
 */
async function registerAttendee(data) {
  const startTime = Date.now();
  const registrationId = uuidv4();

  logger.info('Registering attendee', {
    registrationId,
    eventId: EVENT.id,
    passId: data.passId,
    company: data.company,
    service: SERVICE,
  });

  try {
    await new Promise((resolve) => setTimeout(resolve, 60 + Math.random() * 120));

    const pass = getPassConfig(data.passId);
    const { holds, status } = holdSegments(pass);

    const duration = Date.now() - startTime;

    incrementMetric('registration.success', { route: ROUTE, pass: data.passId });
    recordTiming('registration.latency', duration, { route: ROUTE });

    return {
      success: true,
      registrationId,
      eventId: EVENT.id,
      passId: data.passId,
      passLabel: pass.label,
      status,
      holds,
      attendeeName: data.attendeeName,
      company: data.company,
      submittedAt: new Date().toISOString(),
    };
  } catch (error) {
    const duration = Date.now() - startTime;

    incrementMetric('registration.failure', { route: ROUTE, errorClass: error.name });
    recordTiming('registration.latency', duration, { route: ROUTE, error: 'true' });

    logger.error('Attendee registration failed', {
      registrationId,
      eventId: EVENT.id,
      passId: data.passId,
      error: error.message,
      errorClass: error.name,
      durationMs: duration,
      service: SERVICE,
    });

    Sentry.captureException(error, {
      tags: { route: ROUTE, service: SERVICE, pass: data.passId, alert_path: 'instant' },
      extra: { registrationId, eventId: EVENT.id, company: data.company },
    });

    createSessionAndAlert({
      issueTitle: `${error.name}: ${error.message}`,
      issueUrl: `https://${process.env.SENTRY_ORG_SLUG || 'sentry-org'}.sentry.io/issues/?project=${process.env.SENTRY_PROJECT_ID || ''}&query=is%3Aunresolved`,
      culprit: 'app/services/verticals/73575564.js — registerAttendee',
      errorType: error.name || 'Error',
      errorValue: error.message,
      devinUserId: data.devinUserId,
      devinEmail: data.devinEmail,
      devinOrgId: data.devinOrgId,
      service: SERVICE,
      verticalLabel: 'イベント参加申込（Merge Tokyo 2026）',
      locale: 'ja',
      tags: [
        { key: 'route', value: ROUTE },
        { key: 'service', value: SERVICE },
        { key: 'alert_path', value: 'instant' },
      ],
      extra: { registrationId, eventId: EVENT.id, passId: data.passId, company: data.company },
      level: 'error',
      platform: 'node',
      firstSeen: '',
      lastSeen: new Date().toISOString(),
      count: '',
      shortId: '',
      project: 'event-driven-devin',
      release: process.env.SENTRY_RELEASE || 'event-registration@2.4.0',
      environment: process.env.DD_ENV || 'prod',
      triggeredRule: '',
    }).catch((err) => {
      logger.error('Failed to trigger Devin session from registration error', { error: err.message });
    });

    throw error;
  }
}

module.exports = { registerAttendee, PASS_CONFIGS, SEGMENT_CAPACITY, EVENT };
