/**
 * McDonald's McDelivery — order placement.
 *
 * Models the mcdonalds.order.online (DoorDash Commerce Platform) storefront:
 * menu lookup with meal modifiers (size / side / drink), delivery quote
 * (delivery fee, service fee, Chicago restaurant tax, driver tip) and the
 * Dasher handoff instructions that are generated for every delivery order.
 *
 * Intentional demo defect: "Leave it at my door" became the default
 * contactless drop-off option in `DROP_OFF_OPTIONS`, but the Dasher-side
 * `HANDOFF_PROTOCOLS` table was never extended for it. `resolveHandoffProtocol()`
 * therefore returns `undefined` for the default drop-off and
 * `buildDasherInstructions()` crashes reading `.photoRequired` off it.
 */
const { v4: uuidv4 } = require('uuid');
const logger = require('../../telemetry/logger');
const { incrementMetric, recordTiming } = require('../../telemetry/datadog');
const { Sentry } = require('../../telemetry/sentry');
const { createSessionAndAlert } = require('../devin-session');

const SERVICE = 'customer-2eb494c7-mcdelivery';
const ROUTE = '/api/2eb494c7/order';
const SLACK_MEMBER_ID = process.env.C2EB494C7_SLACK_MEMBER_ID || 'U08S7AVJ478';
const MAX_LINE_QTY = 25;
const MAX_CART_LINES = 20;
const MAX_TIP = 100;

const STORE = {
  id: '659312',
  name: "McDonald's (4061-CHGO-186 W. ADAMS)",
  address: '180 W Adams St, Chicago, IL 60603',
  menu: 'Dinner Menu',
  hours: '5:00 pm - 3:59 am',
  etaMinutes: [11, 21],
};

/** Chicago: 10.25% sales + 0.5% restaurant + 1% MPEA food & beverage. */
const TAX_RATE = 0.1175;
const DELIVERY_FEE = 2.99;
const SERVICE_FEE_RATE = 0.12;

const IMG = 'https://img.cdn4dd.com/p/fit=cover,width=1200,height=1200,format=auto,quality=70/media/photosV2/';

const SIZES = {
  medium: { code: 'medium', label: 'Medium', upcharge: 0 },
  large: { code: 'large', label: 'Large', upcharge: 1.2 },
};

const SIDES = {
  fries: { code: 'fries', label: 'French Fries', upcharge: 0, cal: 320 },
};

const DRINKS = {
  coke: { code: 'coke', label: 'Coke\u00ae', cal: 210, upcharge: 0 },
  sprite: { code: 'sprite', label: 'Sprite\u00ae', cal: 200, upcharge: 0 },
  'diet-coke': { code: 'diet-coke', label: 'Diet Coke\u00ae', cal: 0, upcharge: 0 },
  'dr-pepper': { code: 'dr-pepper', label: 'Dr Pepper\u00ae', cal: 200, upcharge: 0 },
  'sweet-tea': { code: 'sweet-tea', label: 'Sweet Iced Tea', cal: 130, upcharge: 0.2 },
  lemonade: { code: 'lemonade', label: 'Lemonade', cal: 190, upcharge: 1.1 },
  'caramel-frappe': { code: 'caramel-frappe', label: 'Caramel Frapp\u00e9', cal: 490, upcharge: 2.5 },
  'mocha-frappe': { code: 'mocha-frappe', label: 'Mocha Frapp\u00e9', cal: 490, upcharge: 2.5 },
  'sprite-berry-blast': { code: 'sprite-berry-blast', label: 'Sprite\u00ae Berry Blast', cal: 320, upcharge: 2.6 },
  'strawberry-watermelon': { code: 'strawberry-watermelon', label: 'Strawberry Watermelon Refresher', cal: 210, upcharge: 3.1 },
  'dirty-dr-pepper': { code: 'dirty-dr-pepper', label: 'Dirty Dr Pepper\u00ae', cal: 250, upcharge: 2.2 },
};

