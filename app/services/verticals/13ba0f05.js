const crypto = require('crypto');
const Sentry = require('@sentry/node');
const logger = require('../../telemetry/logger');
const { createSessionAndAlert } = require('../devin-session');
const { createDevinSession } = require('../devin-api');
const { getCustomerConfig } = require('../../../config/customers');
const jira = require('../jira');
const { canCreateSession, reserveSession } = require('../session-rate-limiter');

const CUSTOMER = '13ba0f05';
const SERVICE = 'customer-13ba0f05-fuel-change';
const ROUTE = 'POST /api/13ba0f05/fuel-change';
const CULPRIT = 'app/services/verticals/13ba0f05.js — checkPermitHeadroom';
const REPO = 'COG-GTM/event-driven-devin';
const JIRA_PROJECT_KEY = process.env.MAINSPRING_JIRA_PROJECT_KEY || 'MBA';
const JIRA_ASSIGNEE_ACCOUNT_ID = process.env.MAINSPRING_JIRA_ASSIGNEE_ACCOUNT_ID
  || '712020:b8c6e298-ac94-4127-b5d1-d5e182e57b49';
// Presenter whose Devin recents the on-call session lands in when the browser has no saved identity.
const DEFAULT_PRESENTER = {
  devinUserId: process.env.MAINSPRING_PRESENTER_DEVIN_USER_ID || 'email|69efcc3741b62dd9be352f7c',
  devinEmail: process.env.MAINSPRING_PRESENTER_EMAIL || 'shahmir.masood@cognition.ai',
};
const DAY_MS = 24 * 60 * 60 * 1000;
const ALERT_COOLDOWN_MS = Number(process.env.MAINSPRING_ALERT_COOLDOWN_MS) || 60 * 1000;

const SITES = [
  {
    id: 'iad-dc07', name: 'Ashburn DC-07', customer: 'Data center campus (islanded)', region: 'PJM · Loudoun County, VA',
    units: 24, unitKw: 250, loadKw: 5420, fuel: 'NG_PIPELINE', availability: 99.997, permit: 'VA DEQ Art. 6 · Reg. 71034',
    permitNoxTonsPerYear: 9.5,
  },
  {
    id: 'sjc-hq', name: 'Santa Clara Campus', customer: 'Enterprise HQ (grid-parallel)', region: 'CAISO · Santa Clara, CA',
    units: 8, unitKw: 250, loadKw: 1610, fuel: 'NG_PIPELINE', availability: 99.991, permit: 'BAAQMD Permit 24-7781',
    permitNoxTonsPerYear: 2.0,
  },
  {
    id: 'oak-wwtp', name: 'East Bay Water Reclamation', customer: 'Utility (biogas, grid-parallel)', region: 'CAISO · Oakland, CA',
    units: 4, unitKw: 250, loadKw: 880, fuel: 'RNG_BIOGAS', availability: 99.982, permit: 'BAAQMD Permit 22-3105',
    permitNoxTonsPerYear: 1.2,
  },
];

// Fuels the Linear Generator is certified to run, as listed in the fuel-change wizard.
const FUELS = {
  NG_PIPELINE: { id: 'NG_PIPELINE', label: 'Pipeline natural gas', carbon: 'Baseline', h2Percent: 0 },
  RNG_BIOGAS: { id: 'RNG_BIOGAS', label: 'Renewable natural gas (biogas)', carbon: 'Carbon-negative capable', h2Percent: 0 },
  H2NG_30: { id: 'H2NG_30', label: 'Hydrogen blend (30% H₂ / NG)', carbon: '~10% lower CO₂', h2Percent: 30 },
};

// Air-permit emission factors per fuel (lb/MWh), synced from the compliance service.
const PERMIT_EMISSION_FACTORS = {
  NG_PIPELINE: { noxLbPerMWh: 0.013, coLbPerMWh: 0.11, co2LbPerMWh: 1050 },
  RNG_BIOGAS: { noxLbPerMWh: 0.016, coLbPerMWh: 0.13, co2LbPerMWh: 0 },
  H2_BLEND_30: { noxLbPerMWh: 0.015, coLbPerMWh: 0.09, co2LbPerMWh: 945 },
};

