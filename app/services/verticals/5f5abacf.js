const { v4: uuidv4 } = require('uuid');
const logger = require('../../telemetry/logger');
const { incrementMetric, recordTiming } = require('../../telemetry/datadog');
const { Sentry } = require('../../telemetry/sentry');
const { createSessionAndAlert } = require('../devin-session');

const SERVICE = 'process-intelligence-platform';
const ROUTE = '/api/5f5abacf/solutions/discover';

const SOLUTION_TRACKS = {
  'artificial-intelligence': {
    label: 'Artificial Intelligence (AI)',
    initiatives: [
      { id: 'ai-context', title: 'Give AI context', description: 'Empower Enterprise AI with the operational clarity it needs to succeed.', benchmarkKey: 'order-management' },
      { id: 'ai-strategy', title: 'Deploy AI strategically', description: 'Identify high-impact AI use cases and measure RoAI.', benchmarkKey: 'accounts-payable' },
      { id: 'ai-operations', title: 'Integrate AI into operations', description: 'Orchestrate people, agents, and existing technologies to drive outcomes.', benchmarkKey: 'inventory-management' },
    ],
  },
  'supply-chain': {
    label: 'Supply Chain',
    initiatives: [
      { id: 'service-levels', title: 'Improve service levels', description: 'Improve on-time in-full delivery, reduce stockouts, and improve supplier reliability.', benchmarkKey: 'order-management' },
      { id: 'working-capital', title: 'Optimize working capital', description: 'Accelerate slow-moving inventory, and reduce and reallocate excess.', benchmarkKey: 'inventory-management' },
      { id: 'supply-costs', title: 'Contain costs', description: 'Optimize load consolidation, and reduce operating costs and spot purchasing.', benchmarkKey: 'procure-to-pay' },
    ],
  },
  'enterprise-it-modernization': {
    label: 'Enterprise IT Modernization',
    initiatives: [
      { id: 'modernization-strategy', title: 'Set modernization strategy', description: 'Align, plan, and execute your modernization strategy using objective information about the state of your enterprise, not gut instinct.', benchmarkKey: 'it-service-management' },
      { id: 'enterprise-ai', title: 'Make enterprise AI work', description: 'Power Enterprise AI with real-time operational context, deploy it where it drives measurable impact, and integrate it seamlessly into existing systems and workflows.', benchmarkKey: 'shared-services' },
      { id: 'migration-confidence', title: 'Migrate with confidence', description: 'Simplify your digital core by separating true differentiation from technical debt, reducing migration risk while sustaining value beyond go-live.', benchmarkKey: 'production-planning' },
    ],
  },
  'finance-shared-services': {
    label: 'Finance and Shared Services',
    initiatives: [
      { id: 'cash-flow', title: 'Improve cash flow', description: 'Optimize payments and accelerate collections.', benchmarkKey: 'order-to-cash' },
      { id: 'reduce-costs', title: 'Reduce costs', description: 'Prevent duplicate payments and excess spend.', benchmarkKey: 'accounts-payable' },
      { id: 'productivity', title: 'Increase productivity', description: 'Automate actions and improve cycle times.', benchmarkKey: 'accounts-receivable' },
    ],
  },
  'process-excellence': {
    label: 'Process Excellence',
    initiatives: [
      { id: 'analyze', title: 'Analyze', description: 'Understand how your processes truly run. Identify the most impactful opportunities to implement improvements and deploy AI. Run process simulations, predictions, and what-if scenarios.', benchmarkKey: 'procure-to-pay' },
      { id: 'design', title: 'Design', description: 'Redesign operations to integrate Enterprise AI. Re-engineer processes based on deep process insight. Define workflows, outcomes, guardrails, and best practices.', benchmarkKey: 'production-planning' },
      { id: 'operate', title: 'Operate', description: 'Continuously monitor process performance, adherence, and agent activity. Orchestrate AI to work alongside people and systems.', benchmarkKey: 'it-service-management' },
    ],
  },
};

