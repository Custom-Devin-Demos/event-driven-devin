const { v4: uuidv4 } = require('uuid');
const logger = require('../../telemetry/logger');
const { incrementMetric, recordTiming } = require('../../telemetry/datadog');
const { Sentry } = require('../../telemetry/sentry');
const { createSessionAndAlert } = require('../devin-session');

const ROUTE = '/api/844f1b1f/payroll/submit';
const SERVICE = 'siteforce-payroll-service';
const SLACK_MEMBER_ID = process.env.HITT_SLACK_MEMBER_ID || '';
const WEEK_ENDING = '2026-10-31';

/**
 * Davis-Bacon wage determinations (SAM.gov), keyed by classification code.
 */
const WAGE_DETERMINATIONS = {
  VA20260012: {
    id: 'VA20260012', modification: 3, county: 'Arlington County, VA',
    rates: {
      carpenter: { label: 'Carpenter', baseRate: 34.12, fringe: 14.97 },
      laborer_common: { label: 'Laborer: Common or General', baseRate: 24.86, fringe: 9.18 },
      drywall_finisher: { label: 'Drywall Finisher/Taper', baseRate: 31.40, fringe: 12.36 },
      painter_brush: { label: 'Painter: Brush, Roller and Spray', baseRate: 28.75, fringe: 11.02 },
      operating_engineer: { label: 'Power Equipment Operator', baseRate: 41.05, fringe: 16.44 },
    },
  },
};

/**
 * HITT self-perform site workforce, synced nightly from the timekeeping kiosk import.
 */
const PROJECTS = {
  'HITT-24117': {
    id: 'HITT-24117', name: 'DEA Headquarters Modernization', client: 'U.S. General Services Administration',
    location: 'Arlington, VA', sector: 'Government', federal: true, wageDetermination: 'VA20260012',
    contract: 'GS-11P-24-MKC-0042', superintendent: 'Marcus Reyes', percentComplete: 62,
    crew: [
      { id: 'W-10442', name: 'Luis Hernandez', classification: 'Carpenter', classificationCode: 'carpenter', hours: [8, 8, 10, 10, 8, 0, 0] },
      { id: 'W-10518', name: 'Andre Thompson', classification: 'Carpenter', classificationCode: 'carpenter', hours: [8, 8, 8, 10, 8, 0, 0] },
      { id: 'W-10611', name: 'Keisha Brown', classification: 'Laborer: Common or General', classificationCode: 'laborer_common', hours: [8, 8, 8, 8, 8, 0, 0] },
      { id: 'W-10734', name: 'Jose Martinez', classification: 'Laborer: Common or General', classificationCode: 'laborer_common', hours: [10, 10, 10, 8, 8, 4, 0] },
      { id: 'W-10790', name: 'Daniel Okafor', classification: 'Power Equipment Operator', classificationCode: 'operating_engineer', hours: [8, 8, 8, 8, 6, 0, 0] },
      { id: 'W-10856', name: 'Ryan Walsh', classification: 'Drywall Finisher/Taper', classificationCode: 'drywall_finisher_taper', hours: [8, 8, 8, 8, 8, 0, 0] },
      { id: 'W-10871', name: 'Maria Gonzalez', classification: 'Painter: Brush, Roller and Spray', classificationCode: 'painter_brush', hours: [8, 8, 8, 8, 8, 0, 0] },
    ],
  },
  'HITT-25203': {
    id: 'HITT-25203', name: 'Confidential Hyperscale Data Center \u2014 Building 4', client: 'Confidential Hyperscale Client',
    location: 'Ashburn, VA', sector: 'Mission Critical', federal: false, wageDetermination: null,
    contract: 'HITT-MSA-2025-118', superintendent: 'Todd Kessler', percentComplete: 41,
    crew: [
      { id: 'W-11203', name: 'Chris Patel', classification: 'Carpenter', classificationCode: 'carpenter', hours: [10, 10, 10, 10, 10, 8, 0], rate: 36.5 },
      { id: 'W-11219', name: 'Tyler Nguyen', classification: 'Carpenter', classificationCode: 'carpenter', hours: [10, 10, 10, 10, 10, 8, 0], rate: 35.25 },
      { id: 'W-11240', name: 'Samuel Adeyemi', classification: 'Laborer: Common or General', classificationCode: 'laborer_common', hours: [10, 10, 10, 10, 10, 0, 0], rate: 26.0 },
      { id: 'W-11262', name: 'Brandon Lee', classification: 'Drywall Finisher/Taper', classificationCode: 'drywall_finisher_taper', hours: [10, 10, 10, 10, 8, 0, 0], rate: 32.75 },
      { id: 'W-11288', name: 'Erica Johnson', classification: 'Power Equipment Operator', classificationCode: 'operating_engineer', hours: [10, 10, 10, 10, 10, 0, 0], rate: 42.0 },
    ],
  },
  'HITT-25088': {
    id: 'HITT-25088', name: 'Capital One Block A \u2014 Interiors', client: 'Capital One',
    location: 'McLean, VA', sector: 'Corporate Office', federal: false, wageDetermination: null,
    contract: 'HITT-25-0880', superintendent: 'Alyssa Grant', percentComplete: 87,
    crew: [
      { id: 'W-12014', name: 'Kevin Brooks', classification: 'Carpenter', classificationCode: 'carpenter', hours: [8, 8, 8, 8, 8, 0, 0], rate: 35.0 },
      { id: 'W-12033', name: 'Nicole Ramirez', classification: 'Painter: Brush, Roller and Spray', classificationCode: 'painter_brush', hours: [8, 8, 8, 8, 6, 0, 0], rate: 29.5 },
      { id: 'W-12051', name: 'Omar Haddad', classification: 'Laborer: Common or General', classificationCode: 'laborer_common', hours: [8, 8, 8, 8, 8, 0, 0], rate: 25.5 },
    ],
  },
};

