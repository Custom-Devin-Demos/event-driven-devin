const { v4: uuidv4 } = require('uuid');
const logger = require('../../telemetry/logger');
const { incrementMetric, recordTiming } = require('../../telemetry/datadog');
const { Sentry } = require('../../telemetry/sentry');
const { createSessionAndAlert } = require('../devin-session');

/**
 * lululemon product catalog — technical apparel SKUs
 */
const CATALOG = [
  { id: 'LLL-ALIGN-25', name: 'Align\u2122 High-Rise Pant 25"', price: 98.00, category: 'womens-bottoms', colour: 'Black' },
  { id: 'LLL-WTRAIN-28', name: 'Wunder Train High-Rise Tight 28"', price: 108.00, category: 'womens-bottoms', colour: 'True Navy' },
  { id: 'LLL-DEFINE-JK', name: 'Define Jacket Luon\u2122', price: 128.00, category: 'womens-outerwear', colour: 'Heathered Core Ultra Light Grey' },
  { id: 'LLL-SCUBA-HD', name: 'Scuba Oversized Full-Zip Hoodie', price: 118.00, category: 'womens-outerwear', colour: 'Heathered Java' },
  { id: 'LLL-ABC-JOG', name: 'ABC Jogger Warpstreme\u2122', price: 128.00, category: 'mens-bottoms', colour: 'Obsidian' },
  { id: 'LLL-ABC-CLS', name: 'ABC Classic-Fit Trouser 32"L', price: 128.00, category: 'mens-bottoms', colour: 'True Navy' },
  { id: 'LLL-MVT-SS', name: 'Metal Vent Tech Short-Sleeve Shirt', price: 78.00, category: 'mens-tops', colour: 'Graphite Grey' },
  { id: 'LLL-BELT-1L', name: 'Everywhere Belt Bag 1L', price: 38.00, category: 'accessories', colour: 'Black' },
];

/**
 * Tax region configuration
 */
const TAX_REGIONS = {
  US: { taxRate: 0.08, currency: 'USD' },
  EU: { taxRate: 0.20, currency: 'EUR' },
  UK: { taxRate: 0.20, currency: 'GBP' },
  CA: { taxRate: 0.13, currency: 'CAD' },
};

/**
 * Signed-in storefront sessions. The session token is issued at sign-in and is
 * the only trustworthy source of the viewer's identity — the order-status flow
 * must never take the member from request data.
 */
const MEMBER_SESSIONS = {
  sess_demo_avery: { memberId: 'mbr_8841', memberName: 'Avery Chen', email: 'avery.chen@example.com' },
  sess_demo_priya: { memberId: 'mbr_5527', memberName: 'Priya Raghavan', email: 'priya.raghavan@example.com' },
};

/**
 * Order ledger backing the "Track your order" panel. Each record carries the
 * fulfilment PII a member is allowed to see for their own order only.
 */
const ORDER_LEDGER = [
  {
    orderNumber: 'LLL-4471902',
    memberId: 'mbr_5527',
    memberName: 'Priya Raghavan',
    email: 'priya.raghavan@example.com',
    phone: '+1 (415) 555-0186',
    shippingAddress: '2418 Vallejo St, Apt 4, San Francisco, CA 94123',
    cardLast4: '8813',
    loyaltyId: 'STUDIO-5527-AB',
    status: 'Out for delivery',
    placedAt: '2026-09-09T17:04:00Z',
    total: 246.00,
    items: [
      { sku: 'LLL-WTRAIN-28', qty: 1, price: 108.00 },
      { sku: 'LLL-DEFINE-JK', qty: 1, price: 128.00 },
    ],
  },
  {
    orderNumber: 'LLL-4472118',
    memberId: 'mbr_8841',
    memberName: 'Avery Chen',
    email: 'avery.chen@example.com',
    phone: '+1 (206) 555-0142',
    shippingAddress: '915 Pine St, Unit 12, Seattle, WA 98101',
    cardLast4: '4242',
    loyaltyId: 'STUDIO-8841-QT',
    status: 'Preparing for shipment',
    placedAt: '2026-09-11T21:38:00Z',
    total: 136.00,
    items: [
      { sku: 'LLL-ALIGN-25', qty: 1, price: 98.00 },
      { sku: 'LLL-BELT-1L', qty: 1, price: 38.00 },
    ],
  },
];

