const { v4: uuidv4 } = require('uuid');
const logger = require('../../telemetry/logger');
const { incrementMetric, recordTiming } = require('../../telemetry/datadog');
const { Sentry } = require('../../telemetry/sentry');
const { createSessionAndAlert } = require('../devin-session');

const SERVICE = 'customer-485ddc93-sympathy-store';
const ROUTE = '/api/485ddc93/orders';
const SLACK_MEMBER_ID = process.env.TRIBUTETECH_SLACK_MEMBER_ID || '';
const DELIVERY_FEE = 14.99;
const TAX_RATE = 0.07;

const HOME = {
  slug: 'hartwell',
  name: 'Hartwell Family Funeral Home',
  phone: '(203) 555-0142',
  address: '214 Elm Street, Millbrook, CT 06478',
  logo: '/verticals/485ddc93/hartwell-logo.svg',
};

const FLORISTS = [
  { name: 'Millbrook Blossoms', phone: '(203) 555-0131', priority: 1, deliversSameDay: true },
  { name: 'Petal & Stem Florist', phone: '(203) 555-0168', priority: 2, deliversSameDay: false },
];

const CATEGORY_DATA = [
  { slug: 'funeral-flowers', name: 'Funeral Flowers' },
  { slug: 'sympathy-arrangements', name: 'Sympathy Flowers' },
  { slug: 'plants', name: 'Plants' },
  { slug: 'memorial-trees', name: 'Memorial Trees' },
  { slug: 'gift-baskets', name: 'Sympathy Gift Baskets' },
];

const CATEGORIES = CATEGORY_DATA.map((category) => ({
  ...category,
  image: `/verticals/485ddc93/categories/${category.slug}.svg`,
}));

const PRODUCT_DATA = [
  ['eternal-grace-standing-spray', 1, 'Eternal Grace Standing Spray', 'A graceful display of white blooms arranged with soft greenery.', 'Standing Spray', 'service', 'White', true],
  ['heavenly-rose-standing-spray', 1, 'Heavenly Rose Standing Spray', 'Red roses and seasonal flowers create a heartfelt tribute.', 'Standing Spray', 'service', 'Red', true],
  ['peaceful-lavender-easel-spray', 1, 'Peaceful Lavender Easel Spray', 'Lavender and purple flowers bring a gentle, peaceful note.', 'Standing Spray', 'service', 'Purple', false],
  ['sunlit-memories-standing-spray', 1, 'Sunlit Memories Standing Spray', 'Golden blooms and fresh greens offer a warm remembrance.', 'Standing Spray', 'service', 'Yellow', true],
  ['white-lily-casket-spray', 1, 'Pure White Lily Casket Spray', 'Elegant white lilies with seasonal foliage in a full arrangement.', 'Casket Spray', 'service', 'White', false],
  ['classic-red-rose-casket-spray', 1, 'Classic Red Rose Casket Spray', 'Classic red roses set against a bed of rich green leaves.', 'Casket Spray', 'service', 'Red', false],
  ['garden-tribute-casket-spray', 1, 'Garden Tribute Casket Spray', 'A lush garden-inspired blend of seasonal flowers.', 'Casket Spray', 'service', 'Mixed', false],
  ['everlasting-remembrance-wreath', 1, 'Everlasting Remembrance Wreath', 'A traditional circular wreath with a thoughtful mix of flowers.', 'Wreath', 'service', 'Mixed', true],
  ['tender-heart-arrangement', 2, 'Tender Heart Sympathy Arrangement', 'Soft pink blossoms gathered in a graceful vase arrangement.', 'Arrangement', 'both', 'Pink', true],
  ['serene-blue-arrangement', 2, 'Serene Blue Arrangement', 'Blue and white flowers arranged in a soothing palette.', 'Arrangement', 'both', 'Blue', true],
  ['gentle-comfort-bouquet', 2, 'Gentle Comfort Bouquet', 'A relaxed bouquet of mixed seasonal flowers for the home.', 'Bouquet', 'home', 'Mixed', true],
  ['white-elegance-arrangement', 2, 'White Elegance Arrangement', 'A refined arrangement of white flowers and green foliage.', 'Arrangement', 'both', 'White', true],
  ['sunrise-remembrance-basket', 2, 'Sunrise Remembrance Basket', 'Sunny flowers in a keepsake basket, arranged with care.', 'Basket Arrangement', 'service', 'Yellow', true],
  ['graceful-pink-rose-vase', 2, 'Graceful Pink Rose Vase', 'Pink roses and delicate filler flowers in a clear glass vase.', 'Vase Arrangement', 'home', 'Pink', true],
  ['peace-lily-plant', 3, 'Peace Lily Plant', 'A calm, long-lasting green plant with a simple white bloom.', 'Plant', 'both', 'White', true],
  ['orchid-elegance', 3, 'Orchid Elegance', 'A flowering orchid presented in a ceramic container.', 'Plant', 'home', 'Purple', false],
  ['comforting-dish-garden', 3, 'Comforting Dish Garden', 'A collection of leafy plants gathered in a low garden dish.', 'Dish Garden', 'both', 'Green', true],
  ['remembrance-rose-bush', 3, 'Remembrance Rose Bush', 'A rose bush ready for planting in a garden or sunny patio.', 'Plant', 'home', 'Red', false],
  ['memorial-oak-tree', 4, 'Memorial Oak Tree', 'A young oak tree selected for planting in a meaningful place.', 'Tree', 'home', 'Green', false],
  ['dogwood-memorial-tree', 4, 'Dogwood Memorial Tree', 'A flowering dogwood tree offered as a lasting remembrance.', 'Tree', 'home', 'Pink', false],
  ['plant-a-tree-in-memory', 4, 'Plant a Tree in Memory', 'A tree-planting gift supporting a living tribute.', 'Tree', 'home', 'Green', false],
  ['comfort-food-basket', 5, 'Comfort Food Gift Basket', 'A welcoming assortment of comforting pantry favorites.', 'Gift Basket', 'home', 'Mixed', false],
  ['gourmet-sympathy-basket', 5, 'Gourmet Sympathy Basket', 'A thoughtful selection of gourmet treats for sharing.', 'Gift Basket', 'home', 'Mixed', false],
  ['fruit-and-flowers-basket', 5, 'Fruit & Flowers Basket', 'Fresh fruit and bright flowers arranged in a gift basket.', 'Gift Basket', 'home', 'Mixed', true],
  ['tea-and-comfort-basket', 5, 'Tea & Comfort Basket', 'Tea and gentle comforts assembled in a ready-to-share basket.', 'Gift Basket', 'home', 'Mixed', false],
];

