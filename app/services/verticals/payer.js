const { randomUUID } = require('crypto');
const logger = require('../../telemetry/logger');
const { incrementMetric, recordTiming } = require('../../telemetry/datadog');
const { Sentry } = require('../../telemetry/sentry');
const { createSessionAndAlert } = require('../devin-session');

/**
 * Pharmacy processor registry, keyed by RxBIN.
 *
 * BINs are ANSI-assigned six-digit Issuer Identification Numbers. A claim can only
 * be routed to a processor whose BIN appears here.
 */
const PAYER_REGISTRY = {
  '004336': { name: 'CVS Caremark', network: 'Caremark Commercial', supportsPcn: ['ADV', 'ASPROD1', 'MCAIDADV'] },
  '610591': { name: 'Aetna Pharmacy Management', network: 'Aetna Commercial', supportsPcn: ['ADV', 'RXCOMM'] },
  '610502': { name: 'Aetna Medicare Part D', network: 'Aetna Medicare', supportsPcn: ['MEDDADV'] },
};

/**
 * Plan configurations loaded for the 2026 plan year. These drive member ID card
 * printing during welcome season (cards mail in November, become effective Jan 1).
 */
const PLAN_CONFIGS = {
  'NCSHP-7030': {
    planName: 'NC State Health Plan 70/30',
    planYear: 2026,
    effectiveDate: '2026-01-01',
    cardsMailedOn: '2025-11-14',
    rxBin: '0044336',
    rxPcn: 'ADV',
    rxGroup: 'RX8834',
    memberCount: 187400,
  },
  'NCSHP-8020': {
    planName: 'NC State Health Plan 80/20',
    planYear: 2026,
    effectiveDate: '2026-01-01',
    cardsMailedOn: '2025-11-14',
    rxBin: '0044336',
    rxPcn: 'ADV',
    rxGroup: 'RX8835',
    memberCount: 112600,
  },
  'COMM-PPO-2026': {
    planName: 'Aetna Choice POS II',
    planYear: 2026,
    effectiveDate: '2026-01-01',
    cardsMailedOn: '2025-11-14',
    rxBin: '610591',
    rxPcn: 'ADV',
    rxGroup: 'RX2041',
    memberCount: 421900,
  },
  'MED-ADV-2026': {
    planName: 'Aetna Medicare Advantage PPO',
    planYear: 2026,
    effectiveDate: '2026-01-01',
    cardsMailedOn: '2025-10-28',
    rxBin: '610502',
    rxPcn: 'MEDDADV',
    rxGroup: 'MEDRX01',
    memberCount: 268300,
  },
};

/**
 * Members enrolled for the 2026 plan year.
 */
const MEMBERS = {
  'MEM-100234': { name: 'Sandra Whitfield', planId: 'NCSHP-7030', memberSince: '2019-01-01', dependents: 2, pcp: 'Dr. Alicia Barnes' },
  'MEM-100891': { name: 'Marcus Ellison', planId: 'NCSHP-8020', memberSince: '2023-01-01', dependents: 0, pcp: 'Dr. Priya Raman' },
  'MEM-200145': { name: 'Dana Okafor', planId: 'COMM-PPO-2026', memberSince: '2021-06-01', dependents: 1, pcp: 'Dr. Henry Vaughn' },
};

/**
 * Maintenance medications used for the pharmacy counter demo.
 */
const FORMULARY = [
  { ndc: '00093-7267-56', name: 'Levothyroxine 75mcg', daysSupply: 30, copay: 10, cashPrice: 42.18 },
  { ndc: '00378-1805-93', name: 'Metformin ER 500mg', daysSupply: 90, copay: 15, cashPrice: 63.40 },
  { ndc: '00071-0155-23', name: 'Atorvastatin 20mg', daysSupply: 30, copay: 10, cashPrice: 38.75 },
  { ndc: '00186-0740-28', name: 'Escitalopram 10mg', daysSupply: 30, copay: 25, cashPrice: 51.90 },
];

/**
 * Daily pharmacy claim rejection rate for the NC State Health Plan population,
 * spanning the last two weeks of the 2025 plan year and the first two weeks of 2026.
 */
