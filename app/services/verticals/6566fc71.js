const { randomUUID, randomInt } = require('crypto');
const Sentry = require('@sentry/node');
const { createSessionAndAlert } = require('../devin-session');
const logger = require('../../telemetry/logger');

const CUSTOMER = '6566fc71';
const SERVICE = 'customer-6566fc71-officedepot-checkout';
const ROUTE = 'POST /api/6566fc71/checkout';
const CULPRIT = 'app/services/verticals/6566fc71.js — quoteInstallments';
const ASSETS = '/verticals/6566fc71-assets';
const MAX_QUANTITY = 5;
const MAX_ORDER_CENTS = 20000000;
const FREE_SHIPPING_CENTS = 59900;
const HOME_SHIPPING_CENTS = 9900;

const PRODUCTS = {
  100278405: {
    sku: '100278405',
    name: 'Pantalla Smart TV LG 50 pulgadas 4K UHD AI 50UA7500PSA',
    brand: 'LG',
    model: '50UA7500PSA',
    priceCents: 669900,
    listPriceCents: 1059900,
    // Buen Fin campaign: "Hasta 18 MSI" with participating credit cards.
    msiPlans: [3, 6, 9, 12, 18],
    images: ['1200ftw-100278405.jpg', '1200ftw-100278405-2.jpg', '1200ftw-100278405-3.jpg', '1200ftw-100278405-4.jpg', '1200ftw-100278405-5.jpg'].map(f => `${ASSETS}/${f}`),
    breadcrumb: ['Categoría', 'Todas', 'Electrónica', 'Pantallas', 'Pantallas'],
  },
};

const STORES = {
  'santa-fe': { id: 'santa-fe', name: 'Office Depot Santa Fe', address: 'Av. Vasco de Quiroga 3800, Santa Fe, Cuajimalpa, CDMX', hours: 'Lun–Dom 9:00–21:00' },
  polanco: { id: 'polanco', name: 'Office Depot Polanco', address: 'Av. Ejército Nacional 769, Granada, Miguel Hidalgo, CDMX', hours: 'Lun–Dom 9:00–21:00' },
  insurgentes: { id: 'insurgentes', name: 'Office Depot Insurgentes Sur', address: 'Av. Insurgentes Sur 1235, Extremadura Insurgentes, Benito Juárez, CDMX', hours: 'Lun–Dom 9:00–21:00' },
  'monterrey-valle': { id: 'monterrey-valle', name: 'Office Depot Valle Oriente', address: 'Av. Lázaro Cárdenas 1000, Valle del Mirador, Monterrey, N.L.', hours: 'Lun–Dom 9:00–21:00' },
  'guadalajara-andares': { id: 'guadalajara-andares', name: 'Office Depot Andares', address: 'Blvd. Puerta de Hierro 4965, Zapopan, Jal.', hours: 'Lun–Dom 10:00–21:00' },
};

const CARDS = {
  'banamex-credito-4821': { id: 'banamex-credito-4821', label: 'Banamex Visa Crédito •••• 4821', type: 'credito', msi: true },
  'bbva-credito-7730': { id: 'bbva-credito-7730', label: 'BBVA Mastercard Crédito •••• 7730', type: 'credito', msi: true },
  'santander-debito-1094': { id: 'santander-debito-1094', label: 'Santander Débito •••• 1094', type: 'debito', msi: false },
};

// Acquirer surcharge Office Depot absorbs per MSI plan, in basis points of the order total.
const MSI_ACQUIRER_FEES = {
  1: { sobretasaBps: 0 },
  3: { sobretasaBps: 475 },
  6: { sobretasaBps: 775 },
  9: { sobretasaBps: 1075 },
  12: { sobretasaBps: 1350 },
};

