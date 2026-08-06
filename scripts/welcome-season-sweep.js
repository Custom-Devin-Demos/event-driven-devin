#!/usr/bin/env node
/**
 * Welcome-season pre-flight sweep.
 *
 * Validates the pharmacy routing fields on every plan configuration that becomes
 * effective on January 1 before member ID cards are printed and mailed, then submits
 * a synthetic claim against each configuration to confirm it adjudicates end to end.
 *
 * Intended to run as a scheduled job each October through December. Exits non-zero
 * when any plan would produce cards that reject at the pharmacy counter.
 *
 * Usage: node scripts/welcome-season-sweep.js [--plan-year 2026]
 */

const { PAYER_REGISTRY, PLAN_CONFIGS } = require('../app/services/verticals/payer');

const BIN_LENGTH = 6;
const PCN_PATTERN = /^[A-Z0-9]{1,10}$/;
const GROUP_PATTERN = /^[A-Z0-9]{1,15}$/;


/**
 * Validate the pharmacy routing fields a plan will print onto member ID cards.
 */
function validateRxRouting(config) {
  const errors = [];

  if (!config.rxBin) {
    errors.push('RxBIN is missing');
  } else if (!/^\d+$/.test(config.rxBin)) {
    errors.push(`RxBIN "${config.rxBin}" is not numeric`);
  } else if (config.rxBin.length !== BIN_LENGTH) {
    errors.push(`RxBIN "${config.rxBin}" is ${config.rxBin.length} digits — BINs are ${BIN_LENGTH} digits`);
  } else if (!PAYER_REGISTRY[config.rxBin]) {
    errors.push(`RxBIN "${config.rxBin}" is not a registered processor BIN`);
  }

  const pcnWellFormed = Boolean(config.rxPcn) && PCN_PATTERN.test(config.rxPcn);
  if (!pcnWellFormed) {
    errors.push(`RxPCN "${config.rxPcn}" is not a valid processor control number`);
  }

  if (!config.rxGroup || !GROUP_PATTERN.test(config.rxGroup)) {
    errors.push(`RxGRP "${config.rxGroup}" is not a valid group identifier`);
  }

  const processor = PAYER_REGISTRY[config.rxBin];
  if (processor && pcnWellFormed && !processor.supportsPcn.includes(config.rxPcn)) {
    errors.push(`RxPCN "${config.rxPcn}" is not accepted by ${processor.name} on BIN ${config.rxBin}`);
  }

  return errors;
}

/**
 * Submit a synthetic claim against a plan configuration, exercising the same
 * routing lookup the live adjudicator performs.
 */
function submitSyntheticClaim(config) {
  const processor = PAYER_REGISTRY[config.rxBin];
  if (!processor) {
    return { paid: false, reason: `no route for BIN ${config.rxBin} — claim would reject 06 at the counter` };
  }
  if (!processor.supportsPcn.includes(config.rxPcn)) {
    return { paid: false, reason: `${processor.name} does not accept PCN ${config.rxPcn} on BIN ${config.rxBin}` };
  }
  return { paid: true, routedTo: processor.name };
}

/**
 * Plans that take effect on January 1 of the given plan year.
 */
function welcomeSeasonPlans(year) {
  return Object.entries(PLAN_CONFIGS).filter(
    ([, config]) => config.planYear === year && config.effectiveDate === `${year}-01-01`,
  );
}

function sweep(year) {
  const plans = welcomeSeasonPlans(year);
  const failures = [];
  let membersAtRisk = 0;

  process.stdout.write(`\nWelcome-season sweep — plan year ${year}\n`);
  process.stdout.write(`${plans.length} plan configuration(s) effective ${year}-01-01\n\n`);

  for (const [planId, config] of plans) {
    const errors = validateRxRouting(config);
    const claim = submitSyntheticClaim(config);
    const ok = errors.length === 0 && claim.paid;

    process.stdout.write(`${ok ? 'PASS' : 'FAIL'}  ${planId.padEnd(15)} ${config.planName}\n`);
    process.stdout.write(`      BIN ${config.rxBin} / PCN ${config.rxPcn} / GRP ${config.rxGroup}`);
    process.stdout.write(`  ·  cards mail ${config.cardsMailedOn}  ·  ${config.memberCount.toLocaleString()} members\n`);

    for (const err of errors) {
      process.stdout.write(`      → ${err}\n`);
    }
    if (!claim.paid) {
      process.stdout.write(`      → synthetic claim not paid: ${claim.reason}\n`);
    }
    if (ok) {
      process.stdout.write(`      → synthetic claim paid, routed to ${claim.routedTo}\n`);
    }
    process.stdout.write('\n');

    if (!ok) {
      failures.push({ planId, config, errors });
      membersAtRisk += config.memberCount;
    }
  }

  if (plans.length === 0) {
    process.stdout.write(`No plan configurations are effective ${year}-01-01 — nothing was validated.\n\n`);
    return 1;
  }

  if (failures.length === 0) {
    process.stdout.write(`All ${plans.length} plan(s) validated. Cards are safe to print.\n\n`);
    return 0;
  }

  process.stdout.write(`${failures.length} of ${plans.length} plan(s) would produce cards that reject at the pharmacy counter.\n`);
  process.stdout.write(`${membersAtRisk.toLocaleString()} members affected if these cards mail as configured:\n`);
  for (const f of failures) {
    process.stdout.write(`  · ${f.planId} — ${f.config.planName} (${f.config.memberCount.toLocaleString()} members)\n`);
  }
  process.stdout.write('\nBlock the print run and correct the plan configuration before cards mail.\n\n');
  return 1;
}

if (require.main === module) {
  const args = process.argv.slice(2);
  const inlineArg = args.find((a) => a.startsWith('--plan-year='));
  const planYearArg = args.indexOf('--plan-year');
  let rawYear = '2026';
  if (inlineArg) {
    rawYear = inlineArg.slice('--plan-year='.length);
  } else if (planYearArg !== -1) {
    rawYear = args[planYearArg + 1];
  }
  if (!/^\d{4}$/.test(String(rawYear))) {
    process.stderr.write('--plan-year requires a four-digit year, e.g. --plan-year 2026\n');
    process.exitCode = 2;
  } else {
    process.exitCode = sweep(Number(rawYear));
  }
}

module.exports = { validateRxRouting, submitSyntheticClaim, welcomeSeasonPlans, sweep, BIN_LENGTH };