const REMEDIATION_DIRECTIVE = [
  `*Repository to investigate and fix:* \`${REPO}\`. Open a pull request against \`main\`; do not merge or deploy.`,
  '',
  'Mainspring Fleet Console (/mainspring-fleet or /13ba0f05): operators cannot move a site onto the 30% hydrogen blend. Fuel changes to pipeline natural gas and RNG/biogas go through.',
  'Reproduce: open /mainspring-fleet → Ashburn DC-07 → Change fuel → Hydrogen blend (30% H₂ / NG) → Review → Apply fuel change.',
  '- Service: `app/services/verticals/13ba0f05.js` (`applyFuelChange` → `checkPermitHeadroom`, `FUELS`, `PERMIT_EMISSION_FACTORS`)',
  '- Route: `app/routes/verticals/13ba0f05.js` · Page: `app/public/verticals/13ba0f05.html`',
  'Use Sentry and Datadog through MCP to confirm the failing fuel and site before changing code.',
  'Fix the root cause so every certified fuel in the wizard resolves its air-permit emission factors. Keep the existing factor values unchanged.',
  'Add regression coverage in `tests/13ba0f05-mainspring.test.js` that applies every fuel to every site, and update the planted-failure expectations after the fix.',
  'Do not disable Sentry/alerts, swallow the error, skip the permit check, or fake a scheduled change in the browser.',
  'Update the Jira ticket with the root cause and the pull request link.',
].join('\n');

const fuelChanges = [];
const incidents = [];
const ideaRequests = new Map();
let lastAlertAt = 0;

const invalid = (message, code) => Object.assign(new Error(message), { name: 'ValidationError', status: 400, code });

function siteState() {
  return SITES.map((s) => ({ ...s, fuelLabel: FUELS[s.fuel].label }));
}

function getFleet() {
  return { sites: siteState(), fuels: Object.values(FUELS), changes: fuelChanges.slice(0, 5) };
}

function checkPermitHeadroom(site, fuel) {
  const factors = PERMIT_EMISSION_FACTORS[fuel.id];
  const annualMWh = (site.loadKw / 1000) * 8760;
  const noxTons = (annualMWh * factors.noxLbPerMWh) / 2000;
  return {
    annualMWh: Math.round(annualMWh),
    projectedNoxTons: Math.round(noxTons * 1000) / 1000,
    permitNoxTons: site.permitNoxTonsPerYear,
    headroomPct: Math.round((1 - noxTons / site.permitNoxTonsPerYear) * 1000) / 10,
    co2TonsPerYear: Math.round((annualMWh * factors.co2LbPerMWh) / 2000),
  };
}

function sentryUrl(eventId) {
  const org = process.env.SENTRY_ORG_SLUG || 'sentry-org';
  const query = eventId ? `id%3A${eventId}` : 'is%3Aunresolved';
  return `https://${org}.sentry.io/issues/?project=${process.env.SENTRY_PROJECT_ID || ''}&query=${query}`;
}

