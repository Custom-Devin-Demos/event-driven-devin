const crypto = require('crypto');
const Sentry = require('@sentry/node');
const { createSessionAndAlert } = require('../devin-session');
const { runWithAlertDestination } = require('../alert-destination');
const logger = require('../../telemetry/logger');

const CUSTOMER = '9dc8b009';
const SERVICE = 'customer-9dc8b009-online-orders';
const ROUTE = 'POST /api/9dc8b009/orders';
const CULPRIT = 'app/services/verticals/9dc8b009.js — environmentalScore';
const ERROR_CODE = 'RNO-ORD-5031';
const VERTICAL_LABEL = 'Renault — Order Twingo E-Tech électrique online';
const ALERT_COOLDOWN_MS = Number(process.env.RENAULT_ALERT_COOLDOWN_MS || 60000);

// Electric range on sale online. Prices are TTC (incl. 20% VAT), before purchase incentives.
const MODELS = [
  { id: 'twingo-etech', name: 'Twingo E-Tech électrique', version: 'techno', basePrice: 19990, battery: { kWh: 27.5, chemistry: 'LFP cell-to-pack' }, rangeKm: 263, dcKw: 50, plant: 'Novo Mesto (SI)', platform: 'AmpR Small', isNew: true, delivery: 'Mars 2027' },
  { id: 'r5-etech', name: 'Renault 5 E-Tech électrique', version: 'techno autonomie confort', basePrice: 32990, battery: { kWh: 52, chemistry: 'NMC' }, rangeKm: 410, dcKw: 100, plant: 'Douai (FR)', platform: 'AmpR Small', delivery: 'Janvier 2027' },
  { id: 'r4-etech', name: 'Renault 4 E-Tech électrique', version: 'techno autonomie confort', basePrice: 35490, battery: { kWh: 52, chemistry: 'NMC' }, rangeKm: 409, dcKw: 100, plant: 'Maubeuge (FR)', platform: 'AmpR Small', delivery: 'Février 2027' },
  { id: 'scenic-etech', name: 'Scenic E-Tech électrique', version: 'esprit Alpine grande autonomie', basePrice: 49990, battery: { kWh: 87, chemistry: 'NMC' }, rangeKm: 625, dcKw: 150, plant: 'Douai (FR)', platform: 'AmpR Medium', delivery: 'Janvier 2027' },
];

const PAINTS = [
  { id: 'blanc-glacier', label: 'Blanc Glacier', price: 0 },
  { id: 'jaune-pop', label: 'Jaune Pop', price: 800 },
  { id: 'vert-pistache', label: 'Vert Pistache', price: 800 },
  { id: 'noir-etoile', label: 'Noir Étoilé', price: 800 },
];
const WALLBOX = { id: 'mobilize-powerbox', label: 'Mobilize Powerbox 7,4 kW, pose incluse', price: 1190 };
const DEPOSIT = 250;

// Environmental scores published by ADEME (list of 2026-10-15). An order qualifies for the incentive at 60/100 or more.
const ADEME_SCORES = {
  'r5-etech': { score: 74, publishedAt: '2026-10-15' },
  'r4-etech': { score: 72, publishedAt: '2026-10-15' },
  'scenic-etech': { score: 66, publishedAt: '2026-10-15' },
};

// Manufacturer filings for models awaiting the next ADEME list; valid for orders until publication.
const PROVISIONAL_SCORES = {
  'twingo-etech': { score: 76, filedAt: '2026-10-28', dossier: 'ADEME-2026-REN-0193' },
};

const MIN_ENVIRONMENTAL_SCORE = 60;
// CEE "coup de pouce véhicules particuliers électriques" by household (fixture amounts).
const INCENTIVES = { standard: 3100, modeste: 4200 };

