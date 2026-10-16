const { v4: uuidv4 } = require('uuid');
const logger = require('../../telemetry/logger');
const { incrementMetric, recordTiming } = require('../../telemetry/datadog');
const { Sentry } = require('../../telemetry/sentry');
const { postMessage, postThreadReply, lookupSlackUserByEmail } = require('../slack');
const { createDevinSession } = require('../devin-api');
const { declareDatadogIncident } = require('../datadog-incidents');
const { canCreateSession, reserveSession } = require('../session-rate-limiter');

const ROUTE = '/api/f86cc1c6/mobile-order';
const SERVICE = 'customer-f86cc1c6-mobile-order';
const BOOKING_ROUTE = '/api/f86cc1c6/resort-booking';
const BOOKING_SERVICE = 'customer-f86cc1c6-resort-booking';
const SLACK_MEMBER_ID = process.env.MDE_SLACK_MEMBER_ID || 'U0BCD812VA5';
const DEFAULT_RESTAURANT = 'cosmic-rays';
const MAX_QTY = 10;

const RESTAURANTS = {
  'cosmic-rays': {
    id: 'cosmic-rays', name: "Cosmic Ray's Starlight Café", park: 'Magic Kingdom', land: 'Tomorrowland',
    menuName: 'Lunch And Dinner Menu', arrivalWindow: 'Now - 2:40 PM', cuisine: 'American', distance: '0.2 mi',
  },
  'pecos-bill': {
    id: 'pecos-bill', name: 'Pecos Bill Tall Tale Inn and Cafe', park: 'Magic Kingdom', land: 'Frontierland',
    menuName: 'Lunch And Dinner Menu', arrivalWindow: 'Now - 2:55 PM', cuisine: 'Tex-Mex', distance: '0.4 mi',
  },
  'columbia-harbour': {
    id: 'columbia-harbour', name: 'Columbia Harbour House', park: 'Magic Kingdom', land: 'Liberty Square',
    menuName: 'Lunch And Dinner Menu', arrivalWindow: 'Now - 2:35 PM', cuisine: 'Seafood', distance: '0.3 mi',
  },
};

const CATEGORIES = [
  { id: 'entrees', name: 'Entrées' },
  { id: 'plant-based', name: 'Plant-Based' },
  { id: 'sides', name: 'Sides' },
  { id: 'holiday-seasonal', name: 'Holiday Treats' },
  { id: 'desserts', name: 'Desserts' },
  { id: 'beverages', name: 'Beverages' },
];