const STANDARD_PRICES = [
  189.99, 209.99, 179.99, 169.99, 299.99, 329.99, 279.99, 159.99, 69.99, 74.99,
  59.99, 84.99, 99.99, 64.99, 54.99, 79.99, 59.99, 49.99, 39.99, 44.99,
  29.99, 69.99, 89.99, 79.99, 54.99,
];

const DELUXE_DELTAS = [
  50, 50, 50, 50, 80, 70, 70, 40, 20, 20,
  20, 24, 30, 20, 20, 20, 20, 15, 20, 20,
  20, 30, 30, 25, 20,
];

const PREMIUM_DELTAS = [
  110, 120, 100, 100, 160, 170, 150, 90, 45, 45,
  40, 55, 60, 40, 40, 50, 40, 35, 50, 50,
  70, 70, 70, 55, 40,
];

const SIZE_DESCRIPTIONS = {
  standard: 'Thoughtfully arranged in the standard size.',
  deluxe: 'A fuller version with additional flowers or keepsake detail.',
  premium: 'Our most generous size, finished with special care.',
};

const CATEGORIES_BY_ID = CATEGORY_DATA.map((category) => category.slug);

const PRODUCTS = PRODUCT_DATA.map((productData, index) => {
  const [
    slug, categoryId, name, description, style, location, color, sameDay,
  ] = productData;
  const standardPrice = STANDARD_PRICES[index];
  const sizes = [
    { code: 'standard', label: 'Standard', price: standardPrice, description: SIZE_DESCRIPTIONS.standard },
    { code: 'deluxe', label: 'Deluxe', price: standardPrice + DELUXE_DELTAS[index], description: SIZE_DESCRIPTIONS.deluxe },
    { code: 'premium', label: 'Premium', price: standardPrice + PREMIUM_DELTAS[index], description: SIZE_DESCRIPTIONS.premium },
  ];

  return {
    slug,
    category: CATEGORIES_BY_ID[categoryId - 1],
    name,
    description,
    style,
    location,
    color,
    sameDay,
    image: `/verticals/485ddc93/products/${slug}.svg`,
    sizes,
  };
});

const DESTINATIONS = {
  funeral_home: { label: 'Hartwell Family Funeral Home — before the Visitation' },
  residence: { label: "The family's residence" },
};