function buildJiraDescription(ctx) {
  return [
    'Fleet operators cannot move a site onto the 30% hydrogen blend in the Mainspring Fleet Console. Fuel changes to pipeline natural gas and RNG/biogas are scheduled normally.',
    [
      `Error: ${ctx.error.name}: ${ctx.error.message}`,
      `Site: ${ctx.site.name} (${ctx.site.id}), ${ctx.site.units} Linear Generators, ${ctx.site.loadKw} kW load`,
      `Requested fuel: ${ctx.fuel.label} (${ctx.fuel.id})`,
      `Change order: ${ctx.changeId}`,
      `Sentry: ${ctx.sentryUrl}`,
    ].join('\n'),
    `Impact\n${ctx.site.name} stays on pipeline gas; the customer's hydrogen-readiness milestone and the site's decarbonization reporting slip. Every fleet site requesting the H₂ blend is blocked.`,
    'Steps to reproduce\n1. Open https://devindemos.com/mainspring-fleet.\n2. Ashburn DC-07 → Change fuel → Hydrogen blend (30% H₂ / NG) → Review.\n3. Click Apply fuel change.',
    'Expected: the change is scheduled with a permit headroom check. Actual: "Fuel change not applied" and HTTP 500 from POST /api/13ba0f05/fuel-change.',
    'Acceptance criteria\n- Every certified fuel in the wizard resolves its air-permit emission factors.\n- Existing factor values are unchanged.\n- Regression test applies every fuel to every site.',
    `Repository: https://github.com/${REPO}`,
  ].join('\n\n');
}

async function fileJiraTicket(ctx) {
  if (!jira.isConfigured()) {
    logger.warn('Jira not configured — skipping Mainspring ticket', { changeId: ctx.changeId });
    return null;
  }
  try {
    const issue = await jira.createIssue({
      projectKey: JIRA_PROJECT_KEY,
      issueType: 'Bug',
      summary: `[Mainspring] Fuel change to ${ctx.fuel.label} fails with ${ctx.error.name} at ${ctx.site.name}`,
      description: buildJiraDescription(ctx),
      labels: ['mainspring', 'sentry', 'devin-remediation', 'fuel-change'],
      priority: 'High',
      assigneeAccountId: JIRA_ASSIGNEE_ACCOUNT_ID,
    });
    logger.info('Mainspring Jira ticket created', { key: issue.key, changeId: ctx.changeId });
    return issue;
  } catch (error) {
    logger.error('Failed to create Mainspring Jira ticket', { changeId: ctx.changeId, error: error.message, status: error.response?.status });
    return null;
  }
}

async function reportFuelChangeFailure(error, ctx, identity) {
  const tags = { route: ROUTE, service: SERVICE, customer: CUSTOMER, site_id: ctx.site.id, fuel_id: ctx.fuel.id, alert_path: 'instant' };
  logger.error('Fuel change failed', { service: SERVICE, changeId: ctx.changeId, siteId: ctx.site.id, fuelId: ctx.fuel.id, error: error.message });
  if (identity.suppressAlerts) return null;
  const now = Date.now();
  if (now - lastAlertAt < ALERT_COOLDOWN_MS) {
    logger.info('Mainspring alert cooldown active; reset to alert again', { service: SERVICE, changeId: ctx.changeId });
    return null;
  }
  lastAlertAt = now;
  const eventId = Sentry.captureException(error, { tags, extra: { changeId: ctx.changeId } });
  const incident = {
    id: ctx.changeId, createdAt: new Date(now).toISOString(), error: `${error.name}: ${error.message}`,
    site: ctx.site.name, fuel: ctx.fuel.label, sentryUrl: sentryUrl(eventId), jira: null, session: null, state: 'filing-ticket',
  };
  incidents.unshift(incident);
  incidents.length = Math.min(incidents.length, 20);
  const issue = await fileJiraTicket({ ...ctx, error, sentryUrl: incident.sentryUrl });
  incident.jira = issue ? { key: issue.key, url: issue.url } : null;
  incident.state = 'starting-devin';
  const header = issue ? `*Jira ticket:* ${issue.key} - ${issue.url}` : '*Jira ticket:* not created (Jira unavailable) - skip the Jira steps below.';
  createSessionAndAlert({
    title: issue ? `${issue.key}: Mainspring fuel change fails for ${ctx.fuel.label}` : `Mainspring on-call: fuel change fails for ${ctx.fuel.label}`,
    issueTitle: `${error.name}: ${error.message}`,
    issueUrl: incident.sentryUrl,
    culprit: CULPRIT, errorType: error.name, errorValue: error.message,
    customer: CUSTOMER, service: SERVICE, verticalLabel: 'Mainspring Energy — Fleet fuel change',
    level: 'error', platform: 'node',
    ...(identity.devinUserId ? { devinUserId: identity.devinUserId, devinEmail: identity.devinEmail } : DEFAULT_PRESENTER),
    devinOrgId: identity.devinOrgId,
    promptAppendix: [header, eventId ? `*Sentry event ID:* \`${eventId}\`` : '', '', REMEDIATION_DIRECTIVE].filter((l, i) => l || i > 1).join('\n'),
    skipVulnerablePr: true,
    tags: [...Object.entries(tags).map(([key, value]) => ({ key, value })), ...(issue ? [{ key: 'jira', value: issue.key }] : [])],
    extra: { changeId: ctx.changeId, jiraKey: issue?.key || '' },
  })
    .then(async (result) => {
      const url = result?.session?.url || null;
      incident.session = url ? { url } : null;
      incident.state = url ? 'devin-investigating' : (result ? 'alert-only' : 'alert-failed');
      if (issue && url) await jira.addComment(issue.key, `Devin is investigating this issue: ${url}`).catch(() => {});
    })
    .catch((err) => {
      incident.state = 'alert-failed';
      logger.error('Failed to create Devin session for Mainspring fuel change', { error: err.message, changeId: ctx.changeId });
    });
  return incident;
}

