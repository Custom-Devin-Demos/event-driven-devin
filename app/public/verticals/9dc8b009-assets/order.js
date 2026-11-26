/* global document, window, location, fetch, URLSearchParams */
(function () {
  'use strict';
  var REPORTS_ON = new URLSearchParams(location.search).get('reports') !== 'off';
  var VIEWS = ['accueil', 'configurateur'];
  var HH = { standard: 'Ménage standard', modeste: 'Ménage modeste' };
  var SWATCH = { 'blanc-glacier': '#f4f4f2', 'jaune-pop': '#efdf00', 'vert-pistache': '#b9d27a', 'noir-etoile': '#151515' };
  var state = { catalog: null, modelId: null, paintId: null, wallbox: false, household: 'standard', step: 1, busy: false };
  var $ = function (id) { return document.getElementById(id); };

  function eur(n) { return Number(n).toLocaleString('fr-FR').replace(/\u202f|\u00a0/g, ' ') + ' €'; }
  function esc(s) { return String(s).replace(/[&<>"]/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]; }); }
  function model() { return state.catalog.models.find(function (m) { return m.id === state.modelId; }); }
  function paint() { return state.catalog.paints.find(function (p) { return p.id === state.paintId; }); }

  function route() {
    var view = (location.hash || '#accueil').slice(1);
    if (VIEWS.indexOf(view) < 0) view = 'accueil';
    VIEWS.forEach(function (v) { $('view-' + v).hidden = v !== view; });
    window.scrollTo(0, 0);
  }

  function renderRange() {
    $('range').innerHTML = state.catalog.models.map(function (m) {
      return '<div class="mcard"><div class="sil">' + (m.isNew ? '<span class="new">Nouveau</span>' : '') + '</div><h3>' + esc(m.name) + '</h3>' +
        '<div class="from">à partir de <b>' + eur(m.basePrice) + '</b></div><div class="specs"><span><b>' + m.rangeKm + ' km</b> WLTP</span><span><b>' + m.battery.kWh + ' kWh</b></span></div>' +
        '<a class="btn dark" style="margin-top:12px" href="#configurateur" data-pick="' + m.id + '">Commander</a></div>';
    }).join('');
  }

  function renderModels() {
    $('models').innerHTML = state.catalog.models.map(function (m) {
      return '<button type="button" class="opt' + (m.id === state.modelId ? ' on' : '') + '" data-model="' + m.id + '" aria-pressed="' + (m.id === state.modelId) + '">' +
        (m.isNew ? '<span class="new">Nouveau</span>' : '') + '<b>' + esc(m.name) + '</b><small>' + esc(m.version) + ' · ' + m.battery.kWh + ' kWh ' + esc(m.battery.chemistry) + '</small>' +
        '<small>' + m.rangeKm + ' km WLTP · recharge rapide ' + m.dcKw + ' kW · livraison ' + esc(m.delivery) + '</small><span class="p">' + eur(m.basePrice) + '</span></button>';
    }).join('');
  }

  function renderPaints() {
    $('paints').innerHTML = state.catalog.paints.map(function (p) {
      return '<button type="button" class="sw' + (p.id === state.paintId ? ' on' : '') + '" data-paint="' + p.id + '"><i style="background:' + SWATCH[p.id] + '"></i>' + esc(p.label) + ' · ' + (p.price ? '+' + eur(p.price) : 'incluse') + '</button>';
    }).join('');
    $('wallbox').checked = state.wallbox;
  }

  function renderHouseholds() {
    $('households').innerHTML = state.catalog.households.map(function (h) {
      return '<button type="button" class="sw' + (h === state.household ? ' on' : '') + '" data-hh="' + h + '" aria-pressed="' + (h === state.household) + '">' + esc(HH[h] || h) + '</button>';
    }).join('');
  }

  function renderRecap() {
    var m = model(); var p = paint();
    if (!m || !p) return;
    var rows = [['Prix de base', eur(m.basePrice)], ['Teinte ' + p.label, p.price ? eur(p.price) : 'incluse']];
    if (state.wallbox) rows.push(['Borne Mobilize Powerbox', eur(state.catalog.wallbox.price)]);
    rows.push(['Aide à l\'achat', 'calculée à la commande']);
    $('recap').innerHTML = '<h3>' + esc(m.name) + '</h3><div class="specs" style="margin:0 0 10px"><span>' + esc(m.version) + '</span><span>Usine ' + esc(m.plant) + '</span></div>' +
      rows.map(function (r) { return '<div class="row"><span>' + esc(r[0]) + '</span><b>' + r[1] + '</b></div>'; }).join('') +
      '<div class="row tot"><span>Acompte aujourd\'hui</span><span>' + eur(state.catalog.deposit) + '</span></div><div class="note">Acompte remboursable. Solde réglé à la livraison.</div>';
  }

  function go(step) {
    if (step > 1 && !state.modelId) return;
    state.step = step;
    [1, 2, 3].forEach(function (n) { $('step-' + n).hidden = n !== step; });
    document.querySelectorAll('#steps li').forEach(function (li) { li.classList.toggle('on', Number(li.getAttribute('data-step')) <= step); });
    $('result').hidden = true;
    renderRecap();
  }

  function showResult(html, ok) {
    [1, 2, 3].forEach(function (n) { $('step-' + n).hidden = true; });
    $('result').className = 'result' + (ok ? '' : ' bad');
    $('result').innerHTML = html;
    $('result').hidden = false;
    $('result').scrollIntoView({ block: 'start' });
  }

  function submit() {
    if (state.busy) return;
    if (!$('consent').checked) { $('consent').focus(); return; }
    state.busy = true;
    var btn = $('submit');
    btn.disabled = true; btn.innerHTML = '<span class="spinner"></span> Validation de la commande…';
    var payload = { modelId: state.modelId, paintId: state.paintId, wallbox: state.wallbox, household: state.household };
    if (!REPORTS_ON) payload.reports = 'off';
    fetch('/api/9dc8b009/orders', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) })
      .then(function (r) { return r.json().then(function (j) { return { ok: r.ok, status: r.status, body: j }; }); })
      .then(function (res) {
        var b = res.body;
        if (res.ok && b.success) {
          showResult('<h2>Votre commande est confirmée</h2><p>' + esc(b.model) + ' · ' + esc(b.paint) + ' · livraison estimée ' + esc(b.estimatedDelivery) + '.</p>' +
            '<div class="recap" style="position:static;padding:0"><div class="row"><span>Prix du véhicule</span><b>' + eur(b.vehiclePrice) + '</b></div>' +
            (b.options ? '<div class="row"><span>Borne Mobilize Powerbox</span><b>' + eur(b.options) + '</b></div>' : '') +
            '<div class="row"><span>Aide à l\'achat (score ' + b.environmentalScore + '/100)</span><b>' + (b.incentive ? '-' + eur(b.incentive) : 'non éligible') + '</b></div>' +
            '<div class="row tot"><span>Total</span><span>' + eur(b.total) + '</span></div><div class="row"><span>Acompte payé</span><b>' + eur(b.deposit) + '</b></div></div>' +
            '<p>Numéro de commande : <span class="ref" data-testid="order-id">' + esc(b.orderId) + '</span></p><button class="btn ghost" type="button" data-restart>Nouvelle configuration</button>', true);
        } else if (res.status >= 500) {
          showResult('<h2>Votre commande n\'a pas pu aboutir</h2><p>Une erreur est survenue lors du calcul de votre commande. Aucun acompte n\'a été débité.</p>' +
            '<p>Référence : <span class="ref" data-testid="error-ref">' + esc(b.reference || b.requestId || '—') + '</span> · Code : <span class="ref" data-testid="error-code">' + esc(b.code || res.status) + '</span></p>' +
            '<p class="hint">Réessayez plus tard ou contactez le service client Renault.</p><button class="btn ghost" type="button" data-restart>Retour à la configuration</button>', false);
        } else {
          showResult('<h2>Commande impossible</h2><p>' + esc(b.error || 'Vérifiez votre configuration.') + '</p><button class="btn ghost" type="button" data-restart>Retour</button>', false);
        }
      })
      .catch(function () { showResult('<h2>Connexion perdue</h2><p>Vérifiez votre connexion et réessayez.</p><button class="btn ghost" type="button" data-restart>Retour</button>', false); })
      .then(function () { state.busy = false; btn.disabled = false; btn.textContent = 'Commander et payer l\'acompte'; });
  }

  document.addEventListener('click', function (e) {
    if (state.busy) return;
    var pick = e.target.closest('[data-pick]');
    if (pick) {
      if (e.ctrlKey || e.metaKey || e.shiftKey || e.altKey || e.button) return;
      state.modelId = pick.getAttribute('data-pick');
      if (state.catalog) { renderModels(); go(1); }
      return;
    }
    var m = e.target.closest('[data-model]');
    if (m) { state.modelId = m.getAttribute('data-model'); renderModels(); renderRecap(); return; }
    var p = e.target.closest('[data-paint]');
    if (p) { state.paintId = p.getAttribute('data-paint'); renderPaints(); renderRecap(); return; }
    var h = e.target.closest('[data-hh]');
    if (h) { state.household = h.getAttribute('data-hh'); renderHouseholds(); return; }
    var back = e.target.closest('[data-back]');
    if (back) { go(Number(back.getAttribute('data-back'))); return; }
    if (e.target.closest('[data-restart]')) { go(1); return; }
    if (e.target.id === 'to-2') go(2);
    else if (e.target.id === 'to-3') go(3);
    else if (e.target.closest('#submit')) submit();
  });
  document.addEventListener('change', function (e) {
    if (e.target.id === 'wallbox') { state.wallbox = e.target.checked; renderRecap(); }
  });

  window.addEventListener('hashchange', route);
  route();
  fetch('/api/9dc8b009/catalog').then(function (r) { return r.json(); }).then(function (catalog) {
    state.catalog = catalog;
    if (!catalog.models.some(function (m) { return m.id === state.modelId; })) state.modelId = catalog.models[0].id;
    state.paintId = catalog.paints[0].id;
    document.querySelector('[data-bind="deposit"]').textContent = eur(catalog.deposit);
    document.querySelector('[data-bind="wallboxLabel"]').textContent = catalog.wallbox.label;
    document.querySelector('[data-bind="wallboxPrice"]').textContent = '+' + eur(catalog.wallbox.price);
    renderRange(); renderModels(); renderPaints(); renderHouseholds(); renderRecap();
  });
}());