const MENU = [
  { id: 'cr1', restaurantId: 'cosmic-rays', category: 'entrees', name: 'Triple-B Burger', price: 12.99, description: 'Angus Beef Patty with Bacon, Cheddar Spread, Crispy Onions, and Cherry-Barbecue Sauce on a Brioche Bun served with French Fries' },
  { id: 'cr2', restaurantId: 'cosmic-rays', category: 'entrees', name: 'Rotisserie Chicken', price: 14.49, description: 'Half Chicken served with Green Beans and Mashed Potatoes' },
  { id: 'cr3', restaurantId: 'cosmic-rays', category: 'entrees', name: 'Chicken Nuggets', price: 11.29, description: 'Ten crispy nuggets served with French Fries and choice of dipping sauce' },
  { id: 'cr4', restaurantId: 'cosmic-rays', category: 'entrees', name: 'Bacon Cheeseburger', price: 12.79, description: '1/3-lb Angus Chuck Cheeseburger with Bacon served with French Fries' },
  { id: 'cr6', restaurantId: 'cosmic-rays', category: 'plant-based', name: 'Plant-based Greek Salad', price: 10.99, description: 'Romaine, Plant-based Feta, Olives, Tomato, Cucumber, Red Onion and Greek Dressing' },
  { id: 'cr7', restaurantId: 'cosmic-rays', category: 'plant-based', name: 'Plant-based Burger', price: 12.49, description: 'Plant-based Patty with Lettuce, Tomato and Onion served with Apple Slices' },
  { id: 'cr9', restaurantId: 'cosmic-rays', category: 'sides', name: 'French Fries', price: 5.29, description: 'Seasoned crispy fries' },
  { id: 'cr10', restaurantId: 'cosmic-rays', category: 'sides', name: 'Onion Rings', price: 5.79, description: 'Golden battered rings with Barbecue Sauce' },
  { id: 'cr20', restaurantId: 'cosmic-rays', category: 'holiday-seasonal', name: 'Gingerbread Cookie Shake', price: 7.49, description: 'Gingerbread Soft-serve blended with Cookie Crumbles, topped with Whipped Cream and a Mini Gingerbread Mickey', seasonal: true },
  { id: 'cr21', restaurantId: 'cosmic-rays', category: 'holiday-seasonal', name: 'Peppermint Starlight Cupcake', price: 6.29, description: 'Chocolate Cupcake with Peppermint Buttercream and a Star-shaped Sugar Cookie', seasonal: true },
  { id: 'cr13', restaurantId: 'cosmic-rays', category: 'desserts', name: 'Chocolate Cake', price: 5.49, description: 'Rich layered chocolate cake' },
  { id: 'cr15', restaurantId: 'cosmic-rays', category: 'beverages', name: 'Fountain Beverage', price: 4.29, description: 'Assorted Coca-Cola fountain beverages' },
  { id: 'cr16', restaurantId: 'cosmic-rays', category: 'beverages', name: 'Bottled Water', price: 3.75, description: 'Dasani bottled water' },
  { id: 'pb1', restaurantId: 'pecos-bill', category: 'entrees', name: 'Fajita Platter', price: 14.99, description: 'Chicken Fajitas with Seasoned Rice, Beans, Lettuce, Pico de Gallo and Flour Tortillas' },
  { id: 'pb2', restaurantId: 'pecos-bill', category: 'entrees', name: 'Burrito Bowl', price: 13.49, description: 'Seasoned Rice, Beans, Pico de Gallo, Sour Cream and your choice of protein' },
  { id: 'pb9', restaurantId: 'pecos-bill', category: 'sides', name: 'Chips and Salsa', price: 4.99, description: 'Tortilla Chips with House-made Salsa' },
  { id: 'pb15', restaurantId: 'pecos-bill', category: 'beverages', name: 'Fountain Beverage', price: 4.29, description: 'Assorted Coca-Cola fountain beverages' },
  { id: 'ch1', restaurantId: 'columbia-harbour', category: 'entrees', name: 'Fried Shrimp Basket', price: 15.49, description: 'Fried Shrimp served with French Fries and Coleslaw' },
  { id: 'ch2', restaurantId: 'columbia-harbour', category: 'entrees', name: 'Lobster Roll', price: 19.99, description: 'Chilled Lobster Salad on a Toasted Roll served with Chips' },
  { id: 'ch9', restaurantId: 'columbia-harbour', category: 'sides', name: 'New England Clam Chowder', price: 6.49, description: 'Creamy clam chowder in a bread bowl' },
  { id: 'ch15', restaurantId: 'columbia-harbour', category: 'beverages', name: 'Fountain Beverage', price: 4.29, description: 'Assorted Coca-Cola fountain beverages' },
];

// Kitchen display (KDS) routing: menu category → prep station. Kept in step
// with the menu by hand. The Holiday Treats category went live through
// menu-sync MENU-4471 for the Dec 2025 holiday window.
const PREP_STATIONS = {
  entrees: { station: 'GRILL', kdsScreen: 'KDS-1', prepMinutes: 9 },
  'plant-based': { station: 'GRILL-PB', kdsScreen: 'KDS-2', prepMinutes: 8 },
  sides: { station: 'FRY', kdsScreen: 'KDS-3', prepMinutes: 4 },
  desserts: { station: 'COLD', kdsScreen: 'KDS-4', prepMinutes: 2 },
  beverages: { station: 'BEV', kdsScreen: 'KDS-5', prepMinutes: 1 },
};

const SALES_TAX_RATE = 0.065;

function remediationDirective(flow) {
  return [
    '*Repository to investigate and fix:* `COG-GTM/event-driven-devin`',
    '',
    `The failing code path is the Walt Disney World "${flow.action}" call:`,
    ...flow.files,
    '- Page: `app/public/verticals/f86cc1c6.html` (served at `/f86cc1c6`)',
    '',
    'Preserve existing behavior for every resort, restaurant and category.',
    `Run \`npm run lint\` and \`npx jest tests/f86cc1c6-mobile-order.test.js\`, ${flow.test}`,
    'Open a pull request against `main` with the fix.',
  ].join('\n');
}

function validationError(message, code, statusCode = 400) {
  const error = new Error(message);
  error.name = 'ValidationError';
  error.code = code;
  error.statusCode = statusCode;
  return error;
}

function resolveRestaurant(restaurantId) {
  const restaurant = RESTAURANTS[String(restaurantId || DEFAULT_RESTAURANT).toLowerCase()];
  if (!restaurant) throw validationError('Mobile Order is not available at this location.', 'RESTAURANT_NOT_FOUND', 404);
  return restaurant;
}

