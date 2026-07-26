const { v4: uuidv4 } = require('uuid');
const logger = require('../../telemetry/logger');
const { incrementMetric, recordTiming } = require('../../telemetry/datadog');
const { Sentry } = require('../../telemetry/sentry');
const { createSessionAndAlert } = require('../devin-session');

/**
 * AI healthcare-agent catalog. Each agent is tagged with the audiences
 * it serves and the organizational goal / clinical specialty it maps to.
 */
const AGENTS = [
  { id: 'pernicious-anemia', title: 'Pernicious Anemia Management Call', goal: 'Care Management', specialties: ['General'], audiences: ['provider'] },
  { id: 'appointment-scheduling', title: 'Appointment Scheduling', goal: 'Inbound Access Point', specialties: ['Primary Care', 'General'], audiences: ['provider', 'payor'] },
  { id: 'patient-intake-history', title: 'Patient Intake History', goal: 'More Time For Care', specialties: ['Primary Care'], audiences: ['provider'] },
  { id: 'colorectal-screening', title: 'Colorectal Cancer Screening (COL)', goal: 'Quality Improvement', specialties: ['Oncology', 'Gastroenterology'], audiences: ['provider', 'payor'] },
  { id: 'flu-vaccination', title: 'Flu Vaccination (FVA)', goal: 'Quality Improvement', specialties: ['Primary Care'], audiences: ['provider', 'payor'] },
  { id: 'annual-wellness', title: 'Annual Wellness Visit Outreach and Support', goal: 'Quality Improvement', specialties: ['Geriatric', 'Primary Care'], audiences: ['provider', 'payor'] },
  { id: 'flood-preparedness', title: 'Flood Preparedness Outreach', goal: 'Rapid Response', specialties: ['General'], audiences: ['payor'] },
  { id: 'pneumonia-discharge', title: 'Pneumonia Post-Discharge Recovery Support', goal: 'Readmission Prevention', specialties: ['Primary Care'], audiences: ['provider'] },
  { id: 'diabetes-ccm', title: 'Diabetes Chronic Care Management', goal: 'Care Management', specialties: ['Diabetes'], audiences: ['provider', 'payor'] },
  { id: 'heart-failure-ccm', title: 'Heart Failure Care Management', goal: 'Care Management', specialties: ['Cardiology'], audiences: ['provider', 'payor'] },
  { id: 'ckd-management', title: 'Chronic Kidney Disease Management', goal: 'Care Management', specialties: ['Nephrology'], audiences: ['provider', 'payor'] },
  { id: 'chna', title: 'Community Health Needs Assessments', goal: 'Compliance', specialties: ['General'], audiences: ['payor'] },
  { id: 'sdoh-screening', title: 'SDOH Screening & Navigation', goal: 'Health Equity', specialties: ['General'], audiences: ['payor'] },
  { id: 'mammogram-outreach', title: 'Mammogram Screening Completion Outreach', goal: 'Access Growth', specialties: ['Oncology', 'OB/GYN'], audiences: ['provider', 'payor'] },
  { id: 'joint-recovery', title: 'Joint Replacement Post-Surgical Recovery Support', goal: 'Access Growth', specialties: ['Orthopedic'], audiences: ['provider'] },
  { id: 'joint-discharge', title: 'Lower Extremity Joint Replacement Discharge Call', goal: 'CMS Team', specialties: ['Orthopedic'], audiences: ['provider'] },
  { id: 'pap-outreach', title: 'Patient Assistance Program Outreach', goal: 'Access Growth', specialties: ['Pharma'], audiences: ['pharma'] },
  { id: 'adverse-event', title: 'Adverse Event Detection Support', goal: 'Compliance', specialties: ['Pharma'], audiences: ['pharma'] },
  { id: 'rwe-followup', title: 'RWE Longitudinal Patient Follow-Up', goal: 'Quality Improvement', specialties: ['Pharma'], audiences: ['pharma'] },
  { id: 'study-coordinator', title: 'Study Coordinator and Nurse Support', goal: 'More Time For Care', specialties: ['Pharma'], audiences: ['pharma'] },
];

/**
 * Audience segments the catalog can be filtered by. Each segment carries a
 * display label and the taxonomy that drives its specialty facet chips.
 */
const AUDIENCE_SEGMENTS = {
  provider: { id: 'provider', label: 'Provider', taxonomy: { specialties: ['Primary Care', 'Cardiology', 'Nephrology', 'Oncology', 'Orthopedic', 'Diabetes', 'Geriatric', 'Gastroenterology', 'OB/GYN', 'General'] } },
  payor: { id: 'payor', label: 'Payor', taxonomy: { specialties: ['Primary Care', 'Cardiology', 'Nephrology', 'Diabetes', 'Oncology', 'Medicare Advantage', 'General'] } },
  pharma: { id: 'pharma', label: 'Pharma', taxonomy: { specialties: ['Pharma', 'Oncology', 'General'] } },
};

/**
 * Resolve the audience segment selected via the Provider/Payor/Pharma tabs
 * into the normalized shape used by the catalog view.
 */
