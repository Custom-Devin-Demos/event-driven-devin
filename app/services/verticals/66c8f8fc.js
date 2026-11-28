/**
 * My Verizon mobile app — account, sign-in and "Remember me".
 *
 * Sessions and "Remember me" tokens live in memory. A normal session lasts
 * while the app is open; with "Remember me" the app stores a device token and
 * redeems it when reopened (POST /session/resume).
 */
const crypto = require('crypto');

const REMEMBER_ME_DAYS = 30;
const DAY_MS = 24 * 60 * 60 * 1000;

const DEMO_USER = { userId: 'sidney.morgan', name: 'Sidney', phone: '(501) 555-1212' };

const ACCOUNT = {
  name: DEMO_USER.name,
  autoPay: { enabled: true, scheduledFor: 'Dec 15' },
  bill: {
    balanceCents: 14237,
    dueDate: 'Dec 15',
    period: 'Nov 16 – Dec 15',
    savingsCents: 3500,
    lines: [
      { label: 'Plan Unlimited Plus · 2 lines', amountCents: 10000 },
      { label: 'Device payment · iPhone 15 Pro Max (14/36)', amountCents: 2778 },
      { label: 'Fios 1 Gig', amountCents: 3900 },
      { label: 'AutoPay & paper-free billing discount', amountCents: -2000 },
      { label: 'Mobile + Home discount', amountCents: -1500 },
      { label: 'Taxes, surcharges & fees', amountCents: 1059 },
    ],
  },
  dollars: { availableCents: 810, last30Cents: 405, lifetimeCents: 1210 },
  mobile: {
    device: "Sidney's iPhone",
    number: DEMO_USER.phone,
    model: 'Apple iPhone 15 Pro Max, White Titanium, 256 GB',
    plan: 'Unlimited Plus',
    status: 'Ready to upgrade',
    usage: { daysLeft: 22, cycle: 'Nov 16 – Dec 15', dataGb: 18.3 },
  },
  home: {
    address: '1 Verizon Way',
    router: 'Verizon Router',
    online: true,
    plan: 'Fios 1 Gig',
    tv: 'Fios TV+',
  },
};

const sessions = new Map();
const rememberTokens = new Map();

function newToken() {
  return crypto.randomBytes(24).toString('hex');
}

function httpError(status, code, message) {
  const err = new Error(message);
  err.status = status;
  err.code = code;
  return err;
}

function openSession(userId) {
  const sessionToken = newToken();
  sessions.set(sessionToken, { userId, createdAt: Date.now() });
  return sessionToken;
}

function login({ userId, password, rememberMe, deviceId } = {}) {
  const id = String(userId || '').trim().toLowerCase();
  if (!id || !password) throw httpError(400, 'MISSING_CREDENTIALS', 'Enter your user ID and password.');
  if (id !== DEMO_USER.userId && id.replace(/\D/g, '') !== DEMO_USER.phone.replace(/\D/g, '')) {
    throw httpError(401, 'INVALID_CREDENTIALS', 'Your user ID or password is incorrect.');
  }
  const result = { sessionToken: openSession(DEMO_USER.userId), name: DEMO_USER.name };
  if (rememberMe) {
    const rememberToken = newToken();
    rememberTokens.set(DEMO_USER.userId, {
      token: rememberToken,
      deviceId,
      expiresAt: Date.now() + REMEMBER_ME_DAYS * DAY_MS,
    });
    result.rememberToken = rememberToken;
  }
  return result;
}

function resumeSession({ token, deviceId } = {}) {
  const record = rememberTokens.get(deviceId);
  if (!record || record.token !== token || record.expiresAt < Date.now()) {
    throw httpError(401, 'SESSION_EXPIRED', 'Your session has expired. Please sign in again.');
  }
  return { sessionToken: openSession(DEMO_USER.userId), name: DEMO_USER.name };
}

function getAccount(sessionToken) {
  if (!sessions.has(sessionToken)) throw httpError(401, 'NOT_SIGNED_IN', 'Sign in to view your account.');
  return ACCOUNT;
}

function logout({ sessionToken, token } = {}) {
  sessions.delete(sessionToken);
  for (const [key, record] of rememberTokens) if (record.token === token) rememberTokens.delete(key);
  return { ok: true };
}

module.exports = { login, resumeSession, getAccount, logout, DEMO_USER, REMEMBER_ME_DAYS };
