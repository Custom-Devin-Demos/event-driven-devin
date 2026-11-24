/* global document, window, localStorage, fetch, AbortController */
(() => {
  'use strict';
  const $ = id => document.getElementById(id);
  const fmt = new Intl.NumberFormat('es-MX', { style: 'currency', currency: 'MXN' });
  const money = cents => fmt.format(cents / 100);
  const identity = key => { try { return localStorage.getItem(key) || undefined; } catch { return undefined; } };
  const el = (tag, className, text) => {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined) node.textContent = text;
    return node;
  };
  let catalog = null, product = null, busy = false, toastTimer;
  let cart = [];

  function supPrice(node, cents) {
    const [whole, frac] = money(cents).split('.');
    node.replaceChildren(document.createTextNode(`${whole}.`), el('sup', '', frac));
  }
  function notice(title, message) {
    clearTimeout(toastTimer); $('toast-title').textContent = title; $('toast-message').textContent = message;
    $('toast').hidden = false; toastTimer = setTimeout(() => { $('toast').hidden = true; }, 6500);
  }
  function show(view) {
    for (const id of ['view-pdp', 'view-checkout', 'view-confirmation']) $(id).hidden = id !== view;
    window.scrollTo({ top: 0 });
  }
  const cartTotal = () => cart.reduce((sum, line) => sum + line.product.priceCents * line.quantity, 0);
  function renderHeaderCart() {
    $('cart-count').textContent = String(cart.reduce((n, l) => n + l.quantity, 0));
    $('cart-total-header').textContent = money(cartTotal());
  }

  function renderPdp() {
    product.breadcrumb.concat(product.name).forEach(label => { const li = el('li'); li.append(el('a', '', label)); li.firstChild.href = '#'; $('breadcrumb').append(li); });
    product.images.slice(0, 4).forEach((src, i) => {
      const button = el('button'); button.type = 'button'; button.setAttribute('aria-label', `Imagen ${i + 1}`);
      if (i === 0) button.setAttribute('aria-current', 'true');
      const img = el('img'); img.src = src; img.alt = ''; button.append(img);
      button.onclick = () => {
        $('main-image').src = src;
        $('thumbs').querySelectorAll('button').forEach(b => b.removeAttribute('aria-current')); button.setAttribute('aria-current', 'true');
      };
      $('thumbs').append(button);
    });
    $('product-title').textContent = product.name; $('product-sku').textContent = product.sku;
    supPrice($('product-price'), product.priceCents); supPrice($('product-list-price'), product.listPriceCents);
    const maxMsi = Math.max(...product.msiPlans);
    $('msi-max').textContent = `${maxMsi} MSI`; supPrice($('msi-monthly'), Math.round(product.priceCents / maxMsi));
    for (let q = 1; q <= catalog.maxQuantity; q++) $('quantity').append(new window.Option(String(q), String(q)));
    $('plans-body').replaceChildren(...[1, ...product.msiPlans].map(months => {
      const tr = el('tr');
      tr.append(el('td', '', months === 1 ? 'Pago de contado' : `${months} meses sin intereses`), el('td', '', money(Math.round(product.priceCents / months))), el('td', '', money(product.priceCents)));
      return tr;
    }));
  }

  function renderCheckoutOptions() {
    $('store').replaceChildren(...catalog.stores.map(s => new window.Option(s.name, s.id)));
    $('cards').replaceChildren(...catalog.cards.map((card, i) => {
      const label = el('label', 'radio-card'); const input = el('input'); input.type = 'radio'; input.name = 'card'; input.value = card.id; input.checked = i === 0;
      const span = el('span'); span.append(el('strong', '', card.label), el('small', '', card.msi ? 'Participa en meses sin intereses' : 'Pago de contado'));
      label.append(input, span); return label;
    }));
  }
  const selected = name => document.querySelector(`input[name="${name}"]:checked`)?.value;
  const selectedCard = () => catalog.cards.find(c => c.id === selected('card'));
  function availablePlans() {
    const card = selectedCard();
    if (!card?.msi) return [1];
    const plans = cart.map(l => l.product.msiPlans).reduce((acc, p) => acc.filter(m => p.includes(m)));
    return [1, ...plans];
  }
  function shippingCents() {
    return selected('fulfillment') === 'domicilio' && cartTotal() < catalog.freeShippingCents ? catalog.homeShippingCents : 0;
  }
  function renderPlans() {
    const total = cartTotal() + shippingCents();
    const previous = Number($('installments').value) || Math.max(...availablePlans());
    const plans = availablePlans();
    $('installments').replaceChildren(...plans.map(m => new window.Option(m === 1 ? `Pago de contado · ${money(total)}` : `${m} meses sin intereses de ${money(Math.round(total / m))}`, String(m))));
    $('installments').value = String(plans.includes(previous) ? previous : plans[plans.length - 1]);
    $('installments-hint').textContent = selectedCard()?.msi ? 'Promoción Buen Fin: hasta 18 meses sin intereses con tarjetas de crédito participantes.' : 'Los meses sin intereses aplican solo con tarjetas de crédito participantes.';
    renderSummary();
  }
  function renderFulfillment() {
    const home = selected('fulfillment') === 'domicilio';
    $('store-fields').hidden = home; $('home-fields').hidden = !home;
    const store = catalog.stores.find(s => s.id === $('store').value);
    $('store-address').textContent = store ? `${store.address} · ${store.hours}` : '';
    renderPlans();
  }
  function renderSummary() {
    $('summary-lines').replaceChildren(...cart.map(line => {
      const row = el('div', 'line'); const img = el('img'); img.src = line.product.images[0]; img.alt = '';
      const info = el('div'); info.append(el('p', '', line.product.name), el('p', 'small', `Cantidad: ${line.quantity}`), el('strong', '', money(line.product.priceCents * line.quantity)));
      row.append(img, info); return row;
    }));
    const ship = shippingCents(); const total = cartTotal() + ship; const months = Number($('installments').value) || 1;
    $('sum-subtotal').textContent = money(cartTotal()); $('sum-shipping').textContent = ship ? money(ship) : 'Gratis'; $('sum-total').textContent = money(total);
    $('sum-plan').textContent = months > 1 ? `${months} pagos mensuales de ${money(Math.round(total / months))} sin intereses` : 'Un solo pago';
    $('pay').textContent = `Pagar ahora ${money(total)}`;
  }

  function addToCart() {
    if (!product) return;
    const quantity = Number($('quantity').value) || 1;
    cart = [{ product, quantity }];
    const pdpShip = selected('pdp-ship');
    document.querySelector(`input[name="fulfillment"][value="${pdpShip === 'domicilio' ? 'domicilio' : 'tienda'}"]`).checked = true;
    $('checkout-error').hidden = true;
    renderHeaderCart(); renderFulfillment(); show('view-checkout');
  }

  async function pay() {
    if (busy || !cart.length) return;
    const method = selected('fulfillment');
    if (method === 'domicilio' && !/^\d{5}$/.test($('postal-code').value)) {
      $('postal-code').setCustomValidity('Ingresa un código postal de 5 dígitos.'); $('postal-code').reportValidity(); return;
    }
    busy = true; $('pay').disabled = true; $('pay').textContent = 'Procesando pago…'; $('checkout-error').hidden = true;
    const controller = new AbortController(); const timer = setTimeout(() => controller.abort(), 20000);
    try {
      const order = {
        items: cart.map(l => ({ sku: l.product.sku, quantity: l.quantity })),
        fulfillment: method === 'domicilio' ? { method, postalCode: $('postal-code').value } : { method, storeId: $('store').value },
        payment: { cardId: selected('card'), installments: Number($('installments').value) },
      };
      const response = await fetch('/api/6566fc71/checkout', {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, signal: controller.signal,
        body: JSON.stringify({ order, devinUserId: identity('devinUserId'), devinOrgId: identity('devinOrgId'), devinEmail: identity('devinEmail') }),
      });
      const result = await response.json();
      if (!response.ok || !result.success) {
        const detail = `${result.errorClass || 'Error'}: ${result.error || 'Intenta de nuevo.'}`;
        $('checkout-error-title').textContent = response.status >= 500 ? 'No pudimos procesar tu pago' : 'Revisa tu compra';
        $('checkout-error-message').textContent = detail;
        $('checkout-error-ref').textContent = result.requestId ? `Referencia: ${result.requestId}` : '';
        $('checkout-error').hidden = false;
        notice('No pudimos completar tu compra', detail);
        return;
      }
      renderConfirmation(result);
    } catch (error) {
      notice('No pudimos conectar con la tienda', error.name === 'AbortError' ? 'La solicitud tardó demasiado. Intenta de nuevo.' : 'Revisa tu conexión e intenta de nuevo.');
    } finally {
      clearTimeout(timer); busy = false; $('pay').disabled = false; renderSummary();
    }
  }

  function renderConfirmation(result) {
    $('confirm-order').textContent = result.orderId;
    $('confirm-total').textContent = `${money(result.totalCents)} (subtotal ${money(result.subtotalCents)}, envío ${result.shippingCents ? money(result.shippingCents) : 'gratis'})`;
    $('confirm-payment').textContent = result.installments > 1
      ? `${result.card.label} · ${result.installments} meses sin intereses de ${money(result.monthlyPaymentCents)}`
      : `${result.card.label} · pago de contado`;
    const f = result.fulfillment;
    $('confirm-fulfillment').textContent = f.method === 'tienda' ? `${f.storeName} — ${f.storeAddress}. ${f.estimate}.` : `Envío a domicilio (C.P. ${f.postalCode}). ${f.estimate}.`;
    $('confirm-points').textContent = `+${result.walletPoints} puntos`;
    cart = []; renderHeaderCart(); show('view-confirmation');
  }

  $('add-to-cart').onclick = addToCart;
  $('pay').onclick = pay;
  $('back-to-pdp').onclick = () => show('view-pdp');
  $('new-order').onclick = () => show('view-pdp');
  $('cart-button').onclick = () => { if (cart.length) { renderFulfillment(); show('view-checkout'); } else notice('Tu carrito está vacío', 'Agrega un producto para continuar.'); };
  $('dismiss-toast').onclick = () => { $('toast').hidden = true; };
  $('plans-link').onclick = () => $('plans-dialog').showModal();
  $('postal-button').onclick = () => $('postal-dialog').showModal();
  $('postal-dialog').onclose = () => {
    const value = $('postal-input').value;
    if ($('postal-dialog').returnValue === 'ok' && /^\d{5}$/.test(value)) { $('postal-label').textContent = `C.P. ${value}`; $('postal-code').value = value; }
  };
  $('postal-code').oninput = () => { $('postal-code').setCustomValidity(''); renderSummary(); };
  document.querySelectorAll('input[name="fulfillment"]').forEach(input => { input.onchange = renderFulfillment; });
  $('store').onchange = renderFulfillment;
  $('cards').onchange = renderPlans;
  $('installments').onchange = renderSummary;

  async function load() {
    try {
      const response = await fetch('/api/6566fc71/catalog'); if (!response.ok) throw new Error('Catalog unavailable');
      catalog = await response.json(); product = catalog.products[0];
      renderPdp(); renderCheckoutOptions(); renderHeaderCart();
    } catch {
      notice('No pudimos cargar el producto', 'Recarga la página para intentar de nuevo.');
    }
  }
  load();
})();