/**
 * Fields on an order record that identify the member who placed it. Named here
 * so the access audit can report what an unauthorized viewer received without
 * writing any of the values into logs or alerts.
 */
const PII_FIELDS = ['memberName', 'email', 'phone', 'shippingAddress', 'cardLast4', 'loyaltyId'];

const SECURITY_REMEDIATION_DIRECTIVE = [
  '*Repository to investigate and fix:* `COG-GTM/event-driven-devin`',
  '',
  'This is a security finding, not a crash. The order-status endpoint served a',
  'member order to a session that does not own it (IDOR / broken object-level',
  'authorization, CWE-639, OWASP A01:2021). The request succeeded with HTTP 200,',
  'so the only signal is the `order_status.authz_violation` metric and this alert.',
  '',
  'The vulnerable code path is the lululemon order-status vertical:',
  '- Service: `app/services/verticals/50b235c7.js` \u2014 `lookupOrder` resolves the order',
  '  by order number and serializes it without comparing `order.memberId` to the',
  '  member on the session token.',
  '- Route: `app/routes/verticals/50b235c7.js`',
  '- Page: `app/public/verticals/50b235c7.html` (served at `/lululemon`)',
  '',
  'Fix the authorization, not the symptom: deny the request server-side when the',
  'session does not own the order, keep the audit trail, and do not rely on the',
  'frontend hiding fields or on redacting PII in the response.',
  '`npm run audit:lululemon` probes every order with a non-owner session and must',
  'exit zero once the control is in place; add regression coverage alongside',
  '`tests/lululemon-order-authz.test.js`.',
  '',
  'Open a pull request against `main` with the fix.',
].join('\n');

/**
 * Looks up the discount tier for a given subtotal.
 */
function getApplicableDiscount(subtotal) {
  if (subtotal >= 250) return { rate: 0.15, label: '15% off orders $250+' };
  if (subtotal >= 150) return { rate: 0.10, label: '10% off orders $150+' };
  return { rate: 0, label: 'None' };
}

/**
 * Computes the final order total.
 */
function computeOrderTotal(subtotal, region) {
  const taxConfig = TAX_REGIONS[region];
  if (!taxConfig) {
    throw Object.assign(new Error(`Unknown tax region: ${region}`), { code: 'INVALID_REGION' });
  }
  const tax = subtotal * taxConfig.taxRate;
  const discount = getApplicableDiscount(subtotal);
  const discountAmount = (subtotal + tax) * discount.rate;
  return {
    subtotal,
    tax: Math.round(tax * 100) / 100,
    discount: Math.round(discountAmount * 100) / 100,
    discountLabel: discount.label,
    total: Math.round((subtotal + tax - discountAmount) * 100) / 100,
    currency: taxConfig.currency,
  };
}

/**
 * Formats a receipt for the order confirmation.
 */
function formatReceipt(items) {
  return items.map((item) => {
    const product = CATALOG.find((p) => p.id === item.sku) || {};
    return {
      sku: item.sku,
      name: product.name || item.sku,
      category: product.category || 'unknown',
      qty: item.qty,
      lineTotal: Math.round(item.price * item.qty * 100) / 100,
    };
  });
}

function resolveSession(sessionToken) {
  return MEMBER_SESSIONS[sessionToken] || null;
}

function findOrder(orderNumber) {
  const normalized = String(orderNumber || '').trim().toUpperCase();
  return ORDER_LEDGER.find((order) => order.orderNumber === normalized) || null;
}

/**
 * Serializes an order for the order-status panel, including the fulfilment
 * contact and payment details shown to the member who placed it.
 */
