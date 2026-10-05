const { v4: uuidv4 } = require('uuid');
const logger = require('../../telemetry/logger');
const { incrementMetric, recordTiming } = require('../../telemetry/datadog');
const { Sentry } = require('../../telemetry/sentry');
const { createSessionAndAlert } = require('../devin-session');

const SERVICE = 'customer-50a88f70-player-support-routing';
const ROUTE = '/api/50a88f70/support-ticket';
const TICKET_PREFIX = 'EPIC-PS';

const PRODUCTS = {
  fortnite: { label: 'Fortnite' },
  'rocket-league': { label: 'Rocket League' },
  'fall-guys': { label: 'Fall Guys' },
  egs: { label: 'Epic Games Store' },
};

const PLATFORMS = {
  pc: { label: 'PC (Epic Games Launcher)', firstPartyEscalation: false },
  ps5: { label: 'PlayStation 5', firstPartyEscalation: true },
  xbox: { label: 'Xbox Series X|S', firstPartyEscalation: true },
  switch: { label: 'Nintendo Switch', firstPartyEscalation: true },
  mobile: { label: 'iOS / Android', firstPartyEscalation: false },
};

const TOPICS = {
  'item-shop-missing-purchase': { label: 'Item Shop purchase not received', category: 'commerce' },
  'vbucks-missing': { label: 'V-Bucks not received', category: 'commerce' },
  'refund-request': { label: 'Request a refund', category: 'commerce' },
  'account-access': { label: "Can't sign in to my account", category: 'account' },
  'matchmaking-error': { label: 'Matchmaking / connection error', category: 'gameplay' },
};

/**
 * Player Support queues and their contact-SLA policy. Every queue key that
 * TOPIC_ROUTING can return must have an entry here.
 */
const SUPPORT_QUEUES = {
  'fortnite-commerce': { label: 'Fortnite · Purchases & V-Bucks', team: 'Player Support — Commerce', slaHours: 24, priorityBoostHours: 0 },
  'fortnite-gameplay': { label: 'Fortnite · Gameplay & technical', team: 'Player Support — Technical', slaHours: 48, priorityBoostHours: 0 },
  'rocket-league-player-support': { label: 'Rocket League · Player Support', team: 'Psyonix Player Support', slaHours: 48, priorityBoostHours: 0 },
  'fall-guys-player-support': { label: 'Fall Guys · Player Support', team: 'Mediatonic Player Support', slaHours: 48, priorityBoostHours: 0 },
  'egs-commerce': { label: 'Epic Games Store · Purchases & refunds', team: 'Store Support — Commerce', slaHours: 24, priorityBoostHours: 0 },
  'epic-account-security': { label: 'Epic Account · Sign-in & security', team: 'Account Security', slaHours: 12, priorityBoostHours: 4 },
};

/*
 * Fortnitemares (v42.30) routing split: Item Shop missing-purchase reports for
 * Fortnite now go to a dedicated seasonal queue so the event's bundle traffic
 * stops flooding fortnite-commerce. The routing rule shipped with the event
 * drop; the queue's SLA policy was meant to follow in the queue-config sync.
 */
const TOPIC_ROUTING = {
  'fortnite:item-shop-missing-purchase': 'fortnite-fortnitemares-commerce',
  'fortnite:vbucks-missing': 'fortnite-commerce',
  'fortnite:refund-request': 'fortnite-commerce',
  'fortnite:matchmaking-error': 'fortnite-gameplay',
  'egs:item-shop-missing-purchase': 'egs-commerce',
  'egs:vbucks-missing': 'egs-commerce',
  'egs:refund-request': 'egs-commerce',
  'egs:matchmaking-error': 'egs-commerce',
  '*:account-access': 'epic-account-security',
};

const PRODUCT_DEFAULT_QUEUES = {
  fortnite: 'fortnite-commerce',
  'rocket-league': 'rocket-league-player-support',
  'fall-guys': 'fall-guys-player-support',
  egs: 'egs-commerce',
};

const REMEDIATION_DIRECTIVE = [
  '*Repository to investigate and fix:* `COG-GTM/event-driven-devin`',
  '',
  'The failing code path is the Epic Games Player Support contact form vertical:',
  '- Service: `app/services/verticals/50a88f70.js`',
  '- Route: `app/routes/verticals/50a88f70.js`',
  '- Page: `app/public/verticals/50a88f70.html` (served at `/50a88f70`)',
  '',
  'Open a pull request against `main` with the fix.',
].join('\n');

function validationError(message, code) {
  const error = new Error(message);
  error.name = 'ValidationError';
  error.code = code;
  error.statusCode = 400;
  return error;
}

function validateTicketRequest(data) {
  if (!PRODUCTS[data.product]) throw validationError('Choose a game or product.', 'INVALID_PRODUCT');
  if (!PLATFORMS[data.platform]) throw validationError('Choose a platform.', 'INVALID_PLATFORM');
  if (!TOPICS[data.topic]) throw validationError('Choose what you need help with.', 'INVALID_TOPIC');
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(data.email)) throw validationError('Enter a valid email address.', 'INVALID_EMAIL');
  if (data.description.length < 10) throw validationError('Tell us a little more about the issue.', 'DESCRIPTION_TOO_SHORT');
}

function resolveQueueKey(product, topic) {
  return TOPIC_ROUTING[`${product}:${topic}`]
    || TOPIC_ROUTING[`*:${topic}`]
    || PRODUCT_DEFAULT_QUEUES[product];
}

function resolveQueue(product, topic) {
  const queueKey = resolveQueueKey(product, topic);
  return { queueKey, queue: SUPPORT_QUEUES[queueKey] };
}

