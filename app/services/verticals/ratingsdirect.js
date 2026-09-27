const { v4: uuidv4 } = require('uuid');
const logger = require('../../telemetry/logger');
const { incrementMetric, recordTiming } = require('../../telemetry/datadog');
const { Sentry } = require('../../telemetry/sentry');
const { createSessionAndAlert } = require('../devin-session');

const ISSUERS = {
  'SPG-ISS-4471028': {
    issuerId: 'SPG-ISS-4471028',
    issuerName: 'Thornbury Utilities Holdings plc',
    sector: 'Utilities',
    subIndustry: 'regulated_water_utilities',
    subIndustryLabel: 'Regulated Water Utilities',
    domicile: 'United Kingdom',
    currentRating: 'BBB+',
    outlook: 'Stable',
    ratingType: 'Issuer Credit Rating — Foreign Currency LT',
    lastReviewDate: '2026-03-12',
    leadAnalyst: 'D. Marchetti',
    committeeDate: '2026-10-02',
    revenueUsdMn: 2140.5,
  },
  'SPG-ISS-8820416': {
    issuerId: 'SPG-ISS-8820416',
    issuerName: 'Calderon Midstream Partners LP',
    sector: 'Energy',
    subIndustry: 'midstream_energy',
    subIndustryLabel: 'Midstream Energy',
    domicile: 'United States',
    currentRating: 'BB',
    outlook: 'Positive',
    ratingType: 'Issuer Credit Rating — Local Currency LT',
    lastReviewDate: '2026-05-28',
    leadAnalyst: 'R. Okonkwo',
    committeeDate: '2026-10-09',
    revenueUsdMn: 4380.2,
  },
  'SPG-ISS-2298734': {
    issuerId: 'SPG-ISS-2298734',
    issuerName: 'Verrano Specialty Chemicals AG',
    sector: 'Materials',
    subIndustry: 'commodity_chemicals',
    subIndustryLabel: 'Commodity Chemicals',
    domicile: 'Germany',
    currentRating: 'BBB-',
    outlook: 'Negative',
    ratingType: 'Issuer Credit Rating — Foreign Currency LT',
    lastReviewDate: '2026-01-30',
    leadAnalyst: 'S. Lindqvist',
    committeeDate: '2026-10-16',
    revenueUsdMn: 1875.9,
  },
};

const CORPORATE_ANCHOR_MATRIX = {
  excellent: {
    minimal: 'aa',
    modest: 'aa-',
    intermediate: 'a+',
    significant: 'a-',
    aggressive: 'bbb',
    highly_leveraged: 'bbb-',
  },
  strong: {
    minimal: 'aa-',
    modest: 'a+',
    intermediate: 'a-',
    significant: 'bbb',
    aggressive: 'bb+',
    highly_leveraged: 'bb',
  },
  satisfactory: {
    minimal: 'a-',
    modest: 'bbb+',
    intermediate: 'bbb',
    significant: 'bb+',
    aggressive: 'bb-',
    highly_leveraged: 'b+',
  },
  fair: {
    minimal: 'bbb',
    modest: 'bbb-',
    intermediate: 'bb+',
    significant: 'bb',
    aggressive: 'bb-',
    highly_leveraged: 'b',
  },
  weak: {
    minimal: 'bb+',
    modest: 'bb',
    intermediate: 'bb-',
    significant: 'bb-',
    aggressive: 'b+',
    highly_leveraged: 'b-',
  },
  vulnerable: {
    minimal: 'bb-',
    modest: 'b+',
    intermediate: 'b+',
    significant: 'b',
    aggressive: 'b-',
    highly_leveraged: 'b-',
  },
};

