/* global describe, test, expect, jest, afterEach, AbortController, Response */
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const bridge = fs.readFileSync(path.join(__dirname, '../app/public/verticals/assets/6217a32d/tv-bridge.js'), 'utf8');

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
});