function serializeOrder(order) {
  return {
    orderNumber: order.orderNumber,
    status: order.status,
    placedAt: order.placedAt,
    total: order.total,
    memberId: order.memberId,
    memberName: order.memberName,
    email: order.email,
    phone: order.phone,
    shippingAddress: order.shippingAddress,
    cardLast4: order.cardLast4,
    loyaltyId: order.loyaltyId,
    items: formatReceipt(order.items),
  };
}

/**
 * Compares the order owner against the session viewing it. Reports the field
 * names an unauthorized viewer received — never the values.
 */
function auditOrderAccess(order, session) {
  const violation = order.memberId !== session.memberId;
  return {
    violation,
    ownerMemberId: order.memberId,
    viewerMemberId: session.memberId,
    exposedFields: violation ? PII_FIELDS.slice() : [],
  };
}

/**
 * Processes a lululemon e-commerce checkout order.
 */
async function processCheckout(orderData) {
  const startTime = Date.now();
  const orderId = uuidv4();

  logger.info('Processing lululemon checkout', {
    orderId,
    userId: orderData.userId,
    subtotal: orderData.subtotal,
    service: 'lululemon-ecommerce',
    route: '/api/50b235c7/checkout',
  });

  await new Promise((resolve) => setTimeout(resolve, 80 + Math.random() * 120));

  const items = orderData.items || [];
  const computedSubtotal = items.reduce(
    (sum, item) => sum + item.price * item.qty,
    0,
  ) || orderData.subtotal;

  const result = computeOrderTotal(Number(computedSubtotal), orderData.region);
  const duration = Date.now() - startTime;

  incrementMetric('checkout.success', {
    route: '/api/50b235c7/checkout',
    source: 'lululemon-storefront',
  });
  recordTiming('checkout.latency', duration, {
    route: '/api/50b235c7/checkout',
  });

  return {
    success: true,
    orderId,
    orderNumber: 'LLL-4472118',
    total: result.total,
    tax: result.tax,
    discount: result.discount,
    discountLabel: result.discountLabel,
    receipt: formatReceipt(items),
    status: 'confirmed',
    processedAt: new Date().toISOString(),
  };
}

/**
 * Serves the "Track your order" panel.
 *
 * The viewer is resolved from the signed-in session token, and the order is
 * resolved from the order number typed into the panel.
 *
 * @param {Object} data
 * @param {string} data.orderNumber - Order number typed into the panel
 * @param {string} data.sessionToken - Signed-in storefront session
 * @param {boolean} [data.audit] - Set by `npm run audit:lululemon` so probe
 *   traffic is measured without paging anyone.
 */
