/* global window, document, location, performance, AbortController, Response, KeyboardEvent */
(function () {
  if (document.documentElement.dataset.view !== 'tv') return;
  const embedded = window.parent !== window && new URL(location.href).searchParams.get('embed') === '1';
  const nativeFetch = window.fetch.bind(window);
  const paths = new Set(['/api/home/rows', '/api/home/continue-watching', '/api/playback/start']);
  const keys = new Set(['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'Enter', 'Escape', 'Backspace']);
  let sequence = 0;

  function report(data) {
    if (embedded) window.parent.postMessage({ source: 'streamtv-emulator', ...data }, location.origin);
  }

  window.fetch = function (input, options) {
    const url = new URL(typeof input === 'string' ? input : input.url, location.href);
    if (url.origin !== location.origin) return nativeFetch(input, options);
    if (embedded && url.pathname === '/api/oncall/trigger/streamtv') {
      report({ type: 'alert-held' });
      return Promise.resolve(new Response(JSON.stringify({ ok: false, skipped: true, reason: 'Use Send on-call alert in the mock console.' }), { headers: { 'Content-Type': 'application/json' } }));
    }
    if (!paths.has(url.pathname)) return nativeFetch(input, options);
    const id = ++sequence;
    const method = options?.method || 'GET';
    const started = performance.now();
    const controller = new AbortController();
    const callerSignal = options?.signal || (typeof input === 'object' ? input.signal : undefined);
    const abort = () => controller.abort();
    if (callerSignal?.aborted) abort();
    else callerSignal?.addEventListener('abort', abort, { once: true });
    const timer = setTimeout(abort, 12000);
    report({ type: 'request', id, phase: 'start', path: url.pathname, method });
    return nativeFetch(input, { ...options, signal: controller.signal }).then((response) => {
      report({ type: 'request', id, phase: 'end', path: url.pathname, method, status: response.status, durationMs: Math.round(performance.now() - started) });
      return response;
    }, (error) => {
      report({ type: 'request', id, phase: 'end', path: url.pathname, method, status: 0, durationMs: Math.round(performance.now() - started), error: controller.signal.aborted ? 'Client deadline reached or request cancelled' : 'Network request failed' });
      throw error;
    }).finally(() => {
      clearTimeout(timer);
      callerSignal?.removeEventListener('abort', abort);
    });
  };

  if (embedded) {
    window.addEventListener('streamtv-profile', (event) => {
      if (['p-maya', 'p-jordan', 'p-sam'].includes(event.detail)) report({ type: 'profile', profileId: event.detail });
    });
    document.addEventListener('keydown', (event) => {
      if (event.key === 'Home') { event.preventDefault(); report({ type: 'home' }); }
    });
    window.addEventListener('message', (event) => {
      if (event.origin !== location.origin || event.source !== window.parent) return;
      if (event.data?.source !== 'streamtv-emulator' || event.data.type !== 'key' || !keys.has(event.data.key)) return;
      document.dispatchEvent(new KeyboardEvent('keydown', { key: event.data.key, bubbles: true }));
    });
    window.addEventListener('DOMContentLoaded', () => report({ type: 'ready' }));
  }
})();
