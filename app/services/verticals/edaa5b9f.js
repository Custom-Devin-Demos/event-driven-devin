const { v4: uuidv4 } = require('uuid');
const logger = require('../../telemetry/logger');
const { incrementMetric, recordTiming } = require('../../telemetry/datadog');
const { Sentry } = require('../../telemetry/sentry');
const { createSessionAndAlert } = require('../devin-session');

/**
 * Guest support queues. Each queue carries the SLA and the routing
 * destination used to acknowledge an inquiry.
 */
const SUPPORT_QUEUES = {
  parks_experiences: { slaHours: 24, team: 'Parks & Experiences Guest Services', channel: 'email' },
  studio_entertainment: { slaHours: 48, team: 'Studio Entertainment Relations', channel: 'email' },
  shop_merchandise: { slaHours: 24, team: 'shopDisney Guest Support', channel: 'email' },
  corporate_press: { slaHours: 72, team: 'Corporate Communications', channel: 'email' },
};

/**
 * Inquiry topics currently exposed on the contact form.
 * `streaming` was enabled when Disney+ support moved in-house.
 */
const ENABLED_TOPICS = ['parks', 'movies', 'shopping', 'streaming', 'press'];

/**
 * Maps a contact-form topic onto its internal support queue key.
 */
const TOPIC_QUEUE_KEYS = {
  parks: 'parks_experiences',
  movies: 'studio_entertainment',
  shopping: 'shop_merchandise',
  press: 'corporate_press',
  streaming: 'disney_plus_care',
};

/**
 * Resolves the support queue for a contact-form topic.
 */
function resolveSupportQueue(topic) {
  if (!ENABLED_TOPICS.includes(topic)) {
    throw Object.assign(new Error(`Inquiry topic not available: ${topic}`), { code: 'TOPIC_UNAVAILABLE' });
  }
  return SUPPORT_QUEUES[TOPIC_QUEUE_KEYS[topic]];
}

/**
 * Builds the acknowledgement ticket returned to the guest.
 */
function buildInquiryTicket(inquiry, queue) {
  const respondBy = new Date(Date.now() + queue.slaHours * 3600 * 1000);
  return {
    ticketId: `DIS-${uuidv4().slice(0, 8).toUpperCase()}`,
    routedTo: queue.team,
    channel: queue.channel,
    respondBy: respondBy.toISOString(),
    guestName: inquiry.name,
    guestEmail: inquiry.email,
  };
}

/**
 * Submits a guest contact inquiry.
 */
async function submitInquiry(inquiry) {
  const startTime = Date.now();
  const requestId = uuidv4();

  logger.info('Guest inquiry received', {
    requestId,
    topic: inquiry.topic,
    service: 'disney-guest-services',
    route: '/api/edaa5b9f/contact',
  });

  try {
    await new Promise((resolve) => setTimeout(resolve, 80 + Math.random() * 120));

    const queue = resolveSupportQueue(inquiry.topic);
    const ticket = buildInquiryTicket(inquiry, queue);

    const duration = Date.now() - startTime;

    incrementMetric('inquiry.success', {
      route: '/api/edaa5b9f/contact',
      source: 'disney-homepage',
    });
    recordTiming('inquiry.latency', duration, {
      route: '/api/edaa5b9f/contact',
    });

    return {
      success: true,
      requestId,
      ...ticket,
      status: 'received',
      receivedAt: new Date().toISOString(),
    };
  } catch (error) {
    const duration = Date.now() - startTime;

    incrementMetric('inquiry.failure', {
      route: '/api/edaa5b9f/contact',
      errorClass: error.name,
      source: 'disney-homepage',
    });
    recordTiming('inquiry.latency', duration, {
      route: '/api/edaa5b9f/contact',
      error: 'true',
    });

    logger.error('Guest inquiry failed', {
      requestId,
      error: error.message,
      errorClass: error.name,
      durationMs: duration,
      topic: inquiry.topic,
      service: 'disney-guest-services',
    });

    Sentry.captureException(error, {
      tags: {
        route: '/api/edaa5b9f/contact',
        service: 'disney-guest-services',
        source: 'disney-homepage',
      },
      extra: {
        requestId,
        topic: inquiry.topic,
        guestEmail: inquiry.email,
      },
    });

    createSessionAndAlert({
      issueTitle: `${error.name}: ${error.message}`,
      issueUrl: `https://${process.env.SENTRY_ORG_SLUG || 'sentry-org'}.sentry.io/issues/?project=${process.env.SENTRY_PROJECT_ID || ''}&query=is%3Aunresolved`,
      culprit: 'app/services/verticals/edaa5b9f.js \u2014 buildInquiryTicket',
      errorType: error.name || 'Error',
      errorValue: error.message,
      customer: 'edaa5b9f',
      devinUserId: inquiry.devinUserId,
      devinEmail: inquiry.devinEmail,
      devinOrgId: inquiry.devinOrgId,
      service: 'disney-guest-services',
      verticalLabel: 'Disney Guest Contact',
      tags: [
        { key: 'route', value: '/api/edaa5b9f/contact' },
        { key: 'service', value: 'disney-guest-services' },
        { key: 'topic', value: String(inquiry.topic) },
      ],
      extra: {
        requestId,
        topic: inquiry.topic,
      },
      level: 'error',
      platform: 'node',
      firstSeen: '',
      lastSeen: new Date().toISOString(),
      count: '',
      shortId: '',
      project: 'event-driven-devin',
      release: process.env.SENTRY_RELEASE || 'disney-guest-services@1.0.0',
      environment: process.env.DD_ENV || 'prod',
      triggeredRule: '',
    }).catch((err) => {
      logger.error('Failed to trigger Devin session from Disney inquiry error', { error: err.message });
    });

    throw error;
  }
}

module.exports = {
  submitInquiry,
  resolveSupportQueue,
  buildInquiryTicket,
  SUPPORT_QUEUES,
  TOPIC_QUEUE_KEYS,
  ENABLED_TOPICS,
};