function getMenu(restaurantId) {
  const restaurant = resolveRestaurant(restaurantId);
  const items = MENU.filter((item) => item.restaurantId === restaurant.id);
  const categories = CATEGORIES
    .map((category) => ({ ...category, items: items.filter((item) => item.category === category.id) }))
    .filter((category) => category.items.length);
  return { restaurant, categories, restaurants: Object.values(RESTAURANTS) };
}

function resolveLines(restaurant, items) {
  if (!Array.isArray(items) || !items.length) throw validationError('Your bag is empty.', 'EMPTY_BAG');
  return items.map((line) => {
    const item = MENU.find((entry) => entry.id === (line && line.id) && entry.restaurantId === restaurant.id);
    if (!item) throw validationError('An item in your bag is no longer available.', 'ITEM_UNAVAILABLE');
    const qty = Number(line.qty);
    if (!Number.isInteger(qty) || qty < 1 || qty > MAX_QTY) throw validationError('Choose a quantity between 1 and 10.', 'INVALID_QUANTITY');
    return { item, qty };
  });
}

function routeToKitchen(lines) {
  return lines.map((line) => ({ ...line, station: PREP_STATIONS[line.item.category] }));
}

function estimateReadyWindow(tickets) {
  const longest = Math.max(...tickets.map((ticket) => ticket.station.prepMinutes));
  const parallelLoad = tickets.reduce((sum, ticket) => sum + ticket.qty, 0) > 4 ? 3 : 0;
  return longest + parallelLoad;
}

function priceOrder(lines) {
  const subtotal = lines.reduce((sum, line) => sum + line.item.price * line.qty, 0);
  const tax = Math.round(subtotal * SALES_TAX_RATE * 100) / 100;
  return { subtotal: Math.round(subtotal * 100) / 100, tax, total: Math.round((subtotal + tax) * 100) / 100 };
}

const REPO_NAME = 'COG-GTM/event-driven-devin';
const REPO_URL = `https://github.com/${REPO_NAME}`;
const DD_URL = () => process.env.DD_DASHBOARD_URL || 'https://app.datadoghq.com';
const DEMO_BASE_URL = () =>
  (process.env.ONCALL_DEMO_BASE_URL || `https://${process.env.DOMAIN_NAME || 'devindemos.com'}`).replace(/\/$/, '');
const FLOWS = {
  booking: {
    route: BOOKING_ROUTE,
    service: BOOKING_SERVICE,
    metric: 'resort_booking.book_failure',
    team: 'resorts-reservations-oncall',
    repro: 'Places to Stay → Disney\'s Lakeshore Lodge → Book Now',
    action: 'Book Now',
    files: ['- Service: `app/services/verticals/f86cc1c6.js` (`bookResortStay`)', '- Route: `app/routes/verticals/f86cc1c6.js`'],
    test: 'and verify that Book Now on the pre-filled Lakeshore Lodge stay at `/f86cc1c6` returns a confirmation number.',
  },
  mobileOrder: {
    route: ROUTE,
    service: SERVICE,
    metric: 'mobile_order.submit_failure',
    team: 'parks-dining-oncall',
    repro: 'Dining → Cosmic Ray\'s Starlight Café → Your Bag → Submit Order',
    action: 'Submit Order',
    files: ['- Service: `app/services/verticals/f86cc1c6.js` (`submitMobileOrder`)', '- Route: `app/routes/verticals/f86cc1c6.js`'],
    test: 'and verify that Submit Order on the pre-filled bag at `/f86cc1c6` returns an order number.',
  },
};

function monitorFor(flow) {
  return {
    name: `5xx rate — POST ${flow.route}`,
    query: `sum(last_5m):sum:${flow.metric}{route:${flow.route}}.as_count() > 0`,
    threshold: '> 0 failures / 5m',
    baseline: '0 (7-day)',
    team: flow.team,
  };
}
const EMAIL_RE = /^[A-Za-z0-9._%+-]{1,64}@[A-Za-z0-9.-]{1,190}$/;
const DEVIN_ORG_ID_RE = /^[A-Za-z0-9_-]{1,64}$/;
const DEVIN_USER_ID_RE = /^[A-Za-z0-9_|.@+-]{1,128}$/;

function resolveOncallEnv() {
  return {
    token: process.env.SLACK_ONCALL_BOT_TOKEN || process.env.SLACK_BOT_TOKEN,
    alertsChannel: process.env.SLACK_ONCALL_ALERTS_CHANNEL_ID,
  };
}

