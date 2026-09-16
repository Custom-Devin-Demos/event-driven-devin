const { v4: uuidv4 } = require('uuid');
const logger = require('../../telemetry/logger');
const { incrementMetric, recordTiming } = require('../../telemetry/datadog');
const { Sentry } = require('../../telemetry/sentry');
const { createSessionAndAlert } = require('../devin-session');

const SERVICE_TERRITORIES = [
  { zipPrefixes: ['941'], divisionCode: 'SAN_FRANCISCO', county: 'San Francisco' },
  { zipPrefixes: ['940', '944', '943'], divisionCode: 'PENINSULA', county: 'San Mateo' },
  { zipPrefixes: ['945', '946', '947', '948'], divisionCode: 'EAST_BAY', county: 'Alameda' },
  { zipPrefixes: ['949', '954', '955'], divisionCode: 'NORTH_BAY', county: 'Marin' },
  { zipPrefixes: ['956', '957', '958'], divisionCode: 'SACRAMENTO', county: 'Sacramento' },
  { zipPrefixes: ['939', '950', '951', '952'], divisionCode: 'CENTRAL_COAST', county: 'Monterey' },
];

const DIVISIONS = {
  'san-francisco': { name: 'San Francisco', crewQueue: { id: 'CQ-SF-01', region: 'San Francisco' }, slaTier: 'metro' },
  peninsula: { name: 'Peninsula', crewQueue: { id: 'CQ-PEN-01', region: 'Peninsula' }, slaTier: 'suburban' },
  'east-bay': { name: 'East Bay', crewQueue: { id: 'CQ-EB-01', region: 'East Bay' }, slaTier: 'suburban' },
  'north-bay': { name: 'North Bay', crewQueue: { id: 'CQ-NB-01', region: 'North Bay' }, slaTier: 'rural' },
  sacramento: { name: 'Sacramento', crewQueue: { id: 'CQ-SAC-01', region: 'Sacramento' }, slaTier: 'suburban' },
  'central-coast': { name: 'Central Coast', crewQueue: { id: 'CQ-CC-01', region: 'Central Coast' }, slaTier: 'rural' },
};

const SLA_WINDOWS = { metro: 3, suburban: 5, rural: 10 };

const RECENT_STREETLIGHT_REPORTS = [
  { ticketId: 'SL-2026-018342', address: '2418 Vallejo St', city: 'San Francisco', zip: '94123', poleId: 'P-4410-227', issue: 'Light out', status: 'Dispatched', reportedAt: '2026-09-12T08:42:00Z' },
  { ticketId: 'SL-2026-018337', address: '88 Oak Avenue', city: 'San Mateo', zip: '94401', poleId: 'P-2204-119', issue: 'Flickering light', status: 'Assigned', reportedAt: '2026-09-11T19:15:00Z' },
  { ticketId: 'SL-2026-018331', address: '1700 Broadway', city: 'Oakland', zip: '94612', poleId: 'P-3188-064', issue: 'Damaged fixture', status: 'In review', reportedAt: '2026-09-11T14:21:00Z' },
  { ticketId: 'SL-2026-018326', address: '25 Grant Avenue', city: 'Novato', zip: '94945', poleId: 'P-5072-318', issue: 'Light out', status: 'Completed', reportedAt: '2026-09-10T21:08:00Z' },
  { ticketId: 'SL-2026-018319', address: '410 Capitol Mall', city: 'Sacramento', zip: '95814', poleId: 'P-6084-902', issue: 'Exposed wiring', status: 'Dispatched', reportedAt: '2026-09-10T16:37:00Z' },
];

function resolveDivision(zip) {
  const territory = SERVICE_TERRITORIES.find((entry) => entry.zipPrefixes.some((prefix) => String(zip).startsWith(prefix)));
  return { code: territory.divisionCode, division: DIVISIONS[territory.divisionCode] };
}

function estimateRepairWindow(division) {
  return SLA_WINDOWS[division.slaTier];
}

