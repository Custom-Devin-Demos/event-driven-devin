/* Money movement behaviors (jQuery 1.12): transfers, Zelle, Bill Pay */
(function ($) {
  function fmt(n) { return '$' + n.toFixed(2).replace(/\B(?=(\d{3})+(?!\d))/g, ','); }
  function spoken(n) {
    var d = Math.floor(n), c = Math.round((n - d) * 100);
    return d.toLocaleString('en-US') + ' dollars' + (c ? ' and ' + c + ' cents' : '');
  }
  function num(v) { var s = String(v || '').replace(/[$,\s]/g, ''); return /^\d*(\.\d{0,2})?$/.test(s) && s !== '' && s !== '.' ? parseFloat(s) : NaN; }

  $(function () {
    // Move focus to the error summary so keyboard and screen reader users land on it.
    var $sum = $('#pm-error-summary');
    if ($sum.length) {
      $sum.focus();
      // Fragment scrolling after a PRG redirect can reset focus to <body>; focus again once loaded.
      $(window).on('load', function () { setTimeout(function () { $sum.focus(); }, 0); });
    }
    $sum.on('click', 'a', function (e) {
      var $t = $($(this).attr('href'));
      if ($t.length) { e.preventDefault(); $t.focus(); }
    });
    var $doneH = $('.pm-done-hd h2');
    if ($doneH.length) { $doneH.focus(); }

    // Transfers: recurring end date + credit card / mortgage quick amounts.
    var $freq = $('#frequency'), $rec = $('#recurring-end');
    function syncFreq() {
      var once = $freq.val() === 'once';
      $rec.prop('hidden', once);
      var byDate = $rec.find('input[name=end_type]:checked').val() === 'date';
      $('#end_on').prop('disabled', once || !byDate);
    }
    if ($freq.length && $rec.length) { $freq.on('change', syncFreq); $rec.on('change', 'input[name=end_type]', syncFreq); syncFreq(); }
    var $to = $('#to_id');
    function syncTo() {
      $('.pm-quickpay').prop('hidden', true);
      $('.pm-quickpay[data-for="' + $to.val() + '"]').prop('hidden', false);
    }
    if ($to.length) { $to.on('change', syncTo); syncTo(); }
    $(document).on('click', '.pm-chip[data-amount]', function () {
      var $f = $(this).closest('form'), target = $(this).data('target');
      var $amt = target ? $('#' + target) : $f.find('#amount');
      $(this).siblings('.pm-chip').attr('aria-pressed', 'false');
      $(this).attr('aria-pressed', 'true');
      $amt.val($(this).data('amount')).trigger('input').focus();
    });

    // Zelle: new recipient fields.
    var $rcpt = $('#contact_id');
    function syncRcpt() { $('#zl-new').prop('hidden', $rcpt.val() !== 'new'); }
    if ($rcpt.length) { $rcpt.on('change', syncRcpt); syncRcpt(); }

    // Zelle split preview.
    var $split = $('#split-form');
    function syncSplit() {
      var total = num($('#split_total').val());
      var people = $split.find('input[name="contacts[]"]:checked').length;
      var me = $('#include_me').is(':checked') ? 1 : 0;
      var $p = $('#split-preview');
      if (isNaN(total) || total <= 0 || people === 0) { $p.text('Enter a total and choose at least one person to see each share.'); return; }
      var share = Math.floor(total * 100 / (people + me)) / 100;
      $p.text('Each of the ' + people + ' ' + (people === 1 ? 'person' : 'people') + ' you selected will be asked for ' + fmt(share) + ' (' + spoken(share) + ')' + (me ? ', and your share is ' + fmt(Math.round((total - share * people) * 100) / 100) : '') + '.');
    }
    if ($split.length) { $split.on('input change', 'input', syncSplit); syncSplit(); }

    // Bill Pay: running total of the Pay multiple form.
    var $bp = $('#paymulti-form');
    function syncBp() {
      var total = 0, n = 0;
      $bp.find('input.bp-amount').each(function () { var v = num($(this).val()); if (!isNaN(v) && v > 0) { total += v; n += 1; } });
      $('#bp-total').text(n ? n + ' bill' + (n === 1 ? '' : 's') + ', total ' + fmt(total) : 'No payments entered');
    }
    if ($bp.length) { $bp.on('input change', 'input.bp-amount', syncBp); syncBp(); }

    $(document).on('click', '.bp-fill', function () { var $i = $('#' + $(this).data('target')); $i.val($(this).data('amount')).trigger('change').focus(); });

    // Payee form: account number confirmation + eBill only for electronic payees.
    var $dm = $('input[name=delivery_method]');
    function syncDm() { var check = $('input[name=delivery_method]:checked').val() === 'check'; $('#ebill_enabled').prop('disabled', check); if (check) { $('#ebill_enabled').prop('checked', false); } }
    if ($dm.length) { $dm.on('change', syncDm); syncDm(); }
  });
})(jQuery);
