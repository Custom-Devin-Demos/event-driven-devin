const { v4: uuidv4 } = require('uuid');
const logger = require('../../telemetry/logger');
const { incrementMetric, recordTiming } = require('../../telemetry/datadog');
const { Sentry } = require('../../telemetry/sentry');
const { createSessionAndAlert } = require('../devin-session');
const { readAssetRecords, shopVisitInterval, ASSET_RECORDS_SCHEMA, ENGINE_RECORDS } = require('./af1dce4f-asset-records');

const SERVICE = 'af1dce4f-api';
const ROUTE = '/api/af1dce4f/fleet-health/report';

const CUSTOMERS = [
  { id: 'AIR-A', name: 'Airline A', type: 'Airline', region: 'North America', fleet: 'LEAP-1B · NX-1B', engines: 6, apps: ['fleet-health', 'shop-visit-planner'] },
  { id: 'AIR-B', name: 'Airline B', type: 'Airline', region: 'Europe', fleet: 'LEAP-1B · NX-115B', engines: 8, apps: ['fleet-health', 'parts-desk'] },
  { id: 'LES-C', name: 'Lessor C', type: 'Lessor', region: 'Ireland', fleet: 'LEAP-1B · RJ-8E · NX-1B', engines: 6, apps: ['fleet-health', 'shop-visit-planner'] },
];

const AGENTS = [
  {
    id: 'fleet-health-report',
    name: 'Fleet Health Report',
    objective: 'Generate a per-customer engine health report: cycles since last shop visit, EGT margin trend, derate posture and a ranked watch list.',
    ownerTeam: 'Fleet Analytics',
    dataProducts: ['asset-records', 'flight-pulse', 'shop-visits'],
    model: 'gpt-4.1 · Azure Foundry (eastus2)',
    customers: ['AIR-A', 'AIR-B', 'LES-C'],
    status: 'active',
    version: '2.8.1',
    runsThisWeek: 412,
    tools: ['asset_records.read_fleet', 'flight_pulse.egt_trend', 'shop_visits.history', 'report.render_markdown'],
  },
  {
    id: 'shop-visit-forecaster',
    name: 'Shop Visit Forecaster',
    objective: 'Forecast the next shop visit window for each engine from cycle accrual, soft-life limits and current workscope backlog.',
    ownerTeam: 'Services Planning',
    dataProducts: ['asset-records', 'shop-visits'],
    model: 'gpt-4.1 · Azure Foundry (eastus2)',
    customers: ['AIR-A', 'LES-C'],
    status: 'active',
    version: '1.6.0',
    runsThisWeek: 238,
    tools: ['asset_records.read_fleet', 'shop_visits.capacity', 'forecast.monte_carlo'],
  },
  {
    id: 'parts-availability',
    name: 'Parts Availability',
    objective: 'Answer parts availability questions for an open workscope and recommend substitutions from the approved parts list.',
    ownerTeam: 'Material Services',
    dataProducts: ['shop-visits'],
    model: 'claude-sonnet-4.5 · Azure Foundry (westeurope)',
    customers: ['AIR-B'],
    status: 'active',
    version: '3.1.4',
    runsThisWeek: 391,
    tools: ['shop_visits.open_workscopes', 'parts.stock_lookup', 'parts.approved_substitutes'],
  },
  {
    id: 'tech-records-summarizer',
    name: 'Tech Records Summarizer',
    objective: 'Summarize technical records and borescope findings for an engine ahead of a lease return or shop induction.',
    ownerTeam: 'Fleet Analytics',
    dataProducts: ['asset-records'],
    model: 'gpt-4.1-mini · Azure Foundry (eastus2)',
    customers: ['LES-C'],
    status: 'pilot',
    version: '0.9.2',
    runsThisWeek: 57,
    tools: ['asset_records.read_engine', 'records.search_findings', 'report.render_markdown'],
  },
];

