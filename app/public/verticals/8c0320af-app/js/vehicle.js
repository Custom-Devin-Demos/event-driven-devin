/* Vehicle detail: gallery, configuration, payment estimator (Cash / Lease / Loan) and Continue. */
(function () {
  var F = window.Flow;
  var $ = function (sel, root) { return (root || document).querySelector(sel); };
  var $$ = function (sel, root) { return Array.prototype.slice.call((root || document).querySelectorAll(sel)); };

  var ZIP = '19406';
  var PROGRAM_BY_LABEL = { Cash: 'cash', Lease: 'lease-36-10k', Loan: 'finance-72' };

  function rightColumn() {
    return $('[class*="_cardSpacing_1irxy_8"]').parentElement;
  }

  function setRow(li, label, value) {
    var ps = $$('p', li);
    if (label !== null) F.text(ps[0], label);
    F.text(ps[1], value);
  }

  function fillZip() {
    $$('p, span').forEach(function (p) {
      if (p.children.length === 0 && p.textContent.trim() === '67570') p.textContent = ZIP;
    });
  }

  function optionButtons() {
    var est = $('#salesCalculatorContainer');
    return $$('button[aria-controls]', est).map(function (btn) {
      var label = $('p', btn).textContent.trim();
      return { label: label, code: PROGRAM_BY_LABEL[label], btn: btn, panel: document.getElementById(btn.getAttribute('aria-controls')) };
    });
  }

  function fillOptionHeadline(opt, v, quote) {
    var head = $('[class*="_titleContainer_"] p', opt.btn);
    var desc = $('p[class*="_description_"]', opt.btn);
    var spans = $$('p.flex > span', opt.btn);
    var po = v.paymentOptions.filter(function (p) { return p.code === opt.code; })[0];
    if (!po) return;
    if (opt.code === 'cash') {
      head.innerHTML = F.money(v.sellingPrice) + '\u00b9';
      F.text(desc, '');
    } else if (opt.code === 'lease-36-10k') {
      F.text(head, 'Est. ' + po.headline);
      F.text(desc, quote ? F.money(quote.amountDueAtDelivery) + ' due at delivery / 36 months' : po.detail.replace(/ · /g, ' / '));
    } else {
      F.text(head, 'Est. ' + po.headline);
      F.text(desc, po.detail.replace(/ · /g, ' / '));
    }
    if (spans.length > 1) F.text(spans[0], '');
    F.text(spans[spans.length - 1], v.inventoryDiscount ? 'Includes ' + F.money(v.inventoryDiscount) + ' Studio Select adjustment' : 'Studio inventory pricing');
  }

  function fillPanel(opt, v, quote) {
    var lists = $$('#listItems ul', opt.panel);
    var rows = [];
    lists.forEach(function (ul) { $$('li', ul).forEach(function (li) { rows.push(li); }); });
    var labels = $$('label p', opt.panel);
    if (labels[0]) F.text(labels[0], F.money(v.inventoryDiscount || 0) + ' Studio Select adjustment');
    labels.slice(1).forEach(function (p) {
      var row = p.closest('[class*="_checkBox_"]');
      if (row) row.parentElement.style.display = 'none';
    });

    if (opt.code === 'cash') {
      setRow(rows[0], null, F.money(v.listPrice));
      setRow(rows[1], null, F.money(quote ? quote.pricing.destination : 1650));
      rows[2].style.display = 'none';
      setRow(rows[3], 'Studio Select adjustment', '-' + F.money(v.inventoryDiscount || 0));
      setRow(rows[4], null, F.money(quote ? quote.terms.total : v.sellingPrice + 1650));
    } else if (opt.code === 'lease-36-10k' && quote) {
      setRow(rows[0], null, F.money(quote.terms.capitalizedCost));
      setRow(rows[1], null, F.money(quote.amountDueAtDelivery));
      setRow(rows[2], null, String(quote.terms.termMonths));
      setRow(rows[3], null, F.money(quote.terms.monthlyPayment));
    } else if (opt.code === 'finance-72' && quote) {
      setRow(rows[0], null, F.money(quote.terms.principal));
      setRow(rows[1], null, String(quote.terms.termMonths));
      setRow(rows[2], null, F.money(quote.terms.monthlyPayment));
    }
  }

  function requestQuote(v, code) {
    return fetch(F.API + '/quotes', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ vin: v.vin, program: code })
    }).then(function (r) {
      return r.json().then(function (j) { if (!r.ok) throw new Error(j.error || ('quotes ' + r.status)); return j; });
    });
  }

  var selection = 0;

  function setContinue(enabled) {
    var cont = $('[data-testid="checkout_form_submit"]', rightColumn());
    cont.classList.toggle('_disabled_1mz6x_378', !enabled);
    cont.disabled = !enabled;
  }

  function select(opts, opt, v) {
    var mine = ++selection;
    opts.forEach(function (o) {
      var on = o === opt;
      o.btn.setAttribute('aria-expanded', on ? 'true' : 'false');
      o.panel.classList.toggle('hidden', !on);
      o.panel.setAttribute('aria-hidden', on ? 'false' : 'true');
      o.btn.style.background = on ? '#f5f5f5' : '';
    });
    setContinue(false);

    F.set({ program: opt.code, quote: null });
    return requestQuote(v, opt.code).then(function (quote) {
      if (mine !== selection) return;
      F.set({ quote: quote });
      fillOptionHeadline(opt, v, quote);
      fillPanel(opt, v, quote);
      setContinue(true);
    }).catch(function (err) {
      if (mine !== selection) return;
      F.toast('Something went wrong', err.message, true);
    });
  }

  function init(cat) {
    var vin = F.query('vin') || F.state.vin;
    var v = F.vehicleOf(cat, vin) || cat.inventory[0];
    F.set({ trim: v.trim, vin: v.vin });
    document.title = v.modelYear + ' ' + v.trimName + ' | Lucid Motors';

    var col = rightColumn();
    var cards = $$(':scope > div', col);
    F.fillGallery(v);
    F.fillHeader(cards[1], v);
    F.fillSwatches(cards[2], v);
    fillZip();

    var opts = optionButtons();
    opts.forEach(function (opt) {
      fillOptionHeadline(opt, v, null);
      fillPanel(opt, v, null);
      opt.btn.removeAttribute('tabindex');
      opt.btn.addEventListener('click', function () { select(opts, opt, v); });
    });

    var back = $$('button', cards[0])[0];
    if (back) back.addEventListener('click', function () { F.go('vehicles'); });
    var est = $$('button', cards[1]).filter(function (b) { return /PAYMENT ESTIMATOR/i.test(b.textContent); })[0];
    if (est) est.addEventListener('click', function () { $('#salesCalculatorContainer').scrollIntoView({ behavior: 'smooth' }); });

    var cont = $('[data-testid="checkout_form_submit"]', col);
    cont.addEventListener('click', function () {
      if (!F.state.program) {
        F.toast('Choose a payment option', 'Select Cash, Lease or Loan in the Payment Estimator to continue.');
        $('#salesCalculatorContainer').scrollIntoView({ behavior: 'smooth' });
        return;
      }
      if (!F.state.quote || F.state.quote.program.code !== F.state.program) {
        F.toast('Something went wrong', 'Your quote is still being prepared. Please try again.', true);
        return;
      }
      F.go('review');
    });

    var preset = opts.filter(function (o) { return o.code === F.state.program; })[0];
    if (preset) select(opts, preset, v);
  }

  document.addEventListener('DOMContentLoaded', function () {
    F.catalog().then(init).catch(function () {
      F.toast('Something went wrong', 'We couldn’t load this vehicle.', true);
    });
  });
})();