async function resolveTriggeredBy(token, email) {
  if (!email || !EMAIL_RE.test(email)) return null;
  try {
    const memberId = await lookupSlackUserByEmail(token, email);
    return memberId ? `<@${memberId}>` : email;
  } catch (lookupError) {
    logger.warn('MDE triggered-by Slack lookup failed', { error: lookupError.message });
    return email;
  }
}

function fieldPairs(pairs) {
  const fields = pairs
    .filter((pair) => pair && pair[1])
    .map(([label, value]) => ({ type: 'mrkdwn', text: `*${label}:*\n${value}` }));
  const blocks = [];
  for (let i = 0; i < fields.length; i += 2) blocks.push({ type: 'section', fields: fields.slice(i, i + 2) });
  return blocks;
}

function buildAlertBlocks(facts) {
  const MONITOR = monitorFor(facts.flow);
  return [
    { type: 'header', text: { type: 'plain_text', text: `:rotating_light: [Triggered] ${MONITOR.name}`, emoji: true } },
    ...fieldPairs([
      ['Service', `${facts.flow.service} (Walt Disney World)`],
      ['Endpoint', `POST ${facts.flow.route}`],
      ['Error', `\`${facts.errorText}\``],
      [facts.contextLabel, facts.contextValue],
      ['Threshold', MONITOR.threshold],
      ['Baseline', MONITOR.baseline],
      ['Release', facts.release],
      ['On-Call', `<@${SLACK_MEMBER_ID}> (${MONITOR.team})`],
      ['Incident Ref', facts.runRef],
      facts.triggeredBy ? ['Triggered by', facts.triggeredBy] : null,
    ]),
    { type: 'section', text: { type: 'mrkdwn', text: `*Monitor query:*\n\`\`\`${MONITOR.query}\`\`\`` } },
    { type: 'section', text: { type: 'mrkdwn', text: `Demo page: ${DEMO_BASE_URL()}/f86cc1c6\nRepo: ${REPO_URL}` } },
    { type: 'actions', elements: [{ type: 'button', text: { type: 'plain_text', text: ':bar_chart: View in Datadog', emoji: true }, url: DD_URL() }] },
    {
      type: 'context',
      elements: [{
        type: 'mrkdwn',
        text: [`Service: \`${facts.flow.service}\``, new Date().toISOString(), facts.triggeredBy ? `Triggered by ${facts.triggeredBy}` : null]
          .filter(Boolean).join(' | '),
      }],
    },
  ];
}

function buildAlertText(facts) {
  const MONITOR = monitorFor(facts.flow);
  return [
    `:rotating_light: *[Triggered] ${MONITOR.name}*`,
    `*Service:* ${facts.flow.service} (Walt Disney World) | *Error:* ${facts.errorText}`,
    `*On-Call:* <@${SLACK_MEMBER_ID}> | *Incident Ref:* ${facts.runRef}`,
  ].join('\n');
}

function buildSessionPrompt(facts, { channel, threadTs }) {
  const mention = `<@${SLACK_MEMBER_ID}>`;
  const MONITOR = monitorFor(facts.flow);
  return [
    `A Datadog monitor is firing on ${facts.flow.service}. Investigate it and open a PR with the fix.`,
    '',
    `*Monitor:* ${MONITOR.name} — Triggered`,
    `*Query:* \`${MONITOR.query}\``,
    `*Error:* ${facts.errorText}`,
    `*Failing request:* ${facts.flow.action} — ${facts.contextValue}, request ${facts.requestId}`,
    `*Release:* ${facts.release}`,
    `*Incident Ref:* ${facts.runRef}`,
    '',
    `Reproduce it at ${DEMO_BASE_URL()}/f86cc1c6 (${facts.flow.repro}).`,
    '',
    remediationDirective(facts.flow),
    '',
    `*Slack Thread:* channel=${channel} thread_ts=${threadTs}`,
    '',
    'Progress updates for the on-call engineer: reply in the Slack alert thread above twice — '
      + `(1) as soon as the root cause is confirmed, post ${mention} + the root cause in ≤3 lines; `
      + `(2) as soon as the fix PR is open, post ${mention} + the PR link + one line on how you verified. `
      + 'Post with `curl -s -X POST https://slack.com/api/chat.postMessage -H "Authorization: Bearer $SLACK_ONCALL_BOT_TOKEN" '
      + `-H 'Content-Type: application/json' -d '{"channel":"${channel}","thread_ts":"${threadTs}","text":"..."}'\` `
      + '(fall back to `$COG_GTM_DEMO_SLACK_BOT_TOKEN`; never print tokens). If neither is set, use the Devin `slack` tool with `thread_ts`.',
  ].join('\n');
}