const APPS = [
  { id: 'fleet-health', name: 'Fleet Health', description: 'Per-customer dashboard: engine health, open alerts and a generated fleet report.', agents: ['fleet-health-report'], customers: ['AIR-A', 'AIR-B', 'LES-C'], status: 'live', owner: 'Fleet Analytics', ui: 'Dashboard · generated' },
  { id: 'shop-visit-planner', name: 'Shop Visit Planner', description: 'Forecast shop visit windows and reserve slots across the MRO network.', agents: ['shop-visit-forecaster'], customers: ['AIR-A', 'LES-C'], status: 'live', owner: 'Services Planning', ui: 'Planner · generated' },
  { id: 'parts-desk', name: 'Parts Desk', description: 'Conversational parts availability and substitution for open workscopes.', agents: ['parts-availability'], customers: ['AIR-B'], status: 'live', owner: 'Material Services', ui: 'Chat · generated' },
];

const DATA_PRODUCTS = [
  {
    id: 'asset-records',
    name: 'Asset Records',
    description: 'Engine configuration, utilisation (TSN/CSN) and shop visit history per serial number.',
    schemaVersion: ASSET_RECORDS_SCHEMA.version,
    previousVersion: ASSET_RECORDS_SCHEMA.previousVersion,
    lastChange: ASSET_RECORDS_SCHEMA.publishedAt,
    changeAuthor: ASSET_RECORDS_SCHEMA.author,
    changeTeam: ASSET_RECORDS_SCHEMA.team,
    changeId: ASSET_RECORDS_SCHEMA.changeId,
    changeSummary: ASSET_RECORDS_SCHEMA.changeSummary,
    owner: 'Asset Data Platform',
    dependents: ['fleet-health-report', 'shop-visit-forecaster', 'tech-records-summarizer'],
    fields: ASSET_RECORDS_SCHEMA.fields,
  },
  {
    id: 'flight-pulse',
    name: 'Flight Pulse',
    description: 'Per-flight engine performance snapshots: EGT margin, vibration, fuel flow and derate.',
    schemaVersion: '7.1.2',
    previousVersion: '7.1.1',
    lastChange: '2026-09-02T09:40:00Z',
    changeAuthor: 'm.delacroix',
    changeTeam: 'Flight Data Services',
    changeId: 'FDS-1180',
    changeSummary: 'Added vibrationN2 to snapshot; no breaking changes.',
    owner: 'Flight Data Services',
    dependents: ['fleet-health-report'],
    fields: [
      { name: 'esn', type: 'string', nullable: false },
      { name: 'flightId', type: 'string', nullable: false },
      { name: 'egtMarginC', type: 'number', nullable: false },
      { name: 'vibrationN1', type: 'number', nullable: false },
      { name: 'vibrationN2', type: 'number', nullable: false, changedIn: '7.1.2' },
      { name: 'fuelFlowKgH', type: 'number', nullable: false },
    ],
  },
  {
    id: 'shop-visits',
    name: 'Shop Visits',
    description: 'Shop visit events, workscopes, induction and release dates across the MRO network.',
    schemaVersion: '3.4.0',
    previousVersion: '3.3.2',
    lastChange: '2026-07-15T16:05:00Z',
    changeAuthor: 'k.svensson',
    changeTeam: 'Services Data',
    changeId: 'SVD-402',
    changeSummary: 'Workscope codes aligned to the 2026 MRO network catalogue.',
    owner: 'Services Data',
    dependents: ['fleet-health-report', 'shop-visit-forecaster', 'parts-availability'],
    fields: [
      { name: 'visitId', type: 'string', nullable: false },
      { name: 'esn', type: 'string', nullable: false },
      { name: 'shop', type: 'string', nullable: false },
      { name: 'workscope', type: 'string', nullable: false },
      { name: 'inductedAt', type: 'date', nullable: false },
      { name: 'releasedAt', type: 'date', nullable: true },
    ],
  },
];

const BASELINE_CELLS = {
  'fleet-health-report': { 'AIR-A': { errorRate: 0.0, p95Ms: 1840, uptime: 99.98 }, 'AIR-B': { errorRate: 0.0, p95Ms: 1910, uptime: 99.97 }, 'LES-C': { errorRate: 0.0, p95Ms: 1790, uptime: 99.99 } },
  'shop-visit-forecaster': { 'AIR-A': { errorRate: 0.2, p95Ms: 3120, uptime: 99.95 }, 'LES-C': { errorRate: 0.0, p95Ms: 2980, uptime: 99.97 } },
  'parts-availability': { 'AIR-B': { errorRate: 0.4, p95Ms: 2210, uptime: 99.93 } },
  'tech-records-summarizer': { 'LES-C': { errorRate: 1.1, p95Ms: 4460, uptime: 99.80 } },
};

