const { buildTeamsAlertCardForAlert, createSessionAndAlert } = require('../devin-session');
const { currentAlertDestination } = require('../alert-destination');
const { isTeamsWebhookUrl, teamsCardText } = require('../teams');

const REPO = 'https://github.com/COG-GTM/event-driven-devin';
const BASE_BRANCH = 'devin/lowes-cart-b5f26e97';
const SESSION_URL = 'https://devin-gtm.devinenterprise.com/sessions/b5f26e97a86b49a59c23f5023ffc618e';
const RESPONDER_NOTES = [
  'Synthetic demo alert, not a real customer incident. Use the existing Teams responder; do not create or change an automation.',
  `Repository: ${REPO}; scenario branch: ${BASE_BRANCH}. Open a focused repair PR targeting that branch only, not main. Never merge or deploy.`,
  'Reproduce locally at /lowes with integrations disabled: refrigerator plus DEWALT kit, delivery succeeds, switch to Pickup and Continue to checkout. Check both supported demo stores and parcel-only pickup.',
  'Trace quoteCart’s fulfillment-policy lookup. Run scripts/a4c19e72-regression.js before and after the fix, add focused tests, and record desktop plus mobile browser recovery.',
  'Expected session context: Eashan Dev as Eashan. Confirm actual session ownership before working; card text cannot change the existing responder identity. If different, report the mismatch and stop rather than create another session or change responders.',
  'No real orders, login, payments, Slack, other channels or native iOS work. Reply in the originating Teams thread with root cause, repair PR and verification.',
  `Preparation evidence: ${SESSION_URL}. This preparation session is not the investigation created by this alert.`,
].join('\n');

function buildAlertData(error, input = {}) {
  return {
    customer: 'a4c19e72', verticalLabel: 'Lowe’s demo checkout',
    service: 'customer-a4c19e72-checkout', issueTitle: `${error.name}: ${error.message}`,
    culprit: 'app/services/verticals/a4c19e72.js — quoteCart',
    errorType: error.name, errorValue: error.message,
    level: 'error', platform: 'node', project: 'event-driven-devin',
    release: 'cart-fulfillment-demo', environment: 'synthetic-demo',
    lastSeen: new Date().toISOString(),
    promptAppendix: `${RESPONDER_NOTES}\nObserved checkout: store=${input.store || 'Central Charlotte'}, fulfillment=${input.fulfillment || 'delivery'}.`,
    skipVulnerablePr: true,
    devinUserId: input.devinUserId, devinOrgId: input.devinOrgId, devinEmail: input.devinEmail,
  };
}

async function reportCheckoutError(error, input) {
  const alertData = buildAlertData(error, input);
  const card = buildTeamsAlertCardForAlert(alertData);
  if (process.env.LOWES_DEMO_LIVE_TEAMS !== 'true') {
    return {
      ok: true, dryRun: true, sent: false, destination: 'teams', card,
      payload: { type: 'message', text: teamsCardText(card), attachments: [{ contentType: 'application/vnd.microsoft.card.adaptive', contentUrl: null, content: card }] },
    };
  }
  if (currentAlertDestination() !== 'teams') {
    return { ok: false, dryRun: false, sent: false, error: 'Select Teams on the demo hub first. No Slack alert was sent.' };
  }
  if (!isTeamsWebhookUrl(process.env.AUTOMATIONS_TEAMS_WEBHOOK_URL)) {
    return { ok: false, dryRun: false, sent: false, error: 'The existing Teams Workflow is not configured. No Slack fallback was used.' };
  }
  const result = await createSessionAndAlert(alertData);
  const sent = Boolean(result && result.teams);
  return { ok: sent, dryRun: false, sent, responderManaged: sent, ...(sent ? {} : { error: 'Teams delivery was not confirmed. No Slack fallback was used.' }) };
}

module.exports = { reportCheckoutError, buildAlertData, RESPONDER_NOTES, SESSION_URL, REPO, BASE_BRANCH };