const SECTOR_SCORECARDS = {
  // regulated_water_utilities migrated to the 2026 Corporate Methodology scorecard
  // registry; registration pending
  midstream_energy: {
    label: 'Midstream Energy',
    criteriaReference: 'Corporate Methodology (2026) — Midstream Energy',
    scorecardVersion: '2026.1',
    anchorMatrix: CORPORATE_ANCHOR_MATRIX,
    countryRiskWeight: 0.4,
    industryRiskWeight: 0.6,
    liquidityFloors: {
      exceptional: 0,
      strong: 0,
      adequate: 0,
      less_than_adequate: -1,
      weak: -2,
    },
    comparableRatingsRange: [-1, 1],
    minimumFfoToDebtPercent: 13,
    maxDebtToEbitda: 5.5,
    minimumEbitdaInterestCoverage: 2.5,
    committeeQuorum: 5,
  },
  commodity_chemicals: {
    label: 'Commodity Chemicals',
    criteriaReference: 'Corporate Methodology (2026) — Commodity Chemicals',
    scorecardVersion: '2026.1',
    anchorMatrix: CORPORATE_ANCHOR_MATRIX,
    countryRiskWeight: 0.5,
    industryRiskWeight: 0.5,
    liquidityFloors: {
      exceptional: 0,
      strong: 0,
      adequate: 0,
      less_than_adequate: -1,
      weak: -2,
    },
    comparableRatingsRange: [-1, 1],
    minimumFfoToDebtPercent: 20,
    maxDebtToEbitda: 4,
    minimumEbitdaInterestCoverage: 3,
    committeeQuorum: 5,
  },
};

const RATING_SCALE = [
  'aaa',
  'aa+',
  'aa',
  'aa-',
  'a+',
  'a',
  'a-',
  'bbb+',
  'bbb',
  'bbb-',
  'bb+',
  'bb',
  'bb-',
  'b+',
  'b',
  'b-',
  'ccc+',
];
const BUSINESS_RISK_PROFILES = ['excellent', 'strong', 'satisfactory', 'fair', 'weak', 'vulnerable'];
const FINANCIAL_RISK_PROFILES = [
  'minimal',
  'modest',
  'intermediate',
  'significant',
  'aggressive',
  'highly_leveraged',
];
const LIQUIDITY_ASSESSMENTS = ['exceptional', 'strong', 'adequate', 'less_than_adequate', 'weak'];
const SENTRY_ISSUE_QUERY = 'is:unresolved anchorMatrix';
const RATINGSDIRECT_SLACK_MEMBER_ID = process.env.RATINGSDIRECT_SLACK_MEMBER_ID || '';

const REMEDIATION_DIRECTIVE = `Repository: COG-GTM/event-driven-devin. Scope: only the S&P Global RatingsDirect issuer credit scorecard failure below. This repository hosts many independent customer demos, each with its own intentional defect and its own Sentry issues. Investigate only POST /api/ratingsdirect/scorecard and do not modify any other vertical. Explicitly exclude Westpac, NRMA, CFS, QBE, HCF, Suncorp, Insignia, HUB24, Morgan Stanley, the existing S&P Global MI feed-migration vertical da6578ee (alias /spglobal), and every unrelated vertical. The failing surface is app/public/verticals/ratingsdirect.html at GET /ratingsdirect; its "Generate scorecard" action posts to POST /api/ratingsdirect/scorecard in app/routes/verticals/ratingsdirect.js. The scorecard pipeline is generateScorecard -> calculateAnchorScore -> resolveSectorScorecard in app/services/verticals/ratingsdirect.js. Start at resolveSectorScorecard: it looks up SECTOR_SCORECARDS by the issuer's sub-industry, and regulated_water_utilities is intentionally absent because it migrated to the 2026 Corporate Methodology scorecard registry, so the lookup returns undefined and calculateAnchorScore dereferences anchorMatrix. Fix this by registering the missing regulated_water_utilities scorecard entry with its anchor matrix and sector thresholds; do not patch around the crash or modify any other vertical. Verify with node app/server.js, curl against POST /api/ratingsdirect/scorecard, and npm run lint. Visual Fix Verification is mandatory: open the S&P Global RatingsDirect page in a real browser, generate a scorecard after the fix, and capture evidence showing the form, Generate scorecard action, and returned indicative rating.`;

function resolveSectorScorecard(issuer) {
  return SECTOR_SCORECARDS[issuer.subIndustry];
}

function roundScore(value) {
  return Math.round(value * 10) / 10;
}

function validationError(message) {
  const error = new Error(message);
  error.name = 'ValidationError';
  error.code = 'INVALID_SCORECARD_REQUEST';
  error.statusCode = 400;
  return error;
}