const SEED_INCIDENTS = [
  {
    id: 'INC-2026-0412',
    severity: 'S3',
    title: 'Shop Visit Forecaster returning stale capacity for Celma',
    customerId: 'AIR-A',
    agentId: 'shop-visit-forecaster',
    status: 'Resolved',
    openedAt: '2026-09-23T07:12:00Z',
    resolvedAt: '2026-09-23T10:48:00Z',
    rootCause: 'Shop Visits 3.4.0 renamed capacity buckets; the forecaster cached the 3.3.2 bucket names and silently fell back to the previous week.',
    confidence: 'High',
    recommendedOwner: 'Services Planning',
    affected: 'Airline A (Shop Visit Planner). Lessor C unaffected — its cached buckets had already refreshed.',
    rca: 'Devin traced the stale forecast to a cache key built from the pre-3.4.0 capacity bucket names, reproduced it against the Celma capacity feed, and confirmed the 3.3.2 → 3.4.0 rename as the root cause.',
    accountNote: 'Shop visit windows shown between 06:40 and 10:50 UTC on 23 Sep used last week\'s Celma capacity. Current forecasts are correct; no slot reservations were affected.',
    pr: { label: 'PR #4182 · fix(forecaster): rebuild capacity cache keys from Shop Visits 3.4.0', url: '#' },
    session: { label: 'Devin session · 23 Sep 2026', url: '#' },
    timeline: [
      { at: '2026-09-23T07:12:00Z', event: 'Detected — forecast drift alert fired' },
      { at: '2026-09-23T07:14:00Z', event: 'Devin picked up the alert and started investigating' },
      { at: '2026-09-23T07:41:00Z', event: 'RCA posted to incident channel' },
      { at: '2026-09-23T08:05:00Z', event: 'PR #4182 opened with fix and regression test' },
      { at: '2026-09-23T10:20:00Z', event: 'PR approved by Services Planning and merged' },
      { at: '2026-09-23T10:48:00Z', event: 'Deployed via standard pipeline — resolved' },
    ],
  },
  {
    id: 'INC-2026-0398',
    severity: 'S4',
    title: 'Parts Desk timing out on multi-part substitution queries',
    customerId: 'AIR-B',
    agentId: 'parts-availability',
    status: 'Resolved',
    openedAt: '2026-09-09T15:30:00Z',
    resolvedAt: '2026-09-10T09:15:00Z',
    rootCause: 'Substitution lookups were issued serially per part; queries with more than six parts exceeded the 30 s gateway timeout.',
    confidence: 'High',
    recommendedOwner: 'Material Services',
    affected: 'Airline B (Parts Desk) — 14 queries over two days. No other customer uses Parts Desk.',
    rca: 'Devin reproduced the timeout with a nine-part workscope, profiled the agent tool calls and found the approved-substitutes lookup running one part at a time.',
    accountNote: 'Some multi-part availability questions timed out on 9–10 Sep. The lookup is now parallelised and completes in under 4 s.',
    pr: { label: 'PR #4097 · perf(parts): batch approved-substitute lookups', url: '#' },
    session: { label: 'Devin session · 9 Sep 2026', url: '#' },
    timeline: [
      { at: '2026-09-09T15:30:00Z', event: 'Detected — p95 latency alert fired' },
      { at: '2026-09-09T15:33:00Z', event: 'Devin picked up the alert and started investigating' },
      { at: '2026-09-09T16:20:00Z', event: 'RCA posted to incident channel' },
      { at: '2026-09-09T17:02:00Z', event: 'PR #4097 opened with fix and load test' },
      { at: '2026-09-10T08:40:00Z', event: 'PR approved by Material Services and merged' },
      { at: '2026-09-10T09:15:00Z', event: 'Deployed via standard pipeline — resolved' },
    ],
  },
];

const RUNS = [];
const OPEN_INCIDENTS = [];
let resetEpoch = 0;
let incidentSequence = 431;

function capRuns() {
  RUNS.splice(25);
}

function cyclesSinceShopVisit(engine) {
  return engine.csn - engine.lastShopVisit.csnAtVisit;
}

