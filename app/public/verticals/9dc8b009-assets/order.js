/* global document, window, location, fetch, URLSearchParams */
(function () {
  'use strict';
  var REPORTS_ON = new URLSearchParams(location.search).get('reports') !== 'off';
  var VIEWS = ['accueil', 'configurateur'];
  var HH = { standard: 'ménage standard', modeste: 'ménage modeste' };
  var SWATCH = { 'blanc-glacier': '#f1f1ee', 'jaune-pop': '#f2c318', 'vert-pistache': '#2f9e4f', 'noir-etoile': '#1c1c1e' };
  var MODEL_COLOR = { 'twingo-etech': '#2f9e4f', 'r5-etech': '#f2c318', 'r4-etech': '#9fb8c4', 'scenic-etech': '#e8e8e6' };
  var state = { catalog: null, modelId: null, paintId: null, wallbox: false, household: 'standard', step: 1, busy: false };
  var $ = function (id) { return document.getElementById(id); };
  var carSeq = 0;

  function eur(n) { return Number(n).toLocaleString('fr-FR').replace(/\u202f|\u00a0/g, ' ') + ' €'; }
  function esc(s) { return String(s).replace(/[&<>"]/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]; }); }
  function model() { return state.catalog.models.find(function (m) { return m.id === state.modelId; }); }
  function paint() { return state.catalog.paints.find(function (p) { return p.id === state.paintId; }); }

  // Side-view illustration drawn for the mock; taller roof for the crossovers.
  function carSvg(color, tall) {
    var roof = tall ? 'M112 88 C128 52 152 40 196 38 L272 38 C300 38 318 52 336 84' : 'M112 90 C130 62 150 50 190 48 L262 48 C292 48 310 62 328 88';
    var glass = tall ? ['M132 86 C146 60 162 50 196 49 L228 49 L228 86 Z', 'M236 49 L270 49 C292 49 306 60 320 84 L236 86 Z']
      : ['M130 88 C144 66 160 59 190 58 L222 58 L222 88 Z', 'M230 58 L262 58 C284 58 298 68 312 88 L230 88 Z'];
    var wheel = function (x) {
      var spokes = [0, 72, 144, 216, 288].map(function (d) { return '<rect x="' + (x - 1.6) + '" y="122" width="3.2" height="14" rx="1.5" fill="#8d9296" transform="rotate(' + d + ' ' + x + ' 136)"/>'; }).join('');
      return '<circle cx="' + x + '" cy="136" r="30" fill="rgba(0,0,0,.55)"/><circle cx="' + x + '" cy="136" r="27" fill="#141618"/><circle cx="' + x + '" cy="136" r="17" fill="#d9dcde"/><circle cx="' + x + '" cy="136" r="15" fill="#3a3f43"/>' + spokes + '<circle cx="' + x + '" cy="136" r="4" fill="#d9dcde"/>';
    };
    var id = 'cg' + (carSeq += 1);
    return '<svg viewBox="0 0 400 180" aria-hidden="true"><defs>' +
      '<linearGradient id="' + id + 'b" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#fff" stop-opacity=".35"/><stop offset=".45" stop-color="#fff" stop-opacity="0"/><stop offset="1" stop-color="#000" stop-opacity=".45"/></linearGradient>' +
      '<linearGradient id="' + id + 'g" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#3b4750"/><stop offset=".55" stop-color="#11161a"/><stop offset="1" stop-color="#252d33"/></linearGradient></defs>' +
      '<ellipse cx="202" cy="166" rx="176" ry="10" fill="rgba(0,0,0,.45)"/>' +
      '<path d="M30 130 C30 110 40 100 62 96 L112 90 ' + roof.slice(roof.indexOf('C')) + ' L352 94 C368 98 374 110 374 130 L374 140 L30 140 Z" fill="' + color + '" stroke="rgba(0,0,0,.35)" stroke-width="1.5"/>' +
      '<path d="M30 130 C30 110 40 100 62 96 L112 90 ' + roof.slice(roof.indexOf('C')) + ' L352 94 C368 98 374 110 374 130 L374 140 L30 140 Z" fill="url(#' + id + 'b)"/>' +
      '<path d="M44 104 L360 100" stroke="rgba(255,255,255,.45)" stroke-width="1.5"/>' +
      '<path d="' + glass[0] + '" fill="url(#' + id + 'g)"/><path d="' + glass[1] + '" fill="url(#' + id + 'g)"/>' +
      '<path d="M226 92 V132 M150 112 H170 M250 112 H270" stroke="rgba(0,0,0,.3)" stroke-width="2"/>' +
      '<circle cx="356" cy="108" r="8" fill="#fff" stroke="#222" stroke-width="2"/><rect x="30" y="104" width="10" height="12" rx="2" fill="#c4161c"/>' +
      '<rect x="160" y="122" width="44" height="6" rx="3" fill="rgba(0,0,0,.25)"/>' + wheel(104) + wheel(300) + '</svg>';
  }
  function isTall(id) { return id === 'r4-etech' || id === 'scenic-etech'; }

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
    var color = SWATCH[p.id];
    $('stage').innerHTML = carSvg(color, isTall(m.id)) + '<span class="arrow l" aria-hidden="true">‹</span><span class="arrow r" aria-hidden="true">›</span><span class="count">1 / 4</span>';
    $('thumbs').innerHTML = ['on', '', '', ''].map(function (c, i) { return '<span class="stage-bg ' + c + '" style="filter:brightness(' + (1 - i * 0.12) + ')"></span>'; }).join('');
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
  document.querySelectorAll('[data-car]').forEach(function (el) { el.innerHTML = carSvg(el.getAttribute('data-color'), false); });
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