async function applyFuelChange({ siteId, fuelId, ...identity } = {}) {
  const site = SITES.find((s) => s.id === siteId);
  if (!site) throw invalid('Choose a site.', 'UNKNOWN_SITE');
  const fuel = Object.hasOwn(FUELS, fuelId) ? FUELS[fuelId] : null;
  if (!fuel) throw invalid('Choose a certified fuel.', 'UNKNOWN_FUEL');
  if (fuel.id === site.fuel) throw invalid(`${site.name} already runs on ${fuel.label}.`, 'NO_CHANGE');
  const changeId = `FC-${crypto.randomBytes(3).toString('hex').toUpperCase()}`;
  const ctx = { site, fuel, changeId };
  let permit;
  try {
    permit = checkPermitHeadroom(site, fuel);
  } catch (error) {
    const incident = await reportFuelChangeFailure(error, ctx, identity);
    throw Object.assign(error, {
      status: 500, code: 'FUEL_CHANGE_FAILED', reference: changeId, incidentId: incident ? incident.id : null,
      publicMessage: 'Fuel change not applied. The permit headroom check could not complete. The site keeps running on its current fuel.',
    });
  }
  const scheduledFor = new Date(Date.now() + 2 * 60 * 60 * 1000).toISOString();
  const change = {
    id: changeId, siteId: site.id, site: site.name, from: FUELS[site.fuel].label, to: fuel.label, units: site.units,
    permit, scheduledFor, rollout: 'Rolling, 4 units at a time, no load interruption', status: 'Scheduled',
  };
  site.fuel = fuel.id;
  fuelChanges.unshift(change);
  fuelChanges.length = Math.min(fuelChanges.length, 20);
  logger.info('Fuel change scheduled', { service: SERVICE, changeId, siteId: site.id, fuelId: fuel.id });
  return change;
}

const INITIAL_FUELS = Object.fromEntries(SITES.map((s) => [s.id, s.fuel]));
function resetFleet() {
  for (const s of SITES) s.fuel = INITIAL_FUELS[s.id];
  fuelChanges.length = 0;
  lastAlertAt = 0;
  return getFleet();
}

function listIncidents() {
  return incidents.slice(0, 5);
}

/* ---------------- Greenfield: evidence-backed feature ideas ---------------- */