const VALUE_BENCHMARKS = {
  orderManagement: { label: 'Order management', uplift: { low: 18, median: 32, high: 48 }, unit: 'percent', sampleSize: 182, source: 'Celonis Value Benchmarks 2026' },
  accountsPayable: { label: 'Accounts payable', uplift: { low: 24, median: 66, high: 82 }, unit: 'percent', sampleSize: 246, source: 'Celonis Value Benchmarks 2026' },
  inventoryManagement: { label: 'Inventory management', uplift: { low: 12, median: 26, high: 41 }, unit: 'percent', sampleSize: 147, source: 'Celonis Value Benchmarks 2026' },
  procureToPay: { label: 'Procure-to-pay', uplift: { low: 14, median: 29, high: 44 }, unit: 'percent', sampleSize: 219, source: 'Celonis Value Benchmarks 2026' },
  orderToCash: { label: 'Order-to-cash', uplift: { low: 3, median: 7, high: 12 }, unit: 'days', sampleSize: 168, source: 'Celonis Value Benchmarks 2026' },
  itServiceManagement: { label: 'IT service management', uplift: { low: 19, median: 37, high: 55 }, unit: 'percent', sampleSize: 131, source: 'Celonis Value Benchmarks 2026' },
  accountsReceivable: { label: 'Accounts receivable', uplift: { low: 11, median: 23, high: 38 }, unit: 'percent', sampleSize: 204, source: 'Celonis Value Benchmarks 2026' },
  productionPlanning: { label: 'Production planning', uplift: { low: 8, median: 21, high: 36 }, unit: 'percent', sampleSize: 119, source: 'Celonis Value Benchmarks 2026' },
  sharedServices: { label: 'Shared services', uplift: { low: 16, median: 31, high: 49 }, unit: 'percent', sampleSize: 155, source: 'Celonis Value Benchmarks 2026' },
};

function toBenchmarkKey(processName) {
  return processName.replace(/_([a-z])/g, (_, character) => character.toUpperCase());
}

function resolveBenchmark(processName) {
  return VALUE_BENCHMARKS[toBenchmarkKey(processName)];
}

function resolveTrack(track) {
  const selected = SOLUTION_TRACKS[track];
  if (!selected) {
    throw Object.assign(new Error(`Unknown solution track: ${track}`), { code: 'UNKNOWN_TRACK' });
  }
  return selected;
}

function computeOutlook(initiatives) {
  const entries = initiatives.map((initiative) => ({
    id: initiative.id,
    title: initiative.title,
    benchmark: resolveBenchmark(initiative.benchmarkKey),
  }));
  const medianUplift = entries.reduce((sum, entry) => sum + entry.benchmark.uplift.median, 0);
  return {
    medianUplift,
    confidence: 'medium',
    horizonQuarters: 4,
  };
}

function buildBrief(track, outlook) {
  return {
    briefId: outlook.briefId,
    track: track.label,
    initiatives: track.initiatives,
    outlook,
    generatedAt: new Date().toISOString(),
  };
}

async function discoverSolutions(data) {
  const startTime = Date.now();
  const briefId = `brief_${uuidv4().slice(0, 8)}`;

  logger.info('Assembling solutions brief', {
    briefId,
    track: data.track,
    service: SERVICE,
    route: ROUTE,
  });

  try {
    await new Promise((resolve) => setTimeout(resolve, 55 + Math.random() * 90));
    const track = resolveTrack(data.track);
    const outlook = computeOutlook(track.initiatives);
    outlook.briefId = briefId;
    const brief = buildBrief(track, outlook);

    incrementMetric('solutions.discover.success', { route: ROUTE, track: data.track });
    recordTiming('solutions.discover.latency', Date.now() - startTime, { route: ROUTE });
    return { success: true, ...brief };
  } catch (error) {
    const duration = Date.now() - startTime;
    incrementMetric('solutions.discover.failure', {
      route: ROUTE,
      errorClass: error.name,
      track: data.track,
    });
    recordTiming('solutions.discover.latency', duration, { route: ROUTE, error: 'true' });
    logger.error('Solutions brief assembly failed', {
      briefId,
      error: error.message,
      errorClass: error.name,
      durationMs: duration,
      track: data.track,
      service: SERVICE,
    });
    Sentry.captureException(error, {
      tags: { route: ROUTE, service: SERVICE, source: 'commercial-homepage' },
      extra: { briefId, track: data.track },
    });
    createSessionAndAlert({
      issueTitle: `${error.name}: ${error.message}`,
      issueUrl: `https://${process.env.SENTRY_ORG_SLUG || 'sentry-org'}.sentry.io/issues/?project=${process.env.SENTRY_PROJECT_ID || ''}&query=is%3Aunresolved`,
      culprit: 'app/services/verticals/5f5abacf.js — computeOutlook',
      errorType: error.name || 'Error',
      errorValue: error.message,
      customer: '5f5abacf',
      slackMemberIdFallback: 'U08S7AVJ478',
      devinUserId: data.devinUserId,
      devinEmail: data.devinEmail,
      devinOrgId: data.devinOrgId,
      service: SERVICE,
      verticalLabel: 'Celonis — Enterprise AI Solutions',
      tags: [
        { key: 'route', value: ROUTE },
        { key: 'service', value: SERVICE },
      ],
      extra: { briefId, track: data.track },
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
    }).catch((alertError) => {
      logger.error('Failed to trigger Devin session from solutions discovery error', { error: alertError.message });
    });
    throw error;
  }
}

module.exports = {
  discoverSolutions,
  SOLUTION_TRACKS,
  VALUE_BENCHMARKS,
};