function resolveSessionIdentity(requester = {}) {
  if (DEVIN_ORG_ID_RE.test(requester.devinOrgId || '')) {
    return {
      orgId: requester.devinOrgId,
      userId: DEVIN_USER_ID_RE.test(requester.devinUserId || '') ? requester.devinUserId : null,
    };
  }
  return {
    orgId: process.env.DEVIN_ONCALL_ORG_ID || process.env.DEVIN_ORG_ID,
    userId: process.env.DEVIN_ONCALL_USER_ID || null,
  };
}

async function triggerDevinSession(facts, { token, channel, threadTs, requester }) {
  const cap = canCreateSession();
  if (!cap.allowed) {
    logger.warn('MDE On-Call session creation throttled', { runRef: facts.runRef, ...cap });
    return null;
  }
  const release = reserveSession();
  let session = null;
  try {
    session = await createDevinSession(buildSessionPrompt(facts, { channel, threadTs }), {
      ...resolveSessionIdentity(requester),
      apiKey: process.env.DEVIN_ONCALL_SERVICE_KEY,
      title: `[On-Call] ${facts.runRef} ${monitorFor(facts.flow).name}`,
      repos: [REPO_NAME],
    });
  } catch (sessionError) {
    logger.error('MDE On-Call Devin session failed', { runRef: facts.runRef, error: sessionError.message });
  }
  if (!session) {
    release();
    return null;
  }
  logger.info('MDE On-Call Devin session created', { runRef: facts.runRef, sessionId: session.sessionId });
  try {
    await postThreadReply(token, channel, threadTs, `Devin is investigating: ${session.url}`, [
      { type: 'section', text: { type: 'mrkdwn', text: `:mag: *Devin is investigating this alert* — <${session.url}|View session>` } },
    ]);
  } catch (replyError) {
    logger.error('MDE session link reply failed', { runRef: facts.runRef, error: replyError.message });
  }
  return session;
}

/**
 * Post the #oncall-alerts monitor card for a failed booking / Mobile Order, declare a
 * SEV-2 Datadog incident and open the Devin session in the card's thread.
 */
async function raiseOncallAlert({ error, flow = FLOWS.mobileOrder, contextLabel, contextValue, requestId, requester = {} }) {
  const { token, alertsChannel } = resolveOncallEnv();
  if (!token || !alertsChannel) {
    logger.warn('On-Call alerts channel not configured — MDE alert not posted', { requestId });
    return { ok: false, skipped: true };
  }
  const facts = {
    runRef: `WDW-INC-${uuidv4().slice(0, 6).toUpperCase()}`,
    requestId,
    errorText: `${error.name}: ${error.message}`,
    flow,
    contextLabel,
    contextValue,
    release: process.env.SENTRY_RELEASE || 'wdw-web@26.10.2',
    triggeredBy: await resolveTriggeredBy(token, requester.devinEmail),
  };

  const threadTs = await postMessage(token, alertsChannel, buildAlertText(facts), buildAlertBlocks(facts));
  logger.info('Posting alert and triggering Devin', { runRef: facts.runRef, channel: alertsChannel, ts: threadTs });

  declareDatadogIncident({
    title: `Walt Disney World: ${monitorFor(flow).name}`,
    summary: `${flow.action} fails (${contextValue}) with ${facts.errorText}.`,
    runRef: facts.runRef,
    service: flow.service,
    triggeredBy: EMAIL_RE.test(requester.devinEmail || '') ? requester.devinEmail : 'f86cc1c6',
    repoUrl: REPO_URL,
    severity: 'SEV-2',
  }).catch((ddError) => logger.warn('Failed to declare Datadog incident for MDE', { error: ddError.message }));

  const session = threadTs
    ? await triggerDevinSession(facts, { token, channel: alertsChannel, threadTs, requester })
    : null;
  return { ok: true, runRef: facts.runRef, ts: threadTs, ...(session ? { sessionUrl: session.url } : {}) };
}

