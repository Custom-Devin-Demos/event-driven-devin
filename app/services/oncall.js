const crypto = require('crypto');
const logger = require('../telemetry/logger');
const { ownerRotation, postMessage, postThreadReply, lookupSlackUserByEmail } = require('./slack');
const { buildTeamsAlertCard, isTeamsWebhookUrl, postTeamsCard } = require('./teams');
const { createDevinSession } = require('./devin-api');
const { declareDatadogIncident } = require('./datadog-incidents');
const { canCreateSession, reserveSession } = require('./session-rate-limiter');
const { scheduleVulnerablePR } = require('./sonar-pr-trigger');
const { getScenario, getOncallRunRef, setScopedScenario, clearScopedScenario, setScopedConfig, getScopedConfig, clearScopedConfig } = require('../incidentModes');
const { COMPLIANCE_CONFIG: COMPLIANCE_DEFAULTS } = require('./oncall-verticals/banking');

/**
 * On-Call demo service.
 *
 * Posts alert cards, support tickets, and incident bursts to the
 * dedicated On-Call Slack channels. Alert-only by default: the On-Call
 * responders listening to the channels pick the messages up on their own.
 * A skin may opt its own branded page into auto-triage with
 * devinSession: { auto: true }, which creates one Devin session per alert
 * that skin raises and replies with its link in the alert thread. Alerts
 * raised without such a skin never create a session.
 *
 * Channels/token are configurable via env:
 *   SLACK_ONCALL_ALERTS_CHANNEL_ID — alert + incident channel (#oncall-alerts)
 *   SLACK_ONCALL_BUGS_CHANNEL_ID   — bug report channel (#oncall-bugs)
 *   SLACK_ONCALL_ALERTS_CHANNEL_NAME / SLACK_ONCALL_BUGS_CHANNEL_NAME — labels the
 *     on-call ribbon shows after posting (default #oncall-alerts / #oncall-bugs)
 *   SLACK_ONCALL_BOT_TOKEN         — bot token override (default: SLACK_BOT_TOKEN)
 *   ONCALL_TEAMS_WEBHOOK_URL       — optional Teams Workflows webhook; alert cards
 *     from skins with `teamsAlerts: true` are also posted there as Adaptive Cards
 *   <skin.teamsWebhookEnv>         — optional per-skin Teams webhook env var name;
 *     when set to a valid Teams webhook URL, that skin's cards post there instead
 *   ONCALL_TEAMS_ALL_ALERTS=true   — post every alert card to that webhook, not
 *     only `teamsAlerts` skins
 */

const REPO_URL = process.env.ONCALL_REPO_URL || 'https://github.com/COG-GTM/event-driven-devin';
const DEMO_BASE_URL = () =>
  (process.env.ONCALL_DEMO_BASE_URL || `https://${process.env.DOMAIN_NAME || 'devindemos.com'}`).replace(/\/$/, '');

/**
 * Alert scenarios for the on-call vertical demos. Cards are metric-shaped —
 * symptom, monitor, threshold, release marker — with no code locations, so
 * the responder correlates the signal to the cause through telemetry and the
 * repository itself.
 */
