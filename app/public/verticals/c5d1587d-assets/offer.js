/* global document, window, localStorage, location, fetch, URLSearchParams */
(function () {
  'use strict';
  var REPORTS_ON = new URLSearchParams(location.search).get('reports') !== 'off';
  var VIEWS = ['home', 'mortgages', 'offer'];
  var state = { step: 0, catalog: null };
  var $ = function (s, r) { return (r || document).querySelector(s); };
  var $$ = function (s, r) { return Array.prototype.slice.call((r || document).querySelectorAll(s)); };
  var digits = function (v) { return Number(String(v || '').replace(/[^\d]/g, '')); };
  var ils = function (n) { return '₪' + Math.round(n).toLocaleString('he-IL'); };
  var esc = function (s) { return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; }); };

  function presenter() {
    var get = function (k) { try { return localStorage.getItem(k) || undefined; } catch { return undefined; } };
    return { devinUserId: get('devinUserId'), devinOrgId: get('devinOrgId'), devinEmail: get('devinEmail') };
  }

  function route() {
    var view = (location.hash || '#home').slice(1);
    if (VIEWS.indexOf(view) < 0) view = 'home';
    VIEWS.forEach(function (v) { $('#view-' + v).hidden = v !== view; });
    $('#mortgage-subnav').hidden = view === 'home';
    window.scrollTo(0, 0);
  }

  function showStep(i) {
    state.step = i;
    $$('.step').forEach(function (f) { f.hidden = Number(f.dataset.i) !== i; });
    $$('#stepper li').forEach(function (li) {
      var n = Number(li.dataset.i);
      li.className = n === i ? 'on' : (n < i ? 'done' : '');
    });
    $('#result').hidden = true;
    $('#failure').hidden = true;
    if (i === 2) updateLtv();
    if (i === 3) renderSummary();
  }

  function application() {
    return {
      property: {
        purpose: ($('input[name=purpose]:checked') || {}).value,
        price: digits($('#price').value), city: $('#city').value,
        greenCertified: $('#green').checked, newBuild: $('#newBuild').checked,
      },
      borrower: {
        fullName: $('#fullName').value, idNumber: $('#idNumber').value, phone: $('#phone').value,
        netIncome: digits($('#netIncome').value), obligations: digits($('#obligations').value),
      },
      loan: { amount: digits($('#amount').value), years: Number($('#years').value), mix: ($('input[name=mix]:checked') || {}).value },
    };
  }

  function updateLtv() {
    var a = application();
    var p = (state.catalog && state.catalog.purposes || []).filter(function (x) { return x.id === a.property.purpose; })[0];
    var ltv = a.property.price ? (a.loan.amount / a.property.price) * 100 : 0;
    $('#ltv-hint').textContent = 'שיעור מימון: ' + ltv.toFixed(1) + '%' + (p ? ' (מקסימום ל' + p.label + ': ' + Math.round(p.maxLtv * 100) + '%)' : '');
  }

  function renderMixes() {
    $('#mixes').innerHTML = state.catalog.mixes.map(function (m, i) {
      return '<label><input type="radio" name="mix" value="' + esc(m.id) + '"' + (i === 0 ? ' checked' : '') + '><span><b>' + esc(m.label) + '</b><small>' + esc(m.hint) + '</small></span></label>';
    }).join('');
  }

  function renderSummary() {
    var a = application();
    var purpose = state.catalog.purposes.filter(function (x) { return x.id === a.property.purpose; })[0] || {};
    var mix = state.catalog.mixes.filter(function (x) { return x.id === a.loan.mix; })[0] || {};
    var rows = [
      ['מטרת המשכנתא', purpose.label], ['מחיר הנכס', ils(a.property.price)], ['יישוב', a.property.city],
      ['בנייה ירוקה', a.property.greenCertified ? 'כן – ת"י 5281' : 'לא'], ['שם הלווה', a.borrower.fullName],
      ['הכנסה חודשית נטו', ils(a.borrower.netIncome)], ['סכום המשכנתא', ils(a.loan.amount)],
      ['תקופה', a.loan.years + ' שנים'], ['תמהיל', mix.label],
    ];
    $('#summary').innerHTML = rows.map(function (r) { return '<dt>' + esc(r[0]) + '</dt><dd>' + esc(r[1]) + '</dd>'; }).join('');
  }

  function clearErrors() {
    $$('.field.err').forEach(function (f) { f.classList.remove('err'); var m = $('.msg', f); if (m) m.remove(); });
  }

  function fieldError(field, message) {
    var map = { price: 0, city: 0, purpose: 0, fullName: 1, idNumber: 1, phone: 1, netIncome: 1, obligations: 1, amount: 2, years: 2, mix: 2 };
    if (field in map) showStep(map[field]);
    var input = document.getElementById(field);
    var box = input && input.closest('.field');
    if (box) {
      box.classList.add('err');
      var m = document.createElement('div'); m.className = 'msg'; m.textContent = message; box.appendChild(m); input.focus();
    } else {
      toast(message);
    }
  }

  function toast(text) {
    var t = document.createElement('div');
    t.className = 'toast'; t.setAttribute('role', 'status'); t.textContent = text;
    document.body.appendChild(t);
    setTimeout(function () { t.classList.add('hide'); }, 5000);
    setTimeout(function () { t.remove(); }, 5600);
  }

  function renderOffer(o) {
    $$('.step').forEach(function (f) { f.hidden = true; });
    $$('#stepper li').forEach(function (li) { li.className = 'done'; });
    var el = $('#result');
    el.innerHTML = '<h2>' + esc(o.firstName) + ', קיבלת אישור עקרוני למשכנתא!</h2>' +
      '<p>מספר הצעה: <b>' + esc(o.offerId) + '</b> · בתוקף עד ' + esc(o.validUntil) + '</p>' +
      '<p>החזר חודשי ראשון משוער</p><p class="big">' + ils(o.monthlyPayment) + '</p>' +
      '<p>' + esc(o.mix) + ' · ' + ils(o.amount) + ' ל-' + o.years + ' שנים · שיעור מימון ' + o.ltv + '% · יחס החזר מהכנסה ' + o.paymentToIncome + '%</p>' +
      '<table><thead><tr><th>מסלול</th><th>חלק</th><th>סכום</th><th>ריבית שנתית</th><th>החזר חודשי</th></tr></thead><tbody>' +
      o.tracks.map(function (t) { return '<tr><td>' + esc(t.label) + '</td><td>' + t.share + '%</td><td>' + ils(t.principal) + '</td><td>' + t.annualRate.toFixed(2) + '%</td><td>' + ils(t.monthlyPayment) + '</td></tr>'; }).join('') +
      '</tbody></table><p class="hint">הריביות אינדיקטיביות ואינן מהוות התחייבות. האישור הסופי כפוף לבדיקת הנכס ולתנאי הבנק.</p>' +
      '<a class="btn" href="#mortgages">לתיאום פגישה עם יועץ משכנתאות</a>';
    el.hidden = false;
    el.scrollIntoView({ behavior: 'smooth', block: 'center' });
  }

  function renderFailure(body) {
    var el = $('#failure');
    el.innerHTML = '<h3>לא הצלחנו להפיק עבורך הצעה כרגע</h3>' +
      '<p>אירעה תקלה במערכת התמחור. הצוות שלנו כבר מטפל בכך.</p>' +
      '<p>מספר פנייה: <code>' + esc(body.reference || body.requestId || '—') + '</code> · קוד שגיאה: <code>' + esc(body.code || 'MTG-500') + '</code></p>' +
      '<p>ניתן לנסות שוב בעוד מספר דקות או לפנות למוקד המשכנתאות ב-8860*.</p>';
    el.hidden = false;
    el.scrollIntoView({ behavior: 'smooth', block: 'center' });
    toast('אירעה שגיאה בהפקת ההצעה (' + (body.code || '500') + ')');
  }

  function submitOffer() {
    if (!$('#consent').checked) { toast('יש לאשר את בדיקת נתוני האשראי.'); return; }
    var btn = $('#submit-offer');
    btn.disabled = true; btn.textContent = 'מפיקים עבורך הצעה…';
    var payload = Object.assign({ application: application() }, presenter());
    if (!REPORTS_ON) payload.reports = 'off';
    fetch('/api/c5d1587d/mortgage-offers', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) })
      .then(function (r) { return r.json().then(function (b) { return { ok: r.ok, status: r.status, body: b }; }); })
      .then(function (res) {
        if (res.ok) return renderOffer(res.body);
        if (res.status === 400) return fieldError(res.body.field, res.body.error);
        renderFailure(res.body);
      })
      .catch(function () { renderFailure({ code: 'NETWORK' }); })
      .finally(function () { btn.disabled = false; btn.textContent = 'לקבלת אישור עקרוני'; });
  }

  $$('.step').forEach(function (form) {
    form.addEventListener('submit', function (e) {
      e.preventDefault(); clearErrors();
      var i = Number(form.dataset.i);
      if (i < 3) showStep(i + 1); else submitOffer();
    });
    var back = $('[data-back]', form);
    if (back) back.addEventListener('click', function () { clearErrors(); showStep(Number(form.dataset.i) - 1); });
  });
  ['#amount', '#price'].forEach(function (s) { $(s).addEventListener('input', updateLtv); });

  fetch('/api/c5d1587d/catalog').then(function (r) { return r.json(); }).then(function (c) {
    state.catalog = c; renderMixes(); showStep(0);
  });
  window.addEventListener('hashchange', route);
  route();
})();
