/* Configurator: trim selection drives the stage render, specs ticker and price. */
(function () {
  var F = window.Flow;
  var $ = function (sel, root) { return (root || document).querySelector(sel); };
  var $$ = function (sel, root) { return Array.prototype.slice.call((root || document).querySelectorAll(sel)); };

  var SEATING = {
    pure: '12-Way Power Heated Front Seats',
    touring: '12-Way Power Heated & Ventilated Front Seats',
    grand_touring: '20-Way Massaging Front Seats',
    sapphire: '18-Way Sport Seats'
  };

  function summary(section, value) {
    var el = $('section[data-testid="' + section + '"] h2 [class*="_selected__"]');
    F.text(el, value);
  }

  function applyTrim(cat, code) {
    var trim = F.trimOf(cat, code);
    var stock = cat.inventory.filter(function (v) { return v.trim === code; })[0];
    F.set({ trim: code, vin: null, quote: null });

    $$('input[name="LUCID_BUNDLE"]').forEach(function (r) { r.checked = r.value === code; });
    summary('trim', trim.name);
    F.text($('[data-testid="total-price"]'), F.money(trim.basePrice) + ' USD');

    var specs = $$('.SpecsTicker_value__0mGkF');
    if (specs.length >= 4) {
      specs[0].textContent = trim.name.replace('Air ', '') + (trim.drivetrain.indexOf('Rear') >= 0 ? ' RWD' : ' AWD');
      specs[1].textContent = trim.power + ' hp';
      specs[2].textContent = trim.zeroToSixty + ' secs';
      specs[3].textContent = trim.range + ' mi';
    }

    var image = F.studio(stock ? stock.image : trim.image);
    F.setImage($('.VehicleVisual_vehicleImage__Dx7ay'), image);
    $$('img.CameraSlide_camera__XNw3A').forEach(function (img) {
      var cam = F.camOf(img);
      if (cam) F.setImage(img, F.angle(image, cam).replace('/1920x1440/', '/640x480/'));
    });

    if (stock) {
      summary('color', stock.exterior);
      summary('roof', stock.roof);
      summary('look', stock.appearance);
      summary('wheels', stock.wheels);
      summary('interior', stock.interior);
    }
    summary('frontseating', SEATING[code] || SEATING.pure);
    document.title = 'Design Your Lucid Air ' + trim.name.replace('Air ', '') + ' | Lucid Motors';
  }

  function toggleSection(btn) {
    var open = btn.getAttribute('aria-expanded') === 'true';
    var section = btn.closest('section');
    var panel = document.getElementById(btn.getAttribute('aria-controls'));
    var icon = $('img', btn);
    btn.setAttribute('aria-expanded', open ? 'false' : 'true');
    btn.setAttribute('aria-label', open ? 'Open section' : 'Close section');
    var prefix = (section.className.match(/^(\w+?)_/) || [])[1] || 'Section';
    var inactive = { Section: 'Section_inactive__dXxc0', MultiSection: 'MultiSection_inactive__uMYl1', MultiSectionTrim: 'MultiSectionTrim_inactive__4oNLG' }[prefix];
    [section, panel].forEach(function (el) {
      if (el && inactive) el.classList.toggle(inactive, open);
    });
    if (icon) icon.src = icon.src.replace(open ? 'minus.svg' : 'plus.svg', open ? 'plus.svg' : 'minus.svg');
  }

  document.addEventListener('DOMContentLoaded', function () {
    F.catalog().then(function (cat) {
      applyTrim(cat, F.state.trim || 'pure');

      $$('input[name="LUCID_BUNDLE"]').forEach(function (r) {
        r.addEventListener('change', function () { if (r.checked) applyTrim(cat, r.value); });
      });

      $$('section[data-testid] fieldset input[type="radio"]').forEach(function (r) {
        if (r.name === 'LUCID_BUNDLE') return;
        r.addEventListener('change', function () {
          var label = r.closest('label');
          var name = label && $('[class*="_name__"]', label);
          var section = r.closest('section');
          if (name && section) summary(section.getAttribute('data-testid'), name.textContent.trim());
        });
      });

      $$('section[data-testid] h2 button[aria-controls]').forEach(function (btn) {
        btn.addEventListener('click', function () { toggleSection(btn); });
      });

      var view = $('[data-testid="recommendations"]');
      var review = $('[data-testid="review_order"]');
      if (view) view.addEventListener('click', function () { F.go('vehicles'); });
      if (review) review.addEventListener('click', function () { F.go('vehicles'); });
    }).catch(function () {
      F.toast('Something went wrong', 'We couldn’t load the configurator catalog.', true);
    });
  });
})();