async function submitMobileOrder(data) {
  const startTime = Date.now();
  const requestId = `MO-${uuidv4().slice(0, 8).toUpperCase()}`;
  const restaurant = resolveRestaurant(data.restaurantId);
  const lines = resolveLines(restaurant, data.items);
  const itemCount = lines.reduce((sum, line) => sum + line.qty, 0);

  logger.info('Submitting MDE mobile order', {
    requestId, restaurantId: restaurant.id, itemCount, service: SERVICE, route: ROUTE,
  });

  try {
    await new Promise((resolve) => setTimeout(resolve, 250 + Math.random() * 250));

    const tickets = routeToKitchen(lines);
    const readyInMinutes = estimateReadyWindow(tickets);
    const totals = priceOrder(lines);
    const duration = Date.now() - startTime;

    incrementMetric('mobile_order.submit_success', { route: ROUTE, restaurant: restaurant.id });
    recordTiming('mobile_order.submit_latency', duration, { route: ROUTE });

    return {
      success: true,
      requestId,
      orderNumber: `MO-${Math.floor(10000 + Math.random() * 89999)}`,
      status: 'Submitted',
      restaurant: { id: restaurant.id, name: restaurant.name, land: restaurant.land },
      pickupWindow: data.arrivalWindow || restaurant.arrivalWindow,
      readyInMinutes,
      kitchen: tickets.map((t) => ({ item: t.item.name, qty: t.qty, station: t.station.station, kdsScreen: t.station.kdsScreen })),
      ...totals,
    };
  } catch (error) {
    const duration = Date.now() - startTime;

    incrementMetric('mobile_order.submit_failure', { route: ROUTE, restaurant: restaurant.id, errorClass: error.name });
    recordTiming('mobile_order.submit_latency', duration, { route: ROUTE, error: 'true' });

    logger.error('MDE mobile order failed to submit', {
      requestId, error: error.message, errorClass: error.name, durationMs: duration,
      restaurantId: restaurant.id, itemCount, service: SERVICE,
    });

    Sentry.captureException(error, {
      tags: { route: ROUTE, service: SERVICE, restaurant: restaurant.id, alert_path: 'instant' },
      extra: { requestId, itemIds: lines.map((line) => line.item.id), itemCount },
    });

    raiseOncallAlert({
      error, flow: FLOWS.mobileOrder, contextLabel: 'Restaurant', contextValue: `${restaurant.name} (${itemCount} items)`, requestId, requester: data,
    }).catch((alertError) => {
      logger.error('Failed to raise MDE On-Call alert', { error: alertError.message, requestId });
    });

    error.requestId = requestId;
    throw error;
  }
}