function shopVisitSummary(engine) {
  const visit = engine.lastShopVisit;
  return { date: visit.date, shop: visit.shop, workscope: visit.workscope };
}

function scoreEngine(engine) {
  const interval = shopVisitInterval(engine.model);
  const cycles = cyclesSinceShopVisit(engine);
  const lifeUsed = Math.round((cycles / interval.softLimitCycles) * 1000) / 10;
  const egtScore = engine.egtMarginC < 20 ? 2 : engine.egtMarginC < 30 ? 1 : 0;
  const lifeScore = lifeUsed > 80 ? 2 : lifeUsed > 50 ? 1 : 0;
  const risk = egtScore + lifeScore;
  return {
    esn: engine.esn,
    tail: engine.tail,
    position: engine.position,
    model: engine.model,
    tsn: engine.tsn,
    csn: engine.csn,
    cyclesSinceShopVisit: cycles,
    softLifeUsedPct: lifeUsed,
    egtMarginC: engine.egtMarginC,
    derate: engine.derate,
    lastShopVisit: shopVisitSummary(engine),
    health: risk >= 3 ? 'watch' : risk >= 1 ? 'monitor' : 'healthy',
  };
}

function buildReport(reportId, customer, engines) {
  const scored = engines.map(scoreEngine).sort((a, b) => b.softLifeUsedPct - a.softLifeUsedPct);
  const watch = scored.filter((engine) => engine.health === 'watch');
  const monitor = scored.filter((engine) => engine.health === 'monitor');
  const avgEgt = Math.round((scored.reduce((sum, engine) => sum + engine.egtMarginC, 0) / scored.length) * 10) / 10;
  const summary = `${customer.name}: ${scored.length} engines assessed. ${watch.length} on watch, ${monitor.length} to monitor, ${scored.length - watch.length - monitor.length} healthy. Mean EGT margin ${avgEgt} °C. Next shop visit candidate: ${scored[0].tail} #${scored[0].position} (${scored[0].esn}) at ${scored[0].softLifeUsedPct}% of soft life.`;
  return {
    reportId,
    customerId: customer.id,
    customerName: customer.name,
    generatedAt: new Date().toISOString(),
    schemaVersion: engines[0].schemaVersion,
    engines: scored,
    counts: { watch: watch.length, monitor: monitor.length, healthy: scored.length - watch.length - monitor.length },
    meanEgtMarginC: avgEgt,
    summary,
  };
}

function openIncident(customer, error, requestId, reportId) {
  const existing = OPEN_INCIDENTS.find((inc) => inc.customerId === customer.id && inc.agentId === 'fleet-health-report' && !inc.resolvedAt);
  if (existing) {
    existing.occurrences += 1;
    existing.lastSeenAt = new Date().toISOString();
    existing.reportId = reportId;
    existing.requestId = requestId;
    existing.timeline.push({ at: existing.lastSeenAt, event: `Recurred — report ${reportId} (request ${requestId}) failed with the same error` });
    return existing;
  }
  incidentSequence += 1;
  const incident = {
    id: `INC-2026-${String(incidentSequence).padStart(4, '0')}`,
    severity: 'S2',
    title: `Fleet Health Report failing for ${customer.name}`,
    customerId: customer.id,
    agentId: 'fleet-health-report',
    status: 'Investigating · Devin',
    openedAt: new Date().toISOString(),
    resolvedAt: null,
    error: `${error.name}: ${error.message}`,
    requestId,
    reportId,
    occurrences: 1,
    lastSeenAt: new Date().toISOString(),
    rootCause: null,
    confidence: null,
    recommendedOwner: null,
    affected: `${customer.name} (Fleet Health). Other customers unaffected so far.`,
    rca: null,
    accountNote: null,
    pr: null,
    session: null,
    timeline: [
      { at: new Date().toISOString(), event: 'Detected — Fleet Health Report error-rate alert fired' },
      { at: new Date(Date.now() + 1500).toISOString(), event: 'Devin picked up the alert and started investigating' },
    ],
  };
  OPEN_INCIDENTS.unshift(incident);
  return incident;
}

