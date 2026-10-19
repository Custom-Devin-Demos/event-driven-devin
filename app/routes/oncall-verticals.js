const express = require('express');
const { processTransfer } = require('../services/oncall-verticals/banking');
const { upgradePlan } = require('../services/oncall-verticals/telco');
const { provisionLicense } = require('../services/oncall-verticals/hightech');
const { processClaim } = require('../services/oncall-verticals/insurance');
const { finalizeTranscript } = require('../services/oncall-verticals/voice');
const { runCompletion } = require('../services/oncall-verticals/inference');
const { processQuote } = require('../services/oncall-verticals/industrials');
const { addToCart } = require('../services/oncall-verticals/marketplace');
const { submitOrder } = require('../services/oncall-verticals/vaccines');
const { submitClaim } = require('../services/oncall-verticals/pbm');
const { submitPriorAuth } = require('../services/oncall-verticals/priorauth');
const { submitSampleOrder, PRESCRIBERS, PRODUCTS } = require('../services/oncall-verticals/samples');
const { addToBag } = require('../services/oncall-verticals/apparel');
const { checkoutOrder: checkoutSportingGoodsOrder } = require('../services/oncall-verticals/sportinggoods');
const { checkoutOrder: checkoutClickCollectOrder } = require('../services/oncall-verticals/clickcollect');
const { checkoutOrder: checkoutStorePickupOrder } = require('../services/oncall-verticals/storepickup');
const { rebookFlight } = require('../services/oncall-verticals/rebooking');
const { submitCardPayment } = require('../services/oncall-verticals/cardpayment');
const { createSessionAndAlert } = require('../services/devin-session');
const { getOncallSkin } = require('../../config/oncall-skins');
const { runWithAlertDestination } = require('../services/alert-destination');
const logger = require('../telemetry/logger');
const { createEnvironment, createApplication } = require('../services/oncall-verticals/identity');
const { getAvailability, confirmBooking } = require('../services/oncall-verticals/examscheduling');
const { checkoutOrder, defaultPickupSlot: defaultGroceryPickupSlot, CART_ITEMS: GROCERY_CART_ITEMS } = require('../services/oncall-verticals/grocery');

const router = express.Router();

/**
 * POST /api/oncall/banking/transfer — process a fund transfer
 */
router.post('/api/oncall/banking/transfer', async (req, res) => {
  try {
    const result = await processTransfer({
      fromAccount: req.body.fromAccount || 'ACCT-1001',
      toAccount: req.body.toAccount || 'ACCT-1002',
      amount: req.body.amount || 500,
      accountTier: req.body.accountTier || 'standard',
      userId: req.body.userId || 'usr_banking_1',
    }, { debugTimings: req.get('x-debug-timings') === '1' });
    res.json(result);
  } catch (error) {
    const statusCode = error.code === 'INSUFFICIENT_FUNDS' ? 422 : 500;
    res.status(statusCode).json({
      success: false,
      error: error.message,
      errorClass: error.name,
      code: error.code || 'INTERNAL_ERROR',
      requestId: req.requestId,
    });
  }
});

/**
 * POST /api/oncall/telco/upgrade — upgrade a customer's plan
 */
router.post('/api/oncall/telco/upgrade', async (req, res) => {
  try {
    const result = await upgradePlan({
      accountId: req.body.accountId || 'CUST-3001',
      currentPlanCode: String(req.body.currentPlanCode || 'BASIC-12').toUpperCase(),
      targetPlanCode: String(req.body.targetPlanCode || 'FAMILY-PLUS-12').toUpperCase(),
      billingDay: req.body.billingDay || 15,
    });
    res.json(result);
  } catch (error) {
    res.status(500).json({
      success: false,
      error: error.message,
      errorClass: error.name,
      code: error.code || 'UPGRADE_FAILED',
      requestId: req.requestId,
    });
  }
});

