const { v4: uuidv4 } = require('uuid');
const logger = require('../../telemetry/logger');
const { incrementMetric, recordTiming } = require('../../telemetry/datadog');
const { Sentry } = require('../../telemetry/sentry');
const { createSessionAndAlert } = require('../devin-session');

/**
 * Inquiry topics offered on the "Talk to a Rep" contact form. Each topic
 * routes the message to a platform division for triage.
 */
const INQUIRY_TOPICS = [
  { code: 'digital-procurement', label: 'Digital Procurement', division: 'DIGITAL-PROCUREMENT' },
  { code: 'fresh', label: 'BEP Fresh (Produce, Meat, Dairy & Seafood)', division: 'FRESH' },
  { code: 'supply-chain', label: 'Supply Chain Services', division: 'SUPPLY-CHAIN' },
  { code: 'software', label: 'Software & Technology', division: 'SOFTWARE' },
  { code: 'partnerships', label: 'Manufacturer & Distributor Partnerships', division: 'PARTNERSHIPS' },
];

/**
 * Platform division directory used to attach an owner and a response SLA
 * to every routed inquiry.
 *
 * NOTE: DIGITAL-PROCUREMENT was renamed from PROCUREMENT-NETWORK during the
 * FY26 division refresh; the directory entry was migrated under the old key.
 */
const DIVISION_DIRECTORY = {
  'PROCUREMENT-NETWORK': {
    name: 'Digital Procurement Network',
    intakeQueue: 'procurement-intake',
    slaHours: 24,
    escalation: 'chief-procurement-officer',
  },
  FRESH: {
    name: 'BEP Fresh',
    intakeQueue: 'fresh-intake',
    slaHours: 24,
    escalation: 'fresh-division-lead',
  },
  'SUPPLY-CHAIN': {
    name: 'Supply Chain Services',
    intakeQueue: 'supply-chain-intake',
    slaHours: 48,
    escalation: 'supply-chain-director',
  },
  SOFTWARE: {
    name: 'Software & Technology',
    intakeQueue: 'software-intake',
    slaHours: 48,
    escalation: 'cto-office',
  },
  PARTNERSHIPS: {
    name: 'Partner Development',
    intakeQueue: 'partnerships-intake',
    slaHours: 72,
    escalation: 'chief-growth-officer',
  },
};

/**
 * Network stats surfaced on the corporate site.
 */
const NETWORK_STATS = [
  { code: 'restaurants', label: 'Active Restaurants', value: '200k+' },
  { code: 'transactions', label: 'In Network Transactions', value: '$100B+' },
  { code: 'employees', label: 'Employees', value: '1,100+' },
  { code: 'contracts', label: 'Manufacturer Contracts', value: '350+' },
];

/**
 * Scenario directive appended to the Devin investigation prompt.
 *
 * The alert pipeline passes only a prompt to the Devin API, so the repository
 * to remediate has to be named explicitly here.
 */
const REMEDIATION_DIRECTIVE = [
  '*Repository to investigate and fix:* `COG-GTM/event-driven-devin`',
  '',
  'The failing code path is the Buyers Edge Platform rep-inquiry vertical:',
  '- Service: `app/services/verticals/be7a41c9.js`',
  '- Route: `app/routes/verticals/be7a41c9.js`',
  '- Page: `app/public/verticals/be7a41c9.html` (served at `/buyersedge`)',
  '',
  'Open a pull request against `main` with the fix.',
].join('\n');

function findTopic(topicCode) {
  return INQUIRY_TOPICS.find((topic) => topic.code === topicCode) || INQUIRY_TOPICS[0];
}

/**
 * Resolve the division directory entry that owns an inquiry topic.
 */
function resolveDivision(topic) {
  return DIVISION_DIRECTORY[topic.division];
}

/**
 * Build the routing envelope attached to an accepted inquiry: the owning
 * division, the queue it lands in, and the response commitment shown to
 * the sender.
 */
function buildRoutingEnvelope(topic, division) {
  return {
    topic: topic.label,
    division: division.name,
    intakeQueue: division.intakeQueue,
    responseCommitmentHours: division.slaHours,
    escalationPath: division.escalation,
  };
}

