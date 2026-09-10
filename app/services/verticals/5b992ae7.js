const { v4: uuidv4 } = require('uuid');
const logger = require('../../telemetry/logger');
const { incrementMetric, recordTiming } = require('../../telemetry/datadog');
const { Sentry } = require('../../telemetry/sentry');
const { createSessionAndAlert } = require('../devin-session');

/**
 * Engine programs referenced by the customer support inquiry flow.
 */
const ENGINE_PROGRAMS = {
  leap: {
    code: 'leap',
    name: 'CFM LEAP',
    family: 'narrowbody',
    inService: 3800,
  },
  cfm56: {
    code: 'cfm56',
    name: 'CFM56',
    family: 'narrowbody',
    inService: 21000,
  },
  genx: {
    code: 'genx',
    name: 'GEnx',
    family: 'widebody',
    inService: 3200,
  },
  ge9x: {
    code: 'ge9x',
    name: 'GE9X',
    family: 'widebody',
    inService: 120,
  },
  ge90: {
    code: 'ge90',
    name: 'GE90',
    family: 'widebody',
    inService: 2700,
  },
  passport: {
    code: 'passport',
    name: 'Passport',
    family: 'business',
    inService: 250,
  },
  catalyst: {
    code: 'catalyst',
    name: 'Catalyst',
    family: 'business',
    inService: 40,
  },
};

/**
 * Operator profiles keyed by ISO country code. Each profile carries the
 * support segment used to route the inquiry to the right desk.
 */
const OPERATOR_PROFILES = {
  US: { region: 'north-america', currency: 'usd', segment: 'commercial_narrowbody' },
  CA: { region: 'north-america', currency: 'cad', segment: 'commercial_narrowbody' },
  GB: { region: 'europe', currency: 'gbp', segment: 'commercial_widebody' },
  FR: { region: 'europe', currency: 'eur', segment: 'commercial_widebody' },
  AE: { region: 'middle-east', currency: 'aed', segment: 'commercial_widebody' },
  SG: { region: 'apac', currency: 'sgd', segment: 'business_regional' },
};

/**
 * Routing table mapping support segments to the desk that owns the
 * follow-up, plus the engine programs quoted in the response.
 */
const SEGMENT_ROUTING = {
  commercial_narrowbody: {
    desk: 'narrowbody-customer-support',
    responseSlaHours: 24,
    programs: ['leap', 'cfm56', 'rise'],
  },
  commercial_widebody: {
    desk: 'widebody-customer-support',
    responseSlaHours: 24,
    programs: ['genx', 'ge9x', 'ge90'],
  },
  business_regional: {
    desk: 'business-regional-support',
    responseSlaHours: 48,
    programs: ['passport', 'catalyst'],
  },
};

/**
 * Scenario directive appended to the Devin investigation prompt.
 *
 * The alert pipeline passes only a prompt to the Devin API, so the repository
 * to remediate has to be named explicitly here.
 */
const REMEDIATION_DIRECTIVE = [
  '*Repository to investigate and fix:* `Custom-Devin-Demos/event-driven-devin`',
  '',
  'The failing code path is the aerospace customer support inquiry vertical:',
  '- Service: `app/services/verticals/5b992ae7.js`',
  '- Route: `app/routes/verticals/5b992ae7.js`',
  '- Page: `app/public/verticals/5b992ae7.html` (served at `/5b992ae7`)',
  '',
  'Open a pull request against `main` with the fix.',
].join('\n');

/**
 * Scenario directive for errors raised by the Flutter customer portal
 * (service tag `customer-5b992ae7-portal`). The portal ships the same
 * routing/catalog mismatch in Dart, so the fix lands in the Flutter repo, and
 * the fix is only done once it has been verified natively on every desktop
 * target the portal ships to.
 */
const PORTAL_REMEDIATION_DIRECTIVE = [
  '*Repository to investigate and fix:* `github.com/Custom-Devin-Demos/ge-customer-portal` (Flutter)',
  '',
  'This error was raised by the GE Aerospace Customer Portal, a Flutter app that ships to',
  'Linux, Windows, macOS/iOS, Android and web from one codebase. Read `AGENTS.md` in that repo first.',
  '',
  'The failing code path is the Technical Inquiry submission:',
  '- Routing: `lib/domain/segment_routing.dart` (segment → desk → program codes)',
  '- Catalog: `lib/domain/engine_programs.dart` (program code → engine program)',
  '- Crash site: `lib/domain/engine_coverage.dart` (`buildEngineCoverage`)',
  '- Screen: `lib/features/inquiry/inquiry_screen.dart`',
  '',
  'Steps:',
  '1. Reproduce with `flutter test` — the domain tests fail on the routed program code that is',
  '   missing from the catalog.',
  '2. Fix the data, not just the crash site: register the missing program in the catalog and make',
  '   `buildEngineCoverage` skip or flag an unregistered code instead of null-asserting it.',
  '3. Keep `test/domain/segment_routing_test.dart` routing/catalog consistency coverage green and',
  '   add coverage for the tolerant path. `flutter analyze --fatal-infos` and `flutter test` must pass.',
  '4. Open a pull request against `main`, request Devin Review, and STOP for human approval.',
  '5. After approval, spawn child sessions on Linux, Windows and macOS/iOS. Each builds the PR',
  '   branch natively (`scripts/verify-native.sh <platform>` / `scripts/verify-native.ps1`),',
  '   launches the app, submits the same narrowbody inquiry, records the screen showing the',
  '   confirmation, and posts the recording to the PR.',
].join('\n');

