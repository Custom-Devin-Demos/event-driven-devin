/* global document, window, location, fetch, URLSearchParams */
(function () {
  'use strict';
  var REPORTS_ON = new URLSearchParams(location.search).get('reports') !== 'off';
  var VIEWS = ['accueil', 'configurateur'];
  var HH = { standard: 'ménage standard', modeste: 'ménage modeste' };
  var SWATCH = { 'blanc-glacier': '#f1f1ee', 'jaune-pop': '#f2c318', 'vert-pistache': '#2f9e4f', 'noir-etoile': '#1c1c1e' };
  var state = { catalog: null, modelId: null, paintId: null, wallbox: false, household: 'standard', step: 1, busy: false };
  var $ = function (id) { return document.getElementById(id); };

  function eur(n) { return Number(n).toLocaleString('fr-FR').replace(/\u202f|\u00a0/g, ' ') + ' €'; }
  function esc(s) { return String(s).replace(/[&<>"]/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]; }); }
  function model() { return state.catalog.models.find(function (m) { return m.id === state.modelId; }); }
  function paint() { return state.catalog.paints.find(function (p) { return p.id === state.paintId; }); }

  function stagePhoto(m, p) { return '/verticals/9dc8b009-assets/stage/' + m.id + '-' + p.id + '.jpg'; }

  function route() {
    var view = (location.hash || '#accueil').slice(1);
    if (VIEWS.indexOf(view) < 0) view = 'accueil';
    VIEWS.forEach(function (v) { $('view-' + v).hidden = v !== view; });
    document.body.classList.toggle('home', view === 'accueil');
    window.scrollTo(0, 0);
  }

  function renderRange() {
    var intro = document.querySelector('#range .intro').outerHTML;
    $('range').innerHTML = intro + state.catalog.models.map(function (m) {
      return '<a class="mcard" href="#configurateur" data-pick="' + m.id + '"><h3>' + esc(m.name.replace(/ E-Tech électrique$/, '')) + (m.isNew ? '<span class="new">nouveau</span>' : '') + '</h3>' +
        '<div class="from">à partir de ' + eur(m.basePrice) + '</div><div class="ec">classe énergétique <span>A</span></div>' +
        '<div class="pic"><img src="/verticals/9dc8b009-assets/cars/' + m.id + '.jpg" alt="' + esc(m.name) + '" width="900" height="600" loading="lazy"></div><span class="tag">électrique</span></a>';
    }).join('');
  }

  function renderModels() {
    $('models').innerHTML = state.catalog.models.map(function (m) {
      return '<button type="button" class="opt' + (m.id === state.modelId ? ' on' : '') + '" data-model="' + m.id + '" aria-pressed="' + (m.id === state.modelId) + '">' +
        '<span>' + esc(m.name) + (m.isNew ? '<span class="new">nouveau</span>' : '') + '<br><small>' + esc(m.version) + '</small></span><span>' + eur(m.basePrice) + '</span></button>';
    }).join('');
    var m = model();
    if (!m) return;
    $('specs').innerHTML = [
      ['autonomie WLTP cycle combiné (km)', m.rangeKm], ['capacité de la batterie (kWh)', m.battery.kWh], ['chimie de la batterie', m.battery.chemistry],
      ['recharge rapide DC (kW)', m.dcKw], ['plateforme', m.platform], ['livraison estimée', m.delivery],
    ].map(function (r) { return '<div class="spec"><span>' + esc(r[0]) + '</span><span>' + esc(r[1]) + '</span></div>'; }).join('');
    document.querySelector('[data-bind="modelName"]').textContent = m.name;
  }

  function renderStage() {
    var m = model(); var p = paint();
    if (!m || !p) return;
    var src = stagePhoto(m, p);
    $('stage').innerHTML = '<img src="' + src + '" alt="' + esc(m.name + ' ' + p.label) + '" width="1200" height="800" loading="lazy" data-testid="stage-photo"><span class="arrow l" aria-hidden="true">‹</span><span class="arrow r" aria-hidden="true">›</span><span class="count">1 / 4</span>';
    $('thumbs').innerHTML = ['on', '', '', ''].map(function (c, i) { return '<span class="' + c + '" style="background-image:url(' + src + ');filter:brightness(' + (1 - i * 0.08) + ')"></span>'; }).join('');
    var photo = $('stage').querySelector('img');
    photo.onerror = function () {
      var fallback = '/verticals/9dc8b009-assets/cars/' + m.id + '.jpg';
      photo.onerror = null; photo.alt = m.name; photo.src = fallback;
      $('thumbs').querySelectorAll('span').forEach(function (t) { t.style.backgroundImage = 'url(' + fallback + ')'; });
    };
    document.querySelector('[data-bind="headline"]').textContent = eur(m.basePrice + p.price + (state.wallbox ? state.catalog.wallbox.price : 0));
  }

  function renderPaints() {
    $('paints').innerHTML = state.catalog.paints.map(function (p) {
      return '<button type="button" class="sw' + (p.id === state.paintId ? ' on' : '') + '" data-paint="' + p.id + '" aria-pressed="' + (p.id === state.paintId) + '"><i style="background:' + SWATCH[p.id] + '"></i>' + esc(p.label) + '<small>' + (p.price ? '+' + eur(p.price) : 'incluse') + '</small></button>';
    }).join('');
    $('wallbox').checked = state.wallbox;
  }

  function renderHouseholds() {
    $('households').innerHTML = state.catalog.households.map(function (h) {
      return '<button type="button" class="chip' + (h === state.household ? ' on' : '') + '" data-hh="' + h + '" aria-pressed="' + (h === state.household) + '">' + esc(HH[h] || h) + '</button>';
    }).join('');
  }

  function renderRecap() {
    var m = model(); var p = paint();
    if (!m || !p) return;
    var rows = [['prix de base', eur(m.basePrice)], ['teinte ' + p.label, p.price ? eur(p.price) : 'incluse']];
    if (state.wallbox) rows.push(['borne Mobilize Powerbox', eur(state.catalog.wallbox.price)]);
    rows.push(['prime Coup de Pouce', 'calculée à la commande']);
    $('recap').innerHTML = '<h3>votre ' + esc(m.name) + '</h3><div class="trim">' + esc(m.version) + '</div>' +
      rows.map(function (r) { return '<div class="row"><span>' + esc(r[0]) + '</span><b>' + r[1] + '</b></div>'; }).join('') +
      '<div class="row tot"><span>acompte aujourd\'hui</span><span>' + eur(state.catalog.deposit) + '</span></div><div class="note">Acompte remboursable. Solde réglé à la livraison. Usine ' + esc(m.plant) + '.</div>';
    renderStage();
  }

  function go(step) {
    if (!state.catalog || (step > 1 && !state.modelId)) return;
    state.step = step;
    [1, 2, 3].forEach(function (n) { $('step-' + n).hidden = n !== step; });
    document.querySelectorAll('#steps li').forEach(function (li) { li.classList.toggle('on', Number(li.getAttribute('data-step')) <= step); });
    $('result').hidden = true;
    $('recap').hidden = false;
    renderRecap();
    var steps = $('steps');
    if (steps.getBoundingClientRect().top < document.querySelector('.top').offsetHeight) steps.scrollIntoView({ block: 'start' });
  }

  function showResult(html, ok) {
    [1, 2, 3].forEach(function (n) { $('step-' + n).hidden = true; });
    $('recap').hidden = true;
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
    btn.disabled = true; btn.innerHTML = '<span class="spinner"></span> validation de la commande…';
    var payload = { modelId: state.modelId, paintId: state.paintId, wallbox: state.wallbox, household: state.household };
    if (!REPORTS_ON) payload.reports = 'off';
    fetch('/api/9dc8b009/orders', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) })
      .then(function (r) { return r.json().then(function (j) { return { ok: r.ok, status: r.status, body: j }; }); })
      .then(function (res) {
        var b = res.body;
        if (res.ok && b.success) {
          showResult('<h2>votre commande est confirmée</h2><p>' + esc(b.model) + ' · ' + esc(b.paint) + ' · livraison estimée ' + esc(b.estimatedDelivery) + '.</p>' +
            '<div class="recap"><div class="row"><span>prix du véhicule</span><b>' + eur(b.vehiclePrice) + '</b></div>' +
            (b.options ? '<div class="row"><span>borne Mobilize Powerbox</span><b>' + eur(b.options) + '</b></div>' : '') +
            '<div class="row"><span>prime Coup de Pouce (score ' + b.environmentalScore + '/100)</span><b>' + (b.incentive ? '-' + eur(b.incentive) : 'non éligible') + '</b></div>' +
            '<div class="row tot"><span>total</span><span>' + eur(b.total) + '</span></div><div class="row"><span>acompte payé</span><b>' + eur(b.deposit) + '</b></div></div>' +
            '<p>numéro de commande : <span class="ref" data-testid="order-id">' + esc(b.orderId) + '</span></p><button class="btn outline" type="button" data-restart>nouvelle configuration</button>', true);
        } else if (res.status >= 500) {
          showResult('<h2>votre commande n\'a pas pu aboutir</h2><p>Une erreur est survenue lors du calcul de votre commande. Aucun acompte n\'a été débité.</p>' +
            '<p>référence : <span class="ref" data-testid="error-ref">' + esc(b.reference || b.requestId || '—') + '</span> · code : <span class="ref" data-testid="error-code">' + esc(b.code || res.status) + '</span></p>' +
            '<p class="hint">Réessayez plus tard ou contactez le service client Renault.</p><button class="btn outline" type="button" data-restart>retour à la configuration</button>', false);
        } else {
          showResult('<h2>commande impossible</h2><p>' + esc(b.error || 'Vérifiez votre configuration.') + '</p><button class="btn outline" type="button" data-restart>retour</button>', false);
        }
      })
      .catch(function () { showResult('<h2>connexion perdue</h2><p>Vérifiez votre connexion et réessayez.</p><button class="btn outline" type="button" data-restart>retour</button>', false); })
      .then(function () { state.busy = false; btn.disabled = false; btn.textContent = 'commander et payer l\'acompte'; });
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
    document.querySelector('[data-bind="wallboxPrice"]').textContent = eur(catalog.wallbox.price);
    renderRange(); renderModels(); renderPaints(); renderHouseholds(); renderRecap();
  });
}());