/**
 * Contact-SLA deadline for a new case. Console purchases may need a
 * first-party (PlayStation/Xbox/Nintendo) receipt check, which adds a day.
 */
function computeResponseDeadline(queue, platform, createdAt) {
  const firstPartyHours = PLATFORMS[platform].firstPartyEscalation ? 24 : 0;
  const hours = queue.slaHours - queue.priorityBoostHours + firstPartyHours;
  return {
    respondWithinHours: hours,
    respondBy: new Date(createdAt.getTime() + hours * 3600 * 1000).toISOString(),
  };
}

async function submitSupportTicket(data = {}) {
  const startTime = Date.now();
  const requestId = uuidv4();
  const normalized = {
    ...data,
    product: String(data.product ?? '').trim().toLowerCase(),
    platform: String(data.platform ?? '').trim().toLowerCase(),
    topic: String(data.topic ?? '').trim().toLowerCase(),
    email: String(data.email ?? '').trim(),
    displayName: String(data.displayName ?? '').trim(),
    description: String(data.description ?? '').trim(),
  };

  validateTicketRequest(normalized);

  logger.info('Routing Epic Games Player Support request', {
    requestId,
    product: normalized.product,
    platform: normalized.platform,
    topic: normalized.topic,
    service: SERVICE,
    route: ROUTE,
  });

  try {
    await new Promise((resolve) => setTimeout(resolve, 80 + Math.random() * 120));

    const createdAt = new Date();
    const { queueKey, queue } = resolveQueue(normalized.product, normalized.topic);
    const deadline = computeResponseDeadline(queue, normalized.platform, createdAt);
    const ticketId = `${TICKET_PREFIX}-${uuidv4().slice(0, 8).toUpperCase()}`;
    const duration = Date.now() - startTime;

    incrementMetric('player_support.ticket_created', {
      route: ROUTE,
      product: normalized.product,
      topic: normalized.topic,
      queue: queueKey,
    });
    recordTiming('player_support.ticket_latency', duration, { route: ROUTE });

    return {
      success: true,
      ticketId,
      product: PRODUCTS[normalized.product].label,
      platform: PLATFORMS[normalized.platform].label,
      topic: TOPICS[normalized.topic].label,
      queue: { key: queueKey, label: queue.label, team: queue.team },
      respondWithinHours: deadline.respondWithinHours,
      respondBy: deadline.respondBy,
      createdAt: createdAt.toISOString(),
      message: `A player support advocate will reply by email within ${deadline.respondWithinHours} hours.`,
    };
  } catch (error) {
    const duration = Date.now() - startTime;

    incrementMetric('player_support.ticket_failure', {
      route: ROUTE,
      errorClass: error.name,
      product: normalized.product,
      topic: normalized.topic,
    });
    recordTiming('player_support.ticket_latency', duration, { route: ROUTE, error: 'true' });

    logger.error('Player Support ticket routing failed', {
      requestId,
      error: error.message,
      errorClass: error.name,
      durationMs: duration,
      product: normalized.product,
      platform: normalized.platform,
      topic: normalized.topic,
      service: SERVICE,
    });

    Sentry.captureException(error, {
      tags: {
        route: ROUTE,
        service: SERVICE,
        product: normalized.product,
        topic: normalized.topic,
        platform: normalized.platform,
      },
      extra: {
        requestId,
        product: normalized.product,
        platform: normalized.platform,
        topic: normalized.topic,
      },
    });

    createSessionAndAlert({
      issueTitle: `${error.name}: ${error.message}`,
      issueUrl: `https://${process.env.SENTRY_ORG_SLUG || 'sentry-org'}.sentry.io/issues/?project=${process.env.SENTRY_PROJECT_ID || ''}&query=is%3Aunresolved`,
      culprit: 'app/services/verticals/50a88f70.js \u2014 computeResponseDeadline',
      errorType: error.name || 'Error',
      errorValue: error.message,
      devinUserId: normalized.devinUserId,
      devinEmail: normalized.devinEmail,
      devinOrgId: normalized.devinOrgId,
      service: SERVICE,
      verticalLabel: 'Epic Games Player Support',
      promptAppendix: REMEDIATION_DIRECTIVE,
      customer: '50a88f70',
      tags: [
        { key: 'route', value: ROUTE },
        { key: 'service', value: SERVICE },
        { key: 'product', value: normalized.product },
        { key: 'topic', value: normalized.topic },
        { key: 'platform', value: normalized.platform },
        { key: 'ticket_prefix', value: TICKET_PREFIX },
      ],
      extra: {
        requestId,
        product: normalized.product,
        platform: normalized.platform,
        topic: normalized.topic,
      },
      level: 'error',
      platform: 'node',
      firstSeen: '',
      lastSeen: new Date().toISOString(),
      count: '',
      shortId: '',
      project: 'event-driven-devin',
      release: process.env.SENTRY_RELEASE || `${SERVICE}@42.30.0`,
      environment: process.env.DD_ENV || 'prod',
      triggeredRule: '',
    }).catch((alertError) => {
      logger.error('Failed to create Devin session for Player Support routing error', {
        error: alertError.message,
        requestId,
      });
    });

    error.requestId = requestId;
    throw error;
  }
}

module.exports = {
  submitSupportTicket,
  resolveQueue,
  computeResponseDeadline,
  PRODUCTS,
  PLATFORMS,
  TOPICS,
  SUPPORT_QUEUES,
  TOPIC_ROUTING,
  REMEDIATION_DIRECTIVE,
};