const MENU = [
  { sku: 'big-mac-meal', name: 'Big Mac\u00ae Meal', category: 'meals', price: 12.59, meal: true, rating: '77% (185)', image: `${IMG}58c4c0bc-1e9e-477c-8814-7682017c6f7a-retina-large.jpg`, description: '100% pure all beef patties and Big Mac\u00ae sauce sandwiched between a sesame seed bun. Topped off with pickles, crisp shredded lettuce, finely chopped onion, and a slice of American cheese. Served with our World Famous Fries and your choice of a fountain drink.' },
  { sku: 'qpc-meal', name: 'Quarter Pounder\u00ae with Cheese Meal', category: 'meals', price: 12.59, meal: true, rating: '69% (55)', image: `${IMG}aa47c38b-e069-495d-94e4-d5eda29ceb95-retina-large.jpg`, description: 'Served with a juicy Quarter Pounder with Cheese burger, our World Famous Fries\u00ae and your choice of an icy medium fountain drink.' },
  { sku: 'double-qpc-meal', name: 'Double Quarter Pounder\u00ae with Cheese Meal', category: 'meals', price: 15.59, meal: true, rating: '76% (50)', image: `${IMG}80d4c3f0-51ab-47d7-bb9f-db2b39884594-retina-large.jpg`, description: 'Get double the fresh beef flavor with a Double Quarter Pounder\u00ae with Cheese made with fresh beef that\u2019s cooked when you order. Served with our World Famous Fries\u00ae and your choice of an icy soft drink.' },
  { sku: '10pc-nuggets-meal', name: '10 pc. Chicken McNuggets\u00ae Meal', category: 'meals', price: 13.39, meal: true, rating: '71% (122)', image: `${IMG}cc77e58f-ae2c-4900-bae2-75feba59e7f4-retina-large.jpg`, description: '10 tender and delicious Chicken McNuggets made with all white meat chicken\u2014plus our World Famous Fries and your choice of a medium McDonald\u2019s Drink.' },
  { sku: '2-cheeseburger-meal', name: '2 Cheeseburger Meal', category: 'meals', price: 12.29, meal: true, rating: '72% (117)', image: `${IMG}f6a32d05-c463-496a-82fd-1b734bd9d069-retina-large.jpg`, description: '2 simple, satisfying classic McDonald\u2019s Cheeseburgers, served with our World Famous Fries\u00ae and your choice of a medium McDonald\u2019s soft drink.' },
  { sku: 'deluxe-mccrispy-meal', name: 'Deluxe McCrispy\u2122 Meal', category: 'meals', price: 13.39, meal: true, rating: '75% (12)', image: `${IMG}6150e805-fd14-4266-92d0-80fa9e28c9f8-retina-large.jpg`, description: 'Take crispy, juicy and tender to the next level with our Deluxe McCrispy\u2122 combo meal. Features shredded lettuce, Roma tomatoes and mayo topping southern style fried chicken. Served with our World Famous Fries\u00ae and your choice of an icy soft drink.' },
  { sku: 'filet-o-fish-meal', name: 'Filet-O-Fish\u00ae Meal', category: 'meals', price: 12.99, meal: true, rating: '68% (44)', image: `${IMG}98bdea37-1110-4e6b-b3a4-1f7ba91dbc94-retina-large.jpg`, description: 'A classic fish sandwich featuring a crispy fish filet patty made with wild-caught Alaskan Pollock on melty American cheese\u2014topped with creamy McDonald\u2019s tartar sauce, served on a soft, steamed bun, alongside World Famous Fries and your choice of an icy soft drink.' },
  { sku: 'big-mac', name: 'Big Mac\u00ae', category: 'burgers', price: 7.09, rating: '77% (185)', image: `${IMG}154bb9f6-9364-42ec-bb35-3340c2fd60c5-retina-large.jpg`, description: '100% pure all beef patties and Big Mac\u00ae sauce sandwiched between a sesame seed bun. Topped off with pickles, crisp shredded lettuce, finely chopped onion, and a slice of American cheese.' },
  { sku: 'qpc', name: 'Quarter Pounder\u00ae with Cheese', category: 'burgers', price: 7.09, rating: '75% (20)', image: `${IMG}d553151a-ed28-4a8d-b5ff-8b99f24b7c66-retina-large.jpg`, description: 'Features a \u00bc lb.* of 100% fresh beef that\u2019s hot, deliciously juicy and cooked when you order. Seasoned with just a pinch of salt and pepper, sizzled on a flat iron grill, then topped with slivered onions, tangy pickles and two slices of melty American cheese on a sesame seed bun.' },
  { sku: 'double-cheeseburger', name: 'Double Cheeseburger', category: 'burgers', price: 5.39, rating: '76% (126)', image: `${IMG}bf56fe28-8689-45cf-8d47-8e1944743734-retina-large.jpg`, description: 'Two 100% pure all beef patties seasoned with just a pinch of salt and pepper. Topped with tangy pickles, chopped onions, ketchup, mustard, and two melty American cheese slices.' },
  { sku: 'mcdouble', name: 'McDouble\u00ae', category: 'burgers', price: 4.49, rating: '73% (64)', image: `${IMG}c59d4a04-6ade-4c6b-ab5b-51b4efed7865-retina-large.jpg`, description: 'Two 100% pure beef patties seasoned with just a pinch of salt and pepper. Topped with tangy pickles, chopped onions, ketchup, mustard and a melty slice of American cheese.' },
  { sku: 'cheeseburger', name: 'Cheeseburger', category: 'burgers', price: 3.89, rating: '79% (34)', image: `${IMG}d0234d3c-2f3e-4d3f-af5b-9ef2cc603f61-retina-large.jpg`, description: 'Our simple, classic cheeseburger begins with a 100% pure beef burger patty seasoned with just a pinch of salt and pepper. Topped with a tangy pickle, chopped onions, ketchup, mustard, and a slice of melty American cheese.' },
  { sku: 'hamburger', name: 'Hamburger', category: 'burgers', price: 3.19, rating: '87% (8)', image: `${IMG}2c2aba05-08df-429c-a283-4885a4371043-retina-large.jpg`, description: '100% pure beef patty seasoned with just a pinch of salt and pepper. Topped with a tangy pickle, chopped onions, ketchup, and mustard.' },
  { sku: '10pc-nuggets', name: '10 pc. Chicken McNuggets\u00ae', category: 'chicken', price: 7.99, rating: '77% (175)', image: `${IMG}a7e536f2-3989-4c4c-8299-8d959dad0263-retina-large.jpg`, description: 'Tender, juicy Chicken McNuggets with your favorite dipping sauces.' },
  { sku: '6pc-nuggets', name: '6 pc. Chicken McNuggets\u00ae', category: 'chicken', price: 4.29, rating: '71% (96)', image: `${IMG}9b5e41f6-b5cb-41d3-b489-cbba9f743db6-retina-large.jpg`, description: '6 piece Chicken McNuggets\u00ae made with 100% chicken breast meat in a deliciously crispy coating, just waiting to be dipped.' },
  { sku: '20pc-nuggets', name: '20 pc. Chicken McNuggets\u00ae', category: 'chicken', price: 10.59, image: `${IMG}af2958fc-5413-4611-9971-898f767d6fd2-retina-large.jpg`, description: '20 piece Chicken McNuggets\u00ae made with 100% chicken breast meat. Perfect for sharing.' },
  { sku: 'mcchicken', name: 'McChicken\u00ae', category: 'chicken', price: 3.99, rating: '76% (77)', image: `${IMG}6ee20b1c-954d-459a-b661-6a071f26df3d-retina-large.jpg`, description: 'It\u2019s a classic for a reason. Savor the satisfying crunch of our juicy chicken patty, topped with shredded lettuce and just the right amount of creamy mayonnaise, all served on a perfectly toasted bun.' },
  { sku: 'hot-n-spicy-mcchicken', name: "Hot 'N Spicy McChicken\u00ae", category: 'chicken', price: 3.99, rating: '72% (110)', image: `${IMG}7872ab2c-d5f7-4c84-8f81-a235225f8337-retina-large.jpg`, description: 'Crispy, tender chicken seasoned with a bold mix of spices, topped with shredded lettuce, mayonnaise and served on a perfectly toasted bun.' },
  { sku: 'mccrispy', name: 'McCrispy\u2122', category: 'chicken', price: 7.89, image: `${IMG}ade2925d-c98b-47ec-b017-da0d587b6372-retina-large.jpg`, description: 'Southern-style fried chicken sandwich that\u2019s crispy, juicy and tender perfection. Topped with crinkle-cut pickles and served on a toasted, buttered potato roll.' },
  { sku: 'fries', name: 'French Fries', category: 'fries', price: 4.69, rating: '66% (314)', image: `${IMG}e9605793-87c9-47d0-909c-a94bf5f4ffdb-retina-large.jpg`, description: 'McDonald\u2019s World Famous Fries\u00ae made with premium potatoes. Crispy and golden on the outside and fluffy on the inside.' },
  { sku: 'basket-of-fries', name: 'Basket of Fries', category: 'fries', price: 8.29, image: `${IMG}0822f132-2d31-438f-9463-0f82644ddcde-retina-large.jpg`, description: 'A shareable basket of our World Famous Fries\u00ae.' },
  { sku: 'hamburger-happy-meal', name: 'Hamburger Happy Meal\u00ae', category: 'happy-meal', price: 6.69, image: `${IMG}2c114d10-d2b4-4ec0-87f4-18b4318d1209-retina-large.jpg`, description: 'A Hamburger, Kids Fries, Apple Slices, a choice of drink and a toy.' },
  { sku: 'red-bull-dragonberry', name: 'Red Bull\u00ae Dragonberry Energizer', category: 'mccafe', price: 6.69, image: `${IMG}76ed1f9f-4bb6-4dc7-b822-580415360686-retina-large.jpg`, description: 'Red Bull\u00ae Energy Drink with a burst of dragonfruit and berry, poured over ice.' },
  { sku: 'caramel-apple-pie-frappe', name: 'Caramel Apple Pie Frapp\u00e9', category: 'mccafe', price: 4.89, image: `${IMG}14b06218-6d24-4b29-bd75-68ae883df5d9-retina-large.jpg`, description: 'A limited-time frapp\u00e9 blended with caramel apple pie flavor and topped with whipped cream.' },
  { sku: 'strawberry-watermelon-refresher', name: 'Strawberry Watermelon Refresher', category: 'mccafe', price: 4.99, image: `${IMG}1c18def3-3b91-440f-b363-0edbc52a5f34-retina-large.jpg`, description: 'A refreshing blend of strawberry and watermelon flavors served over ice.' },
];