const ALERT_SCENARIOS = {
  banking: {
    vertical: 'banking',
    page: 'banking.html',
    apiPath: '/api/banking/transfer',
    oncallApiPath: '/api/oncall/banking/transfer',
    owner: 'Jordan Patel (payments-oncall)',
    brand: 'Apex Bank (Online Banking)',
    service: 'banking-api',
    endpoint: 'POST /api/oncall/banking/transfer',
    monitor: 'p95 latency — POST /api/oncall/banking/transfer',
    metricQuery: 'p95:trace.express.request.duration{service:checkout-api,resource:POST /api/oncall/banking/transfer}',
    metricValue: '9.6s',
    threshold: '> 1.5s',
    baseline: '~280ms (7-day p95)',
    release: 'apex-bank@1.0.3',
    symptom: 'Transfer submissions hang ~10s before completing. Error rate is normal — requests eventually succeed.',
    impact: 'Every outgoing transfer sits on a spinner for ~10 seconds; support is reporting rising complaint volume.',
  },
  insurance: {
    vertical: 'insurance',
    page: 'insurance.html',
    apiPath: '/api/insurance/claim',
    oncallApiPath: '/api/oncall/insurance/claim',
    owner: 'Morgan Lee (claims-platform-oncall)',
    brand: 'Shield Insurance (Claims Portal)',
    service: 'insurance-api',
    endpoint: 'POST /api/oncall/insurance/claim',
    monitor: '5xx rate — POST /api/oncall/insurance/claim',
    metricQuery: 'sum:trace.express.request.errors{service:checkout-api,resource:POST /api/oncall/insurance/claim,http.status_code:504}',
    metricValue: '504 on ~100% of submissions',
    threshold: '> 5% error rate',
    baseline: '<0.5% (7-day)',
    release: 'shield-insurance@1.0.3',
    symptom: 'Claim submissions hang ~8s and then fail with 504 Gateway Timeout. Upstream adjudication latency is elevated.',
    impact: 'Policyholders cannot file claims through the portal; every submission times out after a long hang.',
  },
  hightech: {
    vertical: 'hightech',
    page: 'hightech.html',
    apiPath: '/api/licenses/provision',
    oncallApiPath: '/api/oncall/licenses/provision',
    owner: 'Sam Okafor (licensing-oncall)',
    brand: 'NovaSoft (License Management)',
    service: 'licensing-api',
    endpoint: 'POST /api/oncall/licenses/provision',
    monitor: 'p95 latency trending up — POST /api/oncall/licenses/provision',
    metricQuery: 'p95:trace.express.request.duration{service:checkout-api,resource:POST /api/oncall/licenses/provision}',
    metricValue: '6.8s and climbing',
    threshold: '> 2s',
    baseline: '~350ms (7-day p95, before novasoft@1.0.3)',
    release: 'novasoft@1.0.3',
    symptom: 'Provisioning latency jumped after the last release and creeps higher with every request. Process RSS trends up alongside it.',
    impact: 'License provisioning is slow for every customer and getting slower under sustained traffic.',
    // Climbing-latency scenario: repeat submits demonstrate the per-request
    // growth, so retries within the window join the same incident.
    retryWindow: true,
  },
  voice: {
    vertical: 'voice',
    page: 'voice.html',
    apiPath: '/api/voice/transcribe',
    oncallApiPath: '/api/oncall/voice/transcribe',
    owner: 'Priya Nair (dictation-oncall)',
    brand: 'EchoScribe (Dictation Console)',
    service: 'dictation-api',
    endpoint: 'POST /api/oncall/voice/transcribe',
    monitor: 'p95 latency trending up — POST /api/oncall/voice/transcribe',
    metricQuery: 'p95:trace.express.request.duration{service:checkout-api,resource:POST /api/oncall/voice/transcribe}',
    metricValue: '7.2s and climbing',
    threshold: '> 1.5s',
    baseline: '~240ms (7-day p95, before echoscribe@1.0.4)',
    release: 'echoscribe@1.0.4',
    symptom: 'Transcript finalization latency jumped after the last release and creeps higher with every utterance. Process RSS trends up alongside it. Error rate is normal.',
    impact: 'Every dictation waits several seconds for its polished transcript, and the wait grows under sustained use.',
    // Climbing-latency scenario: repeat submits demonstrate the per-utterance
    // growth, so retries within the window join the same incident.
    retryWindow: true,
  },
  inference: {
    vertical: 'inference',
    page: 'inference.html',
    apiPath: '/api/inference/completions',
    oncallApiPath: '/api/oncall/inference/completions',
    owner: 'Dana Whitfield (serving-platform-oncall)',
    brand: 'Helix Serve (Inference Console)',
    service: 'inference-gateway',
    endpoint: 'POST /api/oncall/inference/completions',
    monitor: 'p95 time to first token trending up — POST /api/oncall/inference/completions',
    metricQuery: 'p95:demo.inference.ttft{service:checkout-api,route:/api/oncall/inference/completions}',
    metricValue: '6.4s TTFT and climbing',
    threshold: '> 1.5s',
    baseline: '~310ms (7-day p95 TTFT, before helix-serve@1.0.4)',
    release: 'helix-serve@1.0.4',
    symptom: 'Time to first token jumped after the last release and creeps higher with every completion served. Inter-token latency is unchanged and error rate is normal. Process RSS trends up alongside TTFT.',
    impact: 'Every completion waits several seconds before the first token, and the wait grows under sustained traffic. Streaming clients look hung.',
    // Climbing-latency scenario: repeat completions demonstrate the
    // per-request growth, so retries within the window join the same incident.
    retryWindow: true,
  },
  telco: {
    vertical: 'telco',
    page: 'telco.html',
    apiPath: '/api/telco/upgrade',
    oncallApiPath: '/api/oncall/telco/upgrade',
    owner: 'Riley Chen (subscriber-services-oncall)',
    brand: 'WaveConnect (Self-Service Portal)',
    service: 'telco-api',
    endpoint: 'POST /api/oncall/telco/upgrade',
    monitor: 'p95 latency — POST /api/oncall/telco/upgrade',
    metricQuery: 'p95:trace.express.request.duration{service:checkout-api,resource:POST /api/oncall/telco/upgrade}',
    metricValue: '7.9s',
    threshold: '> 1.5s',
    baseline: '~300ms before the plan-catalog refresh',
    release: 'waveconnect@1.0.3',
    symptom: 'Plan upgrades slowed sharply after the plan-catalog refresh added the legacy/regional plans. Latency scales with catalog size.',
    impact: 'Subscribers wait ~8 seconds on every plan change; upgrade completion rate is dropping.',
  },
  marketplace: {
    vertical: 'marketplace',
    page: '63dbb52f.html',
    apiPath: '/api/marketplace/cart',
    oncallApiPath: '/api/oncall/marketplace/cart',
    owner: 'Nina Brandt (marketplace-checkout-oncall)',
    brand: 'Marktplatz Storefront (Product Detail)',
    service: 'cart-api',
    endpoint: 'POST /api/oncall/marketplace/cart',
    monitor: '5xx rate — POST /api/oncall/marketplace/cart',
    metricQuery: 'sum:trace.express.request.errors{service:checkout-api,resource:POST /api/oncall/marketplace/cart,http.status_code:504}',
    metricValue: '504 on ~100% of add-to-cart requests',
    threshold: '> 5% error rate',
    baseline: '<0.4% (7-day)',
    release: 'marketplace-storefront@1.0.4',
    symptom: 'Add-to-cart requests hang ~8s and then fail with 504 Gateway Timeout. Stock reservation latency against the seller inventory partner is elevated.',
    impact: 'Shoppers cannot add marketplace offers to the basket; every add sits on a spinner and then errors.',
    // Branded page only: the storefront card is not offered on the generic hub.
    unlisted: true,
  },
  fluidanalysis: {
    vertical: 'fluidanalysis',
    page: 'b33a7a98.html',
    apiPath: '/api/b33a7a98/cart',
    oncallApiPath: '/api/oncall/fluidanalysis/cart',
    owner: 'Priya Natarajan (marketplace-commerce-oncall)',
    brand: 'Marketplace (Product Detail)',
    service: 'cart-api',
    endpoint: 'POST /api/oncall/fluidanalysis/cart',
    monitor: '5xx rate — POST /api/oncall/fluidanalysis/cart',
    metricQuery: 'sum:trace.express.request.errors{service:cart-api,resource:POST /api/oncall/fluidanalysis/cart,http.status_code:500}',
    metricValue: '500 on ~100% of dealer add-to-cart requests',
    threshold: '> 2% error rate',
    baseline: '<0.2% (7-day)',
    release: 'marketplace-cart@5.2.0',
    symptom: 'Add to Cart on fluid-analysis kits fails immediately with HTTP 500 for dealer accounts. Latency is normal. Onset coincides with the dealer price book migration.',
    impact: 'Dealers cannot order FluidWatch oil and coolant analysis kits; every Add to Cart errors.',
    triggerWhen: { accountId: 'CMI-DLR-40817' },
    unlisted: true,
  },
  picklist: {
    vertical: 'picklist',
    page: '35a59686.html',
    apiPath: '/api/35a59686/picklist',
    oncallApiPath: '/api/oncall/picklist/add',
    owner: 'Marcus Bell (parts-catalog-oncall)',
    brand: 'Genuine Parts (Part Details)',
    service: 'picklist-api',
    endpoint: 'POST /api/oncall/picklist/add',
    monitor: '5xx rate — POST /api/oncall/picklist/add',
    metricQuery: 'sum:trace.express.request.errors{service:picklist-api,resource:POST /api/oncall/picklist/add,http.status_code:500}',
    metricValue: '500 on Add to Pick List for affected part numbers',
    threshold: '> 2% error rate',
    baseline: '<0.1% (7-day)',
    release: 'parts-catalog@17.3.1',
    symptom: 'Add to Pick List on part details fails immediately with HTTP 500 for some part numbers. Latency is normal. Onset coincides with the parts-master sync.',
    impact: 'Technicians cannot add affected genuine parts to their pick list; the button errors on the part-details page.',
    triggerWhen: { partNumber: '3800984' },
    unlisted: true,
  },
  esnlookup: {
    vertical: 'esnlookup',
    page: 'e8615789.html',
    apiPath: '/api/e8615789/esn',
    oncallApiPath: '/api/oncall/esnlookup/lookup',
    owner: 'Tom Ostrowski (service-info-oncall)',
    brand: 'QuickServe Online (ESN Lookup)',
    service: 'esn-lookup-api',
    endpoint: 'POST /api/oncall/esnlookup/lookup',
    monitor: '5xx rate — POST /api/oncall/esnlookup/lookup',
    metricQuery: 'sum:trace.express.request.errors{service:esn-lookup-api,resource:POST /api/oncall/esnlookup/lookup,http.status_code:500}',
    metricValue: '500 on ESN lookups for recently built engines',
    threshold: '> 2% error rate',
    baseline: '<0.1% (7-day)',
    release: 'qsol-info@9.14.0',
    symptom: 'Engine serial number lookups fail immediately with HTTP 500 for some engines. Latency is normal. Onset coincides with the latest engine build-record import.',
    impact: 'Service technicians cannot open owners manuals, troubleshooting guides or wiring diagrams for affected engines.',
    triggerWhen: { esn: '79464646' },
    unlisted: true,
  },
  apparel: {
    vertical: 'apparel',
    page: '0d1ff688.html',
    apiPath: '/api/apparel/bag',
    oncallApiPath: '/api/oncall/apparel/bag',
    owner: 'Dana Whitfield (bag-checkout-oncall)',
    brand: 'Department Store (Product Detail)',
    service: 'bag-api',
    endpoint: 'POST /api/oncall/apparel/bag',
    monitor: '5xx rate — POST /api/oncall/apparel/bag',
    metricQuery: 'sum:trace.express.request.errors{service:checkout-api,resource:POST /api/oncall/apparel/bag,http.status_code:500}',
    metricValue: '500 on ~100% of add-to-bag requests',
    threshold: '> 2% error rate',
    baseline: '<0.2% (7-day)',
    release: 'pdp-web@2.14.0',
    symptom: 'Add to Bag fails immediately with HTTP 500 (TypeError in bag-api). Latency is normal. Onset coincides with the pdp-web 2.14.0 size-picker release.',
    impact: 'Shoppers cannot add apparel to their Bag; every Add to Bag errors right after a size is picked.',
    // Branded page only: the storefront card is not offered on the generic hub.
    unlisted: true,
  },
  grocery: {
    vertical: 'grocery',
    page: 'e2d82a44.html',
    apiPath: '/api/grocery/checkout',
    oncallApiPath: '/api/oncall/grocery/checkout',
    owner: 'Maya Chen (online-grocery-checkout-oncall)',
    brand: 'PC Express (Grocery Checkout)',
    service: 'order-api',
    endpoint: 'POST /api/oncall/grocery/checkout',
    monitor: '5xx rate — POST /api/oncall/grocery/checkout',
    metricQuery: 'sum:trace.express.request.errors{service:checkout-api,resource:POST /api/oncall/grocery/checkout,http.status_code:500}',
    metricValue: '500 on ~100% of checkout submissions',
    threshold: '> 2% error rate',
    baseline: '<0.3% (7-day)',
    release: 'pcx-checkout@1.0.6',
    symptom: 'Checkout submissions fail immediately with HTTP 500 during order-total calculation. Latency is normal. Onset coincides with the weekly PC Optimum offer catalog refresh.',
    impact: 'Shoppers cannot complete PC Express pickup orders; every checkout attempt errors before reaching payment.',
    // Branded page only: the storefront card is not offered on the generic hub.
    unlisted: true,
  },
  sportinggoods: {
    vertical: 'sportinggoods',
    page: '1b17e823.html',
    apiPath: '/api/1b17e823/checkout',
    oncallApiPath: '/api/oncall/sportinggoods/checkout',
    owner: 'Riley Okafor (omnichannel-checkout-oncall)',
    brand: 'Sporting Goods Storefront (Cart Checkout)',
    service: 'order-api',
    endpoint: 'POST /api/oncall/sportinggoods/checkout',
    monitor: 'p95 latency — POST /api/oncall/sportinggoods/checkout',
    metricQuery: 'p95:trace.express.request.duration{service:checkout-api,resource:POST /api/oncall/sportinggoods/checkout}',
    metricValue: '8.0s (504s on store-pickup orders)',
    threshold: '> 2s',
    baseline: '~420ms (7-day p95)',
    release: 'omni-checkout@3.8.0',
    symptom: 'Store-pickup checkouts hang ~8s and then fail with 504 Gateway Timeout. Ship-to-home checkouts are normal. Onset coincides with the omni-checkout 3.8.0 pickup-hold release.',
    impact: 'Shoppers choosing Free Store Pickup cannot complete checkout; every pickup order sits on a spinner and then errors.',
    triggerWhen: { fulfillment: 'pickup' },
    initialClick: '.opt[data-f="pickup"]',
    // Branded page only: the storefront card is not offered on the generic hub.
    unlisted: true,
  },
  clickcollect: {
    vertical: 'clickcollect',
    page: 'coppel.html',
    apiPath: '/api/coppel/checkout',
    oncallApiPath: '/api/oncall/clickcollect/checkout',
    owner: 'Andrea Salazar (omnicanal-oncall)',
    brand: 'Retail Storefront (Mi carrito)',
    service: 'pedidos-api',
    endpoint: 'POST /api/oncall/clickcollect/checkout',
    monitor: 'p95 latency — POST /api/oncall/clickcollect/checkout',
    metricQuery: 'p95:trace.express.request.duration{service:checkout-api,resource:POST /api/oncall/clickcollect/checkout}',
    metricValue: '8.0s (504s on store-pickup orders)',
    threshold: '> 2s',
    baseline: '~380ms (7-day p95)',
    release: 'carrito-web@4.2.0',
    symptom: 'Store-pickup checkouts hang ~8s and then fail with 504 Gateway Timeout. Home-delivery checkouts are normal. Onset coincides with the carrito-web 4.2.0 pickup-hold release.',
    impact: 'Shoppers choosing store pickup cannot complete checkout; every pickup order sits on a spinner and then errors.',
    triggerWhen: { delivery: 'tienda' },
    initialClick: '.delivery-opt[data-delivery="tienda"]',
    // Branded page only: the storefront card is not offered on the generic hub.
    unlisted: true,
  },
  storepickup: {
    vertical: 'storepickup',
    page: 'f813dd7a.html',
    apiPath: '/api/f813dd7a/checkout',
    oncallApiPath: '/api/oncall/storepickup/checkout',
    owner: 'Morgan Lee (omnichannel-oncall)',
    brand: 'Retail Storefront (Shopping Bag)',
    service: 'checkout-api',
    endpoint: 'POST /api/oncall/storepickup/checkout',
    monitor: 'p95 latency — POST /api/oncall/storepickup/checkout',
    metricQuery: 'p95:trace.express.request.duration{service:checkout-api,resource:POST /api/oncall/storepickup/checkout}',
    metricValue: '8.0s (504s on store-pickup orders)',
    threshold: '> 2s',
    baseline: '~350ms (7-day p95)',
    release: 'bag-web@3.12.0',
    symptom: 'Store-pickup checkouts hang ~8s and then fail with 504 Gateway Timeout. Ship-to-address checkouts are normal. Onset coincides with the bag-web 3.12.0 pickup-hold release.',
    impact: 'Shoppers choosing store pickup cannot complete checkout; every pickup order sits on a spinner and then errors.',
    triggerWhen: { fulfillment: 'pickup' },
    // Branded page only: the storefront card is not offered on the generic hub.
    unlisted: true,
  },
  cardpayment: {
    vertical: 'cardpayment',
    page: '8f167941.html',
    apiPath: '/api/8f167941/card-payment',
    oncallApiPath: '/api/oncall/cardpayment/payment',
    owner: 'Dana Whitfield (card-payments-oncall)',
    brand: 'Online Banking (Credit card payments)',
    service: 'card-payments-api',
    endpoint: 'POST /api/oncall/cardpayment/payment',
    monitor: 'Error rate \u2014 POST /api/oncall/cardpayment/payment',
    metricQuery: 'sum:trace.express.request.errors{service:checkout-api,resource:POST /api/oncall/cardpayment/payment}.as_count() / sum:trace.express.request.hits{service:checkout-api,resource:POST /api/oncall/cardpayment/payment}.as_count() * 100',
    metricValue: '100% of checking-funded payments (HTTP 500)',
    threshold: '> 2%',
    baseline: '~0.1% (7-day)',
    release: 'card-payments@2.4.0',
    symptom: 'Credit card payments funded from checking fail immediately with HTTP 500. Payments funded from savings succeed.',
    impact: 'Customers cannot pay their credit card from checking, the default funding account; every attempt errors.',
    triggerWhen: { fromAccount: 'CHK-1634' },
    // Branded page only: not offered on the generic hub.
    unlisted: true,
  },
  rebooking: {
    vertical: 'rebooking',
    page: 'e7a1c4d9.html',
    apiPath: '/api/egencia/rebook',
    oncallApiPath: '/api/oncall/rebooking/rebook',
    owner: 'Camille Lefevre (egencia-rebooking-oncall)',
    brand: 'Corporate Travel (Trip Disruption Rebooking)',
    service: 'egencia-rebooking-api',
    endpoint: 'POST /api/oncall/rebooking/rebook',
    monitor: 'p95 latency — POST /api/oncall/rebooking/rebook',
    metricQuery: 'p95:demo.rebooking.rebook.latency{service:egencia-rebooking-api,route:/api/oncall/rebooking/rebook}',
    metricValue: '8.0s (504s on every rebook)',
    threshold: '> 2s',
    baseline: '~640ms (7-day p95)',
    release: 'egencia-rebooking@5.2.0',
    symptom: 'Rebook requests hang ~8s and then fail with 504 Gateway Timeout. Seat holds on the same alternatives are normal. Onset coincides with the egencia-rebooking 5.2.0 fare-family re-shop release during an airline disruption.',
    impact: 'Travelers whose flight was cancelled cannot confirm an alternative; every Rebook sits on a spinner and then errors, leaving them unticketed.',
    triggerWhen: { action: 'rebook' },
    // Branded page only: the storefront card is not offered on the generic hub.
    unlisted: true,
  },
  identity: {
    vertical: 'identity',
    page: 'a9a14d80.html',
    apiPath: '/api/identity-console',
    oncallApiPath: '/api/oncall/identity',
    owner: 'Dana Whitfield (identity-platform-oncall)',
    brand: 'Identity Cloud (Environment Provisioning)',
    service: 'pingone-environment-api',
    endpoint: 'POST /api/oncall/identity/environments',
    monitor: 'p95 latency — POST /api/oncall/identity/environments',
    metricQuery: 'p95:demo.identity.environment.create.latency{service:pingone-environment-api,route:/api/oncall/identity/environments}',
    metricValue: '9.0s (504 on every environment create)',
    threshold: '> 3s',
    baseline: '~1.6s (7-day p95)',
    release: 'pingone-environments@2026.10.1',
    symptom: 'Environment create requests hang ~9s and then fail with 504 Gateway Timeout. Application creates in existing environments are normal. Onset coincides with the pingone-environments 2026.10.1 release.',
    impact: 'Administrators cannot add new environments; every attempt from the setup assistant spins for ~9s and errors, so the environment is never created.',
    triggerWhen: { action: 'create-environment' },
    unlisted: true,
  },
  examscheduling: {
    vertical: 'examscheduling',
    page: 'e85b5836.html',
    apiPath: '/api/vue-scheduling',
    oncallApiPath: '/api/oncall/examscheduling',
    owner: 'Priya Nair (vue-scheduling-oncall)',
    brand: 'Pearson VUE (Exam Scheduling)',
    service: 'vue-scheduling-api',
    endpoint: 'POST /api/oncall/examscheduling/appointments',
    monitor: 'p95 latency — POST /api/oncall/examscheduling/appointments',
    metricQuery: 'p95:demo.examscheduling.booking.confirm.latency{service:vue-scheduling-api,route:/api/oncall/examscheduling/appointments}',
    metricValue: '9.0s (504 on every booking confirmation)',
    threshold: '> 3s',
    baseline: '~1.7s (7-day p95)',
    release: 'vue-scheduling@2026.10.1',
    symptom: 'Confirm booking hangs about 9s, then returns 504; test-centre availability search answers in under 200ms. Onset coincides with the release.',
    impact: 'Candidates cannot book Certiport or Pearson VUE exams, seats are not reserved, and some retry or call the contact centre.',
    triggerWhen: { action: 'confirm-booking' },
    unlisted: true,
  },
  industrials: {
    vertical: 'industrials',
    page: 'industrials-quote.html',
    apiPath: '/api/industrials/quote',
    oncallApiPath: '/api/oncall/industrials/quote',
    owner: 'Alex Romero (manufacturing-platform-oncall)',
    brand: 'Titan Mfg (Instant Quote)',
    service: 'quote-api',
    endpoint: 'POST /api/oncall/industrials/quote',
    monitor: 'p95 latency — POST /api/oncall/industrials/quote',
    metricQuery: 'p95:trace.express.request.duration{service:checkout-api,resource:POST /api/oncall/industrials/quote}',
    metricValue: '14.2s',
    threshold: '> 2s',
    baseline: '~310ms (7-day p95)',
    release: 'titan-mfg@1.0.1',
    symptom: 'Requests routed through the F3 edge site hang ~14s before completing. F2/F4 are normal and error rate is normal.',
    impact: 'Factory teams wait through a long instant-quote spinner for F3 work while other sites return normally.',
  },
  vaccines: {
    vertical: 'vaccines',
    page: 'fe4f39ba.html',
    apiPath: '/api/vaccines/order',
    oncallApiPath: '/api/oncall/vaccines/order',
    owner: 'Jordan Patel (hcp-ordering-oncall)',
    brand: 'Vaccine Ordering (HCP Portal)',
    service: 'vaccine-ordering-api',
    endpoint: 'POST /api/oncall/vaccines/order',
    monitor: '5xx rate — POST /api/oncall/vaccines/order',
    metricQuery: 'sum:trace.express.request.errors{service:checkout-api,resource:POST /api/oncall/vaccines/order,http.status_code:504}',
    metricValue: '504 on ~100% of order submissions',
    threshold: '> 5% error rate',
    baseline: '<0.3% (7-day)',
    release: 'hcp-ordering-web@1.0.4',
    symptom: 'Vaccine order submissions hang ~8s and then fail with 504 Gateway Timeout. Allocation-hold latency against the cold-chain distribution partner is elevated.',
    impact: 'Practices cannot place vaccine orders; every submission sits on a spinner and then errors. The Vaccine Service Center is reporting rising call volume.',
    unlisted: true,
  },
  pbm: {
    vertical: 'pbm',
    page: 'pbm.html',
    apiPath: '/api/pbm/claim',
    oncallApiPath: '/api/oncall/pbm/claim',
    owner: 'Dana Whitfield (claims-adjudication-oncall)',
    brand: 'Fernway Rx (Pharmacy Claims)',
    service: 'pbm-claims-api',
    endpoint: 'POST /api/oncall/pbm/claim',
    monitor: 'Response time degradation — pbm-claims-api',
    metricQuery: 'index=prod sourcetype=claims service:pbm-claims-api http.status=504 | timechart span=5m count',
    demoPage: '/oncall/pbm',
    metricValue: '504s on ~100% of claim submissions over 15m',
    threshold: 'count > 25 per 5m span',
    baseline: '0–2 per 5m span (7-day search)',
    release: 'pbm-claims-api@3.8.2',
    symptom: 'Claim submissions hang ~8s and then fail with 504 Gateway Timeout. Dynatrace attributes the response time degradation to calls to the delegated utilization-management partners.',
    impact: 'Pharmacies cannot adjudicate claims at point of sale; members are leaving the counter without their prescriptions and the pharmacy help desk is reporting rising call volume.',
    telemetryBrand: 'splunk-dynatrace',
    group: 'healthcare',
    summary: 'Submit a pharmacy claim. It hangs ~8s, then returns a 504.',
    defaultAlertDestination: 'teams',
    oncallOnly: true,
    unlisted: true,
  },
  payer: {
    vertical: 'payer',
    page: 'priorauth.html',
    apiPath: '/api/priorauth/submit',
    oncallApiPath: '/api/oncall/payer/prior-auth',
    owner: 'Renee Castillo (utilization-review-oncall)',
    brand: 'Larkspur Health Plan (Prior Authorization)',
    service: 'payer-priorauth-api',
    endpoint: 'POST /api/oncall/payer/prior-auth',
    monitor: 'Response time degradation — payer-priorauth-api',
    metricQuery: 'index=prod sourcetype=priorauth service:payer-priorauth-api | timechart span=5m p95(duration_ms)',
    demoPage: '/oncall/payer',
    metricValue: 'p95 6.1s and climbing',
    threshold: 'p95(duration_ms) > 2000',
    baseline: '~420ms p95 (7-day search, before payer-priorauth-api@5.2.0)',
    release: 'payer-priorauth-api@5.2.0',
    symptom: 'Prior authorization submissions from the provider portal get slower on every request. Error rate is normal; Dynatrace shows the response time growing in calls to the medical-policy service.',
    impact: 'Provider offices are waiting on the portal for authorization decisions; staff are resubmitting and calling the provider services line.',
    telemetryBrand: 'splunk-dynatrace',
    group: 'healthcare',
    summary: 'Submit a prior authorization. Each submission is slower than the last.',
    defaultAlertDestination: 'teams',
    retryWindow: true,
    oncallOnly: true,
    unlisted: true,
  },
  f8555891: {
    vertical: 'f8555891',
    page: 'f8555891.html',
    apiPath: '/api/f8555891/release-batch',
    oncallApiPath: '/api/f8555891/release-batch',
    owner: 'Priya Natarajan (payroll-platform-oncall)',
    brand: 'Gusto (Payroll Operations)',
    service: 'customer-f8555891-payroll',
    endpoint: 'POST /api/f8555891/release-batch',
    monitor: 'Error rate — payroll batch ACH release',
    metricQuery: 'sum:gusto_payroll.batch_release_failure{service:customer-f8555891-payroll} by {state}.as_count()',
    metricValue: '100% of release attempts failing (HTTP 500 BATCH_RELEASE_FAILED)',
    threshold: '> 0 failures / 5m',
    baseline: '0 failures (30-day)',
    release: 'gusto-payroll-platform@2026.09.15',
    symptom: 'Releasing ACH debits for batch PB-2026-09-15-A fails on every attempt. Failures carry state:MN; the same batch releases cleanly when the one MN company (CO-51177) is excluded.',
    impact: 'Sep 17 pay date for 5 companies / 133 employees is blocked ahead of the 17:30 PT ACH cutoff. MN is a newly onboarded work state.',
    // Gusto-branded console at /gusto, not the generic on-call hub.
    demoPage: '/gusto',
    unlisted: true,
  },
  '90ccfbb2': {
    vertical: '90ccfbb2',
    page: '90ccfbb2.html',
    apiPath: '/api/90ccfbb2/holds',
    oncallApiPath: '/api/90ccfbb2/holds',
    owner: 'Marcus Bell (parks-inventory-oncall)',
    brand: 'Disney Parks (Tickets & Resorts)',
    service: 'resort-inventory',
    endpoint: 'POST /api/90ccfbb2/holds',
    monitor: '5xx rate — Add to Cart (POST /api/holds)',
    metricQuery: 'sum(last_5m):sum:resort_inventory.hold_failure{service:resort-inventory}.as_count() > 0',
    metricValue: '100% of Add to Cart attempts failing for Thanksgiving-week dates (HTTP 500 HOLD_FAILED)',
    threshold: '> 0 failures / 5m',
    baseline: '0 failures (30-day)',
    release: 'resort-inventory@3.15.0',
    symptom: 'Add to Cart returns 500 for park tickets and room-nights dated Thanksgiving week (e.g. Magic Kingdom Sat 11/28). Other dates add to cart and check out normally.',
    impact: 'Guests cannot buy tickets, Park Pass reservations or rooms for the highest-demand dates of the quarter; every failed cart is lost revenue.',
    demoPage: '/90ccfbb2',
    unlisted: true,
  },
  '90ccfbb2-dining': {
    vertical: '90ccfbb2',
    page: '90ccfbb2/dining.html',
    apiPath: '/api/90ccfbb2/dining/reservations',
    oncallApiPath: '/api/90ccfbb2/dining/reservations',
    owner: 'Priya Natarajan (dining-reservations-oncall)',
    brand: 'Disney Dining (Reservations)',
    service: 'dining-reservations',
    endpoint: 'POST /api/90ccfbb2/dining/reservations',
    monitor: '5xx rate — Book Reservation (POST /dining/reservations)',
    metricQuery: 'sum(last_5m):sum:dining_reservations.booking_failure{service:dining-reservations}.as_count() > 0',
    metricValue: '100% of Book Reservation attempts failing (HTTP 500 RESERVATION_FAILED) across all restaurants',
    threshold: '> 0 failures / 5m',
    baseline: '0 failures (30-day)',
    release: 'resort-inventory@3.16.0',
    symptom: 'Book Reservation returns 500 for every restaurant and date (Be Our Guest, Space 220, Blue Bayou…). Tables still show as available; Tickets & Resort Hotels checkout on the same inventory platform is unaffected.',
    impact: 'Guests cannot book any Advance Dining Reservation at Walt Disney World or Disneyland Resort; character-dining and signature restaurants sell out in minutes at the 60-day window.',
    demoPage: '/90ccfbb2/dining',
    unlisted: true,
  },
};

