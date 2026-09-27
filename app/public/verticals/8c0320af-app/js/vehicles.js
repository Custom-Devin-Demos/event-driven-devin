/* Available Vehicles: render the in-stock catalog into the captured card template. */
(function () {
  var F = window.Flow;
  var $ = function (sel, root) { return (root || document).querySelector(sel); };
  var $$ = function (sel, root) { return Array.prototype.slice.call((root || document).querySelectorAll(sel)); };

  var TRIM_ORDER = { pure: 0, touring: 1, grand_touring: 2, sapphire: 3 };

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

  function render(cat) {
    var grid = $('#cards');
    var tpl = $('#card-tpl');
    var list = cat.inventory.slice().sort(function (a, b) {
      return (TRIM_ORDER[a.trim] - TRIM_ORDER[b.trim]) || (a.availabilityDays - b.availabilityDays);
    });
    var mine = list.filter(function (v) { return v.trim === F.state.trim; });
    var rest = list.filter(function (v) { return v.trim !== F.state.trim; });
    mine.concat(rest).forEach(function (v) { grid.insertBefore(renderCard(tpl, v), tpl); });

    var count = $$('p, span, h2, h3').filter(function (e) {
      return e.children.length === 0 && /^\d+ (Vehicles?|Results?)\b/i.test(e.textContent.trim());
    })[0];
    if (count) count.textContent = count.textContent.replace(/^\d+/, String(list.length));
  }

  document.addEventListener('DOMContentLoaded', function () {
    F.catalog().then(render).catch(function () {
      F.toast('Something went wrong', 'We couldn’t load available vehicles.', true);
    });
  });
})();