/**
 * POST /api/oncall/licenses/provision — provision a new license
 */
router.post('/api/oncall/licenses/provision', async (req, res) => {
  try {
    const planName = (req.body.planName || 'Professional').trim();
    const result = await provisionLicense({
      orgName: req.body.orgName || 'New Customer Inc',
      planName,
      seats: Math.min(parseInt(req.body.seats, 10) || 10, 250),
      billingCycle: req.body.billingCycle || 'monthly',
    });
    res.json(result);
  } catch (error) {
    res.status(500).json({
      success: false,
      error: error.message,
      errorClass: error.name,
      code: error.code || 'PROVISION_FAILED',
      requestId: req.requestId,
    });
  }
});

/**
 * POST /api/oncall/voice/transcribe — finalize a dictated utterance
 */
router.post('/api/oncall/voice/transcribe', async (req, res) => {
  try {
    const result = await finalizeTranscript({
      workspace: req.body.workspace || 'Brightmail',
      dictionary: String(req.body.dictionary || 'general').toLowerCase(),
      utterance: String(req.body.utterance || '').slice(0, 4000),
    });
    res.json(result);
  } catch (error) {
    res.status(500).json({
      success: false,
      error: error.message,
      errorClass: error.name,
      code: error.code || 'TRANSCRIBE_FAILED',
      requestId: req.requestId,
    });
  }
});

/**
 * POST /api/oncall/inference/completions — run a chat completion.
 * With `stream: true` the response is server-sent events in the
 * OpenAI-compatible chunk shape, so a client can measure time to first token
 * rather than only total wall clock.
 */
router.post('/api/oncall/inference/completions', async (req, res) => {
  const payload = {
    model: String(req.body.model || 'deepseek-v3').toLowerCase(),
    deployment: req.body.deployment || 'chat-prod',
    prompt: String(req.body.prompt || '').slice(0, 8000),
    maxTokens: req.body.maxTokens,
  };
  const options = {};

  if (req.body.stream !== true) {
    try {
      res.json(await runCompletion(payload, options));
    } catch (error) {
      res.status(500).json({
        success: false,
        error: error.message,
        errorClass: error.name,
        code: error.code || 'COMPLETION_FAILED',
        requestId: req.requestId,
      });
    }
    return;
  }

  res.set({
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  });
  res.flushHeaders();
  const send = (event) => res.write(`data: ${JSON.stringify(event)}\n\n`);

  try {
    const result = await runCompletion(payload, {
      ...options,
      onFirstToken: (ttftMs) => send({ object: 'chat.completion.chunk', ttftMs }),
      onToken: (token) => send({
        object: 'chat.completion.chunk',
        choices: [{ index: 0, delta: { content: token } }],
      }),
    });
    send({
      object: 'chat.completion.chunk',
      choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
      usage: result.usage,
      ttftMs: result.ttftMs,
      tokensPerSecond: result.tokensPerSecond,
      id: result.id,
      model: result.model,
    });
    res.write('data: [DONE]\n\n');
  } catch (error) {
    send({ error: { message: error.message, code: error.code || 'COMPLETION_FAILED' } });
  }
  res.end();
});

/**
 * POST /api/oncall/insurance/claim — submit an insurance claim
 */
router.post('/api/oncall/insurance/claim', async (req, res) => {
  try {
    const result = await processClaim({
      policyId: req.body.policyId || 'POL-5001',
      claimType: req.body.claimType || 'collision',
      amount: req.body.amount || 5000,
      description: req.body.description || 'Vehicle damage from collision',
    });
    res.json(result);
  } catch (error) {
    const isTimeout = error.code === 'ADJUDICATION_TIMEOUT';
    res.status(isTimeout ? 504 : 500).json({
      success: false,
      error: isTimeout
        ? 'Claim submission timed out — please try again in a few minutes.'
        : error.message,
      errorClass: error.name,
      code: error.code || 'CLAIM_FAILED',
      requestId: req.requestId,
    });
  }
});