function resolveOncallEnv() {
  return {
    token: process.env.SLACK_ONCALL_BOT_TOKEN || process.env.SLACK_BOT_TOKEN,
    alertsChannel: process.env.SLACK_ONCALL_ALERTS_CHANNEL_ID,
    bugsChannel: process.env.SLACK_ONCALL_BUGS_CHANNEL_ID,
    teamsWebhookUrl: process.env.ONCALL_TEAMS_WEBHOOK_URL,
    teamsAllAlerts: process.env.ONCALL_TEAMS_ALL_ALERTS === 'true',
  };
}

/**
 * Generate a short unique run reference so each demo run produces a
 * distinguishable alert (and can dodge duplicate-grouping when desired).
 */
function makeRunRef() {
  return `run-${crypto.randomBytes(6).toString('hex')}`;
}

const DD_URL = () => process.env.DD_DASHBOARD_URL || 'https://app.datadoghq.com';

/**
 * Card, thread-reply and session-prompt copy. A skin opts into Spanish with
 * locale: 'es' or Japanese with locale: 'ja'; every other skin stays English.
 */
const ONCALL_STRINGS = {
  en: {
    triggered: 'Triggered',
    service: 'Service',
    endpoint: 'Endpoint',
    metricValue: 'Metric value',
    threshold: 'Threshold',
    baseline: 'Baseline',
    release: 'Release',
    events: 'Events',
    first: 'First',
    last: 'Last',
    owner: 'Owner',
    onCall: 'On-Call',
    incidentRef: 'Incident Ref',
    triggeredBy: 'Triggered by',
    monitorQuery: 'Monitor query',
    affectedPage: 'Affected page',
    openAffectedPage: 'Open affected page',
    viewDatadog: 'View in Datadog',
    submittedFrom: 'Submitted from',
    investigatingText: (url) => `Devin is investigating: ${url}`,
    investigatingBlock: (url) => `:mag: *Devin is investigating this alert* — <${url}|View session>`,
    sessionTitle: (monitor) => `[On-Call] ${monitor}`,
    promptIntro: (service) => `A Datadog monitor is firing on ${service}. Investigate it and open a PR with the fix.`,
    monitor: 'Monitor',
    query: 'Query',
    symptom: 'Symptom',
    impact: 'Impact',
    metricLine: (s) => `${s.metricValue} (threshold ${s.threshold}, baseline ${s.baseline})`,
    reproduce: (url, repo) => `Reproduce the symptom at ${url} and diagnose it from the repository and its telemetry: ${repo}`,
    notify: (mention) => 'Progress updates for the on-call engineer: reply in the Slack alert thread above twice — '
      + `(1) as soon as the root cause is confirmed, post ${mention} + the root cause in ≤3 lines; `
      + `(2) as soon as the fix PR is open, post ${mention} + the PR link + one line on how you verified. `,
    promptLanguage: null,
  },
  es: {
    triggered: 'Activada',
    service: 'Servicio',
    endpoint: 'Endpoint',
    metricValue: 'Valor de la métrica',
    threshold: 'Umbral',
    baseline: 'Línea base',
    release: 'Versión',
    events: 'Eventos',
    first: 'Primero',
    last: 'Último',
    owner: 'Responsable',
    onCall: 'On Call',
    incidentRef: 'Ref. de incidente',
    triggeredBy: 'Activado por',
    monitorQuery: 'Consulta del monitor',
    affectedPage: 'Página afectada',
    openAffectedPage: 'Abrir página afectada',
    viewDatadog: 'Ver en Datadog',
    submittedFrom: 'Enviado desde',
    investigatingText: (url) => `Devin está investigando: ${url}`,
    investigatingBlock: (url) => `:mag: *Devin está investigando esta alerta* — <${url}|Ver sesión>`,
    sessionTitle: (monitor) => `[On Call] ${monitor}`,
    promptIntro: (service) => `Un monitor de Datadog está disparando en ${service}. Investígalo y abre un PR con la corrección.`,
    monitor: 'Monitor',
    query: 'Consulta',
    symptom: 'Síntoma',
    impact: 'Impacto',
    metricLine: (s) => `${s.metricValue} (umbral ${s.threshold}, línea base ${s.baseline})`,
    reproduce: (url, repo) => `Reproduce el síntoma en ${url} y diagnostícalo a partir del repositorio y su telemetría: ${repo}`,
    notify: (mention) => 'Avisos de progreso para la persona On Call: responde dos veces en el hilo de la alerta de Slack de arriba — '
      + `(1) en cuanto confirmes la causa raíz, publica ${mention} + la causa raíz en ≤3 líneas; `
      + `(2) en cuanto el PR con la corrección esté abierto, publica ${mention} + el link del PR + una línea sobre cómo lo verificaste. `,
    promptLanguage: '*Idioma:* responde en español — mensajes en el hilo de Slack, título y descripción del PR, y resumen final.',
  },
  ja: {
    triggered: '発報',
    service: 'サービス',
    endpoint: 'エンドポイント',
    metricValue: 'メトリクス値',
    threshold: 'しきい値',
    baseline: 'ベースライン',
    release: 'リリース',
    events: 'イベント数',
    first: '初回',
    last: '最終',
    owner: '担当',
    onCall: 'オンコール担当',
    incidentRef: 'インシデント参照',
    triggeredBy: '発報者',
    monitorQuery: 'モニタークエリ',
    affectedPage: '影響ページ',
    openAffectedPage: '影響ページを開く',
    viewDatadog: 'Datadogで表示',
    submittedFrom: '送信元',
    investigatingText: (url) => `Devinが調査中です: ${url}`,
    investigatingBlock: (url) => `:mag: *Devinがこのアラートを調査中です* — <${url}|セッションを表示>`,
    sessionTitle: (monitor) => `[オンコール] ${monitor}`,
    promptIntro: (service) => `${service} でDatadogモニターが発報しています。原因を調査し、修正のPRを作成してください。`,
    monitor: 'モニター',
    query: 'クエリ',
    symptom: '症状',
    impact: '影響',
    metricLine: (s) => `${s.metricValue}（しきい値 ${s.threshold}、ベースライン ${s.baseline}）`,
    reproduce: (url, repo) => `${url} で症状を再現し、リポジトリとテレメトリから原因を特定してください: ${repo}`,
    notify: (mention) => 'オンコール担当への進捗連絡: 上記のSlackアラートのスレッドに2回返信してください — '
      + `(1) 根本原因を確認したら、${mention} と根本原因を3行以内で投稿; `
      + `(2) 修正PRを作成したら、${mention} とPRのリンク、検証方法を1行で投稿。 `,
    promptLanguage: '*言語:* 日本語で回答してください — Slackスレッドへの返信、PRのタイトルと説明、最終サマリーはすべて日本語で書いてください。',
  },
};