const REMEDIATION_DIRECTIVE = [
  'Investigate and fix COG-GTM/event-driven-devin. Open a pull request against main; do not merge or deploy.',
  'Office Depot México checkout (/officedepot or /6566fc71, Grupo Gigante) fails on "Pagar ahora" when the customer pays with 18 meses sin intereses (MSI).',
  'Reproduce: Pantalla Smart TV LG 50" (SKU 100278405) → Añadir al carrito → Recoger en tienda → Banamex Visa Crédito → 18 meses sin intereses → Pagar ahora. Pago de contado and 3/6/9/12 MSI succeed.',
  'Inspect app/services/verticals/6566fc71.js, app/routes/verticals/6566fc71.js and app/public/verticals/6566fc71-assets/checkout.js.',
  'The Buen Fin product promotion (msiPlans) offers 18 MSI but MSI_ACQUIRER_FEES has no 18-month entry. The acquirer 18-month surcharge (sobretasa) is 1950 bps (19.50%) of the order total, absorbed by Office Depot; the customer still pays the order total in 18 equal monthly payments.',
  'Keep 18 MSI available; preserve card/MSI eligibility, store and home delivery rules, quantity limits, integer-cent math and server-authoritative totals.',
  'Add regression coverage in tests/6566fc71-checkout.test.js and update the planted-failure expectation after the fix.',
  'Do not disable Sentry/alerts, swallow errors, remove the 18 MSI plan, or fake a successful checkout in the browser.',
].join('\n');

const invalid = message => Object.assign(new Error(message), { name: 'ValidationError', status: 400, code: 'INVALID_CHECKOUT' });
const lookup = (table, key) => (typeof key === 'string' && Object.hasOwn(table, key) ? table[key] : undefined);
const isPlainObject = value => value !== null && typeof value === 'object' && !Array.isArray(value);

function validateCheckout(data) {
  if (!isPlainObject(data)) throw invalid('Revisa los datos de tu compra.');
  const { items, fulfillment, payment } = data;
  if (!Array.isArray(items) || items.length < 1 || items.length > Object.keys(PRODUCTS).length) throw invalid('Tu carrito está vacío.');
  const seen = new Set();
  const lines = items.map(item => {
    if (!isPlainObject(item)) throw invalid('Revisa los productos de tu carrito.');
    const product = lookup(PRODUCTS, item.sku);
    if (!product || seen.has(product.sku)) throw invalid('Uno de los productos ya no está disponible.');
    seen.add(product.sku);
    if (!Number.isSafeInteger(item.quantity) || item.quantity < 1 || item.quantity > MAX_QUANTITY) throw invalid(`Elige una cantidad entre 1 y ${MAX_QUANTITY}.`);
    return { product, quantity: item.quantity };
  });

  if (!isPlainObject(fulfillment)) throw invalid('Selecciona tu método de envío.');
  let delivery;
  if (fulfillment.method === 'tienda') {
    const store = lookup(STORES, fulfillment.storeId);
    if (!store) throw invalid('Selecciona una tienda para recoger tu pedido.');
    delivery = { method: 'tienda', store };
  } else if (fulfillment.method === 'domicilio') {
    if (typeof fulfillment.postalCode !== 'string' || !/^\d{5}$/.test(fulfillment.postalCode)) throw invalid('Ingresa un código postal válido de 5 dígitos.');
    delivery = { method: 'domicilio', postalCode: fulfillment.postalCode };
  } else {
    throw invalid('Selecciona tu método de envío.');
  }

  if (!isPlainObject(payment)) throw invalid('Selecciona tu método de pago.');
  const card = lookup(CARDS, payment.cardId);
  if (!card) throw invalid('Selecciona una tarjeta válida.');
  const installments = payment.installments ?? 1;
  if (!Number.isSafeInteger(installments) || installments < 1) throw invalid('Selecciona un plan de pagos válido.');
  if (installments > 1) {
    if (!card.msi) throw invalid('Los meses sin intereses solo aplican con tarjetas de crédito participantes.');
    if (!lines.every(line => line.product.msiPlans.includes(installments))) throw invalid(`${installments} meses sin intereses no está disponible para tu carrito.`);
  }
  return { lines, delivery, card, installments };
}

function quoteOrder(lines, delivery) {
  const items = lines.map(({ product, quantity }) => ({
    sku: product.sku, name: product.name, image: product.images[0], quantity,
    unitPriceCents: product.priceCents, lineTotalCents: product.priceCents * quantity,
  }));
  const subtotalCents = items.reduce((sum, item) => sum + item.lineTotalCents, 0);
  const shippingCents = delivery.method === 'domicilio' && subtotalCents < FREE_SHIPPING_CENTS ? HOME_SHIPPING_CENTS : 0;
  const totalCents = subtotalCents + shippingCents;
  if (totalCents > MAX_ORDER_CENTS) throw invalid('El total excede el límite por pedido en línea.');
  return { items, subtotalCents, shippingCents, totalCents };
}

