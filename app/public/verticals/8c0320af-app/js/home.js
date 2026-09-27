/* Homepage: fresh flow state, plus nav/CTA routing for links the capture left unresolved. */
(function () {
  var F = window.Flow;

  var ROUTES = [
    [/design|configure|build|order now|shop now|explore air|air /i, 'configure'],
    [/available|inventory|offers|view vehicles|browse/i, 'vehicles']
  ];

  document.addEventListener('DOMContentLoaded', function () {
    F.set({ program: null, quote: null, order: null });

    Array.prototype.forEach.call(document.querySelectorAll('a[href="#"]'), function (a) {
      var label = a.textContent.replace(/\s+/g, ' ').trim();
      for (var i = 0; i < ROUTES.length; i++) {
        if (ROUTES[i][0].test(label)) {
          a.setAttribute('href', F.BASE + '/' + ROUTES[i][1]);
          return;
        }
      }
    });

    Array.prototype.forEach.call(document.querySelectorAll('img'), function (img) {
      if (!/^https?:/.test(img.currentSrc || img.src)) return;
      img.addEventListener('error', function () { F.mirror(img); }, { once: true });
      if (img.complete && img.naturalWidth === 0) F.mirror(img);
    });
  });
})();
