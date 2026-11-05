/**
 * Fee estimation and disclosure text for a new account application.
 */

const { FEE_SCHEDULES } = require('./549ee872-catalog');

/**
 * Offerings reference their fee schedule by key; resolve it to the schedule.
 */
function scheduleFor(offering) {
  const schedule = FEE_SCHEDULES[offering.feeSchedule];
  if (!schedule || !Array.isArray(schedule.tiers) || schedule.tiers.length === 0) {
    throw new Error(`Unknown fee schedule '${offering.feeSchedule}' for offering ${offering.code}`);
  }
  return schedule;
}

function tierFor(schedule, balance) {
  return schedule.tiers.find((tier) => balance <= tier.upTo);
}

function annualAdvisoryFee(balance, bps) {
  return Math.round(balance * (bps / 10000) * 100) / 100;
}

/**
 * First-year cost estimate for the applicant's expected balance.
 */
function estimateCosts(offering, funding) {
  const balance = Math.max(funding.initialDeposit, offering.minimumDeposit);
  const tier = tierFor(scheduleFor(offering), balance);
  return {
    expectedBalance: balance,
    accountFee: tier.accountFee,
    commissionPerTrade: tier.commissionPerTrade,
    advisoryBps: tier.advisoryBps,
    estimatedAnnualAdvisoryFee: annualAdvisoryFee(balance, tier.advisoryBps),
  };
}

/**
 * Disclosure lines shown on the application summary.
 */
function buildDisclosures(offering) {
  const { tiers } = scheduleFor(offering);
  const lines = [];
  if (tiers.every((t) => t.accountFee === 0)) lines.push('No account fees or minimums to open a retail account.');
  if (tiers.every((t) => t.commissionPerTrade === 0)) lines.push('$0 commission for online US stock, ETF, and option trades.');
  const advisory = tiers.filter((t) => t.advisoryBps > 0);
  if (advisory.length) {
    const low = Math.min(...advisory.map((t) => t.advisoryBps));
    const high = Math.max(...advisory.map((t) => t.advisoryBps));
    lines.push(`Gross advisory fee ${(low / 100).toFixed(2)}%–${(high / 100).toFixed(2)}% of assets, billed quarterly.`);
  }
  if (offering.minimumDeposit > 0) lines.push(`Minimum investment $${offering.minimumDeposit.toLocaleString('en-US')}.`);
  lines.push('Investing involves risk, including risk of loss.');
  return lines;
}

module.exports = { estimateCosts, buildDisclosures, scheduleFor, tierFor, annualAdvisoryFee };