function round2(n) {
  return Math.round(n * 100) / 100;
}

function weeklyHours(worker) {
  return worker.hours.reduce((sum, h) => sum + h, 0);
}

function splitHours(total) {
  return { straight: Math.min(total, 40), overtime: Math.max(total - 40, 0) };
}

function listProjects() {
  return Object.values(PROJECTS).map((p) => ({
    ...p,
    weekEnding: WEEK_ENDING,
    crew: p.crew.map((w) => ({ ...w, totalHours: weeklyHours(w) })),
  }));
}

/**
 * Prices one worker's week against the project's Davis-Bacon wage determination.
 */
function prevailingWageLine(worker, determination) {
  const rate = determination.rates[worker.classificationCode];
  const { straight, overtime } = splitHours(weeklyHours(worker));
  const gross = straight * rate.baseRate + overtime * rate.baseRate * 1.5;
  return {
    workerId: worker.id, name: worker.name, classification: rate.label, straight, overtime,
    baseRate: rate.baseRate, fringeRate: rate.fringe, gross: round2(gross), fringes: round2((straight + overtime) * rate.fringe),
  };
}

function internalWageLine(worker) {
  const { straight, overtime } = splitHours(weeklyHours(worker));
  const gross = straight * worker.rate + overtime * worker.rate * 1.5;
  return {
    workerId: worker.id, name: worker.name, classification: worker.classification, straight, overtime,
    baseRate: worker.rate, fringeRate: 0, gross: round2(gross), fringes: 0,
  };
}

function buildPayroll(project) {
  if (project.federal) {
    const determination = WAGE_DETERMINATIONS[project.wageDetermination];
    return project.crew.map((w) => prevailingWageLine(w, determination));
  }
  return project.crew.map(internalWageLine);
}

/**
 * Submits the weekly payroll for a project's self-perform crew. Federal projects
 * produce a WH-347 certified payroll checked against the wage determination.
 */
