const { v4: uuidv4 } = require('uuid');
const logger = require('../../telemetry/logger');
const { incrementMetric, recordTiming } = require('../../telemetry/datadog');
const { Sentry } = require('../../telemetry/sentry');
const { createSessionAndAlert } = require('../devin-session');

const ROUTE = '/api/a1066f3a/capital-calls';
const SERVICE = 'vista-lp-capital-calls';
const SLACK_MEMBER_ID = process.env.VISTA_SLACK_MEMBER_ID || 'U08S7AVJ478';

/**
 * Limited partners on the investor portal.
 */
const LIMITED_PARTNERS = {
  'lp-04417': {
    name: "Meridian State Teachers' Retirement System",
    shortName: 'Meridian STRS',
    type: 'Public pension',
    domicile: 'Illinois, USA',
    relationshipManager: 'C. Alvarez',
    wireRef: 'MSTRS-VEP',
  },
};

/**
 * Fund vehicles the LP is committed to, with the capital call currently
 * pending on each.
 */
const FUND_VEHICLES = {
  'perennial-structured-capital': {
    name: 'Vista Perennial Structured Capital',
    strategy: 'Evergreen structured capital',
    vintage: 2026,
    fundSizeMm: 3200,
    lpCommitmentMm: 45,
    calledToDatePct: 0,
    callNumber: 1,
    callTotalMm: 480,
    noticeDueDays: 10,
    launched: '2026-Q2',
    evergreen: true,
  },
  'equity-partners-viii': {
    name: 'Vista Equity Partners Fund VIII',
    strategy: 'Large-cap enterprise software buyout',
    vintage: 2022,
    fundSizeMm: 20000,
    lpCommitmentMm: 150,
    calledToDatePct: 62,
    callNumber: 9,
    callTotalMm: 1400,
    noticeDueDays: 10,
    launched: '2022-Q1',
    evergreen: false,
  },
  'foundation-fund-v': {
    name: 'Vista Foundation Fund V',
    strategy: 'Middle-market enterprise software',
    vintage: 2023,
    fundSizeMm: 4800,
    lpCommitmentMm: 80,
    calledToDatePct: 44,
    callNumber: 6,
    callTotalMm: 360,
    noticeDueDays: 10,
    launched: '2023-Q3',
    evergreen: false,
  },
  'endeavor-fund-iv': {
    name: 'Vista Endeavor Fund IV',
    strategy: 'Emerging enterprise software',
    vintage: 2024,
    fundSizeMm: 1600,
    lpCommitmentMm: 35,
    calledToDatePct: 28,
    callNumber: 4,
    callTotalMm: 150,
    noticeDueDays: 12,
    launched: '2024-Q2',
    evergreen: false,
  },
  'credit-partners-fund-iii': {
    name: 'Vista Credit Partners Fund III',
    strategy: 'Software-focused private credit',
    vintage: 2021,
    fundSizeMm: 2300,
    lpCommitmentMm: 60,
    calledToDatePct: 81,
    callNumber: 14,
    callTotalMm: 190,
    noticeDueDays: 7,
    launched: '2021-Q4',
    evergreen: false,
  },
};

/**
 * Economic terms per fund vehicle, applied to every capital call notice
 * before it is issued to the limited partner.
 * BUG: Vista Perennial Structured Capital launched in 2026-Q2 and was added to
 * the fund registry (with commitments) but never received a terms row here, so
 * lookups for it resolve `undefined`.
 */
const FUND_TERMS = {
  'equity-partners-viii': {
    managementFeeRate: 0.015,
    feeBasis: 'Committed capital',
    preferredReturnRate: 0.08,
    carriedInterest: 0.2,
    gpCatchUpRate: 1.0,
    waterfall: 'European (whole-of-fund)',
    recyclingCapPct: 20,
  },
  'foundation-fund-v': {
    managementFeeRate: 0.0175,
    feeBasis: 'Invested capital',
    preferredReturnRate: 0.08,
    carriedInterest: 0.2,
    gpCatchUpRate: 1.0,
    waterfall: 'European (whole-of-fund)',
    recyclingCapPct: 15,
  },
  'endeavor-fund-iv': {
    managementFeeRate: 0.02,
    feeBasis: 'Committed capital',
    preferredReturnRate: 0.08,
    carriedInterest: 0.2,
    gpCatchUpRate: 1.0,
    waterfall: 'Deal-by-deal with clawback',
    recyclingCapPct: 25,
  },
  'credit-partners-fund-iii': {
    managementFeeRate: 0.0125,
    feeBasis: 'Invested capital',
    preferredReturnRate: 0.07,
    carriedInterest: 0.15,
    gpCatchUpRate: 0.8,
    waterfall: 'European (whole-of-fund)',
    recyclingCapPct: 10,
  },
};

