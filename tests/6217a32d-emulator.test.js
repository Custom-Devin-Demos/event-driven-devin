/* global describe, test, expect, jest, afterEach, AbortController, Response */
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const bridge = fs.readFileSync(path.join(__dirname, '../app/public/verticals/assets/6217a32d/tv-bridge.js'), 'utf8');
const consoleScript = fs.readFileSync(path.join(__dirname, '../app/public/verticals/assets/6217a32d/emulator.js'), 'utf8');

function consoleHarness(search = '') {
  const nodes = new Map();
  const events = {};
  const location = new URL('https://demo.example/oncall/c/6217a32d' + search);
  const element = () => ({
    innerHTML: '', style: {}, dataset: {}, clientWidth: 1440, events: {},
    classList: { toggle: jest.fn() }, remove: jest.fn(), appendChild: jest.fn(),
    replaceChildren: jest.fn(), scrollIntoView: jest.fn(),
    querySelectorAll: () => [], contentWindow: { focus: jest.fn(), postMessage: jest.fn() },
    addEventListener(name, fn) { this.events[name] = fn; },
  });
  const document = {
    documentElement: { dataset: { view: 'console' } },
    getElementById(id) { if (!nodes.has(id)) nodes.set(id, element()); return nodes.get(id); },
    querySelectorAll: () => [], addEventListener: jest.fn(),
    createElement: jest.fn(element),
  };
  const window = {
    addEventListener: (name, fn) => { events[name] = fn; },
    history: { pushState: jest.fn((_state, _title, url) => { location.href = url.href; }) },
  };
  const fetch = jest.fn();
  vm.runInNewContext(consoleScript, {
    document, window, location, URL, fetch, setInterval: jest.fn(), setTimeout, clearTimeout,
    ResizeObserver: class { observe() {} disconnect() {} },
  });
  const node = (id) => document.getElementById(id);
  const click = (action) => node('emulator').events.click({ target: { closest: () => ({ dataset: { action } }) } });
  return { node, click, document, window, events, location, fetch };
}

describe('6217a32d experience selection', () => {
  test('opens on two idle paths without creating a TV or starting any requests', () => {
    const h = consoleHarness();
    expect(h.document.title).toBe('Experiences | Roku');
    expect(h.node('ceMain').innerHTML).toContain('Open TV experience');
    expect(h.node('ceMain').innerHTML).toContain('Open Cloud Emulator');
    expect(h.document.createElement).not.toHaveBeenCalled();
    expect(h.fetch).not.toHaveBeenCalled();
  });

  test('customer path requires explicit launch and holds alerting until degraded evidence', async () => {
    const h = consoleHarness('?experience=customer');
    expect(h.document.title).toBe('Customer experience | Roku');
    expect(h.node('ceMain').innerHTML).toContain('On-Call workspace');
    expect(h.node('ceAlert').disabled).toBe(true);
    expect(h.document.createElement).not.toHaveBeenCalled();
    await h.click('launch');
    const frame = h.document.createElement.mock.results[0].value;
    expect(frame.src).toContain('view=tv&embed=1&profileId=p-maya');
    h.events.message({ origin: h.location.origin, source: frame.contentWindow, data: {
      source: 'streamtv-emulator', type: 'request', phase: 'end', method: 'GET',
      path: '/api/home/continue-watching', status: 504, durationMs: 8500,
    } });
    expect(h.node('ceAlert').disabled).toBe(false);
    expect(h.fetch).not.toHaveBeenCalled();
    await h.click('oncall');
    expect(h.node('ceOncall').open).toBe(true);
  });

  test('switching paths removes the old frame; developer devices remain idle', async () => {
    const h = consoleHarness();
    await h.click('customer');
    await h.click('launch');
    const frame = h.document.createElement.mock.results[0].value;
    await h.click('devices');
    expect(frame.remove).toHaveBeenCalled();
    expect(h.document.title).toBe('Cloud Emulator | Roku');
    expect(h.node('ceDevices').innerHTML).toContain('Stopped');
    expect(h.location.search).toBe('?experience=developer');
    expect(h.fetch).not.toHaveBeenCalled();
    await h.click('overview');
    expect(h.location.search).toBe('');
    expect(h.node('ceMain').innerHTML).toContain('Open TV experience');
  });

  test('browser history selects an idle workspace without launching the app', () => {
    const h = consoleHarness('?experience=developer');
    h.location.search = '?experience=customer';
    h.events.popstate();
    expect(h.document.title).toBe('Customer experience | Roku');
    expect(h.document.createElement).not.toHaveBeenCalled();
    expect(h.fetch).not.toHaveBeenCalled();
  });
});

function harness({ embedded = true, view = 'tv', fetch = jest.fn().mockResolvedValue(new Response('{}')) } = {}) {
  const parent = { postMessage: jest.fn() };
  const events = {};
  const documentEvents = {};
  const document = {
    documentElement: { dataset: { view } },
    addEventListener: (name, fn) => { documentEvents[name] = fn; },
    dispatchEvent: jest.fn(),
  };
  const window = { fetch, parent, addEventListener: (name, fn) => { events[name] = fn; } };
  if (!embedded) window.parent = window;
  vm.runInNewContext(bridge, {
    window, document, URL, AbortController, Response,
    location: { href: 'https://demo.example/oncall/c/6217a32d?view=tv&embed=1', origin: 'https://demo.example' },
    performance: { now: () => Date.now() }, setTimeout, clearTimeout,
    KeyboardEvent: function (type, options) { Object.assign(this, { type }, options); },
  });
  return { window, document, parent, events, documentEvents, nativeFetch: fetch };
}

