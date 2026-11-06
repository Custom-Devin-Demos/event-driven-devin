const fs = require('fs');
const path = require('path');
const vm = require('vm');
const { CATALOG, STORES } = require('../app/services/verticals/a4c19e72');

const html = fs.readFileSync(path.join(__dirname, '../app/public/verticals/a4c19e72.html'), 'utf8');
const source = html.match(/<script>([\s\S]*?)<\/script>/)[1];

test('presenter guidance names the dedicated Lowe’s destination', () => {
  expect(html).toContain('dedicated eashan-demo Workflow and automation');
  expect(html).not.toContain('automations-demo responder');
});

function element(tagName = 'div', classes = '') {
  const tokens = new Set(classes.split(' '));
  return {
    tagName, children: [], dataset: {},
    classList: {
      add: value => tokens.add(value), remove: value => tokens.delete(value),
      contains: value => tokens.has(value),
      toggle: (value, enabled) => enabled ? tokens.add(value) : tokens.delete(value),
    },
    set textContent(value) { this.text = String(value); this.children = []; },
    get textContent() { return this.text || this.children.map(child => child.textContent).join(' '); },
    append(...children) { this.children.push(...children); },
    replaceChildren() { this.text = ''; this.children = []; },
    setAttribute() {}, addEventListener() {}, scrollIntoView() {},
    showModal: jest.fn(), close: jest.fn(),
  };
}

const savedIdentity = { devinOrgId: 'org-selected', devinUserId: 'user-selected', devinEmail: 'presenter@example.com' };

async function storefront(search = '', identity = savedIdentity, config = {}, storageBlocked = false) {
  const nodes = new Map([...html.matchAll(/<[^>]+\bid="([^"]+)"[^>]*>/g)].map(match => [
    match[1], element('div', match[0].match(/class="([^"]*)"/)?.[1] || ''),
  ]));
  const methods = ['delivery', 'pickup'].map(method => Object.assign(element('button'), { dataset: { method } }));
  const storage = new Map(Object.entries(identity));
  const localStorage = {
    getItem: key => {
      if (storageBlocked === true || storageBlocked === 'read') throw new Error('SecurityError: storage blocked');
      return storage.get(key) || null;
    },
    setItem: (key, value) => {
      if (storageBlocked === true || storageBlocked === 'write') throw new Error('SecurityError: storage blocked');
      storage.set(key, value);
    },
  };
  const fetch = jest.fn().mockImplementation(async url => ({ ok: true, json: async () => url === '/api/config' ? config : { products: CATALOG, stores: STORES, revision: 'Incident baseline' } }));
  vm.runInNewContext(source, {
    document: {
      getElementById: id => nodes.get(id), createElement: element,
      querySelectorAll: selector => selector === '[data-method]' ? methods : [],
    },
    fetch, localStorage, URLSearchParams, location: { search }, Intl,
    setTimeout: jest.fn(), clearTimeout: jest.fn(),
  });
  await new Promise(setImmediate);
  return { nodes, methods, fetch, storage };
}

test.each(['', '?ops=0', '?ops=true'])('shopper view hides internal presenter controls: %s', async search => {
  const { nodes } = await storefront(search);
  expect(nodes.get('demoToolbar').classList.contains('hidden')).toBe(true);
});

test('presenter controls are available only with the explicit display option', async () => {
  const { nodes } = await storefront('?ops=1');
  expect(nodes.get('demoToolbar').classList.contains('hidden')).toBe(false);
  nodes.get('openOps').onclick();
  expect(nodes.get('opsDialog').showModal).toHaveBeenCalledTimes(1);
});

test.each([
  ['accepted', { ok: true, sent: true, dryRun: false }],
  ['preview', { ok: true, sent: false, dryRun: true, payload: { type: 'message' }, card: { body: [], actions: [] } }],
  ['failed', { ok: false, sent: false, error: 'Teams delivery was not confirmed. No Slack fallback.' }],
  ['throttled', { ok: false, sent: false, throttled: true, error: 'Teams cooldown; wait one minute.' }],
  ['missing', undefined],
])('pickup error stays shopper-safe when alert is %s', async (_state, alert) => {
  const { nodes, methods, fetch } = await storefront();
  methods[1].onclick();
  fetch.mockResolvedValue({ ok: false, status: 500, json: async () => ({ error: 'Internal checkout failure', diagnostic: 'TypeError: fee', alert }) });
  await nodes.get('checkout').onclick();
  const notice = nodes.get('notice');
  expect(notice.textContent).toBe('We couldn’t prepare your pickup checkout. Your items are still in your cart. Please try again. No payment was taken.');
  expect(notice.children.map(child => child.tagName)).toEqual(['strong', 'p']);
  expect(nodes.get('opsDialog').showModal).not.toHaveBeenCalled();
  expect(nodes.get('checkout').disabled).toBe(false);
  expect(nodes.get('incidentState').textContent).toContain('TypeError: fee');
  expect(nodes.get('deliveryStatus').textContent).toContain(alert?.dryRun ? 'Dry-run' : alert?.sent ? 'accepted' : 'not confirmed');
  expect(fetch).toHaveBeenCalledTimes(2);
  const request = JSON.parse(fetch.mock.calls[1][1].body);
  expect(request).toMatchObject({ ...savedIdentity, fulfillment: 'pickup', items: [{ sku: 'DEMO-FRIDGE', qty: 1 }, { sku: 'DEMO-BATTERY', qty: 1 }] });
  await nodes.get('checkout').onclick();
  expect(fetch.mock.calls[2][1].body).toBe(fetch.mock.calls[1][1].body);
});