const NOTICE_PURPOSES = {
  investment: { label: 'New portfolio investment' },
  follow_on: { label: 'Follow-on investment' },
  fees_expenses: { label: 'Management fees & partnership expenses' },
};

function resolveFund(fundId) {
  const fund = FUND_VEHICLES[fundId];
  if (!fund) {
    throw Object.assign(new Error(`Unknown fund vehicle: ${fundId}`), { code: 'INVALID_FUND' });
  }
  return fund;
}

function resolveLp(lpId) {
  const lp = LIMITED_PARTNERS[lpId];
  if (!lp) {
    throw Object.assign(new Error(`Unknown limited partner: ${lpId}`), { code: 'INVALID_LP' });
  }
  return lp;
}

function round2(n) {
  return Math.round(n * 100) / 100;
}

/**
 * Prices the notice: the LP's pro-rata share of the call, the quarterly
 * management fee, and the waterfall terms carried on the notice.
 * BUG: FUND_TERMS has no perennial-structured-capital row, so
 * `terms.managementFeeRate` crashes.
 */
function computeNoticeEconomics(fundId, fund, purpose) {
  const terms = FUND_TERMS[fundId];
  const managementFeeRate = terms.managementFeeRate;
  const proRataShare = fund.lpCommitmentMm / fund.fundSizeMm;
  const feeBase = terms.feeBasis === 'Invested capital'
    ? (fund.lpCommitmentMm * fund.calledToDatePct) / 100
    : fund.lpCommitmentMm;
  const managementFeeMm = (feeBase * managementFeeRate) / 4;
  const drawdownMm = fund.callTotalMm * proRataShare;
  const purposeSplit = purpose === 'fees_expenses' ? 0 : drawdownMm;
  const partnershipExpensesMm = drawdownMm * 0.004;

  return {
    proRataSharePct: round2(proRataShare * 100),
    drawdownMm: round2(purposeSplit),
    managementFeeMm: round2(managementFeeMm),
    partnershipExpensesMm: round2(partnershipExpensesMm),
    totalDueMm: round2(purposeSplit + managementFeeMm + partnershipExpensesMm),
    feeBasis: terms.feeBasis,
    managementFeeRatePct: round2(terms.managementFeeRate * 100),
    preferredReturnPct: round2(terms.preferredReturnRate * 100),
    carriedInterestPct: round2(terms.carriedInterest * 100),
    gpCatchUpPct: round2(terms.gpCatchUpRate * 100),
    waterfall: terms.waterfall,
    recyclingCapPct: terms.recyclingCapPct,
  };
}

function unfundedAfterCall(fund, drawdownMm) {
  const calledMm = (fund.lpCommitmentMm * fund.calledToDatePct) / 100;
  return {
    commitmentMm: fund.lpCommitmentMm,
    calledBeforeMm: round2(calledMm),
    calledAfterMm: round2(calledMm + drawdownMm),
    unfundedAfterMm: round2(fund.lpCommitmentMm - calledMm - drawdownMm),
    calledAfterPct: round2(((calledMm + drawdownMm) / fund.lpCommitmentMm) * 100),
  };
}

function dueDate(offsetDays) {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() + offsetDays);
  return d.toISOString().slice(0, 10);
}

function noticeId(fund, fundId) {
  const prefix = fundId.split('-').map((part) => part[0]).join('').toUpperCase();
  return `CN-${prefix}-${fund.vintage}-${String(fund.callNumber).padStart(3, '0')}`;
}

/**
 * Issues a capital call notice to a limited partner for one fund vehicle.
 */