/**
 * POST /api/oncall/industrials/quote — generate an instant manufacturing quote
 */
router.post('/api/oncall/industrials/quote', async (req, res) => {
  try {
    const result = await processQuote({
      partNumber: req.body.partNumber || 'TM-DFM-4400',
      material: req.body.material || '7075-T6 Aluminum',
      toleranceClass: req.body.toleranceClass || 'Class B',
      quantity: req.body.quantity || 25,
      itarControlled: req.body.itarControlled === true,
      site: req.body.site || 'f3-mesa',
    }, { debugTimings: req.get('x-debug-timings') === '1' });
    res.json(result);
  } catch (error) {
    res.status(500).json({
      success: false,
      error: error.message,
      errorClass: error.name,
      code: error.code || 'QUOTE_FAILED',
      requestId: req.requestId,
    });
  }
});

/**
 * POST /api/oncall/marketplace/cart — add a marketplace offer to the cart
 */
router.post('/api/oncall/marketplace/cart', async (req, res) => {
  try {
    const result = await addToCart({
      offerId: req.body.offerId || 'OFF-NA221-PHG',
      sellerId: req.body.sellerId || 'SELLER-PHILIPS-HHG',
      listingId: req.body.listingId || '408492471',
      quantity: req.body.quantity || 1,
    });
    res.json(result);
  } catch (error) {
    const isTimeout = error.code === 'RESERVATION_TIMEOUT';
    res.status(isTimeout ? 504 : 500).json({
      success: false,
      error: isTimeout
        ? 'Zeitüberschreitung beim Reservieren des Artikels. Bitte versuche es in einigen Minuten erneut.'
        : error.message,
      errorClass: error.name,
      code: error.code || 'CART_ADD_FAILED',
      requestId: req.requestId,
    });
  }
});

/**
 * POST /api/oncall/vaccines/order — submit a practice's vaccine order
 */
router.post('/api/oncall/vaccines/order', async (req, res) => {
  try {
    const result = await submitOrder({
      ndc: req.body.ndc || '5816084952',
      quantity: req.body.quantity || 1,
      practiceAccount: req.body.practiceAccount || 'ACCT-1004',
      shipTo: req.body.shipTo || 'ACCT-2101',
      accountTier: req.body.accountTier || 'standard',
      delivery: req.body.delivery === 'nextday' ? 'nextday' : 'standard',
    });
    res.json(result);
  } catch (error) {
    const isTimeout = error.code === 'ALLOCATION_TIMEOUT';
    res.status(isTimeout ? 504 : 500).json({
      success: false,
      error: isTimeout
        ? 'Your order timed out while confirming vaccine allocation. Please try again in a few minutes.'
        : error.message,
      errorClass: error.name,
      code: error.code || 'ORDER_SUBMIT_FAILED',
      requestId: req.requestId,
    });
  }
});

// Same per-IP sliding-hour cap as the on-call trigger endpoints: each alert
// posts to Slack and can start a Devin session.
const AUTOMATED_ALERT_HOURLY_CAP = 50;
const AUTOMATED_ALERT_WINDOW_MS = 3600000;
const automatedAlertWindows = new Map();

function automatedAlertAllowed(req) {
  const forwarded = req.headers['x-forwarded-for'];
  const ip = typeof forwarded === 'string' && forwarded.trim()
    ? forwarded.split(',').pop().trim()
    : (req.socket.remoteAddress || 'unknown');
  const now = Date.now();
  for (const [key, window] of automatedAlertWindows) {
    while (window.length && window[0] <= now - AUTOMATED_ALERT_WINDOW_MS) window.shift();
    if (!window.length) automatedAlertWindows.delete(key);
  }
  const window = automatedAlertWindows.get(ip) || [];
  if (window.length >= AUTOMATED_ALERT_HOURLY_CAP) {
    logger.warn('Automated card-payment alert skipped — hourly cap hit', { ip, limit: AUTOMATED_ALERT_HOURLY_CAP });
    return false;
  }
  window.push(now);
  automatedAlertWindows.set(ip, window);
  return true;
}

