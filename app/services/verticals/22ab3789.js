/**
 * Customer 22ab3789 — homepage "Contact" request intake.
 *
 * The header Contact CTA files a sales contact request: works out the
 * visitor's market from the page locale, routes the request to the owning
 * sales territory and intake queue, and returns the reference and callback
 * window the page confirms back to the visitor.
 */
const { v4: uuidv4 } = require('uuid');
const logger = require('../../telemetry/logger');
const { incrementMetric, recordTiming } = require('../../telemetry/datadog');
const { Sentry } = require('../../telemetry/sentry');
const { createSessionAndAlert } = require('../devin-session');
const territories = require('./22ab3789-territories');

const CUSTOMER = '22ab3789';
const SERVICE = 'customer-22ab3789-contact';
const ROUTE = '/api/22ab3789/contact-requests';
const RELEASE = 'web-contact-intake@3.8.1';
const ALERT_COOLDOWN_MS = Number(process.env.ALERT_COOLDOWN_MS_22AB3789) || 60 * 1000;

const DEFAULT_LOCALE = 'en-us';
const LOCALE_PATTERN = /^[a-z]{2}-[a-z]{2}$/i;
const TOPICS = ['general', 'networking', 'security', 'support'];
const SOURCES = ['header', 'footer', 'support-card'];
const MINUTE_MS = 60 * 1000;

let lastAlertAt = 0;

function badRequest(message, code) {
  const error = new Error(message);
  error.name = 'ValidationError';
  error.statusCode = 400;
  error.code = code;
  return error;
}

function marketFromLocale(locale) {
  const [, region] = locale.split('-');
  return region.toUpperCase();
}

function normalizeRequest(data) {
  const locale = data.locale === undefined || data.locale === null ? DEFAULT_LOCALE : data.locale;
  if (typeof locale !== 'string' || !LOCALE_PATTERN.test(locale)) {
    throw badRequest('locale must look like en-us', 'INVALID_LOCALE');
  }
  const topic = data.topic === undefined || data.topic === null ? 'general' : data.topic;
  if (!TOPICS.includes(topic)) {
    throw badRequest(`topic must be one of ${TOPICS.join(', ')}`, 'INVALID_TOPIC');
  }
  const market = marketFromLocale(locale);
  if (!territories.isServedMarket(market)) {
    throw badRequest(`No sales territory covers ${market}`, 'MARKET_NOT_SERVED');
  }
  const source = SOURCES.includes(data.source) ? data.source : 'header';
  return { locale: locale.toLowerCase(), market, topic, source };
}

function routeRequest(request, now = new Date()) {
  const territory = territories.territoryFor(request.market);
  const queue = territories.queueFor(territory, request.topic);
  return {
    reference: `LMN-${uuidv4().slice(0, 8).toUpperCase()}`,
    market: request.market,
    territory: { id: territory.id, name: territory.name, timezone: territory.timezone },
    queue: { id: queue.id, name: queue.name },
    callbackBy: new Date(now.getTime() + queue.responseMinutes * MINUTE_MS).toISOString(),
  };
}

function sentryIssueUrl() {
  const org = process.env.SENTRY_ORG_SLUG || 'sentry-org';
  const project = process.env.SENTRY_PROJECT_ID || '';
  return `https://${org}.sentry.io/issues/?project=${project}&query=is%3Aunresolved`;
}

function raiseAlert(error, requestId, data) {
  const now = Date.now();
  if (now - lastAlertAt < ALERT_COOLDOWN_MS) {
    logger.warn('Contact request alert suppressed by cooldown', { requestId, cooldownMs: ALERT_COOLDOWN_MS });
    return;
  }
  lastAlertAt = now;

  createSessionAndAlert({
    issueTitle: `${error.name}: ${error.message}`,
    issueUrl: sentryIssueUrl(),
    culprit: 'app/services/verticals/22ab3789.js in routeRequest',
    errorType: error.name || 'Error',
    errorValue: error.message,
    devinUserId: data.devinUserId,
    devinOrgId: data.devinOrgId,
    devinEmail: data.devinEmail,
    service: SERVICE,
    verticalLabel: 'Enterprise Contact Request',
    customer: CUSTOMER,
    tags: [
      { key: 'route', value: ROUTE },
      { key: 'service', value: SERVICE },
      { key: 'topic', value: data.topic },
      { key: 'market', value: data.market },
    ],
    extra: { requestId, locale: data.locale, topic: data.topic, source: data.source },
    level: 'error',
    platform: 'node',
    firstSeen: '',
    lastSeen: new Date().toISOString(),
    count: '',
    shortId: '',
    project: 'event-driven-devin',
    release: RELEASE,
    environment: process.env.DD_ENV || 'prod',
    triggeredRule: '',
  }).then((result) => {
    if (!result && lastAlertAt === now) lastAlertAt = 0;
  }).catch((alertError) => {
    if (lastAlertAt === now) lastAlertAt = 0;
    logger.error('Failed to raise alert for contact request failure', { error: alertError.message, requestId });
  });
}

async function submitContactRequest(data = {}) {
  const requestId = uuidv4();
  const started = Date.now();
  const request = normalizeRequest(data);

  logger.info('Contact request received', { requestId, customer: CUSTOMER, ...request });
  incrementMetric('contact.request.attempt', [`customer:${CUSTOMER}`, `topic:${request.topic}`]);

  try {
    const routing = routeRequest(request);
    recordTiming('contact.request.duration', Date.now() - started, [`customer:${CUSTOMER}`]);
    incrementMetric('contact.request.success', [`customer:${CUSTOMER}`, `territory:${routing.territory.id}`]);
    logger.info('Contact request routed', { requestId, reference: routing.reference, queue: routing.queue.id });
    return { success: true, requestId, request: routing };
  } catch (error) {
    recordTiming('contact.request.duration', Date.now() - started, [`customer:${CUSTOMER}`, 'outcome:error']);
    incrementMetric('contact.request.error', [`customer:${CUSTOMER}`, `error:${error.name}`]);
    logger.error('Contact request failed', {
      requestId,
      error: error.message,
      errorType: error.name,
      stack: error.stack,
      customer: CUSTOMER,
    });

    Sentry.captureException(error, {
      tags: { route: ROUTE, service: SERVICE, customer: CUSTOMER, alert_path: 'instant' },
      extra: { requestId, ...request },
    });

    raiseAlert(error, requestId, { ...data, ...request });

    error.requestId = requestId;
    throw error;
  }
}

module.exports = { submitContactRequest };