function resolveAudienceSegment(audienceId) {
  const raw = AUDIENCE_SEGMENTS[audienceId] || AUDIENCE_SEGMENTS.provider;
  return {
    id: raw.id,
    label: raw.label,
    agentIds: AGENTS.filter((a) => a.audiences.includes(raw.id)).map((a) => a.id),
  };
}

/**
 * Build the specialty facet chips shown for the active audience, marking the
 * selected specialty and counting how many catalog agents fall under each.
 */
function buildSpecialtyFacets(segment, agents, selectedSpecialty) {
  return segment.taxonomy.specialties.map((name) => ({
    name,
    selected: name === selectedSpecialty,
    count: agents.filter((a) => a.specialties.includes(name)).length,
  }));
}

/**
 * Filter the agent catalog for the requested audience tab, clinical
 * specialty, and organizational goal, and assemble the catalog view.
 */
function computeCatalogView(data) {
  const segment = resolveAudienceSegment(data.audience);

  let matches = AGENTS.filter((a) => a.audiences.includes(segment.id));
  if (data.specialty) {
    matches = matches.filter((a) => a.specialties.includes(data.specialty));
  }
  if (data.goal) {
    matches = matches.filter((a) => a.goal === data.goal);
  }

  const facets = buildSpecialtyFacets(segment, matches, data.specialty);

  return {
    audience: segment.id,
    audienceLabel: segment.label,
    specialtyLabel: data.specialty || '',
    goalLabel: data.goal || '',
    facets,
    count: matches.length,
    agents: matches.map((a) => ({ id: a.id, title: a.title, goal: a.goal })),
  };
}

/**
 * Handle a catalog filter request from the "All Agents" browse page.
 */
async function filterAgents(data) {
  const startTime = Date.now();
  const requestId = uuidv4();

  logger.info('Filtering healthcare-agent catalog', {
    requestId,
    audience: data.audience,
    specialty: data.specialty || 'all',
    goal: data.goal || 'all',
    service: 'customer-3d2ef497-agents',
    route: '/api/3d2ef497/filter-agents',
  });

  try {
    await new Promise((resolve) => setTimeout(resolve, 60 + Math.random() * 90));

    const view = computeCatalogView(data);

    const duration = Date.now() - startTime;
    incrementMetric('agent_catalog.filter.success', {
      route: '/api/3d2ef497/filter-agents',
      audience: data.audience,
    });
    recordTiming('agent_catalog.filter.latency', duration, { route: '/api/3d2ef497/filter-agents' });

    return { ...view, requestId, filteredAt: new Date().toISOString() };
  } catch (error) {
    const duration = Date.now() - startTime;
    incrementMetric('agent_catalog.filter.failure', {
      route: '/api/3d2ef497/filter-agents',
      errorClass: error.name,
    });
    recordTiming('agent_catalog.filter.latency', duration, { route: '/api/3d2ef497/filter-agents', error: 'true' });

    logger.error('Healthcare-agent catalog filter failed', {
      requestId,
      error: error.message,
      errorClass: error.name,
      durationMs: duration,
      audience: data.audience,
      service: 'customer-3d2ef497-agents',
    });

    Sentry.captureException(error, {
      tags: {
        route: '/api/3d2ef497/filter-agents',
        service: 'customer-3d2ef497-agents',
        audience: data.audience,
      },
      extra: { requestId, audience: data.audience, specialty: data.specialty, goal: data.goal },
    });

    createSessionAndAlert({
      issueTitle: `${error.name}: ${error.message}`,
      issueUrl: `https://${process.env.SENTRY_ORG_SLUG || 'sentry-org'}.sentry.io/issues/?project=${process.env.SENTRY_PROJECT_ID || ''}&query=is%3Aunresolved`,
      culprit: 'app/services/verticals/3d2ef497.js \u2014 buildSpecialtyFacets',
      errorType: error.name || 'Error',
      errorValue: error.message,
      devinUserId: data.devinUserId,
      devinEmail: data.devinEmail,
      devinOrgId: data.devinOrgId,
      service: 'customer-3d2ef497-agents',
      verticalLabel: 'Agent Catalog Filter',
      customer: '3d2ef497',
      slackMemberId: 'U08S7AVJ478',
      tags: [
        { key: 'route', value: '/api/3d2ef497/filter-agents' },
        { key: 'service', value: 'customer-3d2ef497-agents' },
        { key: 'audience', value: data.audience },
      ],
      extra: { requestId, audience: data.audience, specialty: data.specialty, goal: data.goal },
      level: 'error',
      platform: 'node',
      firstSeen: '',
      lastSeen: new Date().toISOString(),
      count: '',
      shortId: '',
      project: 'event-driven-devin',
      release: process.env.SENTRY_RELEASE || 'customer-3d2ef497-agents@1.0.0',
      environment: process.env.DD_ENV || 'prod',
      triggeredRule: '',
    }).catch((err) => {
      logger.error('Failed to create Devin session for agent catalog error', {
        error: err.message,
        requestId,
      });
    });

    throw error;
  }
}

module.exports = { filterAgents, AGENTS, AUDIENCE_SEGMENTS };