const IDEAS = [
  {
    id: 'jen-copilot',
    title: 'JEN fault copilot in the console',
    pitch: 'Click any active fault and get a ranked diagnosis, the evidence behind it and the next field step, right next to the unit telemetry.',
    evidence: [
      { label: 'Bridgenext case study: Mainspring launched JEN to support fault diagnosis across hundreds of fault scenarios', url: 'https://www.bridgenext.com/our-work/success-stories/designing-scalable-diagnostic-ai-for-mainspring-energy/' },
      { label: 'Lever: Fleet Operations & Analytics Engineer (O&M)', url: 'https://jobs.lever.co/mainspringenergy/5b7ff74e-c82a-4ec1-b52f-7d7a27edb672' },
    ],
    build: 'Add a Faults tab to the Mainspring console with 6 realistic synthetic Linear Generator faults (e.g. piston oscillator amplitude drift, reactor intake pressure low, inverter DC bus ripple). Clicking a fault opens a "JEN diagnosis" panel: ranked likely causes with confidence, the telemetry evidence for each (mini sparkline from synthetic data), and the recommended field action. Add an API `GET /api/13ba0f05/faults` and `POST /api/13ba0f05/faults/:id/diagnose` backed by a deterministic rules engine in the service (no external LLM calls).',
  },
  {
    id: 'islanded-capacity',
    title: 'Islanded data center capacity planner',
    pitch: 'Plan the next 25–50 MW block for an islanded campus: N+2 redundancy, unit count, ramp schedule and fuel draw, before a single diesel genset is ordered.',
    evidence: [
      { label: 'Latitude Media: first AI data center islanded on Mainspring generators, scaling in 25–50 MW increments', url: 'https://www.latitudemedia.com/news/one-year-inside-mainsprings-data-center-pipeline/' },
      { label: 'Mainspring data center solution page', url: 'https://www.mainspringenergy.com/solutions/data-center' },
    ],
    build: 'Add a Capacity planner tab: inputs for IT load growth (MW per quarter), target availability (99.99 / 99.999), redundancy (N+1 / N+2) and fuel. Output a quarter-by-quarter table of units to install, spinning reserve, fuel draw (MMBtu/day) and projected NOx against the site permit, plus a simple stacked bar chart drawn with inline SVG. Add `POST /api/13ba0f05/capacity-plan` with input validation and unit tests for the sizing math.',
  },
  {
    id: 'permit-headroom',
    title: 'Air-permit headroom tracker',
    pitch: 'See every site\'s rolling 12-month NOx and CO against its permit cap, and how much more load or which fuel switch still fits before the next filing.',
    evidence: [
      { label: 'Mainspring product page: near-zero NOx without SCR enables larger builds under regulatory caps', url: 'https://www.mainspringenergy.com/product' },
      { label: 'Latitude Media: Mainspring positioned for capacity and transmission bottlenecks', url: 'https://www.latitudemedia.com/news/one-year-inside-mainsprings-data-center-pipeline/' },
    ],
    build: 'Add a Permits tab listing each site with rolling 12-month NOx/CO (synthetic monthly data), permit cap, % used and a "what fits" calculator (extra kW at current fuel, or the effect of switching fuel). Reuse `PERMIT_EMISSION_FACTORS`. Add `GET /api/13ba0f05/permits` and tests for the rolling-window math. Do not change the fuel-change path or its alerting.',
  },
];

function dailyCap() {
  const n = Number(process.env.MAINSPRING_IDEA_REQUESTS_PER_DAY);
  return Number.isFinite(n) && n >= 0 ? n : 5;
}
function requestsToday(now) {
  return [...ideaRequests.values()].filter((r) => now - r.createdAt < DAY_MS).length;
}