/**
 * Skins with alertPath 'automated' (e.g. 8f167941) send card-payment server
 * errors to the legacy automated alert channel (always Slack, whatever the
 * hub's Teams/Slack choice) with a Devin session instead of the on-call card.
 */
function raiseAutomatedCardPaymentAlert(req, body, error) {
  const skin = getOncallSkin(req.get('x-oncall-skin'));
  if (!skin || skin.vertical !== 'cardpayment' || skin.alertPath !== 'automated') return;
  if (!automatedAlertAllowed(req)) return;
  runWithAlertDestination('slack', () => createSessionAndAlert({
    issueTitle: `${error.name}: ${error.message}`,
    issueUrl: `https://${process.env.SENTRY_ORG_SLUG || 'sentry-org'}.sentry.io/issues/?project=${process.env.SENTRY_PROJECT_ID || ''}&query=is%3Aunresolved`,
    culprit: 'app/services/oncall-verticals/cardpayment.js — submitCardPayment',
    errorType: error.name || 'Error',
    errorValue: error.message,
    devinUserId: body.devinUserId,
    devinEmail: body.devinEmail,
    devinOrgId: body.devinOrgId,
    service: 'card-payments-api',
    verticalLabel: `${skin.company} Online Banking — Credit card payment`,
    customer: skin.slug,
    tags: [
      { key: 'route', value: '/api/oncall/cardpayment/payment' },
      { key: 'service', value: 'card-payments-api' },
      { key: 'fromAccount', value: String(body.fromAccount || '') },
    ],
    extra: { fromAccount: body.fromAccount, amount: body.amount, requestId: req.requestId },
    level: 'error',
    platform: 'node',
  })).catch(() => {});
}

/**
 * POST /api/oncall/pbm/claim — submit a pharmacy claim
 */
router.post('/api/oncall/pbm/claim', async (req, res) => {
  try {
    const result = await submitClaim({
      memberId: req.body.memberId || 'FRX-100245-01',
      ndc: req.body.ndc || '00093505898',
      pharmacyId: req.body.pharmacyId || '4012345',
      quantity: req.body.quantity || 30,
      daysSupply: req.body.daysSupply || 30,
      rxNumber: req.body.rxNumber || 'RX-7710452',
      prescriberNpi: req.body.prescriberNpi || '1467582039',
    });
    res.json(result);
  } catch (error) {
    const isTimeout = error.code === 'ADJUDICATION_TIMEOUT';
    res.status(isTimeout ? 504 : 500).json({
      success: false,
      error: isTimeout
        ? 'The claim timed out during adjudication. Please resubmit, or call the pharmacy help desk if it keeps failing.'
        : error.message,
      errorClass: error.name,
      code: error.code || 'CLAIM_SUBMIT_FAILED',
      requestId: req.requestId,
    });
  }
});

/**
 * POST /api/oncall/payer/prior-auth — submit a prior-authorization request
 */
router.post('/api/oncall/payer/prior-auth', async (req, res) => {
  const body = req.body || {};
  try {
    const result = await submitPriorAuth({
      memberId: body.memberId || 'LSHP-100245-01',
      providerNpi: body.providerNpi || '1316024598',
      cptCode: body.cptCode || '70553',
      icd10: body.icd10 || 'G43.909',
      serviceDate: body.serviceDate || new Date().toISOString().slice(0, 10),
      urgency: body.urgency || 'standard',
      clinicalNotes: typeof body.clinicalNotes === 'string' ? body.clinicalNotes.slice(0, 2000) : '',
    });
    res.json(result);
  } catch (error) {
    const statusCode = ['MEMBER_NOT_ELIGIBLE', 'PROCEDURE_NOT_FOUND'].includes(error.code) ? 422 : 500;
    res.status(statusCode).json({
      success: false,
      error: error.message,
      errorClass: error.name,
      code: error.code || 'PRIOR_AUTH_SUBMIT_FAILED',
      requestId: req.requestId,
    });
  }
});