function makeScorecardReference() {
  const digits = uuidv4().replace(/\D/g, '').slice(0, 10).padEnd(10, '0');
  return `SPG-SCD-${digits}`;
}

function makePackageNumber() {
  const digits = uuidv4().replace(/\D/g, '').slice(0, 8).padEnd(8, '0');
  return `SPG-PKG-${digits}`;
}

function calculateAnchorScore(issuer, inputs) {
  const scorecard = resolveSectorScorecard(issuer);
  const anchorMatrix = scorecard.anchorMatrix;
  const anchor = anchorMatrix[inputs.businessRiskProfile][inputs.financialRiskProfile];
  const countryRiskScore = inputs.countryRiskScore;
  const industryRiskScore = inputs.industryRiskScore;
  const cicraScore = roundScore(
    countryRiskScore * scorecard.countryRiskWeight
      + industryRiskScore * scorecard.industryRiskWeight,
  );
  const liquidityNotches = scorecard.liquidityFloors[inputs.liquidityAssessment];
  const comparableRatingsAdjustment = Math.min(
    Math.max(inputs.comparableRatingsAdjustment, scorecard.comparableRatingsRange[0]),
    scorecard.comparableRatingsRange[1],
  );
  const notchesApplied = liquidityNotches + comparableRatingsAdjustment;
  const anchorIndex = RATING_SCALE.indexOf(anchor);
  const indicativeIndex = Math.min(
    Math.max(anchorIndex - notchesApplied, 0),
    RATING_SCALE.length - 1,
  );
  const indicativeRating = RATING_SCALE[indicativeIndex].toUpperCase();

  return {
    anchor,
    indicativeRating,
    cicraScore,
    liquidityNotches,
    comparableRatingsAdjustment,
    notchesApplied,
    meetsFfoThreshold: inputs.ffoToDebtPercent >= scorecard.minimumFfoToDebtPercent,
    withinLeverageTolerance: inputs.debtToEbitda <= scorecard.maxDebtToEbitda,
    meetsCoverageThreshold: inputs.ebitdaInterestCoverage >= scorecard.minimumEbitdaInterestCoverage,
    criteriaReference: scorecard.criteriaReference,
    scorecardVersion: scorecard.scorecardVersion,
    committeeQuorum: scorecard.committeeQuorum,
    label: scorecard.label,
  };
}