async function issueCapitalCall(data) {
  const startTime = Date.now();
  const requestId = uuidv4();

  logger.info('Issuing Vista LP capital call notice', {
    requestId,
    fundId: data.fundId,
    lpId: data.lpId,
    purpose: data.purpose,
    service: SERVICE,
    route: ROUTE,
  });

  try {
    await new Promise((resolve) => setTimeout(resolve, 80 + Math.random() * 120));

    const fund = resolveFund(data.fundId);
    const lp = resolveLp(data.lpId);
    const economics = computeNoticeEconomics(data.fundId, fund, data.purpose);
    const position = unfundedAfterCall(fund, economics.drawdownMm);

    const duration = Date.now() - startTime;

    incrementMetric('capital_call.issue.success', {
      route: ROUTE,
      fundId: data.fundId,
      purpose: data.purpose,
      vintage: String(fund.vintage),
    });
    recordTiming('capital_call.issue.latency', duration, { route: ROUTE });

    return {
      success: true,
      requestId,
      noticeId: noticeId(fund, data.fundId),
      issuedBy: data.issuedBy,
      limitedPartner: {
        lpId: data.lpId,
        name: lp.name,
        type: lp.type,
        domicile: lp.domicile,
        relationshipManager: lp.relationshipManager,
      },
      fund: {
        fundId: data.fundId,
        name: fund.name,
        strategy: fund.strategy,
        vintage: fund.vintage,
        fundSizeMm: fund.fundSizeMm,
        callNumber: fund.callNumber,
        callTotalMm: fund.callTotalMm,
      },
      notice: {
        purpose: NOTICE_PURPOSES[data.purpose].label,
        noticeDate: new Date().toISOString().slice(0, 10),
        dueDate: dueDate(fund.noticeDueDays),
        noticeDays: fund.noticeDueDays,
        wireReference: `${lp.wireRef}-${noticeId(fund, data.fundId)}`,
      },
      economics,
      position,
      status: 'issued',
      nextStep: 'The notice is available in the LP portal and mails to the partnership contact list tonight.',
      processedAt: new Date().toISOString(),
    };
  } catch (error) {
    const duration = Date.now() - startTime;

    incrementMetric('capital_call.issue.failure', {
      route: ROUTE,
      errorClass: error.name,
      fundId: data.fundId,
      purpose: data.purpose,
    });
    recordTiming('capital_call.issue.latency', duration, { route: ROUTE, error: 'true' });

    logger.error('Vista LP capital call notice failed', {
      requestId,
      error: error.message,
      errorClass: error.name,
      durationMs: duration,
      fundId: data.fundId,
      lpId: data.lpId,
      purpose: data.purpose,
      service: SERVICE,
    });

    Sentry.captureException(error, {
      tags: { route: ROUTE, service: SERVICE, source: 'vista-lp-portal' },
      extra: {
        requestId,
        fundId: data.fundId,
        lpId: data.lpId,
        purpose: data.purpose,
      },
    });

    createSessionAndAlert({
      issueTitle: `${error.name}: ${error.message}`,
      issueUrl: `https://${process.env.SENTRY_ORG_SLUG || 'sentry-org'}.sentry.io/issues/?project=${process.env.SENTRY_PROJECT_ID || ''}&query=is%3Aunresolved`,
      culprit: 'app/services/verticals/a1066f3a.js \u2014 computeNoticeEconomics',
      errorType: error.name || 'Error',
      errorValue: error.message,
      customer: 'a1066f3a',
      devinUserId: data.devinUserId,
      devinEmail: data.devinEmail,
      devinOrgId: data.devinOrgId,
      slackMemberId: data.devinEmail ? '' : SLACK_MEMBER_ID,
      slackMemberIdFallback: SLACK_MEMBER_ID,
      service: SERVICE,
      verticalLabel: 'Vista Equity Partners \u2014 LP Capital Call Notices',
      tags: [
        { key: 'route', value: ROUTE },
        { key: 'service', value: SERVICE },
      ],
      extra: {
        requestId,
        fundId: data.fundId,
        lpId: data.lpId,
        purpose: data.purpose,
      },
      level: 'error',
      platform: 'node',
      firstSeen: '',
      lastSeen: new Date().toISOString(),
      count: '',
      shortId: '',
      project: 'event-driven-devin',
      release: process.env.SENTRY_RELEASE || `${SERVICE}@1.0.0`,
      environment: process.env.DD_ENV || 'prod',
      triggeredRule: '',
    }).catch((err) => {
      logger.error('Failed to trigger Devin session from Vista capital call error', { error: err.message });
    });

    throw error;
  }
}

module.exports = {
  issueCapitalCall,
  resolveFund,
  resolveLp,
  computeNoticeEconomics,
  LIMITED_PARTNERS,
  FUND_VEHICLES,
  FUND_TERMS,
  NOTICE_PURPOSES,
};