const REJECTION_SERIES = [
  { date: '2025-12-18', rejectionRate: 1.8, claims: 8420 },
  { date: '2025-12-19', rejectionRate: 2.1, claims: 9110 },
  { date: '2025-12-22', rejectionRate: 1.9, claims: 10240 },
  { date: '2025-12-23', rejectionRate: 2.4, claims: 11890 },
  { date: '2025-12-26', rejectionRate: 1.7, claims: 6330 },
  { date: '2025-12-29', rejectionRate: 2.0, claims: 9870 },
  { date: '2025-12-30', rejectionRate: 2.2, claims: 12450 },
  { date: '2025-12-31', rejectionRate: 2.3, claims: 14380 },
  { date: '2026-01-01', rejectionRate: 96.4, claims: 3210 },
  { date: '2026-01-02', rejectionRate: 94.8, claims: 15920 },
  { date: '2026-01-05', rejectionRate: 95.1, claims: 21340 },
  { date: '2026-01-06', rejectionRate: 95.6, claims: 19870 },
  { date: '2026-01-07', rejectionRate: 94.9, claims: 18450 },
  { date: '2026-01-08', rejectionRate: 95.3, claims: 17980 },
];

/**
 * Investigation directives appended to the Devin prompt for this scenario.
 *
 * The remediation splits into four independent workstreams, so the triage session
 * fans them out to child sessions and reports back once they land.
 */
const FANOUT_DIRECTIVE = [
  '*Remediation plan — run these four workstreams in parallel as child sessions, then summarize:*',
  '',
  '1. *Card-generation fix* — `generateMemberIdCard()` in `app/services/verticals/payer.js` copies pharmacy routing fields onto member ID cards without validating them. Validate RxBIN/RxPCN/RxGRP against `PAYER_REGISTRY` before a card is issued, fail loudly on an unroutable BIN, and add regression tests covering the 7-digit BIN case. Open a PR.',
  '2. *Blast-radius sweep* — run `node scripts/welcome-season-sweep.js` and audit every plan configuration in `PLAN_CONFIGS`, not just the plan in this alert. Report every plan whose cards would reject at the counter and the total member count affected. Open a PR wiring the sweep into CI so an invalid BIN cannot ship again.',
  '3. *Adjudication bridge* — propose a temporary routing alias so claims presenting the invalid BIN adjudicate to the correct processor while corrected cards are reprinted, so members are not asked to pay cash at the counter. Include the rollback path and an expiry.',
  '4. *Member impact and comms* — produce the affected-member list by plan and group, a pharmacy help-desk script for the reject code, and a JIRA ticket capturing root cause, remediation, and the prevention control.',
  '',
  'Note for triage: every service is healthy and no infrastructure alert fired. The signal is a business metric — `pharmacy_claim.rejected` by `planId` — and the defect is in plan configuration data, not infrastructure.',
].join('\n');

/**
 * Print a member ID card for the plan year.
 *
 * Pharmacy routing fields are copied straight from the plan configuration onto the card.
 */
function generateMemberIdCard(memberId) {
  const member = MEMBERS[memberId];
  if (!member) return null;

  const plan = PLAN_CONFIGS[member.planId];
  if (!plan) return null;

  return {
    memberId,
    memberName: member.name,
    planId: member.planId,
    planName: plan.planName,
    planYear: plan.planYear,
    effectiveDate: plan.effectiveDate,
    cardsMailedOn: plan.cardsMailedOn,
    pcp: member.pcp,
    dependents: member.dependents,
    rxBin: plan.rxBin,
    rxPcn: plan.rxPcn,
    rxGroup: plan.rxGroup,
  };
}

/**
 * Adjudicate an NCPDP pharmacy claim submitted against a member ID card.
 */
