const crypto = require('crypto');
const seed = require('./members.json');

const clone = (value) => JSON.parse(JSON.stringify(value));

/**
 * Mock DICK'S ScoreCard loyalty API (all data invented). In-memory; restart to
 * reset. Earn: 1 pt per $1 times the tier multiplier; every 300 points issues a
 * $10 reward certificate that expires after 60 days. Redeem is a single step.
 */
const POINTS_PER_CERTIFICATE = 300;
const CERTIFICATE_VALUE = 10;
const CERTIFICATE_DAYS = 60;
const TIER_MULTIPLIER = { standard: 1, gold: 1.5, platinum: 2 };

function createScoreCardStore(members = seed, { now = () => new Date() } = {}) {
  const byId = new Map(members.map((m) => [m.sc_member_id, clone(m)]));
  const transactions = new Map([...byId.keys()].map((id) => [id, []]));

  function expireCertificates(m) {
    const today = now().toISOString().slice(0, 10);
    m.reward_certificates.forEach((c) => {
      if (c.status === 'active' && c.expires_on < today) c.status = 'expired';
    });
    return m;
  }

  // An order_id can earn once and redeem once per member; a retry replays the original result.
  function replay(m, type, orderId) {
    const prior = transactions.get(m.sc_member_id).find((t) => t.type === type && t.order_id === orderId);
    return prior && { ...prior.result, member: clone(expireCertificates(m)), replayed: true };
  }

  function record(id, entry) {
    const row = { transaction_id: `txn_${crypto.randomBytes(6).toString('hex')}`, sc_member_id: id, created_at: now().toISOString(), ...entry };
    transactions.get(id).push(row);
    return row;
  }

  return {
    getMember(id) {
      const m = byId.get(Number(id));
      return m ? clone(expireCertificates(m)) : null;
    },

    // Exact match on the stored values: no case or phone-format normalization.
    findMembers({ email, phone }) {
      return [...byId.values()]
        .filter((m) => (email && m.email === email) || (phone && m.phone === phone))
        .map((m) => clone(expireCertificates(m)));
    },

    listTransactions(id) {
      const rows = transactions.get(Number(id));
      return rows ? rows.map(({ result: _result, ...row }) => row) : null;
    },

    earn(id, { amount, order_id }) {
      const m = byId.get(Number(id));
      const prior = replay(m, 'earn', order_id);
      if (prior) return prior;
      const points = Math.floor(amount * TIER_MULTIPLIER[m.tier]);
      m.points_balance += points;
      const issued = [];
      while (m.points_balance >= POINTS_PER_CERTIFICATE) {
        m.points_balance -= POINTS_PER_CERTIFICATE;
        const issuedOn = now();
        const expires = new Date(issuedOn.getTime() + CERTIFICATE_DAYS * 86400000);
        const cert = {
          certificate_id: `RC-${crypto.randomInt(100000, 999999)}`,
          amount: CERTIFICATE_VALUE,
          issued_on: issuedOn.toISOString().slice(0, 10),
          expires_on: expires.toISOString().slice(0, 10),
          status: 'active',
        };
        m.reward_certificates.push(cert);
        issued.push(cert);
      }
      const txn = record(m.sc_member_id, { type: 'earn', points, order_id, description: `Earned on order ${order_id}` });
      const result = { transaction: { ...txn }, certificates_issued: issued };
      txn.result = result;
      return { ...result, member: clone(expireCertificates(m)) };
    },

    redeem(id, { points, order_id }) {
      const m = byId.get(Number(id));
      const prior = replay(m, 'redeem', order_id);
      if (prior) return prior;
      if (points > m.points_balance) return { error: 'insufficient_points', available: m.points_balance };
      m.points_balance -= points;
      const txn = record(m.sc_member_id, { type: 'redeem', points: -points, order_id, description: `Redeemed on order ${order_id}` });
      const result = { transaction: { ...txn } };
      txn.result = result;
      return { ...result, member: clone(expireCertificates(m)) };
    },
  };
}

module.exports = { createScoreCardStore, POINTS_PER_CERTIFICATE, CERTIFICATE_VALUE, CERTIFICATE_DAYS, TIER_MULTIPLIER };