async function generateFleetHealthReport(data) {
  const startTime = Date.now();
  const epoch = resetEpoch;
  const requestId = uuidv4();
  const reportId = `FHR-${requestId.slice(0, 8).toUpperCase()}`;
  const customer = CUSTOMERS.find((entry) => entry.id === data.customerId);

  logger.info('Generating fleet health report', {
    requestId,
    reportId,
    customerId: data.customerId,
    agent: 'fleet-health-report',
    service: SERVICE,
  });

  try {
    if (!customer) {
      const err = new Error(`Unknown customer ${data.customerId}`);
      err.name = 'ValidationError';
      err.status = 400;
      throw err;
    }
    await new Promise((resolve) => setTimeout(resolve, 70 + Math.random() * 110));
    const engines = await readAssetRecords(customer.id);
    const report = buildReport(reportId, customer, engines);
    if (epoch === resetEpoch) {
      RUNS.unshift({ reportId, customerId: customer.id, agentId: 'fleet-health-report', status: 'complete', completedAt: report.generatedAt, durationMs: Date.now() - startTime });
      capRuns();
    }
    incrementMetric('workbench.report.success', { route: ROUTE, customer: customer.id });
    recordTiming('workbench.report.latency', Date.now() - startTime, { route: ROUTE });
    return { success: true, requestId, report };
  } catch (error) {
    const duration = Date.now() - startTime;
    if (error.status === 400) throw error;
    incrementMetric('workbench.report.failure', { route: ROUTE, customer: customer.id, errorClass: error.name });
    recordTiming('workbench.report.latency', duration, { route: ROUTE, error: 'true' });
    logger.error('Fleet health report failed', {
      requestId,
      reportId,
      customerId: customer.id,
      error: error.message,
      errorClass: error.name,
      durationMs: duration,
      service: SERVICE,
    });
    let incident = null;
    if (epoch === resetEpoch) {
      RUNS.unshift({ reportId, customerId: customer.id, agentId: 'fleet-health-report', status: 'failed', error: `${error.name}: ${error.message}`, completedAt: new Date().toISOString(), durationMs: duration });
      capRuns();
      incident = openIncident(customer, error, requestId, reportId);
    }
    Sentry.captureException(error, {
      tags: { route: ROUTE, service: SERVICE, customer: customer.id, agent: 'fleet-health-report', alert_path: 'instant' },
      extra: { requestId, reportId, assetRecordsVersion: ASSET_RECORDS_SCHEMA.version },
    });
    createSessionAndAlert({
      issueTitle: `${error.name}: ${error.message}`,
      issueUrl: `https://${process.env.SENTRY_ORG_SLUG || 'sentry-org'}.sentry.io/issues/?project=${process.env.SENTRY_PROJECT_ID || ''}&query=is%3Aunresolved`,
      culprit: 'app/services/verticals/af1dce4f.js — generateFleetHealthReport',
      errorType: error.name || 'Error',
      errorValue: error.message,
      devinUserId: data.devinUserId,
      devinEmail: data.devinEmail,
      devinOrgId: data.devinOrgId,
      service: SERVICE,
      verticalLabel: 'AI Workbench — Fleet Health Report agent',
      slackMemberId: 'U0BDHHQUM24',
      tags: [
        { key: 'route', value: ROUTE },
        { key: 'service', value: SERVICE },
        { key: 'customer', value: customer.id },
        { key: 'agent', value: 'fleet-health-report' },
      ],
      extra: {
        requestId,
        reportId,
        incidentId: incident ? incident.id : null,
        customerId: customer.id,
        agent: 'fleet-health-report',
        dataProducts: ['asset-records', 'flight-pulse', 'shop-visits'],
        assetRecordsVersion: ASSET_RECORDS_SCHEMA.version,
        promptContext: `The Fleet Health Report agent on the AI Workbench failed while generating report ${reportId} for customer ${customer.id} (${customer.name}). The same agent is still succeeding for the other customers. The report reads engine records from the Asset Records data product (currently schema ${ASSET_RECORDS_SCHEMA.version}, published ${ASSET_RECORDS_SCHEMA.publishedAt} under change ${ASSET_RECORDS_SCHEMA.changeId}). ${customer.name}'s Fleet Health dashboard shows a report error and their cell on the Operations health grid is red until a report completes. Your RCA must state: what broke, who is affected and who is not, the root-cause change and its author, a confidence level, the recommended owning team, and a short plain-language note the account team can send to ${customer.name}.`,
      },
      level: 'error',
      platform: 'node',
      firstSeen: '',
      lastSeen: new Date().toISOString(),
      count: '',
      shortId: '',
      project: 'event-driven-devin',
      release: process.env.SENTRY_RELEASE || 'af1dce4f@1.0.0',
      environment: process.env.DD_ENV || 'prod',
      triggeredRule: '',
      promptAppendix: 'Fix the agent so a report completes for every customer whose fleet the Asset Records data product returns, under its current schema, without changing the data product itself. Add a regression test in tests/ that generates a Fleet Health report for each customer and asserts every engine row carries a numeric cyclesSinceShopVisit and a lastShopVisit summary, and verify the fix in the browser on /af1dce4f by viewing Fleet Health as Airline B and generating a report.',
    }).then((result) => {
      if (incident && !incident.session && result && result.session && result.session.url) {
        incident.session = { label: 'Devin session · live', url: result.session.url };
      }
    }).catch((err) => {
      logger.error('Failed to trigger Devin session from fleet health report error', { error: err.message });
    });
    throw error;
  }
}

