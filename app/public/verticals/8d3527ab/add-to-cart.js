(function () {
  var UNKNOWN_ERROR = 'Your cart could not be updated.';

  if (!(localStorage.getItem('devinOrgId') && localStorage.getItem('devinUserId'))) {
    fetch('/api/config')
      .then(function (r) { return r.json(); })
      .then(function (cfg) {
        if (cfg.lockOrg && cfg.defaultOrgId) localStorage.setItem('devinOrgId', cfg.defaultOrgId);
        if (cfg.lockUser && cfg.defaultUserId) localStorage.setItem('devinUserId', cfg.defaultUserId);
      })
      .catch(function () {});
  }

  var form = document.querySelector('.cc_add_to_cart_form');
  if (!form) return;
  var button = form.querySelector('.cc_add_to_cart');

  function showMessage(text) {
    var container = document.querySelector('.cc_main_container') || document.body;
    var alert = container.querySelector('.cc_page_message');
    if (!alert) {
      alert = document.createElement('div');
      alert.className = 'alert alert-danger cc_page_message';
      container.insertBefore(alert, container.firstChild);
    }
    alert.textContent = text;
    alert.scrollIntoView({ block: 'center' });
  }

  function value(name) {
    var field = form.elements[name];
    return field ? field.value : '';
  }

  form.addEventListener('submit', function (event) {
    event.preventDefault();
    var payload = {
      sku: value('sku'),
      quantity: value('quantity'),
      subscriptionTerm: value('subscriptionTerm'),
      esn: value('esn'),
      devinUserId: localStorage.getItem('devinUserId') || '',
      devinOrgId: localStorage.getItem('devinOrgId') || '',
      devinEmail: localStorage.getItem('devinEmail') || '',
    };

    button.disabled = true;
    fetch('/api/8d3527ab/cart', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    })
      .then(function (res) {
        return res.json().catch(function () { return {}; }).then(function (data) {
          if (res.ok && data.success) {
            window.location.href = form.getAttribute('action');
            return;
          }
          console.error('Add to cart failed', data);
          showMessage(res.status === 400 && data.error ? data.error : UNKNOWN_ERROR);
          button.disabled = false;
        });
      })
      .catch(function () {
        showMessage(UNKNOWN_ERROR);
        button.disabled = false;
      });
  });
}());
