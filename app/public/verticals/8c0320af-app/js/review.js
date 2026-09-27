/* Order review: quoted configuration, payment breakdown, delivery and the explicit Place order call. */
(function () {
  var F = window.Flow;
  var $ = function (sel, root) { return (root || document).querySelector(sel); };
  var $$ = function (sel, root) { return Array.prototype.slice.call((root || document).querySelectorAll(sel)); };

  var ROW_LABEL = '_resetStyles_s0qpd_278 _body_s0qpd_761 _small_s0qpd_422 _light-gray-5_s0qpd_214 _align-left_s0qpd_310 _direction-ltr_s0qpd_310';
  var ROW_VALUE = '_resetStyles_s0qpd_278 _body_s0qpd_761 _small_s0qpd_422 _medium_s0qpd_375 _light-white_s0qpd_178 _align-right_s0qpd_314 _direction-ltr_s0qpd_310';

  function row(container, label, value, strong) {
    var r = document.createElement('div');
    r.style.cssText = 'display:flex;justify-content:space-between;gap:16px;padding:10px 0;border-bottom:1px solid #e5e5e5;';
    var l = document.createElement('p');
    l.className = ROW_LABEL;
    l.textContent = label;
    var v = document.createElement('p');
    v.className = ROW_VALUE;
    v.textContent = value;
    if (strong) { l.style.color = '#111'; l.style.fontWeight = '500'; }
    r.appendChild(l);
    r.appendChild(v);
    container.appendChild(r);
  }

  function fillGallery(v) {
    $$('img[class*="_image_g6qy1"]').forEach(function (img) {
      F.setImage(img, v.image);
      img.style.opacity = '1';
    });
  }

  function fillConfig(v, q) {
    var rows = $('#rev-config-rows');
    rows.innerHTML = '';
    row(rows, 'Model', v.modelYear + ' ' + v.trimName);
    row(rows, 'VIN', v.vin);
    row(rows, 'Stock', v.stockNumber);
    row(rows, 'Exterior', v.exterior);
    row(rows, 'Interior', v.interior);
    row(rows, 'Wheels', v.wheels);
    row(rows, 'Roof', v.roof);
    row(rows, 'Appearance', v.appearance);
    row(rows, 'MSRP', F.money(q.pricing.listPrice));
    row(rows, 'Studio Select adjustment', '-' + F.money(q.pricing.inventoryDiscount));
    row(rows, 'Selling price', F.money(q.pricing.sellingPrice), true);
  }

  function fillPayment(q) {
    F.text($('#rev-pay-title'), q.program.label);
    F.text($('#rev-quote-id'), q.quoteId);
    var t = q.terms;
    var detail = q.program.type === 'lease'
      ? t.termMonths + ' months · ' + (t.milesPerYear / 1000) + 'k mi/yr · Est. ' + F.money(t.monthlyPayment) + '/mo'
      : q.program.type === 'finance'
        ? t.termMonths + ' months · ' + (t.apr * 100).toFixed(2) + '% APR · Est. ' + F.money(Math.round(t.monthlyPayment)) + '/mo'
        : 'Total vehicle price ' + F.money(t.total);
    F.text($('#rev-pay-detail'), detail);
    var rows = $('#rev-pay-rows');
    rows.innerHTML = '';
    q.lines.forEach(function (l) { row(rows, l.label, F.money2(l.amount)); });
    row(rows, 'Due at delivery', F.money2(q.amountDueAtDelivery), true);
  }

  function fillDelivery(q) {
    var zip = (q.studio.address.match(/\b\d{5}\b/) || [''])[0];
    F.text($('#rev-zip'), zip);
    F.text($('#rev-delivery-text'), 'Home Delivery from ' + q.studio.name + ' · ' + q.studio.address + ' · ' + q.studio.deliveryWindow + '.');
  }

  function fillDue(q) {
    F.text($('#rev-due-amount'), F.money2(q.amountDueAtDelivery));
    F.text($('#rev-due-note'), 'Quote ' + q.quoteId + ' · Estimated taxes and fees included. Amount is confirmed at signing.');
  }

  function showError() {
    var box = $('#rev-error');
    box.removeAttribute('hidden');
    box.style.display = '';
    box.scrollIntoView({ behavior: 'smooth', block: 'center' });
  }

  function placeOrder(q) {
    var btn = $('#cta-place');
    var label = $('span', btn);
    var id = F.identity();
    btn.disabled = true;
    btn.classList.add('_disabled_1mz6x_378');
    F.text(label, 'Placing order…');
    var box = $('#rev-error');
    box.setAttribute('hidden', '');
    box.style.display = 'none';

    return fetch(F.API + '/orders', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        quoteId: q.quoteId,
        devinUserId: id.devinUserId,
        devinOrgId: id.devinOrgId,
        devinEmail: id.devinEmail
      })
    }).then(function (r) {
      return r.json().catch(function () { return {}; }).then(function (j) {
        if (!r.ok || j.success === false) {
          var err = new Error('order ' + r.status);
          err.status = r.status;
          throw err;
        }
        return j;
      });
    }).then(function (order) {
      F.set({ order: order });
      F.text(label, 'Order placed');
      F.toast('Order placed', 'Confirmation ' + (order.orderId || order.id || ''));
    }).catch(function () {
      showError();
      btn.disabled = false;
      btn.classList.remove('_disabled_1mz6x_378');
      F.text(label, 'Place order');
    });
  }

  function init(cat) {
    var q = F.state.quote;
    var v = F.vehicleOf(cat, F.state.vin);
    if (!q || !v) {
      F.go(v ? 'vehicle' : 'vehicles', v ? { vin: v.vin } : undefined);
      return;
    }
    document.title = 'Review Your Order | Lucid Motors';
    var col = $('[class*="_cardSpacing_1irxy_8"]').parentElement;
    var cards = $$(':scope > div', col);
    fillGallery(v);
    F.fillHeader(cards[1], v);
    fillConfig(v, q);
    fillPayment(q);
    fillDelivery(q);
    fillDue(q);

    var back = $$('button', cards[0])[0];
    if (back) back.addEventListener('click', function () { F.go('vehicle', { vin: v.vin }); });
    $('#cta-place').addEventListener('click', function () { placeOrder(q); });
  }

  document.addEventListener('DOMContentLoaded', function () {
    F.catalog().then(init).catch(function () {
      F.toast('Something went wrong', 'We couldn’t load your order.', true);
    });
  });
})();