async function submitPayroll(data) {
  const startTime = Date.now();
  const project = PROJECTS[data.projectId];
  const payrollRef = `SF-PR-${uuidv4().slice(0, 6).toUpperCase()}`;
  const requestId = data.requestId || uuidv4();

  logger.info('Submitting SiteForce weekly payroll', {
    payrollRef, requestId, projectId: project.id, federal: project.federal, weekEnding: WEEK_ENDING, service: SERVICE, route: ROUTE,
  });

  try {
    await new Promise((resolve) => setTimeout(resolve, 500 + Math.random() * 400));

    const lines = buildPayroll(project);
    const totals = lines.reduce((acc, l) => ({
      hours: acc.hours + l.straight + l.overtime, gross: acc.gross + l.gross, fringes: acc.fringes + l.fringes,
    }), { hours: 0, gross: 0, fringes: 0 });

    incrementMetric('payroll.submit.success', { route: ROUTE, federal: String(project.federal) });
    recordTiming('payroll.submit.latency', Date.now() - startTime, { route: ROUTE });

    return {
      success: true,
      payrollRef,
      projectId: project.id,
      projectName: project.name,
      weekEnding: WEEK_ENDING,
      form: project.federal ? 'WH-347 Certified Payroll' : 'Weekly Craft Payroll',
      wageDetermination: project.wageDetermination,
      workers: lines.length,
      totalHours: totals.hours,
      grossWages: round2(totals.gross),
      fringeBenefits: round2(totals.fringes),
      lines,
      procoreSync: 'queued',
      submittedAt: new Date().toISOString(),
    };
  } catch (error) {
    const duration = Date.now() - startTime;
    incrementMetric('payroll.submit.failure', { route: ROUTE, errorClass: error.name, federal: String(project.federal) });
    recordTiming('payroll.submit.latency', duration, { route: ROUTE, error: 'true' });

    logger.error('SiteForce payroll submission failed', {
      payrollRef, requestId, projectId: project.id, error: error.message, errorClass: error.name, durationMs: duration, service: SERVICE,
    });

    Sentry.captureException(error, {
      tags: { route: ROUTE, service: SERVICE, source: 'siteforce-payroll', alert_path: 'instant' },
      extra: { payrollRef, projectId: project.id, wageDetermination: project.wageDetermination },
    });

    createSessionAndAlert({
      issueTitle: `${error.name}: ${error.message}`,
      issueUrl: `https://${process.env.SENTRY_ORG_SLUG || 'sentry-org'}.sentry.io/issues/?project=${process.env.SENTRY_PROJECT_ID || ''}&query=is%3Aunresolved`,
      culprit: 'app/services/verticals/844f1b1f.js \u2014 prevailingWageLine',
      errorType: error.name || 'Error',
      errorValue: error.message,
      customer: '844f1b1f',
      devinUserId: data.devinUserId,
      devinEmail: data.devinEmail,
      devinOrgId: data.devinOrgId,
      slackMemberIdFallback: SLACK_MEMBER_ID,
      service: SERVICE,
      verticalLabel: 'HITT SiteForce \u2014 Certified Payroll',
      tags: [
        { key: 'route', value: ROUTE },
        { key: 'service', value: SERVICE },
        { key: 'project', value: project.id },
        { key: 'wage_determination', value: String(project.wageDetermination) },
      ],
      extra: { payrollRef, projectId: project.id, projectName: project.name, weekEnding: WEEK_ENDING },
      level: 'error',
      platform: 'node',
      firstSeen: '',
      lastSeen: new Date().toISOString(),
      count: '',
      shortId: '',
      project: 'event-driven-devin',
      release: process.env.SENTRY_RELEASE || `${SERVICE}@2026.11.1`,
      environment: process.env.DD_ENV || 'prod',
      triggeredRule: '',
    }).catch((err) => {
      logger.error('Failed to trigger Devin session from SiteForce payroll error', { error: err.message });
    });

    error.payrollRef = payrollRef;
    throw error;
  }
}

module.exports = {
  submitPayroll,
  listProjects,
  buildPayroll,
  PROJECTS,
  WAGE_DETERMINATIONS,
  WEEK_ENDING,
};