const REMEDIATION_DIRECTIVE = [
  'Repository: COG-GTM/event-driven-devin. Open a ready-for-review (not draft) pull request against main with a conventional title (e.g. "fix(online-orders): ..."); never merge or deploy.',
  'FIRST, before reading any code: reply in the alert\'s Slack thread (channel and thread_ts are at the end of this prompt; curl chat.postMessage with $SLACK_BOT_TOKEN) with your Devin session link only, e.g. ":robot_face: Investigating — <your session URL>".',
  'Treat this alert as a new incident even if the same error alerted before: do not look for, wait on, reuse or link earlier alerts, threads, sessions, branches or PRs.',
  'Customer impact: Renault online ordering (/renault#configurateur) returns HTTP 500 ' + ERROR_CODE + ' when a customer orders the new Twingo E-Tech électrique, the launch model. Renault 5, Renault 4 and Scenic orders go through.',
  'Reproduce: open /renault?reports=off#configurateur, keep the pre-selected Twingo E-Tech électrique, press "continuer" twice and press "commander et payer l\'acompte". Pick Renault 5 E-Tech électrique and the same order succeeds.',
  'Inspect app/services/verticals/9dc8b009.js (environmentalScore, ADEME_SCORES, PROVISIONAL_SCORES, priceOrder, placeOrder), app/routes/verticals/9dc8b009.js and app/public/verticals/9dc8b009-assets/order.js. Find and state the root cause before changing code.',
  'Business rule: a model that is not yet on the published ADEME list is scored with its manufacturer filing in PROVISIONAL_SCORES, and the order records which source it used (ADEME or PROVISIONAL) and the dossier number. A model with neither score is ordered without the incentive (incentive 0, not eligible), never a 500.',
  'Keep every model, paint, the wallbox option, the 60/100 eligibility threshold, the incentive amounts, the €250 deposit, error reporting and the server-generated order reference intact.',
  'Add regression coverage in tests/9dc8b009-renault-online-order.test.js and update the existing failure expectation after the fix. Run npx jest tests/9dc8b009-renault-online-order.test.js and npm run lint.',
  'Do not disable Sentry/alerts, swallow the error, remove the Twingo from the range, or fake a successful response in the browser.',
  'QA before the PR: once the fix passes tests on your branch, start three child Devin sessions in parallel (one each: desktop browser at 1440x900, iPhone-size viewport 390x844 with touch emulation, Android-size viewport 412x915 with touch emulation). Each child runs the app locally from your branch in its own environment with alerts suppressed (?reports=off), first reproduces the HTTP 500 on main with the Twingo order, then verifies on your branch that the Twingo order is confirmed with the provisional score and the incentive applied and that a Renault 5 order still works, and returns a pass/fail verdict with a screen recording and screenshots. Wait for all three; if any fails, fix it and re-run all three children on the new commit. Open the PR only after all three pass on the same final commit, and put that commit SHA, the three verdicts and recordings in the PR description.',
  'After opening the PR, request Devin Review on it and wait for the Devin Review checks to finish; fix every actionable finding on the same branch and reply to each review comment. If those fixes change the code, re-run all three QA children on the new final commit and update the SHA, verdicts and recordings in the PR description. Then post a short root-cause + PR + Devin Review summary to the Slack thread and stop for human approval.',
].join('\n');

const MAX_STORED_ORDERS = 500;
const orders = new Map();
let lastAlertAt = 0;
const invalid = (message, field) => Object.assign(new Error(message), { name: 'ValidationError', status: 400, code: 'INVALID_ORDER', field });

function getCatalog() {
  return {
    models: MODELS.map(m => ({ ...m, battery: { ...m.battery } })),
    paints: PAINTS.map(p => ({ ...p })),
    wallbox: { ...WALLBOX },
    deposit: DEPOSIT,
    households: Object.keys(INCENTIVES),
  };
}

function validateOrder(input = {}) {
  const model = MODELS.find(m => m.id === input.modelId);
  if (!model) throw invalid('Choisissez un modèle.', 'modelId');
  const paint = PAINTS.find(p => p.id === (input.paintId || PAINTS[0].id));
  if (!paint) throw invalid('Choisissez une teinte.', 'paintId');
  const household = input.household || 'standard';
  if (!Object.prototype.hasOwnProperty.call(INCENTIVES, household)) throw invalid('Choisissez votre situation.', 'household');
  return { model, paint, wallbox: input.wallbox === true, household };
}

// Environmental score used for incentive eligibility.
function environmentalScore(model) {
  const score = ADEME_SCORES[model.id].score;
  return { score, source: 'ADEME', reference: `ADEME ${ADEME_SCORES[model.id].publishedAt}` };
}

function priceOrder({ model, paint, wallbox, household }) {
  const env = environmentalScore(model);
  const eligible = env.score >= MIN_ENVIRONMENTAL_SCORE;
  const incentive = eligible ? INCENTIVES[household] : 0;
  const vehiclePrice = model.basePrice + paint.price;
  const options = wallbox ? WALLBOX.price : 0;
  return {
    vehiclePrice, options, incentive, total: vehiclePrice + options - incentive, deposit: DEPOSIT,
    environmentalScore: env.score, scoreSource: env.source, scoreReference: env.reference, incentiveEligible: eligible,
  };
}

