(function ($) {
  $('#deposit-errors').focus();
  $('#front, #back').on('change', function () {
    var file = this.files && this.files[0], $p = $('#' + this.id + '-preview');
    if (!file) { $p.removeClass('has-image').css('background-image', ''); return; }
    $p.addClass('has-image').css('background-image', 'url(' + URL.createObjectURL(file) + ')');
  });
  $('#deposit-form').on('submit', function () { $('#deposit-submit').prop('disabled', true).text('Depositing...'); });
})(jQuery);