const IMG = 'https://cdn1.parksmedia.wdprapps.disney.com/resize/mwImage/1/900/450/75';
const RESORTS = {
  'lakeshore-lodge': {
    id: 'lakeshore-lodge', name: "Disney's Lakeshore Lodge", area: 'Magic Kingdom Resort Area', category: 'deluxe-signature',
    categoryLabel: 'Deluxe Resort', isNew: true, transport: 'Boat to Magic Kingdom Park',
    image: `${IMG}/vision-dam/digital/parks-platform/parks-global-assets/disney-world/resorts/lakeshore-lodge/overview/LL_PoolSide_Render_04_24_26-7x3-16x9.jpg`,
    blurb: 'A brand-new lakeside retreat on the shores of Bay Lake, steps from the magic of Magic Kingdom Park.',
    rooms: [
      { id: 'll-lake', name: 'Lodge Room – Lake View', sleeps: 5, beds: '2 Queen Beds and 1 Day Bed', nightly: 789 },
      { id: 'll-garden', name: 'Lodge Room – Garden View', sleeps: 5, beds: '2 Queen Beds and 1 Day Bed', nightly: 712 },
    ],
  },
  'grand-floridian': {
    id: 'grand-floridian', name: "Disney's Grand Floridian Resort & Spa", area: 'Magic Kingdom Resort Area', category: 'deluxe',
    categoryLabel: 'Deluxe Resort', transport: 'Monorail, Boat',
    image: `${IMG}/vision-dam/digital/parks-platform/parks-global-assets/disney-world/resorts/grand-floridian/0821ZM_0873SD_JRoh_R2-16x9.jpg`,
    blurb: 'Victorian elegance on the shores of the Seven Seas Lagoon.',
    rooms: [
      { id: 'gf-garden', name: 'Resort View Room', sleeps: 5, beds: '2 Queen Beds and 1 Day Bed', nightly: 899 },
      { id: 'gf-lagoon', name: 'Theme Park View Room', sleeps: 5, beds: '2 Queen Beds and 1 Day Bed', nightly: 1049 },
    ],
  },
  polynesian: {
    id: 'polynesian', name: "Disney's Polynesian Village Resort", area: 'Magic Kingdom Resort Area', category: 'deluxe',
    categoryLabel: 'Deluxe Resort', transport: 'Monorail, Boat',
    image: `${IMG}/vision-dam/digital/parks-platform/parks-global-assets/disney-world/resorts/polynesian-resort/experience/0721ZU_0017KP-2-16x9.jpg`,
    blurb: 'South Pacific charm with white-sand beaches and views of the nighttime spectaculars.',
    rooms: [
      { id: 'py-std', name: 'Standard View Room', sleeps: 5, beds: '2 Queen Beds and 1 Day Bed', nightly: 829 },
      { id: 'py-lagoon', name: 'Lagoon View Room', sleeps: 5, beds: '2 Queen Beds and 1 Day Bed', nightly: 989 },
    ],
  },
  riviera: {
    id: 'riviera', name: "Disney's Riviera Resort", area: 'EPCOT Resort Area', category: 'deluxe-villa',
    categoryLabel: 'Disney Vacation Club Villas', transport: 'Disney Skyliner',
    image: `${IMG}/dam/disney-world/resorts/riviera-resort/overview/riviera-enterance-16x9.jpg`,
    blurb: 'European grandeur inspired by Walt Disney\u2019s travels along the Riviera.',
    rooms: [
      { id: 'rv-deluxe', name: 'Deluxe Studio – Preferred View', sleeps: 5, beds: '1 Queen Bed and 1 Sleeper Sofa', nightly: 712 },
    ],
  },
  'caribbean-beach': {
    id: 'caribbean-beach', name: "Disney's Caribbean Beach Resort", area: 'EPCOT Resort Area', category: 'moderate',
    categoryLabel: 'Moderate Resort', transport: 'Disney Skyliner, Bus',
    image: `${IMG}/vision-dam/digital/parks-platform/parks-global-assets/disney-world/resorts/caribbean-beach-resort/experience/0425ZM_0079OK_R1PW-5x2.jpg`,
    blurb: 'Island-inspired villages around a 45-acre lake.',
    rooms: [
      { id: 'cb-std', name: 'Standard Room', sleeps: 5, beds: '2 Queen Beds and 1 Pull-Down Bed', nightly: 289 },
    ],
  },
  'pop-century': {
    id: 'pop-century', name: "Disney's Pop Century Resort", area: 'ESPN Wide World of Sports Area', category: 'value',
    categoryLabel: 'Value Resort', transport: 'Disney Skyliner, Bus',
    image: `${IMG}/vision-dam/digital/parks-platform/parks-global-assets/disney-world/resorts/disneys-pop-century-resort/experience/WDW_POP_PopShop_ExteriorAngle_BS-16x9.jpg`,
    blurb: 'Larger-than-life icons from the 1950s through the 1990s.',
    rooms: [
      { id: 'pc-std', name: 'Standard Room', sleeps: 4, beds: '2 Full Beds', nightly: 172 },
    ],
  },
};

// Deposit + cancellation rules per resort category, consumed by the payment
// scheduler. Lakeshore Lodge pre-sales introduced the new 'deluxe-signature'
// category through resort-catalog sync RES-2207; payment rules are owned by
// the Reservations Finance team and are released separately.
const DEPOSIT_POLICIES = {
  value: { depositNights: 1, balanceDueDays: 30, cancelFeeNights: 1 },
  moderate: { depositNights: 1, balanceDueDays: 30, cancelFeeNights: 1 },
  deluxe: { depositNights: 1, balanceDueDays: 30, cancelFeeNights: 1 },
  'deluxe-villa': { depositNights: 1, balanceDueDays: 30, cancelFeeNights: 1 },
};

const RESORT_TAX_RATE = 0.125;
const DEFAULT_STAY = { resortId: 'lakeshore-lodge', roomId: 'll-lake', checkIn: '2027-03-11', checkOut: '2027-03-15', adults: 2, children: 2 };

function listResorts() {
  return { resorts: Object.values(RESORTS), defaultStay: DEFAULT_STAY };
}

function parseStayDate(value) {
  const date = new Date(`${value}T00:00:00Z`);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(value)) || Number.isNaN(date.getTime()) || date.toISOString().slice(0, 10) !== value) {
    throw validationError('Choose valid check-in and check-out dates.', 'INVALID_DATES');
  }
  return date;
}