/** Drop-off options shown to the customer on the checkout page. */
const DROP_OFF_OPTIONS = {
  leave_at_door: { code: 'leave_at_door', label: 'Leave it at my door', contactless: true },
  hand_it_to_me: { code: 'hand_it_to_me', label: 'Hand it to me', contactless: false },
  meet_outside: { code: 'meet_outside', label: 'Meet outside', contactless: false },
};

/**
 * Dasher handoff protocol per drop-off option: how the Dasher confirms
 * the delivery and what the instructions card tells them to do.
 */
const HANDOFF_PROTOCOLS = {
  hand_it_to_me: { code: 'hand_it_to_me', confirmation: 'recipient', photoRequired: false, instruction: 'Hand the order to the customer and confirm the name on the receipt.' },
  meet_outside: { code: 'meet_outside', confirmation: 'recipient', photoRequired: false, instruction: 'Text the customer on arrival and wait outside the building entrance.' },
};

const PAYMENT_METHODS = {
  card: { code: 'card', label: 'Credit/Debit Card' },
  paypal: { code: 'paypal', label: 'PayPal' },
  venmo: { code: 'venmo', label: 'Venmo' },
};

const REMEDIATION_DIRECTIVE = [
  '*Repository to investigate and fix:* `COG-GTM/event-driven-devin`',
  '',
  'The failing code path is the McDonald\u2019s McDelivery order vertical:',
  '- Service: `app/services/verticals/2eb494c7.js`',
  '- Route: `app/routes/verticals/2eb494c7.js`',
  '- Page: `app/public/verticals/2eb494c7.html` (served at `/mcdelivery`)',
  '',
  'Open a pull request against `main` with the fix.',
].join('\n');