test('direct entry uses existing locked identity defaults like Pepsi', async () => {
  const { nodes, fetch } = await storefront('', {}, { lockOrg: true, defaultOrgId: 'org-default', lockUser: true, defaultUserId: 'user-default' });
  fetch.mockResolvedValue({ ok: false, status: 500, json: async () => ({}) });
  await nodes.get('checkout').onclick();
  const request = JSON.parse(fetch.mock.calls.find(([url]) => url.endsWith('/checkout'))[1].body);
  expect(request).toMatchObject({ devinOrgId: 'org-default', devinUserId: 'user-default', devinEmail: '' });
});

test('unlocked host defaults do not invent a presenter identity', async () => {
  const { nodes, fetch } = await storefront('', {}, { defaultOrgId: 'org-default', defaultUserId: 'user-default' });
  fetch.mockResolvedValue({ ok: false, status: 500, json: async () => ({}) });
  await nodes.get('checkout').onclick();
  const request = JSON.parse(fetch.mock.calls.find(([url]) => url.endsWith('/checkout'))[1].body);
  expect(request).toMatchObject({ devinOrgId: '', devinUserId: '', devinEmail: '' });
});

test('saved hub identity does not fetch or replace host defaults', async () => {
  const { fetch, storage } = await storefront();
  expect(fetch).not.toHaveBeenCalledWith('/api/config');
  expect(Object.fromEntries(storage)).toEqual(savedIdentity);
});

test('blocked browser storage does not prevent a healthy checkout', async () => {
  const { nodes, fetch } = await storefront('', {}, {}, true);
  fetch.mockResolvedValue({ ok: true, json: async () => ({ total: 2007.36, confirmation: 'DEMO-TEST' }) });
  await nodes.get('checkout').onclick();
  const checkoutRequest = fetch.mock.calls.find(([url]) => url.endsWith('/checkout'));
  expect(checkoutRequest).toBeDefined();
  expect(JSON.parse(checkoutRequest[1].body)).toMatchObject({ devinOrgId: '', devinUserId: '', devinEmail: '' });
  expect(nodes.get('notice').textContent).toContain('Your demo checkout is ready.');
});

test.each([true, 'read', 'write'])('locked identity survives blocked storage: %s', async storageBlocked => {
  const config = { lockOrg: true, defaultOrgId: 'org-default', lockUser: true, defaultUserId: 'user-default' };
  const { nodes, fetch } = await storefront('', { devinUserId: 'user-stale' }, config, storageBlocked);
  fetch.mockResolvedValue({ ok: true, json: async () => ({ total: 2007.36, confirmation: 'DEMO-TEST' }) });
  await nodes.get('checkout').onclick();
  const request = JSON.parse(fetch.mock.calls.find(([url]) => url.endsWith('/checkout'))[1].body);
  expect(request).toMatchObject({ devinOrgId: 'org-default', devinUserId: 'user-default', devinEmail: '' });
  expect(nodes.get('notice').textContent).toContain('Your demo checkout is ready.');
});

test('delivery errors name delivery, not pickup', async () => {
  const { nodes, fetch } = await storefront();
  fetch.mockResolvedValue({ ok: false, status: 400, json: async () => ({ error: 'Invalid cart' }) });
  await nodes.get('checkout').onclick();
  expect(nodes.get('notice').textContent).toContain('your delivery checkout');
  expect(nodes.get('notice').textContent).not.toContain('pickup');
});

test.each(['network', 'invalid response'])('transport error remains shopper-safe: %s', async failure => {
  const { nodes, fetch } = await storefront();
  const error = new Error('Internal Teams transport diagnostic');
  if (failure === 'network') fetch.mockRejectedValue(error);
  else fetch.mockResolvedValue({ json: async () => { throw error; } });
  await nodes.get('checkout').onclick();
  expect(nodes.get('notice').textContent).toContain('Checkout is temporarily unavailable.');
  expect(nodes.get('notice').textContent).not.toContain(error.message);
  expect(nodes.get('incidentState').textContent).toBe(error.message);
  expect(nodes.get('checkout').disabled).toBe(false);
});

test('healthy delivery confirmation still works without exposing presenter status', async () => {
  const { nodes, fetch } = await storefront();
  fetch.mockResolvedValue({ ok: true, status: 200, json: async () => ({ total: 2007.36, confirmation: 'DEMO-TEST', revision: 'Incident baseline' }) });
  await nodes.get('checkout').onclick();
  expect(nodes.get('notice').textContent).toContain('Your demo checkout is ready.');
  expect(nodes.get('notice').textContent).toContain('$2,007.36');
  expect(nodes.get('notice').classList.contains('success')).toBe(true);
  expect(nodes.get('demoToolbar').classList.contains('hidden')).toBe(true);
});
