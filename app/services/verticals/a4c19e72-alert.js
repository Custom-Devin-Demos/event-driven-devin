const REPO = 'https://github.com/COG-GTM/event-driven-devin';
const BASE_BRANCH = 'devin/lowes-cart-b5f26e97';
const SESSION_URL = 'https://devin-gtm.devinenterprise.com/sessions/b5f26e97a86b49a59c23f5023ffc618e';
const SCENARIO = {
  vertical: 'a4c19e72', page: 'a4c19e72.html', unlisted: true, alertOnStatus: [500],
  nativeAlertTrigger: true, defaultAlertDestination: 'teams',
  apiPath: '/api/a4c19e72/checkout', oncallApiPath: '/api/a4c19e72/checkout',
  demoPage: '/lowes',
  brand: 'Lowe’s demo', service: 'customer-a4c19e72-checkout', owner: 'Demo cart platform on-call',
  endpoint: 'POST /api/a4c19e72/checkout', monitor: '[DEMO] Bulky-item pickup checkout failure',
  metricQuery: 'Synthetic cart reproduction; not a live monitoring query',
  metricValue: 'Reproducible failing scenario', threshold: 'Expected HTTP 200', baseline: 'Delivery and parcel pickup succeed',
  release: 'cart-fulfillment-demo', symptom: 'Switching a refrigerator from delivery to pickup prevents checkout.',
  impact: 'Synthetic cart cannot continue. No customer orders or payments exist.',
};

const RESPONDER_NOTES = [
  'Synthetic demo alert, not a real customer incident. Investigate only in Eashan Dev, with the Teams responder configured to run as Eashan. Card text does not configure session identity.',
  `Repository: ${REPO}; scenario branch: ${BASE_BRANCH}. Open a repair PR targeting that branch, not main. Never merge or deploy.`,
  'Reproduce locally at /lowes: keep the refrigerator and DEWALT kit, verify delivery succeeds, then select Pickup and Continue to checkout. Central Charlotte is the suggested reproduction store, not an observed store on this alert; both demo stores are supported.',
  'Trace quoteCart’s fulfillment-policy lookup. Run scripts/a4c19e72-regression.js before and after the fix. Add focused tests and record desktop plus mobile browser recovery.',
  'No real orders, login, payments, Slack, shared customer/on-call posts or native iOS work. Respond in this approved demo Teams thread with root cause, repair PR and verification.',
  `Preparation evidence: ${SESSION_URL}. This existing preparation session is not the session created by this alert. A live Teams responder owns alert-created investigation; local dry-run creates none.`,
].join('\n');

module.exports = { SCENARIO, RESPONDER_NOTES, SESSION_URL, REPO, BASE_BRANCH };