/**
 * POST /api/oncall/lifesciences/sample-order — request HCP drug samples
 */
router.post('/api/oncall/lifesciences/sample-order', async (req, res) => {
  const body = req.body || {};
  const defaultPrescriber = PRESCRIBERS.find((prescriber) => prescriber.hcpNpi === body.hcpNpi) || PRESCRIBERS[0];
  const defaultItems = [
    { productId: PRODUCTS[0].productId, quantity: 4 },
    { productId: PRODUCTS[1].productId, quantity: 4 },
    { productId: PRODUCTS[2].productId, quantity: 4 },
    { productId: PRODUCTS[0].productId, quantity: 4 },
  ];
  try {
    const result = await submitSampleOrder({
      hcpNpi: body.hcpNpi || defaultPrescriber.hcpNpi,
      stateLicense: body.stateLicense || defaultPrescriber.stateLicense,
      shipToAddressId: body.shipToAddressId || defaultPrescriber.shipToAddresses[0].addressId,
      items: body.items === undefined ? defaultItems : body.items,
      signature: body.signature === undefined ? defaultPrescriber.name : body.signature,
    });
    res.json(result);
  } catch (error) {
    const validationCodes = [
      'LICENSE_NOT_VALID',
      'PRODUCT_NOT_SAMPLEABLE',
      'QUANTITY_LIMIT_EXCEEDED',
      'SIGNATURE_REQUIRED',
      'INVALID_ORDER',
      'SHIP_TO_ADDRESS_NOT_FOUND',
    ];
    res.status(validationCodes.includes(error.code) ? 422 : 500).json({
      success: false,
      error: error.message,
      errorClass: error.name,
      code: error.code || 'SAMPLE_ORDER_FAILED',
      requestId: req.requestId,
    });
  }
});

/**
 * POST /api/oncall/cardpayment/payment — pay a credit card from a deposit account
 */
router.post('/api/oncall/cardpayment/payment', async (req, res) => {
  const body = req.body || {};
  try {
    const result = await submitCardPayment({
      fromAccount: body.fromAccount,
      toAccount: body.toAccount || 'CARD-4417',
      amount: body.amount,
    });
    res.json(result);
  } catch (error) {
    const status = error.code === 'INVALID_PAYMENT' ? 400 : error.code === 'INSUFFICIENT_FUNDS' ? 422 : 500;
    if (status === 500) raiseAutomatedCardPaymentAlert(req, body, error);
    res.status(status).json({
      success: false,
      error: status === 500 ? 'We could not process your payment.' : error.message,
      errorClass: error.name,
      code: error.code || 'PAYMENT_FAILED',
      requestId: req.requestId,
    });
  }
});

/**
 * POST /api/oncall/sportinggoods/checkout — place a sporting-goods cart checkout
 */
router.post('/api/oncall/sportinggoods/checkout', async (req, res) => {
  const body = req.body || {};
  try {
    const result = await checkoutSportingGoodsOrder({
      items: body.items,
      memberId: body.memberId || 'guest',
      fulfillment: body.fulfillment || 'ship',
      storeNumber: body.storeNumber || '0212',
      zipCode: body.zipCode,
      paymentMethod: body.paymentMethod || 'card',
    });
    res.json(result);
  } catch (error) {
    const isTimeout = error.code === 'STORE_HOLD_TIMEOUT';
    const status = isTimeout ? 504 : error.code === 'INVALID_CART' ? 400 : 500;
    res.status(status).json({
      success: false,
      error: isTimeout
        ? 'Your order timed out while reserving items at your store. Please try again in a few minutes.'
        : error.message,
      errorClass: isTimeout ? 'GatewayTimeout' : error.name,
      code: error.code || 'CHECKOUT_FAILED',
      requestId: req.requestId,
    });
  }
});