const REMEDIATION_DIRECTIVE = [
  '*Repository to investigate and fix:* `COG-GTM/event-driven-devin`',
  '',
  'The failing code path is the Tribute Technology Evergreen Sympathy Store checkout:',
  '- Service: `app/services/verticals/485ddc93.js`',
  '- Route: `app/routes/verticals/485ddc93.js`',
  '- Page: `app/public/verticals/485ddc93.html` (served at `/tributetech`)',
  '- Test: `tests/485ddc93-sympathy-order.test.js`',
  '',
  'Sympathy store orders delivered to the funeral home (the default for standing sprays, casket sprays, wreaths and arrangements) fail with a TypeError and HTTP 500; residence deliveries succeed.',
  'Find the root cause in `scheduleFuneralHomeDelivery` and the target-service lookup it depends on, and fix it.',
  'Preserve the delivery rules (target service = first upcoming visitation, delivery before the service, Sundays excluded), the residence path, pricing (delivery fee, 7% tax), the response shape, and the Sentry/alert error handling.',
  'Update the test so the default funeral-home order asserts a successful delivery.',
  'Run `npx jest tests/485ddc93-sympathy-order.test.js --runInBand` and `npm run lint`.',
  'Verify a default order at `/tributetech` succeeds.',
  'Open a PR against `main`.',
].join('\n');

function roundCents(value) {
  return Math.round(value * 100) / 100;
}

function utcDateStart(date) {
  return new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
}

function addUtcDays(date, days) {
  const result = new Date(date);
  result.setUTCDate(result.getUTCDate() + days);
  return result;
}

function dateString(date) {
  return date.toISOString().slice(0, 10);
}

function dateFromString(value) {
  const [year, month, day] = value.split('-').map(Number);
  return new Date(Date.UTC(year, month - 1, day));
}

function formatDateLabel(date) {
  return date.toLocaleDateString('en-US', {
    weekday: 'long',
    month: 'long',
    day: 'numeric',
    year: 'numeric',
    timeZone: 'UTC',
  });
}

function formatTimeLabel(time) {
  const [hour, minute] = time.split(':').map(Number);
  const suffix = hour >= 12 ? 'PM' : 'AM';
  const hour12 = hour % 12 || 12;
  return `${hour12}:${String(minute).padStart(2, '0')} ${suffix}`;
}

function buildEvents(asOf) {
  const visitationDate = addUtcDays(asOf, 5);
  const funeralDate = addUtcDays(asOf, 6);
  return [
    {
      eventType: 'visitation',
      title: 'Visitation',
      date: dateString(visitationDate),
      startTime: '16:00',
      endTime: '19:00',
      locationName: 'Hartwell Family Funeral Home chapel',
      address: HOME.address,
    },
    {
      eventType: 'funeral',
      title: 'Funeral Service',
      date: dateString(funeralDate),
      startTime: '10:00',
      endTime: '11:00',
      locationName: "St. Mark's Episcopal Church",
      address: '42 Church Lane, Millbrook, CT 06478',
    },
    {
      eventType: 'committal',
      title: 'Committal',
      date: dateString(funeralDate),
      startTime: '11:30',
      endTime: null,
      locationName: 'Millbrook Cemetery',
      address: '9 Cemetery Road, Millbrook, CT 06478',
    },
  ].map((event) => ({
    ...event,
    startsAtLabel: `${formatDateLabel(dateFromString(event.date))} at ${formatTimeLabel(event.startTime)}`,
  }));
}

function buildObituary(asOf) {
  const deathDate = addUtcDays(asOf, -3);
  const dateOfDeath = dateString(deathDate);
  return {
    obId: 40210017,
    fullName: 'Margaret Ellen Hayes',
    initials: 'MH',
    portrait: '/verticals/485ddc93/portrait-40210017.svg',
    dateOfBirth: '1938-03-12',
    dateOfDeath,
    lifeDates: `March 12, 1938 – ${formatDateLabel(deathDate).replace(/^[^,]+, /, '')}`,
  };
}

function buildStorefront() {
  const asOf = utcDateStart(new Date());
  const events = buildEvents(asOf);
  return {
    home: HOME,
    obituary: buildObituary(asOf),
    events,
    categories: CATEGORIES,
    products: PRODUCTS,
    destinations: Object.entries(DESTINATIONS).map(([key, value]) => ({ key, label: value.label })),
    deliveryFee: DELIVERY_FEE,
    taxRate: TAX_RATE,
  };
}

function validationError(message, code, requestId) {
  const error = new Error(message);
  error.name = 'ValidationError';
  error.statusCode = 400;
  error.code = code;
  error.requestId = requestId;
  return error;
}

