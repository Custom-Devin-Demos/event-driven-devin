/* Profile & Security area behaviors (jQuery 1.12). Progressive enhancement only: every form works without JS. */
(function ($) {
  // Focus the error summary so screen readers announce it on load.
  $(function () { var $s = $('#error-summary'); if ($s.length) { $s.focus(); } });

  // Live passcode rule checklist: <input data-pf-rules="#rules-id" data-pf-online-id="#online_id|literal">
  function checkRules($in) {
    var v = $in.val() || '', $list = $($in.data('pf-rules')), oid = $in.data('pf-online-id') || '';
    if (oid && oid.charAt(0) === '#') { oid = $(oid).val() || ''; }
    var rules = {
      len: v.length >= 8 && v.length <= 20,
      mix: /[A-Za-z]/.test(v) && /\d/.test(v),
      nospace: v.length > 0 && !/\s/.test(v),
      chars: v.length > 0 && !/[^A-Za-z0-9@#*()+={}\/?~;,.\-_!$%^&]/.test(v),
      noid: v.length > 0 && (!oid || v.toLowerCase().indexOf(String(oid).toLowerCase()) === -1)
    };
    var met = 0, total = 0;
    $list.find('[data-rule]').each(function () {
      var ok = !!rules[$(this).data('rule')]; total++; if (ok) { met++; }
      $(this).toggleClass('met', ok).find('.sr-state').text(ok ? ' (met)' : ' (not met)');
    });
    var $live = $($in.data('pf-live'));
    if ($live.length) { $live.text(v.length ? met + ' of ' + total + ' passcode requirements met' : ''); }
  }
  $(document).on('input keyup', 'input[data-pf-rules]', function () { checkRules($(this)); });
  $('input[data-pf-rules]').each(function () { checkRules($(this)); });

  // Show/hide passcode toggles: <button data-pf-show="#id">
  $(document).on('click', '[data-pf-show]', function () {
    var $i = $($(this).data('pf-show')), show = $i.attr('type') === 'password';
    $i.attr('type', show ? 'text' : 'password');
    $(this).text(show ? 'Hide' : 'Show').attr('aria-pressed', show ? 'true' : 'false');
  });

  // Character counters: <textarea data-pf-counter="#counter-id" maxlength=N>
  $(document).on('input', '[data-pf-counter]', function () {
    var max = parseInt($(this).attr('maxlength'), 10), left = max - $(this).val().length;
    $($(this).data('pf-counter')).text(left + ' of ' + max + ' characters remaining');
  });
  $('[data-pf-counter]').trigger('input');

  // Alerts matrix: disabling an alert greys its row; channel checkboxes stay operable for later re-enable.
  $(document).on('change', 'table.pf-matrix input.pf-enable', function () {
    $(this).closest('tr').toggleClass('disabled', !this.checked);
  });

  // Message Center bulk select
  $(document).on('change', '#pf-select-all', function () {
    $('input.pf-msg-sel').prop('checked', this.checked);
  });

  // Confirm destructive actions: <button data-pf-confirm="message">
  $(document).on('click', '[data-pf-confirm]', function (e) {
    if (!window.confirm($(this).data('pf-confirm'))) { e.preventDefault(); }
  });

  // Phone input formatting (704) 555-0142 on blur
  $(document).on('blur', 'input[data-pf-phone]', function () {
    var d = $(this).val().replace(/\D/g, '');
    if (d.length === 11 && d.charAt(0) === '1') { d = d.slice(1); }
    if (d.length === 10) { $(this).val('(' + d.slice(0, 3) + ') ' + d.slice(3, 6) + '-' + d.slice(6)); }
  });

  // Digits-only fields (last 4, ZIP, OTP)
  $(document).on('input', 'input[data-pf-digits]', function () {
    var v = $(this).val(), c = v.replace(/[^\d\-]/g, '');
    if (v !== c) { $(this).val(c); }
  });
})(jQuery);