const TELEMETRY_BRAND_STRINGS = {
  'splunk-dynatrace': {
    en: {
      triggered: 'OPEN Problem',
      metricValue: 'Search result',
      monitorQuery: 'Splunk search',
      viewDatadog: null,
      promptIntro: (service) => `A Dynatrace problem is open on ${service}. Investigate it and open a PR with the fix.`,
      monitor: 'Dynatrace problem',
      promptState: 'OPEN',
      query: 'Splunk search',
      promptTelemetry: 'Start from the Splunk search above and the Dynatrace problem (the affected service and the response-time breakdown of its downstream calls), then confirm the cause in the repository before changing it.',
    },
    es: {
      triggered: 'Problema ABIERTO',
      metricValue: 'Resultado de búsqueda',
      monitorQuery: 'Búsqueda de Splunk',
      viewDatadog: null,
      promptIntro: (service) => `Hay un problema abierto de Dynatrace en ${service}. Investígalo y abre un PR con la solución.`,
      monitor: 'Problema de Dynatrace',
      promptState: 'ABIERTO',
      query: 'Búsqueda de Splunk',
      promptTelemetry: 'Empieza con la búsqueda de Splunk anterior y el problema de Dynatrace (el servicio afectado y el desglose del tiempo de respuesta de sus llamadas posteriores); luego confirma la causa en el repositorio antes de cambiarlo.',
    },
  },
};

function oncallStrings(skin, scenario) {
  const locale = skin && Object.prototype.hasOwnProperty.call(ONCALL_STRINGS, skin.locale)
    ? skin.locale
    : 'en';
  const telemetryBrand = (skin && skin.telemetryBrand) || (scenario && scenario.telemetryBrand) || 'datadog';
  const overlay = TELEMETRY_BRAND_STRINGS[telemetryBrand] && TELEMETRY_BRAND_STRINGS[telemetryBrand][locale];
  return overlay ? { ...ONCALL_STRINGS[locale], ...overlay } : ONCALL_STRINGS[locale];
}

/**
 * Resolve the demo user's hub identity email to a Slack @mention so cards
 * show who launched the trigger (same attribution as the legacy alerts).
 */