function validateOrder(data, requestId) {
  const product = PRODUCTS.find((item) => item.slug === data.product);
  if (!product) {
    throw validationError('Choose a product from the sympathy store.', 'PRODUCT_INVALID', requestId);
  }

  const sizeCode = data.size === undefined || data.size === null || data.size === ''
    ? 'standard'
    : String(data.size).trim();
  const size = product.sizes.find((item) => item.code === sizeCode);
  if (!size) {
    throw validationError('Choose a valid size for this product.', 'PRODUCT_INVALID', requestId);
  }

  const defaultDestination = product.location === 'service' || product.location === 'both'
    ? 'funeral_home'
    : 'residence';
  const destination = data.destination === undefined || data.destination === null
    ? defaultDestination
    : String(data.destination).trim();
  if (!Object.hasOwn(DESTINATIONS, destination)
    || (destination === 'funeral_home' && product.location === 'home')
    || (destination === 'residence' && product.location === 'service')) {
    const message = product.location === 'home'
      ? "This gift is delivered to the family's residence."
      : 'This product can only be delivered to the funeral home.';
    throw validationError(message, 'DESTINATION_INVALID', requestId);
  }

  const senderName = String(data.senderName === undefined ? '' : data.senderName).trim();
  const senderEmail = String(data.senderEmail === undefined ? '' : data.senderEmail).trim();
  if (senderName.length < 2 || senderName.length > 80
    || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(senderEmail)) {
    throw validationError('Enter your name and a valid email address.', 'SENDER_INVALID', requestId);
  }

  const recipientName = String(data.recipientName === undefined ? '' : data.recipientName).trim();
  const recipientAddress = String(data.recipientAddress === undefined ? '' : data.recipientAddress).trim();
  if (destination === 'residence'
    && (recipientName.length < 2 || recipientName.length > 80
      || recipientAddress.length < 5 || recipientAddress.length > 160)) {
    throw validationError('Enter the recipient name and delivery address.', 'RECIPIENT_INVALID', requestId);
  }

  const cardMessage = String(data.cardMessage === undefined || data.cardMessage === null ? '' : data.cardMessage);
  const cardSignature = String(data.cardSignature === undefined || data.cardSignature === null ? '' : data.cardSignature);
  if (cardMessage.length > 200 || cardSignature.length > 100) {
    throw validationError('Keep the card message to 200 characters and signature to 100 characters.', 'CARD_MESSAGE_INVALID', requestId);
  }

  return {
    product,
    size,
    destination,
    senderName,
    senderEmail,
    recipientName,
    recipientAddress,
  };
}

function isSunday(date) {
  return date.getUTCDay() === 0;
}

function nextDeliveryDate(asOf) {
  let deliveryDate = addUtcDays(asOf, 1);
  while (isSunday(deliveryDate)) deliveryDate = addUtcDays(deliveryDate, 1);
  return dateString(deliveryDate);
}

/**
 * The target service is the first upcoming visitation.
 */
function resolveTargetService(events) {
  const SERVICE_EVENT_TYPES = { VISITATION: 'Visitation', FUNERAL: 'Funeral Service' };
  return events.find((event) => event.eventType === SERVICE_EVENT_TYPES.VISITATION);
}

function scheduleFuneralHomeDelivery(target, asOf) {
  const serviceDate = target.date;
  let deliveryDate = dateFromString(serviceDate);

  if (deliveryDate <= asOf || isSunday(deliveryDate)) {
    deliveryDate = addUtcDays(deliveryDate, -1);
    while (deliveryDate <= asOf || isSunday(deliveryDate)) {
      deliveryDate = addUtcDays(deliveryDate, -1);
    }
  }

  return {
    date: dateString(deliveryDate),
    window: '09:00–12:00',
    windowLabel: 'Morning (9:00 AM – 12:00 PM)',
    recipient: `${HOME.name} · ${HOME.address}`,
  };
}

