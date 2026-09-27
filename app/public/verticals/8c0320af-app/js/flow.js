/* Shared state, API access and presenter chrome for the 8c0320af pages. */
(function () {
  var API = '/api/8c0320af';
  var BASE = '/8c0320af';
  var KEY = '8c0320af.flow';
  var MIRROR = '/verticals/assets/8c0320af/';
  var toastTimer = null;

  function load() {
    try {
      return JSON.parse(sessionStorage.getItem(KEY) || '{}');
    } catch (e) {
      return {};
    }
  }

  var state = load();
  if (!state.trim) state.trim = 'pure';

  function save() {
    sessionStorage.setItem(KEY, JSON.stringify(state));
  }

  function set(patch) {
    Object.keys(patch).forEach(function (k) { state[k] = patch[k]; });
    save();
  }

  function money(n) {
    return '$' + Math.round(n).toLocaleString('en-US');
  }

  function money2(n) {
    return '$' + Number(n).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  }

  function identity() {
    return {
      devinOrgId: localStorage.getItem('devinOrgId') || '',
      devinUserId: localStorage.getItem('devinUserId') || '',
      devinEmail: localStorage.getItem('devinEmail') || ''
    };
  }

  if (!localStorage.getItem('devinOrgId') || !localStorage.getItem('devinUserId')) {
    fetch('/api/config').then(function (r) { return r.json(); }).then(function (cfg) {
      if (cfg.defaultOrgId && !localStorage.getItem('devinOrgId')) localStorage.setItem('devinOrgId', cfg.defaultOrgId);
      if (cfg.defaultUserId && !localStorage.getItem('devinUserId')) localStorage.setItem('devinUserId', cfg.defaultUserId);
    }).catch(function () {});
  }

  var catalogPromise = null;
  function catalog() {
    if (!catalogPromise) {
      catalogPromise = fetch(API + '/catalog').then(function (r) {
        if (!r.ok) throw new Error('catalog ' + r.status);
        return r.json();
      });
    }
    return catalogPromise;
  }

  function mirror(img) {
    if (!img || !img.src || img.src.indexOf(MIRROR) >= 0) return;
    var name = img.src.split('?')[0].split('/').pop().replace(/\.(png|webp)$/, '');
    var cam = img.src.match(/\/(CAM_[A-Z]+_\d+)\//);
    if (cam && cam[1] !== 'CAM_EXT_08') name += '-' + cam[1];
    if (img.src.indexOf('/studio/') >= 0) name += '-studio';
    img.removeAttribute('srcset');
    var pic = img.parentElement;
    if (pic && pic.tagName === 'PICTURE') {
      Array.prototype.forEach.call(pic.querySelectorAll('source'), function (s) { s.remove(); });
    }
    img.src = MIRROR + name + '.webp';
  }

  function studio(src) {
    if (!src || src.indexOf('/alpha/') < 0) return src;
    return src.replace(/\/\d+x\d+\/filters:format\(\.webp\)\/filters:sharpen[^/]*\/filters:quality[^/]*\//, '/1920x1440/filters:format(.webp)/').replace('/alpha/', '/studio/');
  }

  var INTERIOR_TAIL = { GT: 'AU00-12W2-CCP01', AT: 'AU00-12W2-CCP00', PURE: 'AU00-12W2-CCP00' };

  function angle(base, cam) {
    var m = base.match(/\/(AIR-([A-Z]+)-STD-)([A-Z0-9-]+)-RENA\.png$/);
    if (!m) return base;
    var src = base.replace(/\/CAM_[A-Z]+_\d+\//, '/' + cam + '/').replace('/alpha/', '/studio/');
    if (cam.indexOf('CAM_INT_') < 0) return src;
    var spec = m[3];
    var pick = function (re) { return (spec.match(re) || [''])[0]; };
    var file = m[1] + [pick(/RF\d+/), pick(/INT\d+/), pick(/AD\d+/), INTERIOR_TAIL[m[2]] || INTERIOR_TAIL.PURE].join('-') + '-RENA-COUS.png';
    return src.replace(/\/AIR-[A-Z0-9-]+\.png$/, '/' + file);
  }

  function camOf(img) {
    var m = (img.alt || '').match(/CAM_[A-Z]+_\d+/);
    return m ? m[0] : null;
  }

  function setImage(img, src) {
    if (!img) return;
    img.removeAttribute('srcset');
    img.removeAttribute('data-src');
    img.onerror = function () { mirror(img); };
    img.src = src;
    var pic = img.parentElement;
    if (pic && pic.tagName === 'PICTURE') {
      Array.prototype.forEach.call(pic.querySelectorAll('source'), function (s) { s.remove(); });
    }
  }

  function toast(title, body, isError) {
    var el = document.getElementById('demo-toast');
    if (!el) return;
    document.getElementById('demo-toast-title').textContent = title;
    document.getElementById('demo-toast-body').textContent = body || '';
    el.classList.toggle('err', !!isError);
    el.classList.add('on');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function () { el.classList.remove('on'); }, 6000);
  }

  function go(page, params) {
    var qs = params ? '?' + Object.keys(params).map(function (k) {
      return encodeURIComponent(k) + '=' + encodeURIComponent(params[k]);
    }).join('&') : '';
    location.href = BASE + (page ? '/' + page : '') + qs;
  }

  function query(name) {
    var m = new RegExp('[?&]' + name + '=([^&]*)').exec(location.search);
    return m ? decodeURIComponent(m[1].replace(/\+/g, ' ')) : null;
  }

  function degraded(on) {
    document.body.classList.toggle('degraded', !!on);
    set({ degraded: !!on });
  }

  function reset() {
    return fetch(API + '/orders/reset', { method: 'POST' })
      .then(function (r) { return r.json(); })
      .then(function () {
        sessionStorage.removeItem(KEY);
        location.href = BASE;
      })
      .catch(function (err) { toast('Reset failed', err.message, true); });
  }

  function text(el, value) {
    if (el) el.textContent = value;
  }

  function trimOf(cat, code) {
    return cat.trims.filter(function (t) { return t.code === code; })[0] || cat.trims[0];
  }

  function vehicleOf(cat, vin) {
    return cat.inventory.filter(function (v) { return v.vin === vin; })[0] || null;
  }

  var THUMBS = MIRROR + 'thumbs/';
  var INTERIOR_THUMB = THUMBS + 'INT02-Grand-Touring-Mojave.webp';
  var PAINT_THUMB = {
    L102: 'L102-Stellar-White', L203: 'L203-Cosmos-Silver', L205: 'L205-Quantum-Grey',
    L304: 'L304-Zenith-Red', L806: 'L806-Fathom-Blue', L901: 'L901-Infinite-Black'
  };
  var WHEEL_THUMB = [
    [/21.*Aero Blade/, 'WH03-Wheel-21-Aero-Blade'], [/21.*Aero Sport/, 'WH02-Wheel-21-Aero-Sport'],
    [/20.*Aero Lite/, 'WH01-Wheel-20-Aero-Lite'], [/19.*Aero Range/, 'WH00-Wheel-19-Aero-Range']
  ];

  function paintThumb(v) {
    var m = (v.image || '').match(/-(L\d{3})-/);
    return m && PAINT_THUMB[m[1]] ? THUMBS + PAINT_THUMB[m[1]] + '.webp' : v.image;
  }

  function wheelThumb(v) {
    var hit = WHEEL_THUMB.filter(function (w) { return w[0].test(v.wheels || ''); })[0];
    return hit ? THUMBS + hit[1] + '.webp' : null;
  }

  function appearanceThumb(v) {
    return THUMBS + (/stealth/i.test(v.appearance || '') ? 'EXT07-Stealth' : 'EXT03-Platinum') + '.webp';
  }

  function seatingOf(v) {
    return v.trim === 'pure' ? '12-Way Power Heated Front Seats' : '20-Way Power Heated Front Seats With Ventilation And Massage';
  }

  /* Fill the captured spec "swatch" rows (label under each value) from an inventory unit. */
  function fillSwatches(root, v) {
    var values = {
      'Interior Theme': v.interior,
      'Driver Assistance System': v.driverAssistance,
      'DriveTrain': v.drivetrain,
      'Exterior Color': v.exterior,
      'Seating': seatingOf(v),
      'Wheels': v.wheels,
      'Sound System': v.sound,
      'Roof': v.roof,
      'Appearance': v.appearance,
      'Packages': v.options.length ? v.options.map(function (o) { return o.label; }).join(', ') : 'Standard Equipment'
    };
    Array.prototype.forEach.call(root.querySelectorAll('[data-testid="swatch"]'), function (sw) {
      var ps = sw.querySelectorAll('p');
      if (ps.length < 2) return;
      var key = ps[1].textContent.trim();
      if (values[key]) {
        ps[0].textContent = values[key];
        sw.setAttribute('aria-label', values[key]);
      }
      var img = sw.querySelector('img');
      if (img && key === 'Interior Theme') setImage(img, INTERIOR_THUMB);
      if (img && key === 'Exterior Color') setImage(img, paintThumb(v));
      if (img && key === 'Wheels' && wheelThumb(v)) setImage(img, wheelThumb(v));
      if (img && key === 'Appearance') setImage(img, appearanceThumb(v));
    });
  }

  /* Fill the captured vehicle header block: year, availability pill, trim, spec ticker and price. */
  function fillHeader(root, v) {
    text(root.querySelector('span[class*="_label_"]'), String(v.modelYear));
    text(root.querySelector('h2[class*="_headline_"], h3'), v.trimName);
    text(root.querySelector('[data-testid="Pill"] p'), v.availability);
    Array.prototype.forEach.call(root.querySelectorAll('[class*="_eyebrow_"]'), function (label) {
      var val = label.parentElement.querySelector('h3, p[class*="_subtitle_"]');
      if (!val) return;
      var key = label.textContent.trim().toLowerCase();
      if (key === 'epa-est. range') val.innerHTML = v.range + ' mi<sup>\u00b2</sup>';
      if (key === 'power') val.textContent = v.power + ' hp';
      if (key === '0-60 mph') val.textContent = v.zeroToSixty + ' secs';
    });
    Array.prototype.forEach.call(root.querySelectorAll('p, h2, h3'), function (p) {
      var html = p.innerHTML.trim();
      if (p.children.length <= 1 && /^\$[\d,]+\s*(<sup>1<\/sup>)?$/.test(html)) {
        p.innerHTML = money(v.sellingPrice) + (html.indexOf('<sup>') >= 0 ? ' <sup>1</sup>' : ' ');
      }
    });
  }

  document.addEventListener('DOMContentLoaded', function () {
    if (state.degraded) document.body.classList.add('degraded');
    var btn = document.getElementById('demo-reset');
    if (btn) btn.addEventListener('click', reset);
    document.addEventListener('click', function (e) {
      var a = e.target.closest && e.target.closest('a[href="#"]');
      if (a) e.preventDefault();
    });
  });

  window.Flow = {
    API: API,
    BASE: BASE,
    state: state,
    set: set,
    money: money,
    money2: money2,
    identity: identity,
    catalog: catalog,
    setImage: setImage,
    mirror: mirror,
    studio: studio,
    angle: angle,
    camOf: camOf,
    toast: toast,
    go: go,
    query: query,
    degraded: degraded,
    reset: reset,
    text: text,
    trimOf: trimOf,
    vehicleOf: vehicleOf,
    seatingOf: seatingOf,
    fillSwatches: fillSwatches,
    fillHeader: fillHeader
  };
})();