/**
 * Assemble the confirmation returned to the sender.
 */
function buildConfirmation(inquiryId, routing) {
  return {
    inquiryId,
    status: 'received',
    routing,
    nextStep: 'A member of the ' + routing.division + ' team will respond within '
      + routing.responseCommitmentHours + ' hours.',
  };
}

/**
 * Submit a rep inquiry from the "Talk to a Rep" contact form.
 */
async function submitInquiry(data) {
  const startTime = Date.now();
  const inquiryId = uuidv4();

  logger.info('Submitting rep inquiry', {
    inquiryId,
    topic: data.topic,
    company: data.company,
    service: 'customer-be7a41c9-rep-inquiry',
    route: '/api/be7a41c9/inquiry',
  });

  try {
    await new Promise((resolve) => setTimeout(resolve, 80 + Math.random() * 120));

    const topic = findTopic(data.topic);
    const division = resolveDivision(topic);
    const routing = buildRoutingEnvelope(topic, division);
    const confirmation = buildConfirmation(inquiryId, routing);

    incrementMetric('rep_inquiry.received', {
      route: '/api/be7a41c9/inquiry',
      topic: topic.code,
    });
    recordTiming('rep_inquiry.latency', Date.now() - startTime, {
      route: '/api/be7a41c9/inquiry',
      error: 'false',
    });

    logger.info('Rep inquiry routed', {
      inquiryId,
      division: routing.division,
      intakeQueue: routing.intakeQueue,
    });

    return confirmation;
  } catch (error) {
    const duration = Date.now() - startTime;

    incrementMetric('rep_inquiry.failure', {
      route: '/api/be7a41c9/inquiry',
      errorClass: error.name,
      topic: data.topic || 'unknown',
    });
    recordTiming('rep_inquiry.latency', duration, {
      route: '/api/be7a41c9/inquiry',
      error: 'true',
    });

    logger.error('Rep inquiry failed', {
      inquiryId,
      topic: data.topic,
      error: error.message,
      errorClass: error.name,
      durationMs: duration,
      service: 'customer-be7a41c9-rep-inquiry',
    });

    Sentry.captureException(error, {
      tags: {
        service: 'customer-be7a41c9-rep-inquiry',
        route: '/api/be7a41c9/inquiry',
        topic: data.topic || 'unknown',
      },
      extra: {
        inquiryId,
        topic: data.topic,
        company: data.company,
      },
    });

    createSessionAndAlert({
      issueTitle: `${error.name}: ${error.message}`,
      issueUrl: `https://${process.env.SENTRY_ORG_SLUG || 'sentry-org'}.sentry.io/issues/?project=${process.env.SENTRY_PROJECT_ID || ''}&query=is%3Aunresolved`,
      culprit: 'app/services/verticals/be7a41c9.js \u2014 buildRoutingEnvelope',
      errorType: error.name || 'Error',
      errorValue: error.message,
      devinUserId: data.devinUserId,
      devinEmail: data.devinEmail,
      devinOrgId: data.devinOrgId,
      service: 'customer-be7a41c9-rep-inquiry',
      verticalLabel: 'Rep Inquiry Routing',
      promptAppendix: REMEDIATION_DIRECTIVE,
      customer: 'default',
      tags: [
        { key: 'route', value: '/api/be7a41c9/inquiry' },
        { key: 'service', value: 'customer-be7a41c9-rep-inquiry' },
        { key: 'topic', value: data.topic || 'unknown' },
      ],
      extra: {
        inquiryId,
        topic: data.topic,
        company: data.company,
      },
      level: 'error',
      platform: 'node',
      firstSeen: '',
      lastSeen: new Date().toISOString(),
    }).catch((alertError) => {
      logger.error('Failed to post alert for rep inquiry error', {
        inquiryId,
        error: alertError.message,
      });
    });

    throw error;
  }
}

module.exports = {
  submitInquiry,
  INQUIRY_TOPICS,
  NETWORK_STATS,
};