function resolveStay(data) {
  const resort = RESORTS[String(data.resortId || DEFAULT_STAY.resortId).toLowerCase()];
  if (!resort) throw validationError('This resort is not available for online booking.', 'RESORT_NOT_FOUND', 404);
  const room = resort.rooms.find((r) => r.id === (data.roomId || resort.rooms[0].id));
  if (!room) throw validationError('This room type is no longer available.', 'ROOM_UNAVAILABLE');
  const checkIn = parseStayDate(data.checkIn || DEFAULT_STAY.checkIn);
  const checkOut = parseStayDate(data.checkOut || DEFAULT_STAY.checkOut);
  const nights = Math.round((checkOut - checkIn) / 86400000);
  if (!Number.isFinite(nights) || nights < 1 || nights > 14) throw validationError('Choose a stay between 1 and 14 nights.', 'INVALID_DATES');
  const adults = Number(data.adults ?? DEFAULT_STAY.adults);
  const children = Number(data.children ?? DEFAULT_STAY.children);
  if (!Number.isInteger(adults) || !Number.isInteger(children) || adults < 1 || children < 0 || adults + children > room.sleeps) throw validationError(`This room sleeps up to ${room.sleeps} Guests.`, 'INVALID_PARTY');
  return { resort, room, checkIn, checkOut, nights, adults, children };
}

function priceStay(stay) {
  const roomTotal = stay.room.nightly * stay.nights;
  const tax = Math.round(roomTotal * RESORT_TAX_RATE * 100) / 100;
  return { nightly: stay.room.nightly, roomTotal, tax, total: Math.round((roomTotal + tax) * 100) / 100 };
}

function buildPaymentSchedule(stay, totals) {
  const policy = DEPOSIT_POLICIES[stay.resort.category];
  const depositDue = Math.round(totals.nightly * policy.depositNights * (1 + RESORT_TAX_RATE) * 100) / 100;
  const balanceDate = new Date(stay.checkIn.getTime() - policy.balanceDueDays * 86400000);
  return { depositDue, balanceDue: Math.round((totals.total - depositDue) * 100) / 100, balanceDueDate: balanceDate.toISOString().slice(0, 10) };
}

async function bookResortStay(data) {
  const startTime = Date.now();
  const requestId = `RES-${uuidv4().slice(0, 8).toUpperCase()}`;
  const stay = resolveStay(data || {});
  const tags = { route: BOOKING_ROUTE, resort: stay.resort.id };

  logger.info('Booking WDW resort stay', {
    requestId, resortId: stay.resort.id, roomId: stay.room.id, nights: stay.nights, service: BOOKING_SERVICE, route: BOOKING_ROUTE,
  });

  try {
    await new Promise((resolve) => setTimeout(resolve, 300 + Math.random() * 300));
    const totals = priceStay(stay);
    const schedule = buildPaymentSchedule(stay, totals);
    incrementMetric('resort_booking.book_success', tags);
    recordTiming('resort_booking.book_latency', Date.now() - startTime, tags);
    return {
      success: true,
      requestId,
      confirmationNumber: String(Math.floor(100000000 + Math.random() * 899999999)),
      resort: { id: stay.resort.id, name: stay.resort.name },
      room: stay.room.name,
      checkIn: stay.checkIn.toISOString().slice(0, 10),
      checkOut: stay.checkOut.toISOString().slice(0, 10),
      nights: stay.nights,
      ...totals,
      ...schedule,
    };
  } catch (error) {
    const duration = Date.now() - startTime;
    incrementMetric('resort_booking.book_failure', { ...tags, errorClass: error.name });
    recordTiming('resort_booking.book_latency', duration, { ...tags, error: 'true' });
    logger.error('WDW resort booking failed', {
      requestId, error: error.message, errorClass: error.name, durationMs: duration, resortId: stay.resort.id, service: BOOKING_SERVICE,
    });
    Sentry.captureException(error, {
      tags: { route: BOOKING_ROUTE, service: BOOKING_SERVICE, resort: stay.resort.id, alert_path: 'instant' },
      extra: { requestId, roomId: stay.room.id, nights: stay.nights },
    });
    raiseOncallAlert({
      error, flow: FLOWS.booking, contextLabel: 'Resort', contextValue: `${stay.resort.name} · ${stay.room.name} · ${stay.nights} nights`, requestId, requester: data,
    }).catch((alertError) => {
      logger.error('Failed to raise WDW booking On-Call alert', { error: alertError.message, requestId });
    });
    error.requestId = requestId;
    throw error;
  }
}

module.exports = {
  listResorts,
  bookResortStay,
  getMenu,
  submitMobileOrder,
  resolveRestaurant,
  raiseOncallAlert,
  MENU,
  CATEGORIES,
};
