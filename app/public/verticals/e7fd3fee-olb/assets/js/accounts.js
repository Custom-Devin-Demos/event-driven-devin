/* Accounts area behaviors (jQuery 1.12). Everything works without JS; this only enhances. */
(function ($) {
  $('html').addClass('js');

  // Date range: show the custom date fields only when "Custom date range" is chosen.
  var $range = $('#f-range'), $custom = $('#custom-dates');
  function syncRange() {
    if ($range.val() === 'custom') { $custom.removeAttr('data-collapsed'); } else { $custom.attr('data-collapsed', '1'); }
  }
  $range.on('change', function () { syncRange(); if ($range.val() === 'custom') { $('#f-from').focus(); } });
  if ($range.length) { syncRange(); }

  // "What's this?" disclosure buttons.
  $(document).on('click', '.info-toggle', function () {
    var $b = $(this), $p = $('#' + $b.attr('aria-controls')), open = $b.attr('aria-expanded') === 'true';
    $b.attr('aria-expanded', open ? 'false' : 'true'); $p.prop('hidden', open);
  });

  // Show / hide the full account number (fetched on demand; never in the page source).
  $(document).on('click', '.js-reveal', function () {
    var $b = $(this), $n = $('#' + $b.attr('aria-controls')), $s = $('#acct-num-status');
    if ($b.attr('aria-pressed') === 'true') {
      $n.html($n.data('masked')); $b.attr('aria-pressed', 'false').html('Show<span class="sr-only"> full number</span>');
      $s.text('Number hidden.');
      return;
    }
    if (!$n.data('masked')) { $n.data('masked', $n.html()); }
    $.ajax({ url: '/e7fd3fee/olb/account-reveal', data: { id: $b.data('account'), reveal: 1 }, dataType: 'json' })
      .done(function (r) {
        $n.empty().append($('<span aria-hidden="true"></span>').text(r.account_number)).append($('<span class="sr-only"></span>').text(r.spoken));
        $b.attr('aria-pressed', 'true').html('Hide<span class="sr-only"> full number</span>');
        $s.text('Full number shown: ' + r.spoken);
      })
      .fail(function (x) {
        var msg = (x.responseJSON && x.responseJSON.error) ? x.responseJSON.error.message : 'We couldn\'t show this number right now. Please try again.';
        $s.text(msg); window.alert(msg);
      });
  });

  $(document).on('click', '.js-print', function () { window.print(); });

  // Budget editor: confirm removal of a budget (Error Prevention).
  $(document).on('change', '.js-remove-budget', function () {
    var $row = $(this).closest('.budget-input');
    $row.toggleClass('removing', this.checked);
  });
})(jQuery);