function buildDispatchTicket(report, resolved) {
  const ticketId = `SL-${new Date().getFullYear()}-${String(Math.floor(Math.random() * 1000000)).padStart(6, '0')}`;
  return {
    ticketId,
    crewQueue: resolved.division.crewQueue.id,
    division: resolved.division.name,
    etaBusinessDays: estimateRepairWindow(resolved.division),
    poleId: report.poleId,
    address: report.address,
    status: 'Dispatched',
  };
}

function formatStreetlightResponse(ticket, requestId) {
  return {
    success: true,
    requestId,
    ticket,
    message: 'Your streetlight report has been submitted.',
  };
}

async function submitStreetlightReport(data) {
  const startTime = Date.now();
  const requestId = uuidv4();

  logger.info('Submitting streetlight report', {
    requestId,
    address: data.address,
    zip: data.zip,
    poleId: data.poleId,
    service: 'c9944b42-api',
  });

  try {
    await new Promise((resolve) => setTimeout(resolve, 70 + Math.random() * 110));

    const resolved = resolveDivision(data.zip);
    const ticket = buildDispatchTicket(data, resolved);
    const duration = Date.now() - startTime;

    incrementMetric('streetlight_report.success', {
      route: '/api/c9944b42/streetlight',
      division: resolved.code,
    });
    recordTiming('streetlight_report.latency', duration, {
      route: '/api/c9944b42/streetlight',
    });

    return formatStreetlightResponse(ticket, requestId);
  } catch (error) {
    const duration = Date.now() - startTime;

    incrementMetric('streetlight_report.failure', {
      route: '/api/c9944b42/streetlight',
      errorClass: error.name,
    });
    recordTiming('streetlight_report.latency', duration, {
      route: '/api/c9944b42/streetlight',
      error: 'true',
    });

    logger.error('Streetlight report failed', {
      requestId,
      error: error.message,
      errorClass: error.name,
      durationMs: duration,
      address: data.address,
      zip: data.zip,
      poleId: data.poleId,
      service: 'c9944b42-api',
    });

    Sentry.captureException(error, {
      tags: {
        route: '/api/c9944b42/streetlight',
        service: 'c9944b42-api',
      },
      extra: {
        requestId,
        zip: data.zip,
        address: data.address,
        poleId: data.poleId,
      },
    });

    createSessionAndAlert({
      issueTitle: `${error.name}: ${error.message}`,
      issueUrl: `https://${process.env.SENTRY_ORG_SLUG || 'sentry-org'}.sentry.io/issues/?project=${process.env.SENTRY_PROJECT_ID || ''}&query=is%3Aunresolved`,
      culprit: 'app/services/verticals/c9944b42.js — submitStreetlightReport',
      errorType: error.name || 'Error',
      errorValue: error.message,
      devinUserId: data.devinUserId,
      devinEmail: data.devinEmail,
      devinOrgId: data.devinOrgId,
      slackMemberId: process.env.DEMO_ONCALL_SLACK_MEMBER_ID || 'U08S7AVJ478',
      service: 'c9944b42-api',
      verticalLabel: 'Utility Outage Center',
      tags: [
        { key: 'route', value: '/api/c9944b42/streetlight' },
        { key: 'service', value: 'c9944b42-api' },
      ],
      extra: {
        requestId,
        zip: data.zip,
        address: data.address,
        poleId: data.poleId,
      },
      promptAppendix: data.sourcePage
        ? `The user-facing page that triggered this error is ${data.sourcePage} — after fixing, verify the fix end-to-end on the same page.`
        : undefined,
      level: 'error',
      platform: 'node',
      firstSeen: '',
      lastSeen: new Date().toISOString(),
      count: '',
      shortId: '',
      project: 'event-driven-devin',
      release: process.env.SENTRY_RELEASE || 'c9944b42@1.0.0',
      environment: process.env.DD_ENV || 'prod',
      triggeredRule: '',
    }).catch((err) => {
      logger.error('Failed to trigger Devin session', { error: err.message });
    });

    throw error;
  }
}

module.exports = {
  submitStreetlightReport,
  SERVICE_TERRITORIES,
  DIVISIONS,
  RECENT_STREETLIGHT_REPORTS,
};