function round2(value) {
  return Math.round(value * 100) / 100;
}

function findItem(sku) {
  return MENU.find((item) => item.sku === sku) || null;
}

function validationError(message, code) {
  const err = new Error(message);
  err.code = code;
  err.status = 400;
  return err;
}

function resolveOption(table, code, fallbackCode, errorCode) {
  if (code === undefined || code === null || code === '') return table[fallbackCode];
  const option = Object.prototype.hasOwnProperty.call(table, code) ? table[code] : undefined;
  if (!option) throw validationError(`Unsupported ${errorCode.toLowerCase().replace(/_/g, ' ')}: ${code}`, errorCode);
  return option;
}

function resolveDropOff(code) {
  return resolveOption(DROP_OFF_OPTIONS, code, 'leave_at_door', 'DROP_OFF_OPTION');
}

function resolvePaymentMethod(code) {
  return resolveOption(PAYMENT_METHODS, code, 'card', 'PAYMENT_METHOD');
}

function resolveTip(tip) {
  if (tip === undefined || tip === null || tip === '') return 3.75;
  const amount = Number(tip);
  if (!Number.isFinite(amount) || amount < 0 || amount > MAX_TIP) {
    throw validationError(`Invalid driver tip: ${tip}`, 'INVALID_TIP');
  }
  return round2(amount);
}

