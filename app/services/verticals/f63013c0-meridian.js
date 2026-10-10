/* global fetch, URLSearchParams */

/**
 * Meridian Pay client adapter for checkout-service.
 *
 * Thin HTTP wrapper over the PSP's v1 payments API. The base URL is resolved
 * at call time so tests and demo tooling can point it wherever the simulator
 * is mounted.
 */

function baseUrl() {
  return process.env.MERIDIAN_PAY_BASE_URL
    || `http://127.0.0.1:${process.env.PORT || 3000}/api/f63013c0/psp`;
}

async function authorize({ amount, currency, cardToken, reference }) {
  const res = await fetch(`${baseUrl()}/v1/payments`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ amount, currency, cardToken, reference }),
  });
  const apiVersion = res.headers.get('meridian-version');
  const body = await res.json();
  if (!res.ok) {
    const err = new Error(`Meridian Pay authorization failed (${res.status})`);
    err.apiVersion = apiVersion;
    throw err;
  }
  // Response shape per Meridian Pay API reference, 2025-06
  return {
    status: body.status,
    paymentId: body.paymentId,
    amount: body.amount,
    currency: body.currency,
    apiVersion,
    responseKeys: Object.keys(body),
  };
}

async function voidAuthorization(id) {
  const res = await fetch(`${baseUrl()}/v1/payments/${encodeURIComponent(id)}/void`, {
    method: 'POST',
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new Error(`Meridian Pay void failed (${res.status})`);
  }
  return body;
}

async function listAuthorizations(params = {}) {
  const query = new URLSearchParams();
  if (params.since) query.set('since', params.since);
  if (params.cardToken) query.set('cardToken', params.cardToken);
  const suffix = query.toString() ? `?${query}` : '';
  const res = await fetch(`${baseUrl()}/v1/authorizations${suffix}`);
  const body = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new Error(`Meridian Pay list authorizations failed (${res.status})`);
  }
  return body.authorizations || [];
}

module.exports = {
  authorize,
  voidAuthorization,
  listAuthorizations,
  baseUrl,
};