/**
 * Resolve the operator profile for the inquiring party.
 */
function resolveOperatorProfile(market) {
  const key = String(market || 'US').toUpperCase();
  return OPERATOR_PROFILES[key] || OPERATOR_PROFILES.US;
}

/**
 * Resolve the support routing entry for an operator profile.
 */
function resolveSupportRouting(profile) {
  return SEGMENT_ROUTING[profile.segment] || SEGMENT_ROUTING.commercial_widebody;
}

/**
 * Build the engine coverage quoted back to the requester for a routing entry.
 */
function buildEngineCoverage(routing) {
  return routing.programs.map((code) => {
    const program = ENGINE_PROGRAMS[code];
    return {
      code: program.code,
      name: program.name,
      family: program.family,
      inService: program.inService,
    };
  });
}

/**
 * Build the confirmation payload returned to the corporate site.
 */
function buildInquirySummary(referenceNumber, profile, routing, coverage) {
  return {
    success: true,
    referenceNumber,
    status: 'received',
    region: profile.region,
    desk: routing.desk,
    responseSlaHours: routing.responseSlaHours,
    programs: coverage,
    receivedAt: new Date().toISOString(),
  };
}

/**
 * Handle a customer support inquiry submitted from the corporate site.
 */
async function submitInquiry(data) {
  const startTime = Date.now();
  const referenceNumber = uuidv4();

  logger.info('Processing support inquiry', {
    referenceNumber,
    topic: data.topic,
    market: data.market,
    service: 'customer-5b992ae7-inquiry',
    route: '/api/5b992ae7/inquiry',
  });

  try {
    await new Promise((resolve) => setTimeout(resolve, 80 + Math.random() * 120));

    const profile = resolveOperatorProfile(data.market);
    const routing = resolveSupportRouting(profile);
    const coverage = buildEngineCoverage(routing);
    const summary = buildInquirySummary(referenceNumber, profile, routing, coverage);

    const duration = Date.now() - startTime;

    incrementMetric('support_inquiry.success', {
      route: '/api/5b992ae7/inquiry',
      topic: data.topic,
    });
    recordTiming('support_inquiry.latency', duration, {
      route: '/api/5b992ae7/inquiry',
    });

    return summary;
  } catch (error) {
    const duration = Date.now() - startTime;

    incrementMetric('support_inquiry.failure', {
      route: '/api/5b992ae7/inquiry',
      errorClass: error.name,
      topic: data.topic,
    });
    recordTiming('support_inquiry.latency', duration, {
      route: '/api/5b992ae7/inquiry',
      error: 'true',
    });

    logger.error('Support inquiry failed', {
      referenceNumber,
      error: error.message,
      errorClass: error.name,
      durationMs: duration,
      topic: data.topic,
      market: data.market,
      service: 'customer-5b992ae7-inquiry',
    });

    Sentry.captureException(error, {
      tags: {
        route: '/api/5b992ae7/inquiry',
        service: 'customer-5b992ae7-inquiry',
        topic: data.topic,
      },
      extra: {
        referenceNumber,
        topic: data.topic,
        market: data.market,
      },
    });

    createSessionAndAlert({
      issueTitle: `${error.name}: ${error.message}`,
      issueUrl: `https://${process.env.SENTRY_ORG_SLUG || 'sentry-org'}.sentry.io/issues/?project=${process.env.SENTRY_PROJECT_ID || ''}&query=is%3Aunresolved`,
      culprit: 'app/services/verticals/5b992ae7.js \u2014 buildEngineCoverage',
      errorType: error.name || 'Error',
      errorValue: error.message,
      devinUserId: data.devinUserId,
      devinEmail: data.devinEmail || 'shawn@cognition.ai',
      devinOrgId: data.devinOrgId,
      service: 'customer-5b992ae7-inquiry',
      verticalLabel: 'Aerospace Customer Support Inquiry',
      promptAppendix: REMEDIATION_DIRECTIVE,
      customer: '5b992ae7',
      tags: [
        { key: 'route', value: '/api/5b992ae7/inquiry' },
        { key: 'service', value: 'customer-5b992ae7-inquiry' },
        { key: 'topic', value: data.topic },
        { key: 'market', value: data.market },
      ],
      extra: {
        referenceNumber,
        topic: data.topic,
        market: data.market,
      },
      level: 'error',
      platform: 'node',
      firstSeen: '',
      lastSeen: new Date().toISOString(),
      count: '',
      shortId: '',
      project: 'event-driven-devin',
      release: process.env.SENTRY_RELEASE || 'customer-5b992ae7-inquiry@1.0.0',
      environment: process.env.DD_ENV || 'prod',
      triggeredRule: '',
    }).catch((err) => {
      logger.error('Failed to create Devin session for support inquiry error', {
        error: err.message,
        referenceNumber,
      });
    });

    throw error;
  }
}

module.exports = {
  submitInquiry,
  REMEDIATION_DIRECTIVE,
  PORTAL_REMEDIATION_DIRECTIVE,
  ENGINE_PROGRAMS,
  OPERATOR_PROFILES,
  SEGMENT_ROUTING,
  resolveOperatorProfile,
  resolveSupportRouting,
  buildEngineCoverage,
};