function resolveSchedule(schedule) {
  if (!schedule || schedule === 'asap') return { mode: 'asap', eta: `${STORE.etaMinutes[0]} - ${STORE.etaMinutes[1]} mins` };
  if (typeof schedule !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/.test(schedule)) {
    throw validationError(`Invalid scheduled delivery window: ${schedule}`, 'INVALID_SCHEDULE');
  }
  return { mode: 'scheduled', eta: schedule };
}

function buildModifiers(item, selection) {
  if (!item.meal) return { size: null, side: null, drink: null, upcharge: 0, summary: [] };
  const size = resolveOption(SIZES, selection.size, 'medium', 'MEAL_SIZE');
  const side = resolveOption(SIDES, selection.side, 'fries', 'MEAL_SIDE');
  const drink = resolveOption(DRINKS, selection.drink, 'coke', 'MEAL_DRINK');
  return {
    size: size.code,
    side: side.code,
    drink: drink.code,
    upcharge: round2(size.upcharge + side.upcharge + drink.upcharge),
    summary: [size.label, side.label, drink.label],
  };
}

function buildCartLines(items) {
  if (!Array.isArray(items)) {
    throw validationError('Cart items must be an array', 'INVALID_CART');
  }
  if (items.length > MAX_CART_LINES) {
    throw validationError(`Cart may contain at most ${MAX_CART_LINES} lines`, 'CART_TOO_LARGE');
  }
  return items.map((entry) => {
    const item = findItem(entry && entry.sku);
    if (!item) {
      throw validationError(`Unknown menu item: ${entry && entry.sku}`, 'UNKNOWN_ITEM');
    }
    const qty = Number(entry.qty === undefined ? 1 : entry.qty);
    if (!Number.isSafeInteger(qty) || qty < 1 || qty > MAX_LINE_QTY) {
      throw validationError(`Invalid quantity for ${item.sku}`, 'INVALID_QUANTITY');
    }
    const modifiers = buildModifiers(item, entry.modifiers || {});
    const unitPrice = round2(item.price + modifiers.upcharge);
    return {
      sku: item.sku,
      name: item.name,
      category: item.category,
      qty,
      unitPrice,
      modifiers: modifiers.summary,
      lineTotal: round2(unitPrice * qty),
    };
  });
}