function remember(id, order) {
  orders.set(id, order);
  if (orders.size > MAX_STORED_ORDERS) orders.delete(orders.keys().next().value);
}

function reportFailure(error, context, data) {
  const tags = { route: ROUTE, service: SERVICE, customer: CUSTOMER, error_code: ERROR_CODE, alert_path: 'instant' };
  logger.error('Online order pricing failed', { ...context, service: SERVICE, error: error.message });
  if (data.suppressAlerts) return;
  Sentry.captureException(error, { tags, extra: context });
  const now = Date.now();
  if (now - lastAlertAt < ALERT_COOLDOWN_MS) {
    logger.info('Online order alert skipped (cooldown)', { service: SERVICE, orderId: context.orderId });
    return;
  }
  lastAlertAt = now;
  logger.info('Posting alert and triggering Devin', { service: SERVICE, orderId: context.orderId });
  // Renault alerts always go to #oncall-alerts, whatever destination the hub cookie picked.
  runWithAlertDestination('slack', () => createSessionAndAlert({
    issueTitle: `${error.name}: ${error.message}`,
    issueUrl: `https://${process.env.SENTRY_ORG_SLUG || 'sentry-org'}.sentry.io/issues/?project=${process.env.SENTRY_PROJECT_ID || ''}&query=is%3Aunresolved`,
    culprit: CULPRIT, errorType: error.name, errorValue: error.message,
    customer: CUSTOMER, service: SERVICE, verticalLabel: VERTICAL_LABEL,
    level: 'error', platform: 'node', release: 'online-orders@2026.11.3', environment: process.env.DD_ENV || 'prod',
    skipVulnerablePr: true,
    promptAppendix: `Incident Ref: ${context.orderId}\n${REMEDIATION_DIRECTIVE}`,
    tags: Object.entries(tags).map(([key, value]) => ({ key, value })), extra: context,
  })).then((result) => {
    if (!result && lastAlertAt === now) lastAlertAt = 0;
  }).catch((err) => {
    if (lastAlertAt === now) lastAlertAt = 0;
    logger.error('Failed to create Devin session for online order failure', { error: err.message, orderId: context.orderId });
  });
}

async function placeOrder(data = {}, now = new Date()) {
  const selection = validateOrder(data);
  const { model, paint, wallbox, household } = selection;
  let orderId;
  do orderId = `RNO-${now.getUTCFullYear()}-${String(crypto.randomInt(0, 1e7)).padStart(7, '0')}`; while (orders.has(orderId));
  try {
    const price = priceOrder(selection);
    const order = {
      success: true, orderId, status: 'CONFIRMED', modelId: model.id, model: model.name, version: model.version,
      paint: paint.label, wallbox, household, ...price, plant: model.plant, estimatedDelivery: model.delivery,
    };
    remember(orderId, order);
    logger.info('Online order confirmed', { service: SERVICE, orderId, modelId: model.id, total: price.total, scoreSource: price.scoreSource });
    return order;
  } catch (error) {
    const context = {
      orderId, modelId: model.id, version: model.version, paintId: paint.id, wallbox, household,
      plant: model.plant, errorCode: ERROR_CODE,
    };
    reportFailure(error, context, data);
    throw Object.assign(error, { status: 500, code: ERROR_CODE, reference: orderId });
  }
}

function getOrder(orderId) {
  const order = typeof orderId === 'string' ? orders.get(orderId) : undefined;
  if (!order) throw Object.assign(new Error('Commande introuvable.'), { name: 'NotFoundError', status: 404, code: 'ORDER_NOT_FOUND' });
  return order;
}

function resetAlertCooldown() { lastAlertAt = 0; }

module.exports = {
  CUSTOMER, SERVICE, ROUTE, CULPRIT, ERROR_CODE, MODELS, PAINTS, WALLBOX, DEPOSIT, ADEME_SCORES, PROVISIONAL_SCORES,
  MIN_ENVIRONMENTAL_SCORE, INCENTIVES, REMEDIATION_DIRECTIVE, getCatalog, validateOrder, environmentalScore, priceOrder,
  placeOrder, getOrder, resetAlertCooldown,
};