async function adjudicateClaim(data) {
  const startTime = Date.now();
  const claimId = randomUUID();
  const card = generateMemberIdCard(data.memberId);

  logger.info('Adjudicating pharmacy claim', {
    claimId,
    memberId: data.memberId,
    ndc: data.ndc,
    rxBin: card ? card.rxBin : null,
    service: 'payer-api',
  });

  if (!card) {
    const notFound = new Error(`Member ${data.memberId} is not enrolled`);
    notFound.code = 'MEMBER_NOT_FOUND';
    throw notFound;
  }

  let routingLookupFailed = false;

  try {
    await new Promise((resolve) => setTimeout(resolve, 70 + Math.random() * 110));

    const drug = FORMULARY.find((f) => f.ndc === data.ndc) || FORMULARY[0];
    const processor = PAYER_REGISTRY[card.rxBin];

    routingLookupFailed = !processor;
    const routedTo = processor.name;
    const duration = Date.now() - startTime;

    incrementMetric('pharmacy_claim.paid', {
      route: '/api/payer/pharmacy-claim',
      planId: card.planId,
    });
    recordTiming('pharmacy_claim.latency', duration, {
      route: '/api/payer/pharmacy-claim',
    });

    return {
      success: true,
      claimId,
      memberId: data.memberId,
      memberName: card.memberName,
      drug: drug.name,
      daysSupply: drug.daysSupply,
      copay: drug.copay,
      routedTo,
      rxBin: card.rxBin,
      rxPcn: card.rxPcn,
      rxGroup: card.rxGroup,
      status: 'paid',
      adjudicatedAt: new Date().toISOString(),
    };
  } catch (error) {
    const duration = Date.now() - startTime;

    if (routingLookupFailed) {
      error.rejectCode = '06';
      error.rejectReason = 'M/I Group Number — RxBIN not found in processor registry';
      error.submittedBin = card.rxBin;
    }

    incrementMetric('pharmacy_claim.rejected', {
      route: '/api/payer/pharmacy-claim',
      errorClass: error.name,
      rejectCode: error.rejectCode || 'unknown',
    });
    recordTiming('pharmacy_claim.latency', duration, {
      route: '/api/payer/pharmacy-claim',
      error: 'true',
    });

    logger.error('Pharmacy claim adjudication failed', {
      claimId,
      error: error.message,
      errorClass: error.name,
      rejectCode: error.rejectCode,
      submittedBin: error.submittedBin,
      durationMs: duration,
      memberId: data.memberId,
    });

    Sentry.captureException(error, {
      tags: {
        route: '/api/payer/pharmacy-claim',
        service: 'payer-api',
        planId: card ? card.planId : 'unknown',
        rejectCode: error.rejectCode || 'unknown',
      },
      extra: { claimId, memberId: data.memberId, ndc: data.ndc, submittedBin: error.submittedBin },
    });

    createSessionAndAlert({
      issueTitle: `${error.name}: ${error.message}`,
      issueUrl: `https://${process.env.SENTRY_ORG_SLUG || 'sentry-org'}.sentry.io/issues/?project=${process.env.SENTRY_PROJECT_ID || ''}&query=is%3Aunresolved`,
      culprit: 'app/services/verticals/payer.js — adjudicateClaim',
      errorType: error.name || 'Error',
      errorValue: error.message,
      devinUserId: data.devinUserId,
      devinEmail: data.devinEmail,
      devinOrgId: data.devinOrgId,
      service: 'payer-api',
      verticalLabel: 'Pharmacy Claim Adjudication',
      promptAppendix: FANOUT_DIRECTIVE,
      tags: [
        { key: 'route', value: '/api/payer/pharmacy-claim' },
        { key: 'service', value: 'payer-api' },
        { key: 'planId', value: card ? card.planId : 'unknown' },
        { key: 'rejectCode', value: error.rejectCode || 'unknown' },
      ],
      extra: { claimId, memberId: data.memberId, ndc: data.ndc, submittedBin: error.submittedBin },
      level: 'error',
      platform: 'node',
      firstSeen: '',
      lastSeen: new Date().toISOString(),
      count: '',
      shortId: '',
      project: 'event-driven-devin',
      release: process.env.SENTRY_RELEASE || 'payer-portal@1.0.0',
      environment: process.env.DD_ENV || 'prod',
      triggeredRule: '',
    }).catch((err) => {
      logger.error('Failed to trigger Devin session from pharmacy claim error', { error: err.message });
    });

    throw error;
  }
}

module.exports = {
  adjudicateClaim,
  generateMemberIdCard,
  FANOUT_DIRECTIVE,
  PAYER_REGISTRY,
  PLAN_CONFIGS,
  MEMBERS,
  FORMULARY,
  REJECTION_SERIES,
};