async function generateScorecard(data) {
  const startTime = Date.now();
  const scorecardReference = makeScorecardReference();
  const packageNumber = makePackageNumber();
  const issuerId = data.issuerId;
  const issuer = ISSUERS[issuerId];
  const businessRiskProfile = data.businessRiskProfile;
  const financialRiskProfile = data.financialRiskProfile;
  const countryRiskScore = data.countryRiskScore;
  const industryRiskScore = data.industryRiskScore;
  const ffoToDebtPercent = data.ffoToDebtPercent;
  const debtToEbitda = data.debtToEbitda;
  const ebitdaInterestCoverage = data.ebitdaInterestCoverage;
  const liquidityAssessment = data.liquidityAssessment;
  const comparableRatingsAdjustment = data.comparableRatingsAdjustment;
  const analystNotes = data.analystNotes;
  const criteriaConfirmed = data.criteriaConfirmed;

  if (!issuerId || !String(issuerId).trim() || !issuer) {
    throw validationError(`Unknown issuer ID: ${issuerId || '(none)'}`);
  }
  if (!BUSINESS_RISK_PROFILES.includes(businessRiskProfile)) {
    throw validationError('Business risk profile is invalid');
  }
  if (!FINANCIAL_RISK_PROFILES.includes(financialRiskProfile)) {
    throw validationError('Financial risk profile is invalid');
  }
  if (!LIQUIDITY_ASSESSMENTS.includes(liquidityAssessment)) {
    throw validationError('Liquidity assessment is invalid');
  }
  if (!Number.isInteger(countryRiskScore) || countryRiskScore < 1 || countryRiskScore > 6) {
    throw validationError('Country risk score must be an integer from 1 to 6');
  }
  if (!Number.isInteger(industryRiskScore) || industryRiskScore < 1 || industryRiskScore > 6) {
    throw validationError('Industry risk score must be an integer from 1 to 6');
  }
  if (!Number.isFinite(ffoToDebtPercent) || ffoToDebtPercent <= 0) {
    throw validationError('FFO to debt must be a positive number');
  }
  if (!Number.isFinite(debtToEbitda) || debtToEbitda < 0) {
    throw validationError('Debt to EBITDA must be zero or greater');
  }
  if (!Number.isFinite(ebitdaInterestCoverage) || ebitdaInterestCoverage <= 0) {
    throw validationError('EBITDA interest coverage must be a positive number');
  }
  if (![-1, 0, 1].includes(comparableRatingsAdjustment)) {
    throw validationError('Comparable ratings adjustment must be -1, 0 or 1');
  }
  if (typeof analystNotes !== 'string' || !analystNotes.trim()) {
    throw validationError('Analyst notes are required');
  }
  if (criteriaConfirmed !== true) {
    throw validationError('Criteria confirmation is required before generating a scorecard');
  }

  logger.info('Generating S&P Global issuer credit scorecard', {
    scorecardReference,
    packageNumber,
    issuerId,
    issuerName: issuer.issuerName,
    sector: issuer.sector,
    subIndustry: issuer.subIndustry,
    businessRiskProfile,
    financialRiskProfile,
    countryRiskScore,
    industryRiskScore,
    ffoToDebtPercent,
    debtToEbitda,
    ebitdaInterestCoverage,
    liquidityAssessment,
    comparableRatingsAdjustment,
    analystNotes,
    channel: data.channel,
    service: 'customer-spg-ratingsdirect',
    route: '/api/ratingsdirect/scorecard',
  });

  try {
    const outcome = calculateAnchorScore(issuer, {
      businessRiskProfile,
      financialRiskProfile,
      countryRiskScore,
      industryRiskScore,
      ffoToDebtPercent,
      debtToEbitda,
      ebitdaInterestCoverage,
      liquidityAssessment,
      comparableRatingsAdjustment,
    });
    const generatedAt = new Date().toISOString();
    const duration = Date.now() - startTime;

    incrementMetric('ratingsdirect_scorecard.success', {
      route: '/api/ratingsdirect/scorecard',
      subIndustry: issuer.subIndustry,
      sector: issuer.sector,
    });
    recordTiming('ratingsdirect_scorecard.latency', duration, {
      route: '/api/ratingsdirect/scorecard',
    });

    return {
      success: true,
      status: 'generated',
      scorecardReference,
      packageNumber,
      ...issuer,
      businessRiskProfile,
      financialRiskProfile,
      countryRiskScore,
      industryRiskScore,
      ffoToDebtPercent,
      debtToEbitda,
      ebitdaInterestCoverage,
      liquidityAssessment,
      comparableRatingsAdjustment,
      analystNotes,
      criteriaConfirmed,
      ...outcome,
      committeeDate: issuer.committeeDate,
      generatedAt,
    };
  } catch (error) {
    const duration = Date.now() - startTime;

    if (error.name === 'ValidationError') {
      incrementMetric('ratingsdirect_scorecard.failure', {
        route: '/api/ratingsdirect/scorecard',
        errorClass: error.name,
        subIndustry: issuer.subIndustry,
        sector: issuer.sector,
      });
      recordTiming('ratingsdirect_scorecard.latency', duration, {
        route: '/api/ratingsdirect/scorecard',
        error: 'true',
      });
      throw error;
    }

    incrementMetric('ratingsdirect_scorecard.failure', {
      route: '/api/ratingsdirect/scorecard',
      errorClass: error.name,
      subIndustry: issuer.subIndustry,
      sector: issuer.sector,
    });
    recordTiming('ratingsdirect_scorecard.latency', duration, {
      route: '/api/ratingsdirect/scorecard',
      error: 'true',
    });

    logger.error('S&P Global issuer credit scorecard failed', {
      scorecardReference,
      packageNumber,
      issuerId,
      issuerName: issuer.issuerName,
      sector: issuer.sector,
      subIndustry: issuer.subIndustry,
      currentRating: issuer.currentRating,
      outlook: issuer.outlook,
      businessRiskProfile,
      financialRiskProfile,
      countryRiskScore,
      industryRiskScore,
      ffoToDebtPercent,
      debtToEbitda,
      ebitdaInterestCoverage,
      liquidityAssessment,
      comparableRatingsAdjustment,
      analystNotes,
      channel: data.channel,
      error: error.message,
      errorClass: error.name,
      durationMs: duration,
      service: 'customer-spg-ratingsdirect',
      route: '/api/ratingsdirect/scorecard',
    });

    Sentry.captureException(error, {
      tags: {
        route: '/api/ratingsdirect/scorecard',
        service: 'customer-spg-ratingsdirect',
        subIndustry: issuer.subIndustry,
        sector: issuer.sector,
        issuerId,
      },
      extra: {
        scorecardReference,
        packageNumber,
        issuerId,
        issuerName: issuer.issuerName,
        sector: issuer.sector,
        subIndustry: issuer.subIndustry,
        currentRating: issuer.currentRating,
        outlook: issuer.outlook,
        businessRiskProfile,
        financialRiskProfile,
        countryRiskScore,
        industryRiskScore,
        ffoToDebtPercent,
        debtToEbitda,
        ebitdaInterestCoverage,
        liquidityAssessment,
        comparableRatingsAdjustment,
        channel: data.channel,
      },
    });

    createSessionAndAlert({
      issueTitle: `${error.name}: ${error.message}`,
      issueUrl: `https://${process.env.SENTRY_ORG_SLUG || 'sentry-org'}.sentry.io/issues/?project=${process.env.SENTRY_PROJECT_ID || ''}&query=${encodeURIComponent(SENTRY_ISSUE_QUERY)}`,
      culprit: 'app/services/verticals/ratingsdirect.js — calculateAnchorScore',
      errorType: error.name || 'Error',
      errorValue: error.message,
      service: 'customer-spg-ratingsdirect',
      verticalLabel: 'S&P Global RatingsDirect — Issuer Credit Scorecard',
      customer: 'ratingsdirect',
      slackMemberId: data.devinEmail ? '' : RATINGSDIRECT_SLACK_MEMBER_ID,
      slackMemberIdFallback: RATINGSDIRECT_SLACK_MEMBER_ID,
      devinUserId: data.devinUserId,
      devinEmail: data.devinEmail,
      devinOrgId: data.devinOrgId,
      promptAppendix: REMEDIATION_DIRECTIVE,
      tags: [
        { key: 'route', value: '/api/ratingsdirect/scorecard' },
        { key: 'service', value: 'customer-spg-ratingsdirect' },
        { key: 'subIndustry', value: issuer.subIndustry },
        { key: 'sector', value: issuer.sector },
        { key: 'issuerId', value: issuerId },
      ],
      extra: {
        scorecardReference,
        packageNumber,
        issuerId,
        issuerName: issuer.issuerName,
        sector: issuer.sector,
        subIndustry: issuer.subIndustry,
        currentRating: issuer.currentRating,
        outlook: issuer.outlook,
        businessRiskProfile,
        financialRiskProfile,
        countryRiskScore,
        industryRiskScore,
        ffoToDebtPercent,
        debtToEbitda,
        ebitdaInterestCoverage,
        liquidityAssessment,
        comparableRatingsAdjustment,
        channel: data.channel,
      },
      level: 'error',
      platform: 'node',
      firstSeen: '',
      lastSeen: new Date().toISOString(),
      count: '',
      shortId: '',
      project: 'event-driven-devin',
      release: 'customer-spg-ratingsdirect@1.0.0',
      environment: process.env.DD_ENV || 'prod',
      triggeredRule: '',
    }).catch((alertError) => {
      logger.error('Failed to create Devin session for S&P Global scorecard error', {
        scorecardReference,
        error: alertError.message,
      });
    });

    throw error;
  }
}

module.exports = {
  generateScorecard,
  resolveSectorScorecard,
  calculateAnchorScore,
  roundScore,
  ISSUERS,
  SECTOR_SCORECARDS,
  CORPORATE_ANCHOR_MATRIX,
  RATING_SCALE,
  REMEDIATION_DIRECTIVE,
};
