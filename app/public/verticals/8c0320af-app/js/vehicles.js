/* Available Vehicles: render the in-stock catalog into the captured card template. */
(function () {
  var F = window.Flow;
  var $ = function (sel, root) { return (root || document).querySelector(sel); };
  var $$ = function (sel, root) { return Array.prototype.slice.call((root || document).querySelectorAll(sel)); };

  var TRIM_ORDER = { pure: 0, touring: 1, grand_touring: 2, sapphire: 3 };
  var TRIM_BY_LABEL = { 'Pure': 'pure', 'Touring': 'touring', 'Grand Touring': 'grand_touring' };
  var AVAIL_BY_LABEL = {
    'Available Now': [0, 0], 'Available In 1 Week': [1, 7], 'Available In 2 Weeks': [8, 14], 'Available In 3+ Weeks': [15, Infinity]
  };
  var CHECK_SVG = '<svg viewBox="0 0 20 20" width="20" height="20" aria-hidden="true"><path d="M5 10.5l3 3 7-7" fill="none" stroke="#fff" stroke-width="2"/></svg>';

  function leaseMonthly(v) {
    var lease = v.paymentOptions.filter(function (p) { return p.type === 'lease'; })[0];
    return lease ? parseInt(lease.headline.replace(/[^0-9]/g, ''), 10) : Infinity;
  }

  /* Map each captured filter checkbox label to a predicate over an inventory unit. */
  function predicateFor(label) {
    if (TRIM_BY_LABEL[label]) return function (v) { return v.trim === TRIM_BY_LABEL[label]; };
    if (AVAIL_BY_LABEL[label]) {
      var range = AVAIL_BY_LABEL[label];
      return function (v) { return v.availabilityDays >= range[0] && v.availabilityDays <= range[1]; };
    }
    if (label === 'Studio Select') return function (v) { return v.inventoryDiscount > 0; };
    if (label === 'Aluminum' || label === 'Glass') return function (v) { return v.roof.indexOf(label) === 0; };
    if (/^DreamDrive/.test(label)) return function (v) { return v.driverAssistance === label; };
    if (/^Surreal Sound/.test(label)) return function (v) { return v.sound === label; };
    if (/^\d+-Way/.test(label)) return function (v) { return F.seatingOf(v).indexOf(label.split(' ')[0]) === 0; };
    if (label === 'Stealth & Sound Package') return function (v) { return /stealth/i.test(v.appearance || ''); };
    if (/^20\d\d$/.test(label)) return function (v) { return String(v.modelYear) === label; };
    return null;
  }

  var SORTS = {
    featured: function (a, b) { return (TRIM_ORDER[a.trim] - TRIM_ORDER[b.trim]) || (a.availabilityDays - b.availabilityDays); },
    distance: function (a, b) { return a.availabilityDays - b.availabilityDays; },
    lease_asc: function (a, b) { return leaseMonthly(a) - leaseMonthly(b); },
    lease_desc: function (a, b) { return leaseMonthly(b) - leaseMonthly(a); },
    price_asc: function (a, b) { return a.sellingPrice - b.sellingPrice; },
    price_desc: function (a, b) { return b.sellingPrice - a.sellingPrice; }
  };

  var filters = {};   /* group name -> { label -> predicate } of checked boxes */
  var sortKey = 'featured';

  function renderCard(tpl, v) {
    var card = tpl.content.firstElementChild.cloneNode(true);
    var lease = v.paymentOptions.filter(function (p) { return p.type === 'lease'; })[0];

    F.fillHeader(card, v);

    var priceBox = $('[class*="_priceBox_"]', card);
    var rows = $$(':scope > div', priceBox);
    F.text($$('h3', rows[0])[1], lease ? lease.headline.replace('/mo', '') : F.money(v.sellingPrice));
    if (v.inventoryDiscount) {
      var msrp = $('p', rows[1]);
      var save = document.createElement('p');
      save.className = msrp.className;
      save.innerHTML = '<s>' + F.money(v.listPrice) + '</s>\u2002' + F.money(v.inventoryDiscount) + ' Studio Select adjustment';
      save.style.cssText = 'display:flex;justify-content:flex-end;white-space:nowrap;';
      priceBox.appendChild(save);
    }

    var img = $('img[class*="_image_"]', card);
    F.setImage(img, v.image);
    img.style.opacity = '1';
    F.fillSwatches(card, v);

    var view = $('[data-testid="checkout_form_submit"]', card);
    var open = function (e) {
      e.preventDefault();
      F.set({ trim: v.trim, vin: v.vin, program: null, quote: null });
      F.go('vehicle', { vin: v.vin });
    };
    view.addEventListener('click', open);
    var anchor = $('a[role="link"]', card);
    anchor.setAttribute('href', F.BASE + '/vehicle?vin=' + v.vin);
    anchor.addEventListener('click', open);

    var more = $('[class*="_cta_center_"] button', card);
    if (more) {
      more.addEventListener('click', function () {
        var uplift = $('[class*="_upliftContainer_"]', card);
        var expanded = uplift.style.height === 'auto';
        uplift.style.height = expanded ? '292px' : 'auto';
        $('#card', card).style.height = expanded ? '769px' : 'auto';
        F.text($('span', more), expanded ? 'More Features' : 'Fewer Features');
        $('svg', more).style.transform = expanded ? '' : 'rotate(180deg)';
      });
    }
    return card;
  }

  function matches(v) {
    return Object.keys(filters).every(function (group) {
      var preds = Object.keys(filters[group]).map(function (k) { return filters[group][k]; });
      return !preds.length || preds.some(function (p) { return p(v); });
    });
  }

  function visibleList(cat) {
    var list = cat.inventory.filter(matches).sort(SORTS[sortKey] || SORTS.featured);
    if (sortKey !== 'featured') return list;
    var mine = list.filter(function (v) { return v.trim === F.state.trim; });
    var rest = list.filter(function (v) { return v.trim !== F.state.trim; });
    return mine.concat(rest);
  }

  function render(cat) {
    var grid = $('#cards');
    var tpl = $('#card-tpl');
    $$(':scope > [data-vin]', grid).forEach(function (el) { grid.removeChild(el); });
    var list = visibleList(cat);
    list.forEach(function (v) {
      var card = renderCard(tpl, v);
      card.setAttribute('data-vin', v.vin);
      grid.insertBefore(card, tpl);
    });
  }

  function bindFilters(cat) {
    $$('[aria-label$=" Selection"]').forEach(function (groupEl) {
      var group = groupEl.getAttribute('aria-label');
      filters[group] = {};
      $$('[class*="_checkBox_"]', groupEl).forEach(function (box) {
        var input = $('input', box);
        var wrap = $('[class*="_checkBoxIconWrapper_"]', box);
        var label = input.getAttribute('aria-label');
        var pred = predicateFor(label);
        input.removeAttribute('readonly');
        if (!pred) {
          box.setAttribute('aria-disabled', 'true');
          box.style.cssText = 'opacity:.4;pointer-events:none;';
          return;
        }
        var toggle = function (e) {
          e.preventDefault();
          var on = !input.checked;
          input.checked = on;
          wrap.classList.toggle('_checked_3y0kd_339', on);
          wrap.innerHTML = on ? CHECK_SVG : '';
          wrap.appendChild(input);
          if (on) filters[group][label] = pred; else delete filters[group][label];
          render(cat);
        };
        box.addEventListener('click', toggle);
        box.addEventListener('keydown', function (e) { if (e.key === ' ' || e.key === 'Enter') toggle(e); });
      });
    });
  }

  function bindSort(cat) {
    var combo = $('[role="combobox"][aria-label="Select Sort By"]');
    var menu = $('#dropdown-listbox');
    var selected = $('#dropdown-selected-text');
    if (!combo || !menu || !selected) return;
    var items = $$('li[role="option"]', menu);
    var pick = function (li) {
      sortKey = li.getAttribute('data-value');
      F.text(selected, $('p', li).textContent.trim());
      items.forEach(function (o) {
        var on = o === li;
        o.setAttribute('aria-selected', on ? 'true' : 'false');
        $('p', o).classList.toggle('_selected_h57gv_380', on);
      });
      render(cat);
    };
    var close = function () {
      menu.classList.add('_hidden_h57gv_317');
      combo.setAttribute('aria-expanded', 'false');
    };
    combo.addEventListener('click', function () {
      var open = menu.classList.toggle('_hidden_h57gv_317');
      combo.setAttribute('aria-expanded', open ? 'false' : 'true');
    });
    items.forEach(function (li) {
      li.addEventListener('click', function (e) { e.stopPropagation(); pick(li); close(); });
    });
    document.addEventListener('click', function (e) {
      if (!combo.contains(e.target) && !menu.contains(e.target)) close();
    });
    var featured = items.filter(function (li) { return li.getAttribute('data-value') === 'featured'; })[0];
    if (featured) {
      F.text(selected, $('p', featured).textContent.trim());
      items.forEach(function (o) { o.setAttribute('aria-selected', o === featured ? 'true' : 'false'); });
    }
  }

  document.addEventListener('DOMContentLoaded', function () {
    F.catalog().then(function (cat) {
      bindFilters(cat);
      bindSort(cat);
      render(cat);
    }).catch(function () {
      F.toast('Something went wrong', 'We couldn’t load available vehicles.', true);
    });
  });
})();