async function placeOrder(data = {}) {
  const startedAt = new Date();
  const startTime = startedAt.getTime();
  const asOf = utcDateStart(startedAt);
  const requestId = `TS-${uuidv4().slice(0, 8).toUpperCase()}`;
  const order = validateOrder(data && typeof data === 'object' ? data : {}, requestId);

  logger.info('Placing sympathy store order', {
    requestId,
    product: order.product.slug,
    size: order.size.code,
    destination: order.destination,
    service: SERVICE,
    route: ROUTE,
  });

  try {
    await new Promise((resolve) => setTimeout(resolve, 80 + Math.random() * 120));

    const events = buildEvents(asOf);
    let delivery;
    if (order.destination === 'residence') {
      delivery = {
        date: nextDeliveryDate(asOf),
        window: '09:00–12:00',
        windowLabel: 'Morning (9:00 AM – 12:00 PM)',
        recipient: `${order.recipientName} · ${order.recipientAddress}`,
      };
    } else {
      const target = resolveTargetService(events);
      delivery = scheduleFuneralHomeDelivery(target, asOf);
    }

    const subtotal = roundCents(order.size.price);
    const deliveryFee = DELIVERY_FEE;
    const tax = roundCents((subtotal + deliveryFee) * TAX_RATE);
    const total = roundCents(subtotal + deliveryFee + tax);
    const durationMs = Date.now() - startTime;
    const florist = FLORISTS.find((entry) => entry.priority === 1);

    incrementMetric('sympathy_order.success', { route: ROUTE, destination: order.destination });
    recordTiming('sympathy_order.latency', durationMs, { route: ROUTE });

    return {
      success: true,
      requestId,
      orderNumber: `EVG-${uuidv4().slice(0, 8).toUpperCase()}`,
      product: { slug: order.product.slug, name: order.product.name, image: order.product.image },
      size: { code: order.size.code, label: order.size.label, price: order.size.price },
      destination: { key: order.destination, label: DESTINATIONS[order.destination].label },
      delivery: {
        ...delivery,
        dateLabel: formatDateLabel(dateFromString(delivery.date)),
      },
      florist: { name: florist.name, phone: florist.phone },
      inMemoryOf: 'Margaret Ellen Hayes',
      subtotal,
      deliveryFee,
      tax,
      total,
      status: 'confirmed',
      placedAt: new Date().toISOString(),
    };
  } catch (error) {
    const durationMs = Date.now() - startTime;

    incrementMetric('sympathy_order.failure', {
      route: ROUTE,
      errorClass: error.name,
      destination: order.destination,
    });
    recordTiming('sympathy_order.latency', durationMs, {
      route: ROUTE,
      error: 'true',
    });

    logger.error('Sympathy store order failed', {
      requestId,
      product: order.product.slug,
      size: order.size.code,
      destination: order.destination,
      error: error.message,
      errorClass: error.name,
      durationMs,
      service: SERVICE,
    });

    Sentry.captureException(error, {
      tags: {
        route: ROUTE,
        service: SERVICE,
        alert_path: 'instant',
        destination: order.destination,
        product: order.product.slug,
      },
      extra: {
        requestId,
        product: order.product.slug,
        size: order.size.code,
        destination: order.destination,
      },
    });

    error.requestId = requestId;
    createSessionAndAlert({
      issueTitle: `${error.name}: ${error.message}`,
      issueUrl: `https://${process.env.SENTRY_ORG_SLUG || 'sentry-org'}.sentry.io/issues/?project=${process.env.SENTRY_PROJECT_ID || ''}&query=is%3Aunresolved`,
      culprit: 'app/services/verticals/485ddc93.js — scheduleFuneralHomeDelivery',
      errorType: error.name || 'Error',
      errorValue: error.message,
      devinUserId: data.devinUserId,
      devinEmail: data.devinEmail,
      devinOrgId: data.devinOrgId,
      service: SERVICE,
      verticalLabel: 'Tribute Technology Sympathy Store Checkout',
      promptAppendix: REMEDIATION_DIRECTIVE,
      customer: '485ddc93',
      slackMemberId: data.devinEmail ? '' : SLACK_MEMBER_ID,
      slackMemberIdFallback: SLACK_MEMBER_ID,
      tags: [
        { key: 'route', value: ROUTE },
        { key: 'service', value: SERVICE },
        { key: 'destination', value: order.destination },
        { key: 'product', value: order.product.slug },
      ],
      extra: {
        requestId,
        product: order.product.slug,
        size: order.size.code,
        destination: order.destination,
      },
      level: 'error',
      platform: 'node',
      firstSeen: '',
      lastSeen: new Date().toISOString(),
      count: '',
      shortId: '',
      project: 'event-driven-devin',
      release: process.env.SENTRY_RELEASE || `${SERVICE}@1.0.0`,
      environment: process.env.DD_ENV || 'prod',
      triggeredRule: '',
    }).catch((alertError) => {
      logger.error('Failed to create Devin session for sympathy store order', {
        error: alertError.message,
        requestId,
      });
    });

    throw error;
  }
}

module.exports = {
  buildStorefront,
  placeOrder,
  PRODUCTS,
  CATEGORIES,
  DESTINATIONS,
  DELIVERY_FEE,
  TAX_RATE,
  REMEDIATION_DIRECTIVE,
  resolveTargetService,
  scheduleFuneralHomeDelivery,
};
