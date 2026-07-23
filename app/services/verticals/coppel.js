const { v4: uuidv4 } = require('uuid');
const logger = require('../../telemetry/logger');
const { incrementMetric, recordTiming } = require('../../telemetry/datadog');
const { Sentry } = require('../../telemetry/sentry');
const { createSessionAndAlert } = require('../devin-session');

/**
 * Coppel "Mi carrito" storefront catalog.
 * Prices in MXN, matching the coppel.com cart experience.
 */
const PRODUCTS = [
  {
    id: 'DEP-LUMEA-SC1997',
    name: 'Depiladora Philips Lumea IPL SC1997-50 con Filtro UV',
    listPrice: 9599,
    price: 7129,
    seller: 'Coppel',
    category: 'Belleza y Cuidado Personal',
  },
  {
    id: 'TEL-SAMS-A54',
    name: 'Samsung Galaxy A54 5G 128GB Negro',
    listPrice: 8999,
    price: 6499,
    seller: 'Coppel',
    category: 'Telefonía',
  },
  {
    id: 'PAN-LG-55UHD',
    name: 'Pantalla LG 55" UHD 4K Smart TV',
    listPrice: 12999,
    price: 9499,
    seller: 'Coppel',
    category: 'Pantallas y Electrónica',
  },
  {
    id: 'LAV-MABE-19KG',
    name: 'Lavadora Mabe Automática 19 kg Blanca',
    listPrice: 10499,
    price: 8299,
    seller: 'Coppel',
    category: 'Línea Blanca',
  },
];

/**
 * Per-SKU promotional discounts. Sourced from the merchandising service
 * and merged into each cart line before pricing.
 */
const PROMOTIONS = {
  'DEP-LUMEA-SC1997': { rate: 0.257, label: 'Oferta Coppel' },
  'TEL-SAMS-A54': { rate: 0.277, label: 'Oferta Coppel' },
  'PAN-LG-55UHD': { rate: 0.269, label: 'Oferta Coppel' },
  'LAV-MABE-19KG': { rate: 0.209, label: 'Oferta Coppel' },
};

/**
 * Free shipping ("Envío gratis") threshold in MXN.
 */
const FREE_SHIPPING_THRESHOLD = 499;
const STANDARD_SHIPPING = 99;

/**
 * Build the cart line items from the incoming SKUs.
 */
function buildLineItems(items) {
  return items.map((item) => {
    const product = PRODUCTS.find((p) => p.id === item.sku);
    if (!product) return null;
    const qty = item.qty || 1;
    return {
      sku: product.id,
      name: product.name,
      seller: product.seller,
      qty,
      unitPrice: product.price,
      listPrice: product.listPrice,
    };
  }).filter(Boolean);
}

/**
 * Compute the cart summary ("Resumen de tu compra"): subtotal,
 * descuento, envío and total de contado.
 */
function computeCartSummary(lineItems) {
  const subtotal = lineItems.reduce((sum, li) => sum + li.listPrice * li.qty, 0);

  const discount = lineItems.reduce((sum, li) => {
    const promo = li.promotion;
    return sum + li.listPrice * li.qty * promo.rate;
  }, 0);

  const discountedSubtotal = subtotal - discount;
  const shipping = discountedSubtotal >= FREE_SHIPPING_THRESHOLD ? 0 : STANDARD_SHIPPING;
  const total = discountedSubtotal + shipping;

  return {
    productCount: lineItems.reduce((sum, li) => sum + li.qty, 0),
    subtotal: Math.round(subtotal),
    discount: Math.round(discount),
    shipping,
    total: Math.round(total),
    currency: 'MXN',
  };
}

/**
 * Process a Coppel cart checkout ("Continuar compra").
 */
async function processCheckout(data) {
  const startTime = Date.now();
  const orderId = uuidv4();

  logger.info('Processing Coppel cart checkout', {
    orderId,
    itemCount: data.items ? data.items.length : 0,
    service: 'coppel-carrito',
  });

  try {
    await new Promise((resolve) => setTimeout(resolve, 70 + Math.random() * 120));

    const lineItems = buildLineItems(data.items || []);
    if (lineItems.length === 0) {
      const err = new Error('Tu carrito está vacío. Agrega al menos un producto.');
      err.name = 'EmptyCartError';
      err.code = 'EMPTY_CART';
      throw err;
    }

    const summary = computeCartSummary(lineItems);

    const duration = Date.now() - startTime;
    incrementMetric('coppel_checkout.success', { route: '/api/coppel/checkout' });
    recordTiming('coppel_checkout.latency', duration, { route: '/api/coppel/checkout' });

    return {
      success: true,
      orderId,
      items: lineItems,
      ...summary,
      delivery: data.delivery || 'domicilio',
      processedAt: new Date().toISOString(),
    };
  } catch (error) {
    const duration = Date.now() - startTime;
    incrementMetric('coppel_checkout.failure', { route: '/api/coppel/checkout', errorClass: error.name });
    recordTiming('coppel_checkout.latency', duration, { route: '/api/coppel/checkout', error: 'true' });
    logger.error('Coppel cart checkout failed', {
      orderId,
      error: error.message,
      errorClass: error.name,
      durationMs: duration,
    });
    Sentry.captureException(error, {
      tags: {
        route: '/api/coppel/checkout',
        service: 'coppel-carrito',
      },
      extra: { orderId, itemCount: data.items ? data.items.length : 0 },
    });
    createSessionAndAlert({
      issueTitle: `${error.name}: ${error.message}`,
      issueUrl: `https://${process.env.SENTRY_ORG_SLUG || 'sentry-org'}.sentry.io/issues/?project=${process.env.SENTRY_PROJECT_ID || ''}&query=is%3Aunresolved`,
      culprit: 'app/services/verticals/coppel.js \u2014 computeCartSummary',
      errorType: error.name || 'Error',
      errorValue: error.message,
      devinUserId: data.devinUserId,
      devinOrgId: data.devinOrgId,
      devinEmail: data.devinEmail,
      service: 'coppel-carrito',
      verticalLabel: 'Coppel Mi Carrito',
      customer: 'coppel',
      tags: [
        { key: 'route', value: '/api/coppel/checkout' },
        { key: 'service', value: 'coppel-carrito' },
      ],
      extra: { orderId, itemCount: data.items ? data.items.length : 0 },
      level: 'error',
      platform: 'node',
      firstSeen: '',
      lastSeen: new Date().toISOString(),
      count: '',
      shortId: '',
      project: 'event-driven-devin',
      release: 'coppel-carrito@1.0.0',
      environment: process.env.DD_ENV || 'prod',
      triggeredRule: '',
    }).catch((alertError) => {
      logger.error('Failed to trigger Devin session from Coppel checkout error', { error: alertError.message });
    });
    throw error;
  }
}

module.exports = { processCheckout, PRODUCTS, PROMOTIONS };
