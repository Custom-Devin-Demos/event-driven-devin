const { buildTeamsAlertCardForAlert, createSessionAndAlert } = require('../devin-session');
const { currentAlertDestination } = require('../alert-destination');
const { isTeamsWebhookUrl, teamsCardText } = require('../teams');
const { Sentry } = require('../../telemetry/sentry');
const { teamsWebhookEnv } = require('../../../config/customers/a4c19e72');

const REPO = 'https://github.com/COG-GTM/event-driven-devin';
const BASE_BRANCH = 'devin/lowes-cart-b5f26e97';
const SESSION_URL = 'https://devin-gtm.devinenterprise.com/sessions/b5f26e97a86b49a59c23f5023ffc618e';

function sentryIssueUrl(query = 'service:customer-a4c19e72-checkout route:/api/a4c19e72/checkout') {
  return `https://${process.env.SENTRY_ORG_SLUG || 'devin-gtm'}.sentry.io/issues/?project=${encodeURIComponent(process.env.SENTRY_PROJECT_ID || '')}&query=${encodeURIComponent(query)}`;
}

function buildAlertData(error, input = {}) {
  return {
    customer: 'a4c19e72', verticalLabel: 'Lowe’s Checkout',
    service: 'customer-a4c19e72-checkout', issueTitle: `${error.name}: ${error.message}`,
    issueUrl: sentryIssueUrl(),
    culprit: 'app/services/verticals/a4c19e72.js — quoteCart',
    errorType: error.name, errorValue: error.message,
    level: 'error', platform: 'node', project: 'event-driven-devin',
    release: process.env.SENTRY_RELEASE || `acme-checkout@${process.env.APP_VERSION || '1.0.0'}`,
    environment: process.env.SENTRY_ENVIRONMENT || process.env.DD_ENV || 'prod',
    lastSeen: new Date().toISOString(),
    tags: [
      { key: 'route', value: '/api/a4c19e72/checkout' },
      { key: 'service', value: 'customer-a4c19e72-checkout' },
      { key: 'scenario', value: 'lowes-cart-demo' },
      { key: 'alert_path', value: 'instant' },
    ],
    extra: { store: input.store, fulfillment: input.fulfillment },
    skipVulnerablePr: true,
    devinUserId: input.devinUserId, devinOrgId: input.devinOrgId, devinEmail: input.devinEmail,
  };
}

function rehearsalReason() {
  if (process.env.NODE_ENV !== 'production') return 'local-or-test-runtime';
  if (process.env.CI) return 'ci-runtime';
  if (process.env.LOWES_DEMO_DRY_RUN === 'true') return 'explicit-dry-run';
  if (!isTeamsWebhookUrl(process.env[teamsWebhookEnv])) return 'missing-teams-target';
  return null;
}

let nextAlertAt = 0;
const ALERT_COOLDOWN_MS = 60_000;

async function reportCheckoutError(error, input) {
  const alertData = buildAlertData(error, input);
  const card = buildTeamsAlertCardForAlert(alertData);
  const reason = rehearsalReason();
  if (reason) {
    return {
      ok: true, dryRun: true, sent: false, destination: 'teams', reason, card,
      payload: { type: 'message', text: teamsCardText(card), attachments: [{ contentType: 'application/vnd.microsoft.card.adaptive', contentUrl: null, content: card }] },
    };
  }
  if (currentAlertDestination() !== 'teams') {
    return { ok: false, dryRun: false, sent: false, error: 'Select Teams on the demo hub first. No Slack alert was sent.' };
  }
  const now = Date.now();
  if (now < nextAlertAt) {
    return { ok: false, dryRun: false, sent: false, throttled: true, retryAfterMs: nextAlertAt - now, error: 'A demo alert was attempted recently. Wait one minute before retrying; no additional alert was sent.' };
  }
  nextAlertAt = now + ALERT_COOLDOWN_MS;
  const eventId = Sentry.captureException(error, {
    tags: Object.fromEntries(alertData.tags.map(({ key, value }) => [key, value])),
    extra: alertData.extra,
  });
  if (eventId) alertData.issueUrl = sentryIssueUrl(eventId);
  const result = await createSessionAndAlert(alertData);
  const sent = Boolean(result && result.teams);
  return { ok: sent, dryRun: false, sent, responderManaged: sent, ...(sent ? {} : { error: 'Teams delivery was not confirmed. No Slack fallback was used.' }) };
}

module.exports = { rehearsalReason, reportCheckoutError, buildAlertData, SESSION_URL, REPO, BASE_BRANCH };