function buildIdeaPrompt(idea) {
  return [
    `# Mainspring Fleet Console — build: ${idea.title}`,
    '',
    `A Mainspring Energy product lead wants this new capability in the Fleet Console mock served at https://devindemos.com/mainspring-fleet: ${idea.pitch}`,
    '',
    '## Why (public evidence)',
    ...idea.evidence.map((e) => `- ${e.label}: ${e.url}`),
    '',
    '## What to build',
    idea.build,
    '',
    '## Scope',
    `- Repository: ${REPO}. Work on a new branch and open a pull request against \`main\`. Do not merge it.`,
    `- Only edit \`app/public/verticals/${CUSTOMER}.html\`, \`app/routes/verticals/${CUSTOMER}.js\`, \`app/services/verticals/${CUSTOMER}.js\` and \`tests/${CUSTOMER}-mainspring.test.js\`.`,
    '- Keep the console look: dark navy shell, Mainspring green accents, Inter/system font. All data is synthetic.',
    '- Do not change the fuel-change path (`applyFuelChange`, `checkPermitHeadroom`) or its alerting.',
    '',
    '## Done means',
    `- \`npm run lint\` and \`npx jest tests/${CUSTOMER}-mainspring.test.js tests/verticals-registry.test.js\` pass, with new tests for the feature.`,
    '- You ran the app locally (`PORT=3100 node app/server.js`), opened /mainspring-fleet, exercised the feature and embedded a screenshot in the PR description.',
    `- PR title is "Mainspring feature: ${idea.title}". The description opens with the evidence links above, then two plain sentences on what an operator can now do.`,
  ].join('\n');
}

async function createIdeaRequest({ ideaId, devinUserId, devinOrgId, devinEmail } = {}, now = Date.now()) {
  const idea = IDEAS.find((i) => i.id === ideaId);
  if (!idea) throw invalid('Unknown idea.', 'UNKNOWN_IDEA');
  if (requestsToday(now) >= dailyCap()) {
    throw Object.assign(new Error(`Daily limit reached (${dailyCap()} Devin builds per day).`), { status: 429, code: 'IDEA_REQUEST_LIMIT' });
  }
  const capacity = canCreateSession();
  if (!capacity.allowed) {
    throw Object.assign(new Error('Devin is at capacity right now. Try again in a few minutes.'), { status: 429, code: 'SESSION_CAP' });
  }
  const release = reserveSession();
  const record = { id: crypto.randomBytes(6).toString('hex'), ideaId: idea.id, title: idea.title, createdAt: now, sessionUrl: null, state: 'queued' };
  ideaRequests.set(record.id, record);
  const config = getCustomerConfig(CUSTOMER);
  try {
    const session = await createDevinSession(buildIdeaPrompt(idea), {
      apiKey: config.apiKey,
      orgId: devinOrgId || config.devinOrgId,
      userId: devinUserId || config.devinUserId || DEFAULT_PRESENTER.devinUserId,
      userEmail: devinEmail || DEFAULT_PRESENTER.devinEmail,
      title: `Mainspring feature: ${idea.title}`,
      repos: [REPO],
    });
    record.state = session ? 'working' : 'unavailable';
    record.sessionUrl = session ? session.url : null;
    if (!session) { release(); ideaRequests.delete(record.id); }
  } catch (error) {
    release();
    ideaRequests.delete(record.id);
    record.state = 'unavailable';
    logger.error('Mainspring idea session failed', { ideaId: idea.id, error: error.message, status: error.response?.status });
  }
  return { ...record, createdAt: new Date(record.createdAt).toISOString() };
}

function listIdeas(now = Date.now()) {
  return {
    ideas: IDEAS.map(({ build: _build, ...rest }) => rest),
    cap: dailyCap(),
    usedToday: requestsToday(now),
    requests: [...ideaRequests.values()].sort((a, b) => b.createdAt - a.createdAt).slice(0, 5)
      .map((r) => ({ ...r, createdAt: new Date(r.createdAt).toISOString() })),
  };
}

module.exports = {
  CUSTOMER, SERVICE, ROUTE, SITES, FUELS, PERMIT_EMISSION_FACTORS, IDEAS, REMEDIATION_DIRECTIVE, DEFAULT_PRESENTER,
  getFleet, applyFuelChange, checkPermitHeadroom, resetFleet, listIncidents, listIdeas, createIdeaRequest, buildIdeaPrompt, buildJiraDescription,
  _incidents: incidents, _ideaRequests: ideaRequests,
};