const EMAIL_RE = /^[^\s@<>|]{1,64}@[^\s@<>|]{1,255}$/;

async function resolveTriggeredBy(token, devinEmail) {
  // Validate shape so a client-supplied value can't inject Slack mrkdwn
  // (e.g. <!channel>) into the cards.
  if (!devinEmail || !EMAIL_RE.test(devinEmail)) return null;
  try {
    const memberId = await lookupSlackUserByEmail(token, devinEmail);
    return memberId ? `<@${memberId}>` : devinEmail;
  } catch (error) {
    logger.warn('Triggered-by Slack lookup failed', { error: error.message });
    return devinEmail;
  }
}

function slackMemberIdOf(mention) {
  const match = /^<@([A-Z0-9]{1,32})>$/i.exec(mention || '');
  return match ? match[1] : null;
}

/**
 * Shared Block Kit helpers so On-Call cards match the polish of the legacy
 * Automated Alerts cards (header, field grid, action buttons, context row).
 */
function fieldPairs(pairs) {
  const fields = pairs
    .filter((p) => p && p[1])
    .map(([label, value]) => ({ type: 'mrkdwn', text: `*${label}:*\n${value}` }));
  const blocks = [];
  for (let i = 0; i < fields.length; i += 2) {
    blocks.push({ type: 'section', fields: fields.slice(i, i + 2) });
  }
  return blocks;
}

function headerBlock(text) {
  return { type: 'header', text: { type: 'plain_text', text, emoji: true } };
}

function mrkdwnSection(text) {
  return { type: 'section', text: { type: 'mrkdwn', text } };
}

function datadogActions(t = ONCALL_STRINGS.en) {
  return {
    type: 'actions',
    elements: [
      {
        type: 'button',
        text: { type: 'plain_text', text: `:bar_chart: ${t.viewDatadog}`, emoji: true },
        url: DD_URL(),
      },
    ],
  };
}

function contextBlock(service, triggeredBy, submittedFrom, t = ONCALL_STRINGS.en) {
  const parts = [`${t.service}: \`${service || 'checkout-api'}\``];
  if (submittedFrom) parts.push(`${t.submittedFrom}: <${submittedFrom}|${submittedFrom.replace(/^https?:\/\//, '')}>`);
  parts.push(new Date().toISOString());
  if (triggeredBy) parts.push(`${t.triggeredBy} ${triggeredBy}`);
  return {
    type: 'context',
    elements: [{ type: 'mrkdwn', text: parts.join(' | ') }],
  };
}

/**
 * Build the plain-text alert card for a scenario.
 * When `unique` is true, a per-run reference is woven into the alert so the
 * responder treats it as a fresh occurrence; when false, the message matches
 * the canonical signature to demonstrate duplicate grouping.
 */
function demoPagePath(scenario, skin) {
  if (skin) return `/oncall/c/${skin.slug}`;
  return scenario.demoPage || null;
}

function demoPageLine(scenario, skin) {
  const path = demoPagePath(scenario, skin);
  return path ? `*${oncallStrings(skin, scenario).affectedPage}:* ${DEMO_BASE_URL()}${path}` : null;
}

/**
 * Alert card copy for a scenario with a skin's optional alertCard overrides
 * applied. Without overrides the scenario itself is returned, so the card is
 * unchanged.
 */
function resolveAlertCard(scenario, skin) {
  const card = skin && isPlainObject(skin.alertCard) ? skin.alertCard : null;
  if (!card) return scenario;
  const pick = (key, fallback) => (typeof card[key] === 'string' && card[key].trim() ? card[key] : fallback);
  const team = pick('team', null);
  return {
    ...scenario,
    monitor: pick('title', scenario.monitor),
    service: pick('service', scenario.service),
    endpoint: pick('endpointLabel', scenario.endpoint),
    release: pick('release', scenario.release),
    owner: team && scenario.owner ? `${scenario.owner.replace(/\s*\([^)]*\)$/, '')} (${team})` : scenario.owner,
    metricQuery: pick('metricQuery', scenario.metricQuery),
    metricValue: pick('metricValue', scenario.metricValue),
    threshold: pick('threshold', scenario.threshold),
    baseline: pick('baseline', scenario.baseline),
    symptom: pick('symptom', scenario.symptom),
    impact: pick('impact', scenario.impact),
  };
}

function buildAlertMessage(scenario, { runRef, now, firstSeen, events, triggeredBy, onCall, skin }) {

  const card = resolveAlertCard(scenario, skin);
  const brand = skin ? skin.company : scenario.brand;
  const t = oncallStrings(skin, scenario);
  const lines = [
    `:rotating_light: *[${t.triggered}] ${card.monitor}*`,
    '',
    `*${t.service}:* ${card.service} (${brand})`,
    demoPageLine(scenario, skin),
    `*${t.endpoint}:* ${card.endpoint}`,
    `*${t.metricValue}:* ${card.metricValue} | *${t.threshold}:* ${card.threshold} | *${t.baseline}:* ${card.baseline}`,
    `*${t.monitorQuery}:* \`${card.metricQuery}\``,
    onCall ? `*${t.onCall}:* ${onCall}` : `*${t.owner}:* ${ownerRotation(card.owner)}`,
    runRef ? `*${t.incidentRef}:* ${runRef}` : null,
    triggeredBy ? `*${t.triggeredBy}:* ${triggeredBy}` : null,
    '',
    `Env: production | ${t.release}: ${card.release}`,
    `${t.events}: ${events} | ${t.first}: ${firstSeen.toISOString()} | ${t.last}: ${now.toISOString()}`,
    '',
    `Repo: ${REPO_URL}`,
  ];

  return lines.filter((l) => l !== null).join('\n');
}

/**
 * Investigation prompt for a skin's auto-triage session. Built only from the
 * scenario's monitor-shaped facts — the same signal a human responder gets —
 * so no code locations, and no request-derived text, reach the session.
 */
const SLACK_MEMBER_ID_RE = /^[A-Z0-9]{1,32}$/i;
const SLACK_CHANNEL_ID_RE = /^[A-Z0-9]{1,32}$/i;
const SLACK_TS_RE = /^\d{1,16}\.\d{1,9}$/;

function notifySlackMemberParagraph(memberId, channel, threadTs, t = ONCALL_STRINGS.en) {
  const mention = `<@${memberId}>`;
  return [
    t.notify(mention)
      + 'Post with `curl -s -X POST https://slack.com/api/chat.postMessage -H "Authorization: Bearer $SLACK_ONCALL_BOT_TOKEN" '
      + `-H 'Content-Type: application/json' -d '{"channel":"${channel}","thread_ts":"${threadTs}","text":"..."}'\` `
      + '(fall back to `$COG_GTM_DEMO_SLACK_BOT_TOKEN`; both are org secrets available as env vars in the triage session — never print them). '
      + 'If neither token is set, use the Devin `slack` tool with `thread_ts`.',
  ].join('');
}

function buildOncallSessionPrompt(scenario, skin, runRef, { channel, threadTs, onCallMemberId } = {}) {
  const t = oncallStrings(skin, scenario);
  // Monitor facts match the skin's Slack card; service/endpoint stay real so the session can find the code.
  const card = { ...resolveAlertCard(scenario, skin), service: scenario.service, endpoint: scenario.endpoint };
  const lines = [
    t.promptIntro(card.service),
    '',
    `*${t.monitor}:* ${card.monitor} — ${t.promptState || t.triggered}`,
    `*${t.query}:* \`${card.metricQuery}\``,
    `*${t.endpoint}:* ${card.endpoint}`,
    `*${t.metricValue}:* ${t.metricLine(card)}`,
    `*${t.release}:* ${card.release}`,
    `*${t.symptom}:* ${card.symptom}`,
    `*${t.impact}:* ${card.impact}`,
    runRef ? `*${t.incidentRef}:* ${runRef}` : null,
    '',
    t.reproduce(`${DEMO_BASE_URL()}/oncall/c/${skin.slug}`, REPO_URL),
  ].filter((l) => l !== null);

  if (t.promptTelemetry) {
    lines.push('');
    lines.push(t.promptTelemetry);
  }

  if (
    skin.devinSession
    && typeof skin.devinSession.promptAppendix === 'string'
    && skin.devinSession.promptAppendix.trim()
  ) {
    lines.push('');
    lines.push(skin.devinSession.promptAppendix);
  }

  const hasThread = SLACK_CHANNEL_ID_RE.test(channel || '') && SLACK_TS_RE.test(threadTs || '');
  if (hasThread) {
    lines.push('');
    lines.push(`*Slack Thread:* channel=${channel} thread_ts=${threadTs}`);
  }

  const notifyId = onCallMemberId || (skin.devinSession && skin.devinSession.notifySlackMemberId);
  if (hasThread && typeof notifyId === 'string' && SLACK_MEMBER_ID_RE.test(notifyId)) {
    lines.push('');
    lines.push(notifySlackMemberParagraph(notifyId, channel, threadTs, t));
  }

  if (t.promptLanguage) {
    lines.push('');
    lines.push(t.promptLanguage);
  }

  return lines.join('\n');
}

/**
 * Identity of the person who triggered the run, as the demo header resolved it
 * (org name + email → Devin ids) and the page forwarded it. Sessions are then
 * created under that account instead of the service user's. Ids are shape-
 * checked because they arrive from the browser, and org and user are taken as
 * one identity: a user id only belongs to the org it was resolved against, so
 * a requester org with no user runs as that org's service user rather than
 * borrowing a user id from the skin or the environment.
 */
const DEVIN_ORG_ID_RE = /^[A-Za-z0-9_-]{1,64}$/;
// User ids carry their identity provider as a prefix, e.g. `email|<hex>`.
const DEVIN_USER_ID_RE = /^[A-Za-z0-9_|.@+-]{1,128}$/;

function resolveRequesterIdentity({ devinOrgId, devinUserId } = {}) {
  const orgId = DEVIN_ORG_ID_RE.test(devinOrgId || '') ? devinOrgId : null;
  if (!orgId) return { orgId: null, userId: null, complete: false };
  return {
    orgId,
    userId: DEVIN_USER_ID_RE.test(devinUserId || '') ? devinUserId : null,
    complete: true,
  };
}

/**
 * Pick the account the session is created under. A Devin user id only exists
 * inside one org, so each source is taken whole: mixing a skin's org with the
 * environment's user yields a pair the API rejects. A source that names an org
 * but no user runs as that org's service user.
 */
function resolveSessionIdentity(requester, config) {
  if (requester.complete) return { orgId: requester.orgId, userId: requester.userId };
  if (config.orgId) return { orgId: config.orgId, userId: config.userId || null };
  return {
    orgId: process.env.DEVIN_ONCALL_ORG_ID || process.env.DEVIN_ORG_ID,
    userId: process.env.DEVIN_ONCALL_USER_ID || null,
  };
}

/**
 * Create the auto-triage Devin session for a skin that opted in, and reply
 * with its link in the Slack alert thread. Never throws: a failed session must
 * not fail the alert that triggered it.
 */