/**
 * Look up the Dasher handoff protocol for the customer's drop-off choice.
 * Returns `undefined` when no protocol is registered for the option.
 */
function resolveHandoffProtocol(dropOff) {
  return HANDOFF_PROTOCOLS[dropOff.code];
}

/**
 * Build the instructions card the Dasher sees at the door.
 */
function buildDasherInstructions(dropOff, address, note) {
  const protocol = resolveHandoffProtocol(dropOff);
  return {
    dropOff: dropOff.label,
    contactless: dropOff.contactless,
    photoRequired: protocol.photoRequired,
    confirmation: protocol.confirmation,
    instruction: note ? `${protocol.instruction} Customer note: ${note}` : protocol.instruction,
    address,
  };
}

function computeFees(subtotal) {
  const deliveryFee = DELIVERY_FEE;
  const serviceFee = round2(subtotal * SERVICE_FEE_RATE);
  const tax = round2((subtotal + deliveryFee + serviceFee) * TAX_RATE);
  return { deliveryFee, serviceFee, tax };
}

function buildOrderSummary({
  orderId, lines, dropOff, address, note, tip, schedule, paymentMethod,
}) {
  const subtotal = round2(lines.reduce((sum, line) => sum + line.lineTotal, 0));
  const fees = computeFees(subtotal);
  const total = round2(subtotal + fees.deliveryFee + fees.serviceFee + fees.tax + tip);
  const dasher = buildDasherInstructions(dropOff, address, note);

  return {
    orderId,
    orderNumber: `MCD-${orderId.slice(0, 8).toUpperCase()}`,
    store: { id: STORE.id, name: STORE.name },
    lines,
    subtotal,
    deliveryFee: fees.deliveryFee,
    serviceFee: fees.serviceFee,
    tax: fees.tax,
    tip,
    total,
    delivery: {
      address,
      mode: schedule.mode,
      eta: schedule.eta,
      dropOff: dropOff.label,
      dasher,
    },
    payment: paymentMethod.label,
    currency: 'USD',
    status: 'confirmed',
    createdAt: new Date().toISOString(),
  };
}