function quoteInstallments(totalCents, installments) {
  const fee = MSI_ACQUIRER_FEES[installments];
  const merchantFeeCents = Math.round(totalCents * fee.sobretasaBps / 10000);
  return { installments, monthlyPaymentCents: Math.round(totalCents / installments), merchantFeeCents };
}

function fulfillmentSummary(delivery) {
  if (delivery.method === 'tienda') {
    const { id, name, address, hours } = delivery.store;
    return { method: 'tienda', storeId: id, storeName: name, storeAddress: address, storeHours: hours, estimate: 'Listo para recoger hoy después de 2 horas' };
  }
  return { method: 'domicilio', postalCode: delivery.postalCode, estimate: 'Entrega de 2 a 4 días hábiles' };
}

async function checkout(data = {}) {
  const { lines, delivery, card, installments } = validateCheckout(data.order);
  const totals = quoteOrder(lines, delivery);
  const checkoutId = randomUUID();
  try {
    const plan = quoteInstallments(totals.totalCents, installments);
    const orderId = `OD${randomInt(100000000, 999999999)}`;
    logger.info('Office Depot México order placed', { service: SERVICE, checkoutId, orderId, totalCents: totals.totalCents, installments, merchantFeeCents: plan.merchantFeeCents });
    return {
      success: true, orderId, checkoutId, currency: 'MXN', ...totals,
      installments: plan.installments, monthlyPaymentCents: plan.monthlyPaymentCents,
      card: { id: card.id, label: card.label, type: card.type },
      fulfillment: fulfillmentSummary(delivery),
      walletPoints: Math.floor(totals.totalCents / 10000),
    };
  } catch (error) {
    const context = { checkoutId, installments, cardId: card.id, fulfillment: delivery.method, totalCents: totals.totalCents, skus: lines.map(l => l.product.sku) };
    const tags = { route: ROUTE, service: SERVICE, customer: CUSTOMER, alert_path: 'instant' };
    Sentry.captureException(error, { tags, extra: context });
    logger.error('Office Depot México checkout failed', { ...context, service: SERVICE, error: error.message });
    logger.info('Posting alert and triggering Devin', { service: SERVICE, checkoutId });
    createSessionAndAlert({
      issueTitle: `${error.name}: ${error.message}`,
      issueUrl: `https://${process.env.SENTRY_ORG_SLUG || 'sentry-org'}.sentry.io/issues/?project=${process.env.SENTRY_PROJECT_ID || ''}&query=is%3Aunresolved`,
      culprit: CULPRIT, errorType: error.name, errorValue: error.message,
      customer: CUSTOMER, service: SERVICE, verticalLabel: 'Office Depot México — Checkout (Grupo Gigante)',
      level: 'error', platform: 'node',
      devinUserId: data.devinUserId, devinOrgId: data.devinOrgId, devinEmail: data.devinEmail,
      promptAppendix: REMEDIATION_DIRECTIVE,
      tags: Object.entries(tags).map(([key, value]) => ({ key, value })), extra: context,
    }).catch(err => logger.error('Failed to create Devin session for Office Depot México checkout', { error: err.message, checkoutId }));
    throw Object.assign(error, { status: 500, code: 'CHECKOUT_FAILED' });
  }
}

function publicCatalog() {
  return {
    products: Object.values(PRODUCTS),
    stores: Object.values(STORES),
    cards: Object.values(CARDS),
    maxQuantity: MAX_QUANTITY,
    freeShippingCents: FREE_SHIPPING_CENTS,
    homeShippingCents: HOME_SHIPPING_CENTS,
  };
}

module.exports = {
  CUSTOMER, SERVICE, ROUTE, CULPRIT, PRODUCTS, STORES, CARDS, MAX_QUANTITY, REMEDIATION_DIRECTIVE,
  validateCheckout, quoteOrder, quoteInstallments, checkout, publicCatalog,
};