async function triggerSkinDevinSession(
  scenario,
  skin,
  { token, channel, threadTs, runRef, requester, onCallMemberId },
) {
  const config = skin.devinSession;
  if (!config || !config.auto) return null;

  const cap = canCreateSession();
  if (!cap.allowed) {
    logger.warn('On-Call skin session creation throttled', { skin: skin.slug, ...cap });
    return null;
  }

  // Reserve before the async call so concurrent alerts cannot all pass the cap check.
  const release = reserveSession();
  let session = null;
  try {
    session = await createDevinSession(buildOncallSessionPrompt(scenario, skin, runRef, { channel, threadTs, onCallMemberId }), {
      ...resolveSessionIdentity(requester, config),
      apiKey: config.apiKey || process.env.DEVIN_ONCALL_SERVICE_KEY,
      title: oncallStrings(skin, scenario).sessionTitle(resolveAlertCard(scenario, skin).monitor),
    });
  } catch (error) {
    logger.error('On-Call skin Devin session failed', { skin: skin.slug, error: error.message });
  }

  if (!session) {
    release();
    return null;
  }

  logger.info('On-Call skin Devin session created', {
    skin: skin.slug,
    scenario: scenario.vertical,
    sessionId: session.sessionId,
  });

  try {
    const t = oncallStrings(skin, scenario);
    await postThreadReply(token, channel, threadTs, t.investigatingText(session.url), [
      mrkdwnSection(t.investigatingBlock(session.url)),
    ]);
  } catch (error) {
    logger.error('On-Call skin session link reply failed', { skin: skin.slug, error: error.message });
  }

  return session;
}

/**
 * Queue the SonarCloud remediation demo PR for a skin that opted in with
 * sonarPR: { auto: true }. Fire-and-forget like the legacy alert flow; the
 * trigger itself logs and skips when no GitHub token is configured.
 */
function triggerSkinSonarPR(skin, requester) {
  const config = skin && skin.sonarPR;
  if (!config || !config.auto) return false;
  scheduleVulnerablePR(0, config.customer || 'default', requester.userId || undefined, requester.orgId || undefined);
  return true;
}

/**
 * Post an alert card for the given scenario to the On-Call alerts channel.
 */
function validEmail(email) {
  return email && EMAIL_RE.test(email) ? email : null;
}

/**
 * Mirror of the Slack alert card for Teams. Delivery is best-effort: a failed
 * Teams post is logged and never blocks the Slack card.
 */
async function postTeamsAlert(webhookUrl, scenario, skin, { card, brand, runRef, events, firstSeen, triggeredByEmail }) {
  const demoPath = demoPagePath(scenario, skin);
  const t = oncallStrings(skin, scenario);
  const teamsCard = buildTeamsAlertCard({
    title: `\u{1F6A8} [${t.triggered}] ${card.monitor}`,
    facts: [
      [t.service, `${card.service} (${brand})`],
      [t.endpoint, card.endpoint],
      ...(t.promptState ? [[t.monitor, `${card.monitor} — ${t.promptState}`]] : []),
      [t.metricValue, card.metricValue],
      [t.threshold, card.threshold],
      [t.baseline, card.baseline],
      [t.release, card.release],
      [t.events, `${events} | ${t.first}: ${firstSeen.toISOString()}`],
      [t.triggeredBy, triggeredByEmail],
    ],
    monitorQuery: card.metricQuery,
    codeTitle: t.monitorQuery,
    // Top-level TextBlocks: the Teams responder drops FactSet rows.
    body: [
      `**${t.owner}:** ${ownerRotation(card.owner)}`,
      demoPath ? `**${t.affectedPage}:** ${DEMO_BASE_URL()}${demoPath}` : null,
      `Repo: ${REPO_URL}`,
    ],
    actions: [
      t.viewDatadog ? { title: t.viewDatadog, url: DD_URL() } : null,
      demoPath ? { title: t.openAffectedPage, url: `${DEMO_BASE_URL()}${demoPath}` } : null,
    ],
    footer: [
      runRef ? `${t.incidentRef}: ${runRef}` : null,
      `${t.service}: ${card.service}`,
      `${t.endpoint}: ${card.endpoint}`,
    ].filter(Boolean).join(' | '),
  });
  try {
    await postTeamsCard(webhookUrl, teamsCard);
    logger.info('On-Call alert posted to Teams', { scenario: scenario.vertical || scenario.service });
    return true;
  } catch (error) {
    logger.warn('On-Call Teams alert post failed', { error: error.message, status: error.response && error.response.status });
    return false;
  }
}

async function postOncallAlert(scenarioId, options = {}) {
  const scenario = ALERT_SCENARIOS[scenarioId];
  if (!scenario) {
    return { ok: false, error: `Unknown scenario: ${scenarioId}` };
  }

  const skin = options.skin || null;
  const env = resolveOncallEnv();
  const { token, alertsChannel } = env;
  const skinWebhookUrl = skin && skin.teamsWebhookEnv ? process.env[skin.teamsWebhookEnv] : null;
  const teamsWebhook = (isTeamsWebhookUrl(skinWebhookUrl) && skinWebhookUrl) || env.teamsWebhookUrl;
  // destination: 'slack' | 'teams' from the presenter's hub choice. Teams skips
  // Slack so one demo is never investigated by both the Slack and the Teams
  // responder; with no Teams webhook configured it falls back to Slack.
  const destination = options.destination === 'slack' || options.destination === 'teams' ? options.destination : null;
  const teamsWanted = destination === 'teams';
  const teamsOnly = teamsWanted && Boolean(teamsWebhook);
  if (teamsWanted && !teamsOnly) {
    logger.warn('Teams On-Call alert requested but ONCALL_TEAMS_WEBHOOK_URL is not set — posting to Slack');
  }
  // Server-managed Teams routing only applies to callers that made no choice.
  const serverTeamsRouting = !destination && (env.teamsAllAlerts || Boolean(skin && skin.teamsAlerts));
  const teamsWebhookUrl = teamsOnly || serverTeamsRouting ? teamsWebhook : null;
  const slackReady = Boolean(token && alertsChannel) && !teamsOnly;
  if (!slackReady && !teamsWebhookUrl) {
    logger.warn('On-Call alerts channel not configured — skipping alert post');
    return { ok: false, skipped: true, error: 'SLACK_ONCALL_ALERTS_CHANNEL_ID or bot token not configured' };
  }

  const runRef = options.runRef || (options.unique !== false ? makeRunRef() : null);
  const triggeredBy = slackReady ? await resolveTriggeredBy(token, options.devinEmail) : null;
  // onCallIsTriggerer: the presenter who triggered the alert is paged as On-Call.
  const onCallMemberId = skin && skin.devinSession && skin.devinSession.onCallIsTriggerer
    ? slackMemberIdOf(triggeredBy)
    : null;
  const onCall = onCallMemberId ? triggeredBy : null;
  // When the presenter is paged as On-Call, a separate "Triggered by" would
  // only repeat the same person.
  const triggeredByLine = onCall ? null : triggeredBy;
  const t = oncallStrings(skin, scenario);
  const now = new Date();
  const firstSeen = new Date(now.getTime() - (5 + Math.floor(Math.random() * 20)) * 60000);
  const events = 3 + Math.floor(Math.random() * 12);
  const text = buildAlertMessage(scenario, { runRef, now, firstSeen, events, triggeredBy: triggeredByLine, onCall, skin });
  const card = resolveAlertCard(scenario, skin);
  const brand = skin ? skin.company : scenario.brand;
  const blocks = [
    headerBlock(`:rotating_light: [${t.triggered}] ${card.monitor}`),
    ...fieldPairs([
      [t.service, `${card.service} (${brand})`],
      [t.endpoint, card.endpoint],
      [t.metricValue, card.metricValue],
      [t.threshold, card.threshold],
      [t.baseline, card.baseline],
      [t.release, card.release],
      [t.events, `${events} | ${t.first}: ${firstSeen.toISOString()}`],
      onCall ? [t.onCall, onCall] : [t.owner, ownerRotation(card.owner)],
      runRef ? [t.incidentRef, runRef] : null,
      triggeredByLine ? [t.triggeredBy, triggeredByLine] : null,
    ]),
    mrkdwnSection(`*${t.monitorQuery}:*\n\`\`\`${card.metricQuery}\`\`\``),
    mrkdwnSection(
      (demoPageLine(scenario, skin) ? `${demoPageLine(scenario, skin)}\n` : '') +
      `Repo: ${REPO_URL}`
    ),
    ...(t.viewDatadog ? [datadogActions(t)] : []),
    contextBlock(card.service, triggeredByLine, null, t),
  ];
  const teamsDelivery = teamsWebhookUrl
    ? postTeamsAlert(teamsWebhookUrl, scenario, skin, {
      card, brand, runRef, events, firstSeen, triggeredByEmail: validEmail(options.devinEmail),
    })
    : Promise.resolve(null);
  let ts = null;
  if (slackReady) {
    try {
      ts = await postMessage(token, alertsChannel, text, blocks);
      logger.info('On-Call alert posted', { scenario: scenarioId, channel: alertsChannel, ts });
    } catch (error) {
      if (!(await teamsDelivery)) throw error;
      logger.warn('On-Call Slack alert post failed; alert delivered to Teams', { error: error.message });
    }
  }
  const teams = await teamsDelivery;
  if (!ts && !teams) {
    return { ok: false, error: 'Teams alert post failed' };
  }
  // Non-unique runs group into one alert thread, so only unique runs open an incident.
  if (skin && skin.datadogIncident && runRef) {
    declareDatadogIncident({
      title: `${brand}: ${card.monitor}`,
      summary: [card.symptom, card.impact].filter(Boolean).join(' '),
      runRef,
      service: card.service,
      triggeredBy: validEmail(options.devinEmail) || `oncall/c/${skin.slug}`,
      repoUrl: REPO_URL,
      severity: 'SEV-2',
    }).catch((error) => logger.warn('Failed to declare Datadog incident for On-Call skin', { skin: skin.slug, error: error.message }));
  }
  const requester = resolveRequesterIdentity(options);
  // Teams-only alerts skip the skin's session: the Teams channel responder
  // already investigates the alert, and a second session would duplicate it.
  const session = skin && ts
    ? await triggerSkinDevinSession(scenario, skin, {
      token, channel: alertsChannel, threadTs: ts, runRef, requester, onCallMemberId,
    })
    : null;
  const sonarPR = triggerSkinSonarPR(skin, requester);
  return {
    ok: true,
    ...(ts ? { ts, channel: alertsChannel } : {}),
    ...(teams ? { teams: true } : {}),
    ...(teamsWanted && !teamsOnly ? { teamsFailed: true } : {}),
    ...(session ? { sessionUrl: session.url } : {}),
    ...(sonarPR ? { sonarPR: true } : {}),
  };
}

