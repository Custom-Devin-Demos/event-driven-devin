const { randomUUID } = require('crypto');

const CUSTOMER = 'a4c19e72';
const REVISION = 'Incident baseline';
const CATALOG = [
  { sku: 'DEMO-FRIDGE', brand: 'Samsung', name: 'Bespoke 26-cu ft French Door Refrigerator', detail: 'Fingerprint-resistant stainless steel · Counter-depth', price: 1599, was: 2199, shippingClass: 'bulky', image: '/verticals/lowes-assets/refrigerator.jpeg' },
  { sku: 'DEMO-BATTERY', brand: 'DEWALT', name: '20V MAX XR 2-Pack Battery & Charger Kit', detail: 'Two 8 Ah batteries · Charger included', price: 199, was: 299, shippingClass: 'parcel', image: '/verticals/lowes-assets/battery.jpeg' },
  { sku: 'DEMO-LIGHT', brand: 'Klein Tools', name: 'Rechargeable LED Pocket Flashlight', detail: 'Slim profile · Integrated laser', price: 39.98, was: 49.98, shippingClass: 'parcel', image: '/verticals/lowes-assets/flashlight.jpeg' },
];
const STORES = ['Central Charlotte', 'South Charlotte'];
const FULFILLMENT = {
  delivery: { bulky: { fee: 79, promise: 'Scheduled delivery available' }, parcel: { fee: 0, promise: 'Free shipping' } },
  pickup: { parcel: { fee: 0, promise: 'Ready in 3 hours' } },
};

function invalid(message) {
  return Object.assign(new Error(message), { status: 400, code: 'INVALID_CART' });
}

function quoteCart({ items, fulfillment = 'delivery', store = 'Central Charlotte' } = {}) {
  if (!['delivery', 'pickup'].includes(fulfillment) || !STORES.includes(store)) throw invalid('Choose a supported fulfillment method and demo store.');
  if (!Array.isArray(items) || !items.length || items.length > CATALOG.length) throw invalid('Add an item to your cart.');
  const seen = new Set();
  const lines = items.map(item => {
    const product = CATALOG.find(p => p.sku === item?.sku);
    if (!product || seen.has(product.sku) || !Number.isInteger(item.qty) || item.qty < 1 || item.qty > 5) throw invalid('Invalid product or quantity.');
    seen.add(product.sku);
    const policy = FULFILLMENT[fulfillment][product.shippingClass];
    return { ...product, qty: item.qty, lineTotal: Math.round(product.price * item.qty * 100) / 100, fee: policy.fee, promise: policy.promise };
  });
  const subtotalCents = lines.reduce((sum, p) => sum + Math.round(p.price * 100) * p.qty, 0);
  const feeCents = Math.max(...lines.map(p => p.fee * 100));
  const taxCents = Math.round(subtotalCents * 0.0725);
  return { success: true, demo: true, confirmation: `DEMO-${randomUUID().slice(0, 8).toUpperCase()}`, fulfillment, store, lines, subtotal: subtotalCents / 100, fee: feeCents / 100, tax: taxCents / 100, total: (subtotalCents + feeCents + taxCents) / 100, currency: 'USD', revision: REVISION };
}

module.exports = { CUSTOMER, REVISION, CATALOG, STORES, quoteCart };