afterEach(() => jest.useRealTimers());

describe('6217a32d mock emulator bridge', () => {
  test('does not start requests or install the TV bridge on the idle console', () => {
    const h = harness({ view: 'console' });
    expect(h.window.fetch).toBe(h.nativeFetch);
    expect(h.nativeFetch).not.toHaveBeenCalled();
    expect(h.events).toEqual({});
  });

  test('reports actual API status and elapsed time without logging identity or request bodies', async () => {
    const h = harness({ fetch: jest.fn().mockResolvedValue(new Response('{}', { status: 504 })) });
    const response = await h.window.fetch('/api/home/continue-watching?profileId=p-sam');
    expect(response.status).toBe(504);
    expect(h.nativeFetch).toHaveBeenCalledTimes(1);
    const [start, end] = h.parent.postMessage.mock.calls.map(([payload]) => payload);
    expect(start).toMatchObject({ phase: 'start', path: '/api/home/continue-watching', method: 'GET' });
    expect(end).toMatchObject({ phase: 'end', status: 504, durationMs: expect.any(Number) });
    expect(end).not.toHaveProperty('body');
    expect(end).not.toHaveProperty('headers');
    expect(h.parent.postMessage.mock.calls.every((call) => call[1] === 'https://demo.example')).toBe(true);
  });

  test('holds automatic shim alerts in embedded mode without making a network request', async () => {
    const h = harness();
    const response = await h.window.fetch('/api/oncall/trigger/streamtv', { method: 'POST', body: '{}' });
    expect(await response.json()).toMatchObject({ ok: false, skipped: true });
    expect(h.nativeFetch).not.toHaveBeenCalled();
    expect(h.parent.postMessage).toHaveBeenCalledWith({ source: 'streamtv-emulator', type: 'alert-held' }, 'https://demo.example');
  });

  test('preserves standalone TV alert routing', async () => {
    const h = harness({ embedded: false });
    await h.window.fetch('/api/oncall/trigger/streamtv', { method: 'POST' });
    expect(h.nativeFetch).toHaveBeenCalledWith('/api/oncall/trigger/streamtv', { method: 'POST' });
  });

  test('bounds a hanging API request at 12 seconds', async () => {
    jest.useFakeTimers();
    const h = harness({ fetch: jest.fn((_url, options) => new Promise((_resolve, reject) => {
      options.signal.addEventListener('abort', () => reject(new Error('aborted')));
    })) });
    const pending = h.window.fetch('/api/home/continue-watching?profileId=p-maya');
    const rejected = expect(pending).rejects.toThrow('aborted');
    await jest.advanceTimersByTimeAsync(12000);
    await rejected;
    expect(h.parent.postMessage.mock.calls.at(-1)[0]).toMatchObject({ phase: 'end', status: 0, durationMs: 12000, error: 'Client deadline reached or request cancelled' });
    expect(jest.getTimerCount()).toBe(0);
  });

  test('clears the request deadline on a successful response', async () => {
    jest.useFakeTimers();
    const h = harness();
    await h.window.fetch('/api/home/rows');
    expect(jest.getTimerCount()).toBe(0);
  });

  test('only accepts supported remote keys from the same-origin parent', () => {
    const h = harness();
    const message = { source: h.parent, origin: 'https://demo.example', data: { source: 'streamtv-emulator', type: 'key', key: 'Enter' } };
    h.events.message({ ...message, origin: 'https://other.example' });
    h.events.message({ ...message, source: {} });
    h.events.message({ ...message, data: { ...message.data, key: 'Delete' } });
    expect(h.document.dispatchEvent).not.toHaveBeenCalled();
    h.events.message(message);
    expect(h.document.dispatchEvent).toHaveBeenCalledWith(expect.objectContaining({ type: 'keydown', key: 'Enter', bubbles: true }));
  });

  test('maps the native Home key back to the mock device launcher', () => {
    const h = harness();
    const event = { key: 'Home', preventDefault: jest.fn() };
    h.documentEvents.keydown(event);
    expect(event.preventDefault).toHaveBeenCalled();
    expect(h.parent.postMessage).toHaveBeenCalledWith({ source: 'streamtv-emulator', type: 'home' }, 'https://demo.example');
  });

  test('only reports supported inner-TV profile changes to the console', () => {
    const h = harness();
    h.events['streamtv-profile']({ detail: 'p-jordan' });
    expect(h.parent.postMessage).toHaveBeenCalledWith({ source: 'streamtv-emulator', type: 'profile', profileId: 'p-jordan' }, 'https://demo.example');
    h.events['streamtv-profile']({ detail: 'unknown' });
    h.events['streamtv-profile']({ detail: { profileId: 'p-sam' } });
    expect(h.parent.postMessage).toHaveBeenCalledTimes(1);
  });
});