/**
 * Post a human-style bug report to the On-Call bugs channel.
 * Accepts either a canned scenario id or free-form text. With `threadTs` the
 * ticket is filed as a sub-ticket in that parent ticket's thread; `ticketId`
 * is shown in the header the way a support tool labels a case.
 */
async function postOncallBugReport({ text, reporter, severity, productArea, devinEmail, supportCenter, submittedFrom, threadTs, ticketId, parentTicketId }) {
  const { token, bugsChannel } = resolveOncallEnv();

  const body = text;
  if (!body) {
    return { ok: false, error: 'No bug report text' };
  }

  if (!token || !bugsChannel) {
    logger.warn('On-Call bugs channel not configured — skipping bug report post');
    return {
      ok: false,
      skipped: true,
      error: 'SLACK_ONCALL_BUGS_CHANNEL_ID or bot token not configured',
    };
  }

  const triggeredBy = await resolveTriggeredBy(token, devinEmail);
  let message = [
    body,
    triggeredBy ? `Triggered by: ${triggeredBy}` : null,
    submittedFrom ? `Submitted from: ${submittedFrom}` : null,
  ].filter((l) => l !== null).join('\n');
  let blocks = null;
  if (reporter || severity || productArea) {
    const reportedBy = reporter && (reporter.name || reporter.email)
      ? [reporter.name, reporter.email && `<${reporter.email}>`].filter(Boolean).join(' ')
      : null;
    const centerName = supportCenter || 'Acme Support Center';
    const centerSlug = centerName.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
    const label = ticketId ? ` ${ticketId}` : '';
    const heading = threadTs
      ? `:page_facing_up: Sub-ticket${label} — ${centerName}`
      : `:inbox_tray: New support ticket${label} — ${centerName}`;
    message = [
      heading,
      parentTicketId ? `Parent ticket: ${parentTicketId}` : null,
      reportedBy ? `Reported by: ${reportedBy}` : null,
      productArea ? `Product area: ${productArea}` : null,
      severity ? `Severity: ${severity}` : null,
      triggeredBy ? `Triggered by: ${triggeredBy}` : null,
      '',
      body,
      submittedFrom ? `Submitted from: ${submittedFrom}` : null,
    ].filter((l) => l !== null).join('\n');
    blocks = [
      headerBlock(heading),
      ...fieldPairs([
        parentTicketId ? ['Parent ticket', parentTicketId] : null,
        reportedBy ? ['Reported by', reportedBy] : null,
        productArea ? ['Product area', productArea] : null,
        severity ? ['Severity', severity] : null,
      ]),
      mrkdwnSection(body),
      contextBlock(centerSlug, triggeredBy, submittedFrom),
    ];
  }

  const ts = threadTs
    ? await postThreadReply(token, bugsChannel, threadTs, message, blocks)
    : await postMessage(token, bugsChannel, message, blocks);
  logger.info('On-Call bug report posted', {
    channel: bugsChannel,
    ts,
    threadTs: threadTs || null,
    ticketId: ticketId || null,
  });
  return {
    ok: true,
    ts,
    channel: bugsChannel,
  };
}

/**
 * Infra-style (SRE) incidents: each activates one of the app's built-in
 * incident scenarios (so the degradation is genuinely observable in latency,
 * logs, and error rates), posts a Datadog-monitor-style alert card to the
 * alerts channel, and auto-reverts to healthy after a window so the regular
 * demos are unaffected.
 */
