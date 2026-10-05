const crypto = require('crypto');

/**
 * Meridian Pay — in-process simulator of the fictional card PSP that
 * processes payments for the Ralph Lauren digital flagship checkout.
 *
 * Stands in for the vendor's sandbox environment. Authorizations live in
 * memory; the active API version can be flipped on a schedule so the
 * "2026-10" rollout lands mid-demo without a deploy.
 */

const API_VERSIONS = ['2025-06', '2026-10'];
const DESCRIPTOR = 'RALPH LAUREN';
const CROCKFORD = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';

const state = {
  apiVersion: '2026-10',
  authorizations: [],
  idempotency: new Map(),
  flipTimer: null,
  flipAt: null,
};

// ULID-lookalike: 10-char Crockford base32 timestamp + 10-char random tail.
function newAuthorizationId() {
  let time = '';
  let n = Date.now();
  for (let i = 0; i < 10; i += 1) {
    time = CROCKFORD[n % 32] + time;
    n = Math.floor(n / 32);
  }
  const rand = crypto.randomBytes(8).toString('hex').toUpperCase().slice(0, 10);
  return `psp_${time}${rand}`;
}

function shapeForVersion(auth, version) {
  const base = {
    status: auth.status,
    amount: auth.amount,
    currency: auth.currency,
    descriptor: auth.descriptor,
  };
  if (version === '2026-10') {
    return { ...base, pspReference: auth.id };
  }
  return { ...base, paymentId: auth.id };
}

function createPayment({ amount, currency, cardToken, reference }, { idempotencyKey } = {}) {
  if (idempotencyKey && state.idempotency.has(idempotencyKey)) {
    const existing = state.idempotency.get(idempotencyKey);
    return {
      status: 200,
      headers: { 'Meridian-Version': state.apiVersion },
      body: shapeForVersion(existing, state.apiVersion),
      replayed: true,
    };
  }

  const auth = {
    id: newAuthorizationId(),
    status: 'AUTHORISED',
    amount,
    currency,
    cardToken,
    reference,
    descriptor: DESCRIPTOR,
    createdAt: new Date().toISOString(),
    voidedAt: null,
  };
  state.authorizations.push(auth);
  if (idempotencyKey) state.idempotency.set(idempotencyKey, auth);

  return {
    status: 200,
    headers: { 'Meridian-Version': state.apiVersion },
    body: shapeForVersion(auth, state.apiVersion),
    replayed: false,
  };
}

function voidPayment(id) {
  const auth = state.authorizations.find((a) => a.id === id);
  if (!auth) return null;
  if (!auth.voidedAt) {
    auth.status = 'VOIDED';
    auth.voidedAt = new Date().toISOString();
  }
  return auth;
}

function listAuthorizations({ since, cardToken } = {}) {
  const sinceMs = since ? new Date(since).getTime() : null;
  return state.authorizations.filter((a) => {
    if (sinceMs && new Date(a.createdAt).getTime() < sinceMs) return false;
    if (cardToken && a.cardToken !== cardToken) return false;
    return true;
  });
}

function getVersion() {
  return state.apiVersion;
}

function setVersion(version) {
  if (!API_VERSIONS.includes(version)) {
    const err = new Error(`Unsupported API version: ${version}`);
    err.code = 'UNSUPPORTED_VERSION';
    throw err;
  }
  state.apiVersion = version;
  return state.apiVersion;
}

function getFlipAt() {
  return state.flipAt;
}

function armFlip(seconds, toVersion = '2026-10') {
  if (state.flipTimer) clearTimeout(state.flipTimer);
  state.flipAt = new Date(Date.now() + seconds * 1000).toISOString();
  state.flipTimer = setTimeout(() => {
    try {
      setVersion(toVersion);
    } finally {
      state.flipTimer = null;
      state.flipAt = null;
    }
  }, seconds * 1000);
  state.flipTimer.unref();
  return state.flipAt;
}

function reset() {
  if (state.flipTimer) {
    clearTimeout(state.flipTimer);
    state.flipTimer = null;
  }
  state.flipAt = null;
  state.authorizations = [];
  state.idempotency = new Map();
  state.apiVersion = '2025-06';
}

module.exports = {
  API_VERSIONS,
  DESCRIPTOR,
  createPayment,
  voidPayment,
  listAuthorizations,
  getVersion,
  setVersion,
  armFlip,
  getFlipAt,
  reset,
};