/**
 * POST /api/oncall/clickcollect/checkout — place a Coppel cart checkout
 * (home delivery or "Recoger en tienda")
 */
router.post('/api/oncall/clickcollect/checkout', async (req, res) => {
  const body = req.body || {};
  try {
    const result = await checkoutClickCollectOrder({
      items: body.items,
      delivery: body.delivery || 'domicilio',
      storeNumber: body.storeNumber || '0071',
    });
    res.json(result);
  } catch (error) {
    const isTimeout = error.code === 'STORE_HOLD_TIMEOUT';
    const status = isTimeout ? 504 : error.code === 'INVALID_CART' ? 400 : 500;
    res.status(status).json({
      success: false,
      error: isTimeout
        ? 'Se agotó el tiempo al apartar tus productos en la tienda. Intenta de nuevo en unos minutos.'
        : error.message,
      errorClass: isTimeout ? 'GatewayTimeout' : error.name,
      code: error.code || 'CHECKOUT_FAILED',
      requestId: req.requestId,
    });
  }
});

/**
 * POST /api/oncall/storepickup/checkout — place a cart checkout
 */
router.post('/api/oncall/storepickup/checkout', async (req, res) => {
  const body = req.body || {};
  try {
    const result = await checkoutStorePickupOrder({
      items: body.items,
      promoCode: body.promoCode,
      fulfillment: body.fulfillment || 'ship',
      storeNumber: body.storeNumber || '0412',
      zipCode: body.zipCode,
    });
    res.json(result);
  } catch (error) {
    const isTimeout = error.code === 'STORE_HOLD_TIMEOUT';
    const status = isTimeout ? 504 : error.code === 'INVALID_CART' ? 400 : 500;
    res.status(status).json({
      success: false,
      error: isTimeout
        ? 'Your order timed out while reserving items at your store. Please try again in a few minutes.'
        : error.message,
      errorClass: isTimeout ? 'GatewayTimeout' : error.name,
      code: error.code || 'CHECKOUT_FAILED',
      requestId: req.requestId,
    });
  }
});

/**
 * POST /api/oncall/rebooking/rebook — rebook a disrupted traveler onto an
 * alternative flight (`action: 'rebook'`) or hold a seat on it (`action: 'hold'`)
 */
router.post('/api/oncall/rebooking/rebook', async (req, res) => {
  const body = req.body || {};
  try {
    const result = await rebookFlight({
      tripId: body.tripId,
      alternativeId: body.alternativeId,
      action: body.action,
    });
    res.json(result);
  } catch (error) {
    const isTimeout = error.code === 'RESHOP_TIMEOUT';
    const status = isTimeout ? 504 : error.code === 'INVALID_REBOOK' ? 400 : 500;
    res.status(status).json({
      success: false,
      error: isTimeout
        ? 'Rebooking is taking longer than expected. We could not confirm your new flight — your original ticket is still open.'
        : error.message,
      errorClass: isTimeout ? 'GatewayTimeout' : error.name,
      code: error.code || 'REBOOK_FAILED',
      requestId: req.requestId,
    });
  }
});

/**
 * POST /api/oncall/apparel/bag — add an apparel style to the bag
 */
router.post('/api/oncall/apparel/bag', async (req, res) => {
  try {
    const result = await addToBag({
      styleId: req.body.styleId || '8688977',
      size: req.body.size,
      color: req.body.color,
      quantity: req.body.quantity || 1,
    });
    res.json(result);
  } catch (error) {
    res.status(error.code === 'STYLE_NOT_FOUND' ? 404 : 500).json({
      success: false,
      error: 'We couldn\u2019t add this item to your Bag.',
      errorClass: error.name,
      code: error.code || 'BAG_ADD_FAILED',
      requestId: req.requestId,
    });
  }
});