function envNumber(value, fallback) {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

const INFRA_WINDOW_MS = envNumber(
  process.env.ONCALL_INFRA_WINDOW_MS || process.env.ONCALL_LATENCY_WINDOW_MS,
  10 * 60 * 1000,
);

/**
 * Per-run degradation registry: each activation is scoped to its run ref, so
 * only requests carrying that run's oncall_run cookie see the symptoms.
 * Concurrent runs are fully independent — nothing here touches the global
 * scenario slot used by the admin endpoint.
 */
const scopedInfra = new Map();

/**
 * Bounded, reversible memory-growth mode for the memory-leak incident.
 * Holds real allocated buffers so the process RSS genuinely climbs in
 * Datadog, but is strictly capped (ONCALL_MEMLEAK_CAP_MB, default 150MB)
 * well below the container limit and freed when the window ends.
 */
const MEMLEAK_CAP_MB = Math.min(envNumber(process.env.ONCALL_MEMLEAK_CAP_MB, 150), 300);
const MEMLEAK_CHUNK_MB = 8;
let memLeakChunks = [];
let memLeakInterval = null;

function startMemoryGrowth(windowMs) {
  stopMemoryGrowth();
  const steps = Math.max(1, Math.floor(MEMLEAK_CAP_MB / MEMLEAK_CHUNK_MB));
  const intervalMs = Math.max(2000, Math.floor(windowMs / (steps + 1)));
  memLeakInterval = setInterval(() => {
    if (memLeakChunks.length >= steps) {
      clearInterval(memLeakInterval);
      memLeakInterval = null;
      return;
    }
    // fill(1) forces the OS to actually commit the pages so RSS rises
    memLeakChunks.push(Buffer.alloc(MEMLEAK_CHUNK_MB * 1024 * 1024, 1));
    logger.warn('Simulated memory growth', {
      heldMB: memLeakChunks.length * MEMLEAK_CHUNK_MB,
      capMB: MEMLEAK_CAP_MB,
      rssMB: Math.round(process.memoryUsage().rss / 1024 / 1024),
    });
  }, intervalMs);
  if (memLeakInterval.unref) memLeakInterval.unref();
}

/**
 * A browser carries a single oncall_run cookie, so a new trigger replaces
 * the caller's previous run. Revert the old run's degradation so nothing is
 * left silently active with no cookie pointing at it. A prior SEV-1's
 * Datadog incident keeps its own auto-resolve timer.
 */
function supersedePriorRun(newRunRef) {
  const prior = getOncallRunRef();
  if (prior && prior !== newRunRef) {
    revertScopedInfra(prior, 'superseded by a new run from the same browser');
    clearOncallConfigOverride(prior, 'superseded by a new run from the same browser');
  }
}

function revertScopedInfra(runRef, reason) {
  const entry = scopedInfra.get(runRef);
  if (!entry) return;
  if (entry.timer) clearTimeout(entry.timer);
  if (entry.scenario) clearScopedScenario(runRef);
  scopedInfra.delete(runRef);
  clearOncallConfigOverride(runRef, reason);
  // Memory growth is inherently process-wide (RSS); release it only once no
  // other live run still needs it.
  if (entry.memoryGrowth && !Array.from(scopedInfra.values()).some((e) => e.memoryGrowth)) {
    stopMemoryGrowth();
  }
  logger.info('On-Call infra incident state reverted to healthy', { runRef, reason });
}

function stopMemoryGrowth() {
  if (memLeakInterval) clearInterval(memLeakInterval);
  memLeakInterval = null;
  if (memLeakChunks.length > 0) {
    memLeakChunks = [];
    if (global.gc) global.gc();
    logger.info('Simulated memory growth released', {
      rssMB: Math.round(process.memoryUsage().rss / 1024 / 1024),
    });
  }
}

const INFRA_INCIDENTS = {
  latency: {
    scenario: 'slow-db',
    owner: 'Riley Chen (platform-oncall)',
    build(now) {
      const p95 = (2.1 + Math.random() * 1.2).toFixed(2);
      const baseline = (0.18 + Math.random() * 0.08).toFixed(2);
      return {
        title: ':warning: [Triggered] p95 latency spike — checkout-api endpoints',
        monitor: '`avg(last_5m):p95:trace.express.request{service:checkout-api} > 2` — *Triggered*',
        fields: [
          ['Current p95', `${p95}s (baseline ${baseline}s)`],
          ['Affected endpoints', 'GET /search, POST /checkout'],
        ],
        symptoms: `GET /search and POST /checkout requests are slow; app logs show "Slow search query" and "Slow database query detected" warnings with 1500–3000ms query times. Error rate is normal — this is a latency degradation, not an outage. First: ${new Date(now.getTime() - 6 * 60000).toISOString()} | Last: ${now.toISOString()}`,
        instruction: `Investigate the slow query paths in app/routes/search.js, app/services/search.js, app/routes/checkout.js, and app/services/checkout.js. Repo: ${REPO_URL}`,
      };
    },
  },
  'dependency-timeout': {
    scenario: 'dependency-timeout',
    owner: 'Riley Chen (platform-oncall)',
    build(now) {
      const timeoutPct = (26 + Math.random() * 10).toFixed(1);
      const p99 = (5.0 + Math.random() * 0.4).toFixed(2);
      return {
        title: ':hourglass_flowing_sand: [Triggered] payments-gateway timeouts — POST /checkout degraded',
        monitor: '`sum(last_10m):checkout.dependency_timeout{upstream:payments-gateway}.as_rate() > 0.2` — *Triggered*',
        fields: [
          ['Timeout rate', `${timeoutPct}% of checkout calls timing out against payments-gateway (5s deadline)`],
          ['Current p99 on POST /checkout', `${p99}s`],
          ['Blast radius', 'intermittent — most checkouts succeed, affected users see a spinner then a 504'],
        ],
        symptoms: `App logs show "PaymentGatewayTimeoutError" bursts; upstream payments-gateway p50 looks normal, suggesting a connection-handling or timeout-budget issue on our side rather than a provider outage. First: ${new Date(now.getTime() - 9 * 60000).toISOString()} | Last: ${now.toISOString()}`,
        instruction: `Investigate the timeout handling in app/routes/checkout.js and app/services/checkout.js. Repo: ${REPO_URL}`,
      };
    },
  },
  'memory-leak': {
    scenario: 'healthy',
    memoryGrowth: true,
    owner: 'Riley Chen (platform-oncall)',
    build(now) {
      const baselineRss = Math.round(process.memoryUsage().rss / 1024 / 1024);
      return {
        title: ':chart_with_upwards_trend: [Triggered] memory growth — checkout-api',
        monitor: `\`avg(last_30m):system.mem.rss{service:checkout-api} > ${baselineRss + 50}MB\` — *Triggered*`,
        fields: [
          ['Current RSS', `${baselineRss}MB and climbing steadily (holding pattern expected ~flat)`],
          ['Projected', `+${MEMLEAK_CAP_MB}MB within the hour at current growth rate`],
          ['User impact', 'none yet — latency will creep up as heap pressure grows; OOM restart projected if unaddressed'],
        ],
        symptoms: `RSS climbs monotonically and never plateaus — consistent with an unbounded in-process cache or listener accumulation rather than load. First: ${new Date(now.getTime() - 20 * 60000).toISOString()} | Last: ${now.toISOString()}`,
        instruction: `Investigate in-process caches and per-request allocations that survive the request lifecycle. Repo: ${REPO_URL}`,
      };
    },
  },
  'slo-burn': {
    scenario: 'checkout-regression',
    owner: 'Riley Chen (platform-oncall)',
    build(now) {
      const burn = (12 + Math.random() * 5).toFixed(1);
      const errPct = (46 + Math.random() * 6).toFixed(1);
      return {
        title: ':rotating_light: [SLO] Fast burn — checkout availability error budget',
        monitor: `\`burn_rate(slo:checkout-availability-99.9, window:1h) > 14.4\` — *Fast burn: ${burn}x*`,
        fields: [
          ['SLO', 'checkout availability 99.9% (30d) — monthly error budget exhausted in < 2 days at this rate'],
          ['Error rate', `${errPct}% of POST /checkout requests failing (InventoryReservationError, TypeError)`],
        ],
        symptoms: `Intermittent checkout failures — a mix of inventory reservation conflicts and tax-calculation errors on roughly half of orders; retries succeed sometimes. Budget burn is what tripped this. First: ${new Date(now.getTime() - 32 * 60000).toISOString()} | Last: ${now.toISOString()}`,
        instruction: `Investigate the inventory reservation and tax calculation paths in app/services/checkout.js. Repo: ${REPO_URL}`,
      };
    },
  },
};

/**
 * Activate an infra incident's real degradation (scenario mode and/or memory
 * growth) with the standard auto-revert window. Returns true if any state
 * was activated.
 */
function activateInfraIncident(kind, windowMs = INFRA_WINDOW_MS, runRef) {
  const incident = INFRA_INCIDENTS[kind];
  if (!incident || !runRef) return false;
  if (incident.scenario === 'healthy' && !incident.memoryGrowth) return false;
  revertScopedInfra(runRef, 'superseded by new incident');
  const entry = {
    kind,
    scenario: null,
    memoryGrowth: Boolean(incident.memoryGrowth),
    revertAt: Date.now() + windowMs,
    timer: null,
  };
  if (incident.scenario !== 'healthy') {
    setScopedScenario(runRef, incident.scenario);
    entry.scenario = incident.scenario;
  }
  // Memory growth is process-wide RSS: keep it monotonic across concurrent
  // runs by only starting the allocator when no other live run holds it.
  if (incident.memoryGrowth && !Array.from(scopedInfra.values()).some((e) => e.memoryGrowth)) {
    startMemoryGrowth(windowMs);
  }
  entry.timer = setTimeout(() => {
    revertScopedInfra(runRef, `window elapsed for ${kind}`);
  }, windowMs);
  if (entry.timer.unref) entry.timer.unref();
  scopedInfra.set(runRef, entry);
  return true;
}

async function postOncallInfraIncident(kind = 'latency', options = {}) {
  const incident = INFRA_INCIDENTS[kind];
  if (!incident) {
    return { ok: false, error: `Unknown infra incident: ${kind}` };
  }

  const runRef = makeRunRef();
  const { token, alertsChannel } = resolveOncallEnv();
  if (!token || !alertsChannel) {
    logger.warn('On-Call alerts channel not configured — skipping infra alert');
    return { ok: false, error: 'SLACK_ONCALL_ALERTS_CHANNEL_ID or bot token not configured' };
  }

  supersedePriorRun(runRef);
  activateInfraIncident(kind, INFRA_WINDOW_MS, runRef);

  const triggeredBy = await resolveTriggeredBy(token, options.devinEmail);
  const now = new Date();
  const card = incident.build(now);
  const ownerLine = ownerRotation(incident.owner);
  const text = [
    `${card.title}`,
    `Monitor: ${card.monitor}`,
    ...card.fields.map(([label, value]) => `${label}: ${value}`),
    `Symptoms: ${card.symptoms}`,
    'Service: checkout-api | Env: production',
    `Owner: ${ownerLine}`,
    `Incident Ref: ${runRef}`,
    triggeredBy ? `Triggered by: ${triggeredBy}` : null,
    card.instruction,
  ].filter((l) => l !== null).join('\n');
  const blocks = [
    headerBlock(card.title),
    mrkdwnSection(`*Monitor:* ${card.monitor}`),
    ...fieldPairs([
      ...card.fields,
      ['Env', 'production'],
      ['Service', '`checkout-api`'],
      ['Owner', ownerLine],
      ['Incident Ref', runRef],
      triggeredBy ? ['Triggered by', triggeredBy] : null,
    ]),
    mrkdwnSection(`*Symptoms:* ${card.symptoms}`),
    mrkdwnSection(card.instruction),
    datadogActions(),
    contextBlock('checkout-api', triggeredBy),
  ];

  let ts;
  try {
    ts = await postMessage(token, alertsChannel, text, blocks);
  } catch (error) {
    // Keep observable state consistent with what was announced: if the alert
    // never posted, don't leave the app silently degraded for the full window.
    revertScopedInfra(runRef, 'infra alert post failed');
    throw error;
  }
  logger.info('On-Call infra incident posted', { kind, channel: alertsChannel, ts, runRef, windowMs: INFRA_WINDOW_MS });
  return {
    ok: true,
    ts,
    channel: alertsChannel,
    runRef,
    kind,
    scenario: incident.scenario,
    active: incident.scenario !== 'healthy' || Boolean(incident.memoryGrowth),
    windowMinutes: Math.round(INFRA_WINDOW_MS / 60000),
  };
}

/**
 * Live state for the /oncall page's health strip: current scenario, active
 * infra incident (and time remaining), and process memory.
 */
function getInfraState() {
  // Scoped to the caller: reports the degradation belonging to the run ref
  // on the request's oncall_run cookie (if any), never someone else's run.
  const runRef = getOncallRunRef();
  const entry = runRef ? scopedInfra.get(runRef) : null;
  return {
    scenario: getScenario(),
    runRef: entry ? runRef : null,
    activeKind: entry ? entry.kind : null,
    memoryGrowth: Boolean(entry && entry.memoryGrowth),
    heldMB: memLeakChunks.length * MEMLEAK_CHUNK_MB,
    rssMB: Math.round(process.memoryUsage().rss / 1024 / 1024),
    msRemaining: entry ? Math.max(0, entry.revertAt - Date.now()) : null,
  };
}

/**
 * Per-run runtime config overrides — the mitigation surface for the on-call
 * demos. A responder registers an override for their run ref (e.g. reverting
 * the compliance screening parameters); only requests scoped to that run see
 * it, and it auto-expires so the app returns to its shipped (degraded)
 * configuration for the next demo. The shipped config itself never changes.
 */
const CONFIG_OVERRIDE_FIELDS = {
  screeningWindowDays: { min: 1, max: 365 },
  // The concurrency ceiling keeps a brute-force parallelism bump from clearing
  // the recovery threshold on its own: at 5, the full 90-day window still
  // screens well above threshold (~2s), so the lookback regression must also
  // be fixed before the incident can confirm recovery.
  screeningConcurrency: { min: 1, max: 5 },
};
const CONFIG_OVERRIDE_TTL_MS = envNumber(process.env.ONCALL_CONFIG_OVERRIDE_TTL_MS, 45 * 60 * 1000);
// Overrides are keyed by caller-supplied run refs, so the registry is capped
// like the other per-run registries; the oldest override is evicted first.
const CONFIG_OVERRIDE_MAX = envNumber(process.env.ONCALL_CONFIG_OVERRIDE_MAX, 50);
const configOverrides = new Map();

function clearOncallConfigOverride(runRef, reason) {
  const entry = configOverrides.get(runRef);
  if (!entry) return;
  if (entry.timer) clearTimeout(entry.timer);
  configOverrides.delete(runRef);
  clearScopedConfig(runRef);
  logger.info('On-Call config override cleared', { runRef, reason });
}

function setOncallConfigOverride(runRef, patch) {
  if (!runRef || !/^[A-Za-z0-9-]+$/.test(runRef)) {
    return { ok: false, error: 'A valid runRef is required' };
  }
  const applied = {};
  for (const [field, value] of Object.entries(patch || {})) {
    if (!Object.prototype.hasOwnProperty.call(CONFIG_OVERRIDE_FIELDS, field)) continue;
    const spec = CONFIG_OVERRIDE_FIELDS[field];
    const n = Number(value);
    if (!Number.isInteger(n) || n < spec.min || n > spec.max) {
      return { ok: false, error: `${field} must be an integer between ${spec.min} and ${spec.max}` };
    }
    applied[field] = n;
  }
  if (Object.keys(applied).length === 0) {
    return { ok: false, error: `No recognized config fields. Supported: ${Object.keys(CONFIG_OVERRIDE_FIELDS).join(', ')}` };
  }

  // The override lives as long as the run it belongs to: an active infra
  // incident's remaining window, or the standard TTL otherwise.
  const infra = scopedInfra.get(runRef);
  const ttlMs = infra
    ? Math.max(60000, infra.revertAt - Date.now())
    : CONFIG_OVERRIDE_TTL_MS;

  const prior = configOverrides.get(runRef);
  if (prior && prior.timer) clearTimeout(prior.timer);
  while (!prior && configOverrides.size >= CONFIG_OVERRIDE_MAX) {
    const keys = Array.from(configOverrides.keys());
    // Prefer evicting overrides whose run has no live incident so an open
    // run's mitigation is only dropped as a last resort.
    const evict = keys.find((k) => !scopedInfra.has(k)) || keys[0];
    clearOncallConfigOverride(evict, 'override registry at capacity');
  }
  setScopedConfig(runRef, applied);
  const timer = setTimeout(() => {
    clearOncallConfigOverride(runRef, 'override TTL elapsed');
  }, ttlMs);
  if (timer.unref) timer.unref();
  configOverrides.set(runRef, {
    fields: { ...((prior && prior.fields) || {}), ...applied },
    timer,
    expiresAt: Date.now() + ttlMs,
  });
  logger.info('On-Call config override set', { runRef, applied, ttlMs });
  return {
    ok: true,
    runRef,
    applied,
    fields: configOverrides.get(runRef).fields,
    expiresAt: new Date(Date.now() + ttlMs).toISOString(),
  };
}

/**
 * Effective compliance config for the caller's run (or an explicit runRef):
 * shipped defaults with any live override applied.
 */
function getOncallConfigView(explicitRunRef) {
  const runRef = explicitRunRef || getOncallRunRef();
  const entry = runRef ? configOverrides.get(runRef) : null;
  const override = entry ? entry.fields : (explicitRunRef ? {} : getScopedConfig());
  return {
    runRef: runRef || null,
    defaults: { ...COMPLIANCE_DEFAULTS },
    override,
    effective: { ...COMPLIANCE_DEFAULTS, ...override },
    overrideExpiresAt: entry ? new Date(entry.expiresAt).toISOString() : null,
  };
}

function isPlainObject(value) {
  return value !== null &&
    typeof value === 'object' &&
    !Array.isArray(value) &&
    (Object.getPrototypeOf(value) === Object.prototype ||
      Object.getPrototypeOf(value) === null);
}

module.exports = {
  ALERT_SCENARIOS,
  postOncallAlert,
  postOncallBugReport,
  INFRA_INCIDENTS,
  postOncallInfraIncident,
  getInfraState,
  isPlainObject,
  buildOncallSessionPrompt,
  setOncallConfigOverride,
  getOncallConfigView,
};