function cellStatus(agentId, customerId) {
  const baseline = BASELINE_CELLS[agentId] && BASELINE_CELLS[agentId][customerId];
  if (!baseline) return null;
  const recent = RUNS.filter((run) => run.agentId === agentId && run.customerId === customerId);
  const failures = recent.filter((run) => run.status === 'failed').length;
  if (recent.length === 0) {
    return { ...baseline, state: baseline.errorRate > 1 ? 'yellow' : 'green', runs: 0 };
  }
  const latestFailed = recent[0].status === 'failed';
  const errorRate = Math.round((failures / recent.length) * 1000) / 10;
  return {
    errorRate: latestFailed ? Math.max(errorRate, 50) : errorRate,
    p95Ms: latestFailed ? baseline.p95Ms : Math.round((baseline.p95Ms + recent[0].durationMs) / 2),
    uptime: latestFailed ? Math.round((baseline.uptime - 0.6) * 100) / 100 : baseline.uptime,
    state: latestFailed ? 'red' : errorRate > 10 ? 'yellow' : 'green',
    runs: recent.length,
    lastError: latestFailed ? recent[0].error : null,
  };
}

function operationsGrid() {
  return AGENTS.map((agent) => ({
    agentId: agent.id,
    agentName: agent.name,
    cells: CUSTOMERS.map((customer) => ({ customerId: customer.id, ...(cellStatus(agent.id, customer.id) || { state: 'na' }) })),
  }));
}

function platformStatus() {
  return OPEN_INCIDENTS.length > 0 ? 'incident' : 'nominal';
}

function getOverview() {
  const grid = operationsGrid();
  const redCells = grid.reduce((sum, row) => sum + row.cells.filter((cell) => cell.state === 'red').length, 0);
  return {
    status: platformStatus(),
    customers: CUSTOMERS,
    agents: AGENTS,
    apps: APPS,
    dataProducts: DATA_PRODUCTS,
    fleets: ENGINE_RECORDS,
    grid,
    incidents: [...OPEN_INCIDENTS, ...SEED_INCIDENTS],
    runs: RUNS,
    summary: {
      activeAgents: AGENTS.filter((agent) => agent.status === 'active').length,
      apps: APPS.length,
      customersServed: CUSTOMERS.length,
      runsThisWeek: AGENTS.reduce((sum, agent) => sum + agent.runsThisWeek, 0) + RUNS.length,
      openIncidents: OPEN_INCIDENTS.length,
      hoursSavedThisWeek: 1184,
      redCells,
    },
  };
}

function resetWorkbench() {
  resetEpoch += 1;
  const cleared = RUNS.length + OPEN_INCIDENTS.length;
  RUNS.length = 0;
  OPEN_INCIDENTS.length = 0;
  logger.info('Workbench demo state reset', { cleared, service: SERVICE });
  incrementMetric('workbench.reset', { route: '/api/af1dce4f/fleet-health/reset' });
  return { success: true, cleared, status: platformStatus() };
}

module.exports = {
  generateFleetHealthReport,
  resetWorkbench,
  getOverview,
  CUSTOMERS,
  AGENTS,
  APPS,
  DATA_PRODUCTS,
  SEED_INCIDENTS,
};
