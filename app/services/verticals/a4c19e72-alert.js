const { createHash, timingSafeEqual } = require('crypto');
const { buildTeamsAlertCard, teamsCardText, isTeamsWebhookUrl, postTeamsCard } = require('../teams');

const REPO = 'https://github.com/COG-GTM/event-driven-devin';
const BASE_BRANCH = 'devin/lowes-cart-b5f26e97';
const SESSION_URL = 'https://devin-gtm.devinenterprise.com/sessions/b5f26e97a86b49a59c23f5023ffc618e';
const SCENARIO = {
  vertical: 'a4c19e72', page: 'a4c19e72.html', unlisted: true, alertOnStatus: [500],
  apiPath: '/api/a4c19e72/checkout', oncallApiPath: '/api/a4c19e72/checkout',
  brand: 'Lowe’s demo', service: 'customer-a4c19e72-checkout', owner: 'Demo cart platform on-call',
  endpoint: 'POST /api/a4c19e72/checkout', monitor: 'Bulky-item pickup checkout failure',
  metricQuery: 'Synthetic cart reproduction; not a live monitoring query',
  metricValue: 'One reproducible failing scenario', threshold: 'Expected HTTP 200', baseline: 'Delivery and parcel pickup succeed',
  release: 'cart-fulfillment-demo', symptom: 'Switching a refrigerator from delivery to pickup prevents checkout.',
  impact: 'Synthetic cart cannot continue. No customer orders or payments exist.',
};

function previewAlert() {
  const card = buildTeamsAlertCard({
    title: '[DEMO] Cart checkout failed after switching to pickup',
    facts: [['Service', SCENARIO.service], ['Store', 'Central Charlotte'], ['Endpoint', SCENARIO.endpoint], ['Release', SCENARIO.release]],
    body: [
      'Synthetic incident specimen. Default is dry-run: no Teams message, page, or new Devin session is sent.',
      'Reproduce: open /lowes, keep the refrigerator, select Pickup, then Continue to checkout. Delivery and parcel-only pickup are healthy controls.',
      `Investigate ${REPO} on branch ${BASE_BRANCH}. Trace the fulfillment policy lookup for bulky pickup. Add a focused regression test and fix PR targeting that scenario branch, not main. Never merge or deploy.`,
      'Use Eashan Dev only. Run locally with outbound integrations disabled. Record desktop and responsive-browser recovery. No Slack, real customer/on-call posts, orders, login, payment data, or native iOS work.',
      'An approved Teams channel responder would investigate after actual delivery. The rehearsal uses an existing preparation session and prebuilt repair PR; it is not an alert-created session.',
    ],
    actions: [{ title: 'Scenario source', url: `${REPO}/tree/${BASE_BRANCH}` }, { title: 'Preparation session (existing)', url: SESSION_URL }],
    footer: `${SCENARIO.service} | ${SCENARIO.endpoint} | Synthetic demo only`,
  });
  return { ok: true, dryRun: true, sent: false, destination: 'teams', card, payload: { type: 'message', text: teamsCardText(card), attachments: [{ contentType: 'application/vnd.microsoft.card.adaptive', contentUrl: null, content: card }] } };
}

let lastSent = 0;
let sending = false;
async function sendApprovedDemo({ token, approval } = {}) {
  const url = process.env.LOWES_DEMO_TEAMS_WEBHOOK_URL;
  const expected = process.env.LOWES_DEMO_SEND_TOKEN || '';
  const channel = process.env.LOWES_DEMO_APPROVED_CHANNEL || '';
  const digest = process.env.LOWES_DEMO_APPROVED_WEBHOOK_SHA256;
  const authorized = process.env.LOWES_DEMO_TEAMS_ENABLED === 'true'
    && expected.length >= 32 && typeof token === 'string' && Buffer.byteLength(token) === Buffer.byteLength(expected)
    && timingSafeEqual(Buffer.from(token), Buffer.from(expected)) && channel && approval === channel
    && isTeamsWebhookUrl(url) && createHash('sha256').update(url).digest('hex') === digest;
  if (!authorized) throw Object.assign(new Error('Live delivery is disabled or explicit demo-channel approval is missing.'), { status: 403 });
  if (sending || Date.now() - lastSent < 60000) throw Object.assign(new Error('Demo delivery is limited to one attempt per minute.'), { status: 429 });
  sending = true;
  lastSent = Date.now();
  try {
    const { card } = previewAlert();
    const status = await postTeamsCard(url, card);
    return { ok: true, sent: true, dryRun: false, webhookAccepted: true, channel, status, note: 'Webhook accepted. Channel rendering and responder execution must be verified in Teams.' };
  } finally { sending = false; }
}

module.exports = { SCENARIO, previewAlert, sendApprovedDemo, SESSION_URL, REPO, BASE_BRANCH };
