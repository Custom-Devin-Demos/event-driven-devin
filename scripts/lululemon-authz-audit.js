#!/usr/bin/env node
/**
 * lululemon order-status authorization audit.
 *
 * Probes the real order-status path with every (order, non-owner session) pair
 * and fails when a session receives an order it does not own. This is the
 * control that should have caught the IDOR before it shipped; it is not wired
 * into CI, which is why the gap reached production.
 *
 * Usage: npm run audit:lululemon
 */
const {
  lookupOrder,
  MEMBER_SESSIONS,
  ORDER_LEDGER,
  PII_FIELDS,
} = require('../app/services/verticals/50b235c7');

async function probePair(sessionToken, order) {
  const session = MEMBER_SESSIONS[sessionToken];
  try {
    const result = await lookupOrder({ orderNumber: order.orderNumber, sessionToken, audit: true });
    const leakedFields = PII_FIELDS.filter((field) => result.order[field] !== undefined);
    return {
      orderNumber: order.orderNumber,
      ownerMemberId: order.memberId,
      viewerMemberId: session.memberId,
      leaked: true,
      leakedFields,
    };
  } catch (error) {
    if (error.code === 'NOT_AUTHORIZED' || error.statusCode === 403 || error.statusCode === 404) {
      return {
        orderNumber: order.orderNumber,
        ownerMemberId: order.memberId,
        viewerMemberId: session.memberId,
        leaked: false,
        leakedFields: [],
      };
    }
    throw error;
  }
}

async function runAudit() {
  const findings = [];
  for (const sessionToken of Object.keys(MEMBER_SESSIONS)) {
    const session = MEMBER_SESSIONS[sessionToken];
    for (const order of ORDER_LEDGER) {
      if (order.memberId === session.memberId) continue;
      const probe = await probePair(sessionToken, order);
      if (probe.leaked) findings.push(probe);
    }
  }
  return findings;
}

async function main() {
  const findings = await runAudit();

  if (findings.length === 0) {
    process.stdout.write('lululemon order-status authorization audit: no cross-account access\n');
    return;
  }

  process.stdout.write(`lululemon order-status authorization audit: ${findings.length} cross-account leak(s)\n`);
  for (const finding of findings) {
    process.stdout.write(
      `  ${finding.orderNumber} owned by ${finding.ownerMemberId} served to ${finding.viewerMemberId}`
      + ` — exposed: ${finding.leakedFields.join(', ')}\n`,
    );
  }
  process.exitCode = 1;
}

if (require.main === module) {
  main().catch((error) => {
    process.stderr.write(`lululemon order-status authorization audit failed: ${error.message}\n`);
    process.exitCode = 1;
  });
}

module.exports = { runAudit, probePair };