async function lookupOrder(data) {
  const startTime = Date.now();
  const requestId = uuidv4();

  const session = resolveSession(data.sessionToken);
  if (!session) {
    throw Object.assign(new Error('No signed-in member session'), {
      name: 'AuthenticationError',
      code: 'SESSION_REQUIRED',
      statusCode: 401,
    });
  }

  const order = findOrder(data.orderNumber);
  if (!order) {
    throw Object.assign(new Error(`Unknown order number: ${String(data.orderNumber || '').trim()}`), {
      name: 'ValidationError',
      code: 'ORDER_NOT_FOUND',
      statusCode: 404,
    });
  }

  const payload = serializeOrder(order);
  const access = auditOrderAccess(order, session);
  const duration = Date.now() - startTime;

  recordTiming('order_status.latency', duration, {
    route: '/api/50b235c7/order-status',
  });

  if (!access.violation) {
    incrementMetric('order_status.success', {
      route: '/api/50b235c7/order-status',
      source: 'lululemon-storefront',
    });

    return {
      success: true,
      requestId,
      viewerMemberId: session.memberId,
      crossAccount: false,
      order: payload,
    };
  }

  incrementMetric('order_status.authz_violation', {
    route: '/api/50b235c7/order-status',
    source: 'lululemon-storefront',
    control: 'object-level-authorization',
  });

  logger.warn('Order status served to a member who does not own the order', {
    requestId,
    orderNumber: order.orderNumber,
    ownerMemberId: access.ownerMemberId,
    viewerMemberId: access.viewerMemberId,
    exposedFields: access.exposedFields,
    audit: Boolean(data.audit),
    service: 'lululemon-order-status',
    route: '/api/50b235c7/order-status',
  });

  if (data.audit) {
    return {
      success: true,
      requestId,
      viewerMemberId: session.memberId,
      crossAccount: true,
      exposedFields: access.exposedFields,
      order: payload,
    };
  }

  const finding = Object.assign(
    new Error(
      `Order ${order.orderNumber} owned by ${access.ownerMemberId} returned to session member ${access.viewerMemberId}`,
    ),
    { name: 'BrokenAccessControlError' },
  );

  Sentry.captureException(finding, {
    level: 'error',
    tags: {
      route: '/api/50b235c7/order-status',
      service: 'lululemon-order-status',
      source: 'lululemon-storefront',
      cwe: 'CWE-639',
      owasp: 'A01:2021-Broken Access Control',
    },
    extra: {
      requestId,
      orderNumber: order.orderNumber,
      ownerMemberId: access.ownerMemberId,
      viewerMemberId: access.viewerMemberId,
      exposedFields: access.exposedFields,
    },
  });

  createSessionAndAlert({
    issueTitle: `${finding.name}: order-status endpoint returned another member's order (CWE-639)`,
    issueUrl: `https://${process.env.SENTRY_ORG_SLUG || 'sentry-org'}.sentry.io/issues/?project=${process.env.SENTRY_PROJECT_ID || ''}&query=is%3Aunresolved`,
    culprit: 'app/services/verticals/50b235c7.js \u2014 lookupOrder',
    errorType: finding.name,
    errorValue: finding.message,
    devinUserId: data.devinUserId,
    devinEmail: data.devinEmail,
    devinOrgId: data.devinOrgId,
    service: 'lululemon-order-status',
    verticalLabel: 'lululemon Order Status',
    customer: '50b235c7',
    promptAppendix: SECURITY_REMEDIATION_DIRECTIVE,
    tags: [
      { key: 'route', value: '/api/50b235c7/order-status' },
      { key: 'service', value: 'lululemon-order-status' },
      { key: 'cwe', value: 'CWE-639' },
      { key: 'owasp', value: 'A01:2021-Broken Access Control' },
      { key: 'finding_class', value: 'idor' },
      { key: 'severity', value: 'high' },
    ],
    extra: {
      requestId,
      orderNumber: order.orderNumber,
      ownerMemberId: access.ownerMemberId,
      viewerMemberId: access.viewerMemberId,
      exposedFields: access.exposedFields.join(', '),
      httpStatus: 200,
    },
    level: 'error',
    platform: 'node',
    firstSeen: '',
    lastSeen: new Date().toISOString(),
    count: '',
    shortId: '',
    project: 'event-driven-devin',
    release: process.env.SENTRY_RELEASE || 'lululemon-order-status@1.0.0',
    environment: process.env.DD_ENV || 'prod',
    triggeredRule: '',
  }).catch((err) => {
    logger.error('Failed to trigger Devin session from lululemon order-status finding', {
      error: err.message,
      requestId,
    });
  });

  return {
    success: true,
    requestId,
    viewerMemberId: session.memberId,
    crossAccount: true,
    exposedFields: access.exposedFields,
    order: payload,
  };
}

module.exports = {
  processCheckout,
  lookupOrder,
  computeOrderTotal,
  formatReceipt,
  serializeOrder,
  auditOrderAccess,
  resolveSession,
  findOrder,
  CATALOG,
  TAX_REGIONS,
  MEMBER_SESSIONS,
  ORDER_LEDGER,
  PII_FIELDS,
  SECURITY_REMEDIATION_DIRECTIVE,
};
