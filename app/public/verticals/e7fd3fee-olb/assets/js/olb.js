/* Online Banking legacy behaviors (jQuery 1.12) */
(function ($) {
  if (!window.OLB) { return; }
  // Session timeout: warn 60s before the server-side inactivity limit; one action extends it.
  var warnAt = (OLB.timeout - 60) * 1000, timer, countdown;
  function arm() {
    clearTimeout(timer);
    timer = setTimeout(function () {
      var left = 60, $d = $('#timeout-dialog');
      $d.prop('hidden', false); $('#timeout-stay').focus();
      countdown = setInterval(function () {
        left -= 1; $('#timeout-secs').text(left);
        if (left <= 0) { window.location = '/e7fd3fee/olb/login'; }
      }, 1000);
    }, warnAt);
  }
  $(document).on('click', '#timeout-stay', function () {
    $.get('/e7fd3fee/olb/keepalive');
    clearInterval(countdown); $('#timeout-secs').text(60);
    $('#timeout-dialog').prop('hidden', true); arm();
  });
  $.ajaxSetup({ headers: { 'X-CSRF-Token': OLB.csrf } });
  arm();
})(jQuery);
