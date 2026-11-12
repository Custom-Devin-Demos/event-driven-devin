/**
 * Seeded access-log evidence for the 4491bcfa EA Account portal demo.
 *
 * Represents the request history that the gateway's access log would contain for
 * a single session hitting GET /api/accounts/:accountId/profile repeatedly. One
 * session, from one source IP, pulled hundreds of distinct account profiles
 * inside a five-minute window. These records are synthetic.
 *
 * The signed-in portal session reuses ATTACKER_SESSION so that the live demo
 * (changing the account id in the URL) continues the same enumeration run.
 */

const { ACCOUNT_IDS } = require('./4491bcfa-accounts');

const ATTACKER_SESSION = 'sess_9f2a7c41e8b3d6';
const SOURCE_IP = '203.0.113.47';
const USER_AGENT = 'python-requests/2.31.0';
const OWNER_ACCOUNT = 'EA-100000';
const WINDOW_MINUTES = 5;
const WINDOW_START = '2026-11-11T03:58:12Z';

// 213 distinct account ids already pulled cross-account in the window; the 214th
// distinct id arrives live when the demo changes the account in the URL.
const SEEDED_IDS = ACCOUNT_IDS.filter((id) => id !== OWNER_ACCOUNT).slice(0, 213);

function buildSeededLog() {
  const start = new Date(WINDOW_START).getTime();
  const spanMs = WINDOW_MINUTES * 60 * 1000;
  return SEEDED_IDS.map((accountId, i) => {
    const ts = new Date(start + Math.round((i / SEEDED_IDS.length) * spanMs)).toISOString();
    return {
      ts,
      ip: SOURCE_IP,
      sessionId: ATTACKER_SESSION,
      method: 'GET',
      path: `/api/accounts/${accountId}/profile`,
      status: 200,
      userAgent: USER_AGENT,
    };
  });
}

const SEEDED_LOG = buildSeededLog();

function toLogLines() {
  return SEEDED_LOG.map(
    (e) => `${e.ts} ${e.ip} "${e.method} ${e.path}" ${e.status} session=${e.sessionId} ua="${e.userAgent}"`,
  );
}

module.exports = {
  ATTACKER_SESSION,
  SOURCE_IP,
  USER_AGENT,
  OWNER_ACCOUNT,
  WINDOW_MINUTES,
  WINDOW_START,
  SEEDED_IDS,
  SEEDED_LOG,
  DISTINCT_SEEDED: SEEDED_IDS.length,
  toLogLines,
};
