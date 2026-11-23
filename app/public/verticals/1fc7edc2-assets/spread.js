/* global document, window, location, fetch, URLSearchParams */
(function () {
  'use strict';
  var REPORTS_ON = new URLSearchParams(location.search).get('reports') !== 'off';
  var VIEWS = ['home', 'spread'];
  var SYMBOL = { ILS: '₪', USD: '$', EUR: '€', THB: '฿', GBP: '£' };
  var state = { account: null, chargeId: null, payments: 12, step: 1, busy: false, spread: {} };
  var $ = function (id) { return document.getElementById(id); };

  function money(n, cur) {
    var digits = cur === 'ILS' || n % 1 ? 2 : 0;
    return (SYMBOL[cur] || cur + ' ') + Number(n).toLocaleString('en-US', { minimumFractionDigits: digits, maximumFractionDigits: 2 });
  }
  function date(iso) { var p = iso.split('-'); return p[2] + '.' + p[1] + '.' + p[0]; }
  function esc(s) { return String(s).replace(/[&<>"]/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]; }); }
  function charge() { return state.account.charges.find(function (c) { return c.id === state.chargeId; }); }

  function route() {
    var view = (location.hash || '#home').slice(1);
    if (VIEWS.indexOf(view) < 0) view = 'home';
    VIEWS.forEach(function (v) { $('view-' + v).hidden = v !== view; });
    window.scrollTo(0, 0);
  }

  function bind(account) {
    var card = account.card;
    var vals = { firstName: card.holder.split(' ')[0], product: card.product, last4: card.last4, network: card.network,
      billingDate: date(card.billingDate), availableCredit: money(card.availableCredit, 'ILS').replace('.00', '') };
    document.querySelectorAll('[data-bind]').forEach(function (el) { el.textContent = vals[el.getAttribute('data-bind')]; });
  }

  function eligible(c) { return !(c.currency === 'ILS' && c.amount < state.account.minSpread) && !state.spread[c.id]; }
  function firstEligible() { var c = state.account.charges.find(eligible); return c ? c.id : null; }

  function renderCharges(focus) {
    $('charges').innerHTML = state.account.charges.map(function (c) {
      var done = Boolean(state.spread[c.id]);
      var tooSmall = !done && !eligible(c);
      var fx = c.currency !== 'ILS' ? '<span class="fx">' + c.currency + '</span>' : '';
      var note = done ? '<div class="note">נפרסה · ' + esc(state.spread[c.id]) + '</div>' : c.currency !== 'ILS' ? '<div class="note">יומר לשקלים ביום החיוב</div>' : tooSmall ? '<div class="note">מתחת לסכום המינימלי לפריסה</div>' : '';
      return '<tr class="row' + (c.id === state.chargeId ? ' sel' : '') + (tooSmall || done ? ' dis' : '') + '" data-id="' + c.id + '">' +
        '<td><input type="radio" name="charge" aria-label="' + esc(c.merchant) + '"' + (c.id === state.chargeId ? ' checked' : '') + (tooSmall || done ? ' disabled' : '') + '></td>' +
        '<td><b>' + esc(c.merchant) + '</b><div class="note">' + esc(c.city) + '</div></td><td>' + date(c.date) + '</td><td>' + esc(c.category) + '</td>' +
        '<td class="amt">' + fx + money(c.amount, c.currency) + note + '</td></tr>';
    }).join('');
    $('to-2').disabled = !state.chargeId;
    if (focus) { var sel = document.querySelector('#charges tr.sel input'); if (sel) sel.focus(); }
  }

  function renderOpts(focus) {
    $('opts').innerHTML = state.account.paymentOptions.map(function (n) {
      return '<button type="button" data-n="' + n + '" class="' + (n === state.payments ? 'on' : '') + '">' + n + '<span>תשלומים</span></button>';
    }).join('');
    if (focus) { var on = document.querySelector('#opts button.on'); if (on) on.focus(); }
  }

  function renderSummary() {
    var c = charge();
    $('summary').innerHTML = [
      ['בית העסק', esc(c.merchant)], ['סכום העסקה', money(c.amount, c.currency)],
      ['מספר תשלומים', state.payments], ['תשלום ראשון', date(state.account.card.billingDate)],
      ['כרטיס', state.account.card.product + ' •••• ' + state.account.card.last4], ['המרה', c.currency === 'ILS' ? 'ללא' : 'לפי שער ההמרה ביום החיוב'],
    ].map(function (r) { return '<div><span>' + r[0] + '</span><b>' + r[1] + '</b></div>'; }).join('');
  }

  function go(step) {
    if (step > 1 && !(state.account && state.chargeId)) return;
    state.step = step;
    [1, 2, 3].forEach(function (n) { $('step-' + n).hidden = n !== step; });
    document.querySelectorAll('#steps li').forEach(function (li) { li.classList.toggle('on', Number(li.getAttribute('data-step')) <= step); });
    $('result').hidden = true;
    if (step === 3) renderSummary();
  }

  function showResult(html, ok) {
    [1, 2, 3].forEach(function (n) { $('step-' + n).hidden = true; });
    $('result').className = 'result ' + (ok ? 'ok' : 'bad');
    $('result').innerHTML = html;
    $('result').hidden = false;
  }

  function submit() {
    if (state.busy) return;
    if (!$('consent').checked) { $('consent').focus(); return; }
    state.busy = true;
    var btn = $('submit');
    btn.disabled = true; btn.innerHTML = '<span class="spinner"></span> מחשבים את הפריסה…';
    var payload = { chargeId: state.chargeId, payments: state.payments };
    if (!REPORTS_ON) payload.reports = 'off';
    fetch('/api/1fc7edc2/installment-plans', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) })
      .then(function (r) { return r.json().then(function (j) { return { ok: r.ok, status: r.status, body: j }; }); })
      .then(function (res) {
        var b = res.body;
        if (res.ok && b.success) {
          state.spread[b.chargeId] = b.planId;
          state.chargeId = firstEligible();
          renderCharges();
          showResult('<h2>הפריסה אושרה</h2><p>העסקה ב־' + esc(b.merchant) + ' תיפרס ל־' + b.payments + ' תשלומים חודשיים.</p>' +
            '<div class="sum"><div><span>סכום לחיוב</span><b>' + money(b.billingAmount, 'ILS') + '</b></div><div><span>תשלום חודשי</span><b>' + money(b.monthlyPayment, 'ILS') + '</b></div>' +
            '<div><span>ריבית שנתית</span><b>' + b.annualRate + '%</b></div><div><span>סך עלות האשראי</span><b>' + money(b.totalInterest, 'ILS') + '</b></div></div>' +
            '<p>מספר אסמכתא: <span class="ref" data-testid="plan-id">' + esc(b.planId) + '</span></p><button class="btn ghost" type="button" data-restart>לפריסת עסקה נוספת</button>', true);
        } else if (res.status >= 500) {
          showResult('<h2>לא הצלחנו להשלים את הפריסה</h2><p>אירעה תקלה בחישוב הפריסה. הבקשה לא נקלטה ולא בוצע שינוי בחיוב.</p>' +
            '<p>מספר פנייה: <span class="ref" data-testid="error-ref">' + esc(b.reference || b.requestId || '—') + '</span> · קוד: <span class="ref" data-testid="error-code">' + esc(b.code || res.status) + '</span></p>' +
            '<p class="note">אפשר לנסות שוב מאוחר יותר או לפנות למוקד השירות.</p><button class="btn ghost" type="button" data-restart>חזרה לבחירת עסקה</button>', false);
        } else {
          showResult('<h2>לא ניתן לפרוס את העסקה</h2><p>' + esc(b.error || 'בדקו את הפרטים ונסו שוב.') + '</p><button class="btn ghost" type="button" data-restart>חזרה לבחירת עסקה</button>', false);
        }
      })
      .catch(function () { showResult('<h2>אין חיבור</h2><p>בדקו את החיבור לאינטרנט ונסו שוב.</p><button class="btn ghost" type="button" data-restart>חזרה</button>', false); })
      .then(function () { state.busy = false; btn.disabled = false; btn.textContent = 'לאישור הפריסה'; });
  }

  document.addEventListener('click', function (e) {
    var row = e.target.closest('#charges tr.row');
    if (row && !row.classList.contains('dis')) { state.chargeId = row.getAttribute('data-id'); renderCharges(true); return; }
    var opt = e.target.closest('#opts button');
    if (opt) { state.payments = Number(opt.getAttribute('data-n')); renderOpts(true); return; }
    var back = e.target.closest('[data-back]');
    if (back) { go(Number(back.getAttribute('data-back'))); return; }
    if (e.target.closest('[data-restart]')) { go(1); return; }
    if (e.target.id === 'to-2') go(2);
    else if (e.target.id === 'to-3') go(3);
    else if (e.target.closest('#submit')) submit();
  });

  window.addEventListener('hashchange', route);
  route();
  fetch('/api/1fc7edc2/account').then(function (r) { return r.json(); }).then(function (account) {
    state.account = account;
    state.chargeId = account.charges[0].id;
    bind(account); renderCharges(); renderOpts();
  });
}());
