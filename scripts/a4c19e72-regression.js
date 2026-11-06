const assert = require('node:assert/strict');
const { quoteCart, STORES } = require('../app/services/verticals/a4c19e72');

for (const store of STORES) {
  for (const qty of [1, 2]) {
    const items = [{ sku: 'DEMO-FRIDGE', qty }, { sku: 'DEMO-BATTERY', qty: 1 }];
    const delivery = quoteCart({ items, store, fulfillment: 'delivery' });
    const pickup = quoteCart({ items, store, fulfillment: 'pickup' });
    assert.equal(pickup.success, true);
    assert.equal(pickup.fee, 0);
    assert.equal(pickup.total, delivery.total - 79);
    assert.equal(pickup.lines.length, 2);
    assert.equal(pickup.store, store);
    console.log(`PASS: delivery → pickup, ${qty} bulky item(s), ${store}, totals and cart preserved`);
  }
}