async function placeOrder(data) {
  const startTime = Date.now();
  const orderId = uuidv4();
  const lines = buildCartLines(data.items || []);
  if (lines.length === 0) {
    throw validationError('Your cart is empty', 'EMPTY_CART');
  }
  const dropOff = resolveDropOff(data.dropOff);
  const paymentMethod = resolvePaymentMethod(data.paymentMethod);
  const tip = resolveTip(data.tip);
  const schedule = resolveSchedule(data.schedule);
  const address = String(data.address || '233 S Wacker Dr, Chicago, IL 60606, USA').trim();
  const note = data.dropOffNote ? String(data.dropOffNote).trim().slice(0, 200) : '';

  logger.info('Placing McDelivery order', {
    orderId,
    storeId: STORE.id,
    lines: lines.length,
    dropOff: dropOff.code,
    schedule: schedule.mode,
    paymentMethod: paymentMethod.code,
    tip,
    service: SERVICE,
    route: ROUTE,
  });

  try {
    await new Promise((resolve) => setTimeout(resolve, 90 + Math.random() * 140));

    const summary = buildOrderSummary({
      orderId, lines, dropOff, address, note, tip, schedule, paymentMethod,
    });

    const duration = Date.now() - startTime;
    incrementMetric('mcdelivery_order.success', { route: ROUTE, drop_off: dropOff.code, schedule: schedule.mode });
    recordTiming('mcdelivery_order.latency', duration, { route: ROUTE });

    logger.info('McDelivery order confirmed', {
      orderId,
      orderNumber: summary.orderNumber,
      total: summary.total,
      eta: summary.delivery.eta,
      durationMs: duration,
      service: SERVICE,
    });

    return summary;
  } catch (error) {
    const duration = Date.now() - startTime;

    incrementMetric('mcdelivery_order.failure', {
      route: ROUTE,
      errorClass: error.name,
      drop_off: dropOff.code,
      schedule: schedule.mode,
    });
    recordTiming('mcdelivery_order.latency', duration, { route: ROUTE, error: 'true' });

    logger.error('McDelivery order failed', {
      orderId,
      error: error.message,
      errorClass: error.name,
      durationMs: duration,
      storeId: STORE.id,
      dropOff: dropOff.code,
      schedule: schedule.mode,
      paymentMethod: paymentMethod.code,
      lines: lines.length,
      skus: lines.map((line) => line.sku),
      service: SERVICE,
    });

    Sentry.captureException(error, {
      tags: {
        route: ROUTE,
        service: SERVICE,
        drop_off: dropOff.code,
        schedule: schedule.mode,
      },
      extra: {
        orderId,
        storeId: STORE.id,
        dropOff: dropOff.code,
        paymentMethod: paymentMethod.code,
        lines: lines.length,
        skus: lines.map((line) => line.sku),
      },
    });

    createSessionAndAlert({
      issueTitle: `${error.name}: ${error.message}`,
      issueUrl: `https://${process.env.SENTRY_ORG_SLUG || 'sentry-org'}.sentry.io/issues/?project=${process.env.SENTRY_PROJECT_ID || ''}&query=is%3Aunresolved`,
      culprit: 'app/services/verticals/2eb494c7.js \u2014 buildDasherInstructions',
      errorType: error.name || 'Error',
      errorValue: error.message,
      devinUserId: data.devinUserId,
      devinEmail: data.devinEmail,
      devinOrgId: data.devinOrgId,
      slackMemberId: data.devinEmail ? '' : SLACK_MEMBER_ID,
      slackMemberIdFallback: SLACK_MEMBER_ID,
      service: SERVICE,
      verticalLabel: "McDonald's McDelivery",
      promptAppendix: REMEDIATION_DIRECTIVE,
      customer: '2eb494c7',
      level: 'error',
      platform: 'node',
      tags: [
        { key: 'route', value: ROUTE },
        { key: 'service', value: SERVICE },
        { key: 'drop_off', value: dropOff.code },
        { key: 'schedule', value: schedule.mode },
      ],
      extra: {
        orderId,
        storeId: STORE.id,
        dropOff: dropOff.code,
        paymentMethod: paymentMethod.code,
        lines: lines.length,
        skus: lines.map((line) => line.sku),
      },
    }).catch((err) => {
      logger.error('Failed to create Devin session for McDelivery order error', {
        error: err.message,
        orderId,
      });
    });

    throw error;
  }
}

module.exports = {
  placeOrder,
  REMEDIATION_DIRECTIVE,
  STORE,
  MENU,
  SIZES,
  SIDES,
  DRINKS,
  DROP_OFF_OPTIONS,
  HANDOFF_PROTOCOLS,
  PAYMENT_METHODS,
  DELIVERY_FEE,
  SERVICE_FEE_RATE,
  TAX_RATE,
  buildCartLines,
  buildModifiers,
  resolveHandoffProtocol,
  buildDasherInstructions,
  computeFees,
  buildOrderSummary,
};
