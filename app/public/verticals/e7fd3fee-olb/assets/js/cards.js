/* Card Management behaviors (jQuery 1.12). Pages work without JavaScript; this adds dialogs and conveniences. */
(function ($) {
  var lastTrigger = null;

  function focusables($root) {
    return $root.find('a[href],button:not([disabled]),input:not([disabled]):not([type=hidden]),select,textarea,[tabindex]:not([tabindex="-1"])').filter(':visible');
  }

  function openDialog($d, trigger) {
    lastTrigger = trigger || document.activeElement;
    $d.prop('hidden', false);
    var $f = focusables($d);
    ($f.filter('button[type=submit]').first().length ? $f.filter('button[type=submit]').first() : $f.first()).focus();
  }

  function closeDialog($d) {
    $d.prop('hidden', true);
    if (lastTrigger) { $(lastTrigger).focus(); }
    lastTrigger = null;
  }

  // Lock/unlock toggle opens a confirmation dialog; without JS the link goes to card_lock.php.
  $('[data-open-dialog]').each(function () {
    var $t = $(this);
    if ($('#' + $t.attr('data-open-dialog')).length) { $t.attr('role', 'button'); }
  });
  $(document).on('click', '[data-open-dialog]', function (e) {
    var $d = $('#' + $(this).attr('data-open-dialog'));
    if (!$d.length) { return; }
    e.preventDefault();
    openDialog($d, this);
  });
  $(document).on('keydown', '[data-open-dialog]', function (e) {
    if (e.which === 32) { e.preventDefault(); $(this).trigger('click'); }
  });
  $(document).on('click', '[data-close-dialog]', function () { closeDialog($(this).closest('.card-modal')); });
  $(document).on('click', '.card-modal', function (e) { if (e.target === this) { closeDialog($(this)); } });
  $(document).on('keydown', '.card-modal', function (e) {
    if (e.which === 27) { e.preventDefault(); closeDialog($(this)); return; }
    if (e.which !== 9) { return; }
    var $f = focusables($(this)), first = $f.get(0), last = $f.get($f.length - 1);
    if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
    else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
  });
  $(document).on('submit', '.card-modal form, form[data-once]', function () {
    $(this).find('button[type=submit]').prop('disabled', true).attr('aria-disabled', 'true');
  });

  // Travel notice: show one empty optional destination at a time.
  var $opt = $('[data-optional-dest]');
  if ($opt.length) {
    $opt.prop('hidden', true);
    $('#add-dest').prop('hidden', false).on('click', function () {
      var $next = $('[data-optional-dest][hidden]').first();
      $next.prop('hidden', false).find('input').focus();
      if (!$('[data-optional-dest][hidden]').length) { $(this).prop('hidden', true); }
    });
  }
  $('#f-start_date').on('change', function () { if (this.value) { $('#f-end_date').attr('min', this.value); } });

  // Replacement: keep the submit label naming the selected card.
  $('#f-card_id').on('change', function () {
    var l4 = $(this).find('option:selected').attr('data-last4');
    if (l4 && $('#replace-last4').length) { $('#replace-last4').text(l4); }
  });

  // Dispute wizard: show reason-specific follow-ups for yes/no questions.
  $('[data-reveal-when]').each(function () {
    var $box = $(this), spec = $box.attr('data-reveal-when').split('='), name = spec[0], val = spec[1];
    function sync() {
      var on = $('input[name="' + name + '"]:checked').val() === val;
      $box.prop('hidden', !on);
      $box.find('input,select,textarea').prop('disabled', !on);
    }
    $(document).on('change', 'input[name="' + name + '"]', sync);
    sync();
  });
  $('[data-autosubmit]').on('change', function () { $(this).closest('form').submit(); });
  $('[data-autosubmit-btn]').hide();

  // Character counter for dispute details.
  $('textarea[data-maxlength]').each(function () {
    var $t = $(this), max = +$t.attr('data-maxlength'), $c = $('#' + $t.attr('data-counter'));
    function upd() { var left = max - $t.val().length; $c.text(left + ' characters remaining'); }
    $t.on('input', upd); upd();
  });

  // Move focus to the error summary or confirmation heading after a redirect.
  var $sum = $('#error-summary');
  if ($sum.length) { $sum.focus(); }
  else { $('[data-autofocus]').first().focus(); }
})(jQuery);