/**
 * POST /api/oncall/grocery/checkout — place a PC Express pickup order
 */
router.post('/api/oncall/grocery/checkout', async (req, res) => {
  try {
    const result = await checkoutOrder({
      storeId: req.body.storeId || '1039',
      lines: Array.isArray(req.body.lines) && req.body.lines.length
        ? req.body.lines
        : GROCERY_CART_ITEMS.map((i) => ({ sku: i.sku, quantity: i.quantity })),
      pickupSlot: req.body.pickupSlot || defaultGroceryPickupSlot(),
    });
    res.json(result);
  } catch (error) {
    const statusCode = error.code === 'ITEM_NOT_FOUND' ? 422 : 500;
    res.status(statusCode).json({
      success: false,
      error: 'We couldn\'t calculate your order total. Please try again.',
      errorClass: error.name,
      code: error.code || 'CHECKOUT_FAILED',
      requestId: req.requestId,
    });
  }
});

router.post('/api/oncall/identity/environments', async (req, res) => {
  const body = req.body || {};
  try {
    const result = await createEnvironment({
      name: body.name,
      description: body.description,
      licenseType: body.licenseType,
      useCase: body.useCase,
      type: body.type,
      services: body.services,
      samplePopulations: body.samplePopulations,
    });
    res.json(result);
  } catch (error) {
    const isTimeout = error.code === 'PROVISION_TIMEOUT';
    const status = isTimeout ? 504 : error.code === 'INVALID_ENVIRONMENT' ? 400 : 500;
    res.status(status).json({
      success: false,
      error: isTimeout
        ? 'The environment could not be created. The request timed out before provisioning finished. Try again in a few minutes.'
        : error.message,
      errorClass: isTimeout ? 'GatewayTimeout' : error.name,
      code: error.code || 'ENVIRONMENT_CREATE_FAILED',
      requestId: req.requestId,
    });
  }
});

router.post('/api/oncall/identity/applications', async (req, res) => {
  const body = req.body || {};
  try {
    const result = await createApplication({
      environmentId: body.environmentId,
      name: body.name,
      type: body.type,
    });
    res.json(result);
  } catch (error) {
    const status = error.code === 'INVALID_APPLICATION' ? 400 : 500;
    res.status(status).json({
      success: false,
      error: error.message,
      errorClass: error.name,
      code: error.code || 'APPLICATION_CREATE_FAILED',
      requestId: req.requestId,
    });
  }
});

router.post('/api/oncall/examscheduling/availability', (req, res) => {
  try {
    res.json(getAvailability(req.body || {}));
  } catch (error) {
    const status = error.code === 'INVALID_BOOKING' ? 400 : 500;
    res.status(status).json({
      success: false,
      error: error.message,
      errorClass: error.name,
      code: error.code || 'AVAILABILITY_FAILED',
      requestId: req.requestId,
    });
  }
});

router.post('/api/oncall/examscheduling/appointments', async (req, res) => {
  const body = req.body || {};
  try {
    res.json(await confirmBooking({
      examCode: body.examCode,
      testCentreId: body.testCentreId,
      slotId: body.slotId,
      candidate: body.candidate,
      residencyRegion: body.residencyRegion,
    }));
  } catch (error) {
    const isTimeout = error.code === 'BOOKING_TIMEOUT';
    const status = isTimeout ? 504 : error.code === 'INVALID_BOOKING' ? 400 : 500;
    res.status(status).json({
      success: false,
      error: isTimeout
        ? 'We couldn\'t confirm your booking. The request timed out before your appointment was reserved. Please try again in a few minutes.'
        : error.message,
      errorClass: isTimeout ? 'GatewayTimeout' : error.name,
      code: error.code || 'BOOKING_FAILED',
      requestId: req.requestId,
    });
  }
});

module.exports = router;
