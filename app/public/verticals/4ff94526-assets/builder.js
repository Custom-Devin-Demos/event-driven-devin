/* global document, window, localStorage, fetch, AbortController */
(() => {
  'use strict';
  const $ = id => document.getElementById(id);
  let groups = [], crustSizes = {}, quantity = 1, busy = false, toastTimer;
  const cart = [];
  const money = amount => `$${amount.toFixed(2)}`;
  const identity = key => { try { return localStorage.getItem(key) || undefined; } catch { return undefined; } };
  const el = (tag, className, text) => {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined) node.textContent = text;
    return node;
  };
  function image(src, alt) {
    const node = el('img'); node.src = src; node.alt = alt; node.loading = 'lazy';
    node.onerror = () => { node.onerror = null; node.src = '/verticals/4ff94526-assets/hero.webp'; };
    return node;
  }
  function notice(title, message) {
    clearTimeout(toastTimer); $('toast-title').textContent = title; $('toast-message').textContent = message;
    $('toast').hidden = false; toastTimer = setTimeout(() => { $('toast').hidden = true; }, 6500);
  }
  function value(name) { return document.querySelector(`input[name="${name}"]:checked`)?.value; }
  function optionName(groupId, id) { return groups.find(g => g.id === groupId)?.options.find(o => o.id === id)?.label || id; }
  function pizza() {
    const result = { quantity, size: value('size'), instructions: $('instructions').value };
    groups.forEach(group => {
      result[group.id] = group.multiple
        ? [...document.querySelectorAll(`input[name="${group.id}"]:checked`)].map(input => input.value)
        : value(group.id);
    });
    for (const group of ['sauce', 'cheese']) {
      result[`${group}Portion`] = document.querySelector(`#${group} .choice-wrap:has(input:checked) .portion button[aria-pressed="true"]`)?.dataset.portion || 'normal';
    }
    return result;
  }
  function description(p) {
    const extras = ['meats', 'veggies', 'extraCheese', 'dips'].flatMap(key => p[key].map(id => optionName(key, id)));
    const portionName = group => {
      const portion = p[`${group}Portion`];
      const prefix = portion !== 'normal' && !p[group].startsWith('no-') ? `${portion[0].toUpperCase()}${portion.slice(1)} ` : '';
      return prefix + optionName(group, p[group]);
    };
    return [p.size[0].toUpperCase() + p.size.slice(1), optionName('crust', p.crust), optionName('seasoning', p.seasoning), portionName('sauce'), portionName('cheese'), ...extras].join(' · ');
  }
  function summary() {
    $('item-summary').textContent = `(${quantity}) Pizza`;
    const text = description(pizza());
    $('side-summary').textContent = text; $('side-summary').hidden = false;
    $('summary-details').textContent = text;
  }
  function quantities() {
    $('quantity').value = quantity; $('quantity').textContent = quantity;
    $('minus').disabled = quantity <= 1; $('plus').disabled = quantity >= 10;
    summary();
  }
  function renderSizes() {
    const previous = value('size');
    const allowed = crustSizes[value('crust')];
    const selected = allowed.includes(previous) ? previous : allowed[allowed.length - 1];
    const fieldset = $('size').querySelector('fieldset'); fieldset.replaceChildren(el('legend', '', 'Choose your Size'));
    for (const [id, inches] of [['small', 10], ['medium', 12], ['large', 14]]) {
      if (!allowed.includes(id)) continue;
      const label = el('label', 'choice'); const input = el('input'); input.type = 'radio'; input.name = 'size'; input.value = id; input.checked = id === selected;
      const copy = el('span', 'choice-label', id[0].toUpperCase() + id.slice(1)); copy.append(el('span', 'size-inches', `${inches}"`));
      label.append(input, copy); fieldset.append(label);
    }
  }
  function renderGroup(group) {
    const section = el('section', 'option-section'); section.id = group.id;
    section.append(el('h2', '', group.label));
    if (group.id === 'dips') section.append(el('p', 'section-note', 'Additional charges apply.'));
    const fieldset = el('fieldset', `choices ${group.id}`); fieldset.append(el('legend', '', `Choose your ${group.label}`));
    for (const option of group.options) {
      const wrap = el('div', 'choice-wrap');
      const label = el('label', 'choice'); const input = el('input');
      input.type = group.multiple ? 'checkbox' : 'radio'; input.name = group.id; input.value = option.id; input.checked = Boolean(option.selected);
      label.append(input);
      if (option.image) label.append(image(option.image, ''));
      label.append(el('span', 'choice-label', option.label)); wrap.append(label);
      if (['sauce', 'cheese'].includes(group.id) && !option.id.startsWith('no-')) {
        const portions = el('div', 'portion'); portions.hidden = !input.checked; portions.setAttribute('aria-label', `${option.label} portion`);
        for (const portion of ['light', 'normal', 'extra']) {
          const button = el('button', '', portion[0].toUpperCase() + portion.slice(1)); button.type = 'button'; button.dataset.portion = portion;
          button.setAttribute('aria-pressed', String(portion === 'normal'));
          button.onclick = () => { portions.querySelectorAll('button').forEach(b => b.setAttribute('aria-pressed', String(b === button))); summary(); };
          portions.append(button);
        }
        wrap.append(portions);
      }
      fieldset.append(wrap);
    }
    section.append(fieldset); return section;
  }
  function updatePortions() {
    for (const section of document.querySelectorAll('#options .choice-wrap')) {
      const portion = section.querySelector('.portion'); if (portion) portion.hidden = !section.querySelector('input').checked;
    }
  }
  function renderCart() {
    $('cart-lines').replaceChildren();
    const count = cart.reduce((sum, item) => sum + item.pizza.quantity, 0);
    $('cart-count').textContent = count; $('cart-count').hidden = count === 0;
    $('cart-button').setAttribute('aria-label', count ? `View cart - ${count} pizza${count === 1 ? '' : 's'}` : 'View cart - empty');
    if (!cart.length) $('cart-lines').append(el('p', '', 'Your cart is empty. Build a pizza to get started.'));
    cart.forEach((item, index) => {
      const row = el('div', 'cart-line'); const content = el('div');
      row.append(image(`/verticals/4ff94526-assets/${item.pizza.crust.toLowerCase()}.webp`, optionName('crust', item.pizza.crust)));
      content.append(el('h3', '', `(${item.pizza.quantity}) Pizza`), el('p', '', description(item.pizza)), el('strong', '', money(item.total)));
      if (item.pizza.instructions) content.append(el('p', '', item.pizza.instructions));
      const remove = el('button', '', 'Remove'); remove.setAttribute('aria-label', `Remove pizza ${index + 1}`);
      remove.onclick = () => { cart.splice(index, 1); renderCart(); };
      const actions = el('p'); actions.append(remove); content.append(actions); row.append(content); $('cart-lines').append(row);
    });
    $('cart-total').textContent = `Subtotal: ${money(cart.reduce((sum, item) => sum + item.total, 0))}`;
  }
  async function addToCart() {
    if (busy || !groups.length) return;
    busy = true;
    const buttons = [...document.querySelectorAll('.add-to-cart')];
    buttons.forEach(button => { button.disabled = true; button.textContent = 'Adding…'; });
    const controller = new AbortController(); const timer = setTimeout(() => controller.abort(), 20000);
    try {
      const response = await fetch('/api/4ff94526/cart', {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, signal: controller.signal,
        body: JSON.stringify({ pizza: pizza(), devinUserId: identity('devinUserId'), devinOrgId: identity('devinOrgId'), devinEmail: identity('devinEmail') }),
      });
      const result = await response.json();
      if (!response.ok || !result.success) {
        notice("We couldn't add your pizza", `${result.errorClass || 'Error'}: ${result.error || 'Please try again.'}`);
        return;
      }
      cart.push(result); renderCart(); $('cart-dialog').showModal();
    } catch (error) {
      notice('Unable to reach the store', error.name === 'AbortError' ? 'Your request timed out. Please try again.' : 'Check your connection and try again.');
    } finally {
      clearTimeout(timer); busy = false;
      buttons.forEach(button => { button.disabled = false; button.textContent = 'Add To Cart'; });
    }
  }
  $('plus').onclick = () => { quantity = Math.min(10, quantity + 1); quantities(); };
  $('minus').onclick = () => { quantity = Math.max(1, quantity - 1); quantities(); };
  $('dismiss-toast').onclick = () => { $('toast').hidden = true; };
  $('cart-button').onclick = () => { renderCart(); $('cart-dialog').showModal(); };
  $('location-button').onclick = () => $('location-dialog').showModal();
  $('location-form').onsubmit = event => {
    event.preventDefault();
    if (!$('store').value) { $('store').setCustomValidity('Choose a demo store.'); $('store').reportValidity(); return; }
    $('location-label').textContent = $('store').value; $('location-dialog').close();
  };
  $('store').onchange = () => $('store').setCustomValidity('');
  document.querySelectorAll('[data-close]').forEach(button => { button.onclick = () => button.closest('dialog').close(); });
  document.querySelectorAll('.add-to-cart').forEach(button => { button.onclick = addToCart; });
  $('options').onchange = event => {
    if (event.target.name === 'crust') renderSizes();
    updatePortions(); summary();
  };
  $('dips').onchange = summary;
  function sticky() { $('sticky-bar').hidden = window.innerWidth > 650 && document.querySelector('.hero').getBoundingClientRect().bottom > 0; }
  window.addEventListener('scroll', sticky, { passive: true }); window.addEventListener('resize', sticky); sticky();
  async function load() {
    try {
      const response = await fetch('/api/4ff94526/catalog'); if (!response.ok) throw new Error('Catalog unavailable');
      const data = await response.json(); groups = data.groups; crustSizes = data.crustSizes;
      $('options').replaceChildren();
      for (const group of groups) {
        (group.id === 'dips' ? $('dips') : $('options')).append(renderGroup(group));
        if (group.id === 'crust') {
          const size = el('section', 'option-section'); size.id = 'size'; size.append(el('h2', '', 'Size'), el('fieldset', 'choices sizes')); $('options').append(size);
        }
      }
      renderSizes();
      summary();
      document.querySelectorAll('.add-to-cart').forEach(button => { button.disabled = false; });
    } catch {
      groups = []; $('plus').disabled = true;
      $('options').replaceChildren(el('p', '', 'Pizza options could not be loaded.'));
      const retry = el('button', 'primary', 'Try again'); retry.onclick = () => { $('plus').disabled = false; $('dips').replaceChildren(); load(); }; $('options').append(retry);
    }
  }
  load();
})();
