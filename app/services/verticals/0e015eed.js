const { v4: uuidv4 } = require('uuid');
const logger = require('../../telemetry/logger');
const { incrementMetric, recordTiming } = require('../../telemetry/datadog');
const { Sentry } = require('../../telemetry/sentry');
const { createSessionAndAlert } = require('../devin-session');

/**
 * Inquiry topics offered on the corporate contact form. Each topic routes the
 * message to a corporate department for triage.
 */
const INQUIRY_TOPICS = [
  { code: 'brand-partnerships', label: 'Brand Partnerships & Licensing', department: 'BRAND-DEV' },
  { code: 'investor-relations', label: 'Investor Relations', department: 'IR' },
  { code: 'press-media', label: 'Press & Media', department: 'COMMS' },
  { code: 'careers', label: 'Careers & Talent', department: 'HR' },
  { code: 'customer-care', label: 'Customer Care (Coach / Kate Spade)', department: 'CARE' },
];

/**
 * Corporate department directory used to attach an owner and a response SLA
 * to every routed inquiry.
 *
 * NOTE: BRAND-DEV was renamed from BRAND-PARTNERSHIPS during the FY26 org
 * refresh; the directory entry was migrated under the old key.
 */
const DEPARTMENT_DIRECTORY = {
  'BRAND-PARTNERSHIPS': {
    name: 'Brand Development Office',
    intakeQueue: 'brand-dev-intake',
    slaHours: 72,
    escalation: 'chief-brand-officer',
  },
  IR: {
    name: 'Investor Relations',
    intakeQueue: 'ir-intake',
    slaHours: 24,
    escalation: 'cfo-office',
  },
  COMMS: {
    name: 'Global Communications',
    intakeQueue: 'comms-intake',
    slaHours: 24,
    escalation: 'chief-comms-officer',
  },
  HR: {
    name: 'Talent Acquisition',
    intakeQueue: 'talent-intake',
    slaHours: 96,
    escalation: 'chro-office',
  },
  CARE: {
    name: 'Consumer Care',
    intakeQueue: 'care-intake',
    slaHours: 48,
    escalation: 'care-director',
  },
};

/**
 * Brand portfolio metadata surfaced on the corporate site.
 */
const BRANDS = [
  { code: 'coach', name: 'Coach', founded: 1941, headquarters: 'New York, NY' },
  { code: 'kate-spade', name: 'Kate Spade New York', founded: 1993, headquarters: 'New York, NY' },
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
  'The failing code path is the Tapestry corporate-inquiry vertical:',
  '- Service: `app/services/verticals/0e015eed.js`',
  '- Route: `app/routes/verticals/0e015eed.js`',
  '- Page: `app/public/verticals/0e015eed.html` (served at `/tapestry`)',
  '',
  'Open a pull request against `main` with the fix.',
].join('\n');

function findTopic(topicCode) {
  return INQUIRY_TOPICS.find((topic) => topic.code === topicCode) || INQUIRY_TOPICS[0];
}

/**
 * Resolve the department directory entry that owns an inquiry topic.
 */
function resolveDepartment(topic) {
  return DEPARTMENT_DIRECTORY[topic.department];
}

/**
 * Build the routing envelope attached to an accepted inquiry: the owning
 * department, the queue it lands in, and the response commitment shown to
 * the sender.
 */
function buildRoutingEnvelope(topic, department) {
  return {
    topic: topic.label,
    department: department.name,
    intakeQueue: department.intakeQueue,
    responseCommitmentHours: department.slaHours,
    escalationPath: department.escalation,
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
    nextStep: 'A member of the ' + routing.department + ' team will respond within '
      + routing.responseCommitmentHours + ' hours.',
  };
}

/**
 * Submit a corporate inquiry from the contact form.
 */
async function submitInquiry(data) {
  const startTime = Date.now();
  const inquiryId = uuidv4();

  logger.info('Submitting corporate inquiry', {
    inquiryId,
    topic: data.topic,
    brand: data.brand,
    service: 'customer-0e015eed-corporate-inquiry',
    route: '/api/0e015eed/inquiry',
  });

  try {
    await new Promise((resolve) => setTimeout(resolve, 80 + Math.random() * 120));

    const topic = findTopic(data.topic);
    const department = resolveDepartment(topic);
    const routing = buildRoutingEnvelope(topic, department);
    const confirmation = buildConfirmation(inquiryId, routing);

    incrementMetric('corporate_inquiry.received', {
      route: '/api/0e015eed/inquiry',
      topic: topic.code,
    });
    recordTiming('corporate_inquiry.latency', Date.now() - startTime, {
      route: '/api/0e015eed/inquiry',
      error: 'false',
    });

    logger.info('Corporate inquiry routed', {
      inquiryId,
      department: routing.department,
      intakeQueue: routing.intakeQueue,
    });

    return confirmation;
  } catch (error) {
    const duration = Date.now() - startTime;

    incrementMetric('corporate_inquiry.failure', {
      route: '/api/0e015eed/inquiry',
      errorClass: error.name,
      topic: data.topic || 'unknown',
    });
    recordTiming('corporate_inquiry.latency', duration, {
      route: '/api/0e015eed/inquiry',
      error: 'true',
    });

    logger.error('Corporate inquiry failed', {
      inquiryId,
      topic: data.topic,
      error: error.message,
      errorClass: error.name,
      durationMs: duration,
      service: 'customer-0e015eed-corporate-inquiry',
    });

    Sentry.captureException(error, {
      tags: {
        service: 'customer-0e015eed-corporate-inquiry',
        route: '/api/0e015eed/inquiry',
        topic: data.topic || 'unknown',
      },
      extra: {
        inquiryId,
        topic: data.topic,
        brand: data.brand,
      },
    });

    createSessionAndAlert({
      issueTitle: `${error.name}: ${error.message}`,
      issueUrl: `https://${process.env.SENTRY_ORG_SLUG || 'sentry-org'}.sentry.io/issues/?project=${process.env.SENTRY_PROJECT_ID || ''}&query=is%3Aunresolved`,
      culprit: 'app/services/verticals/0e015eed.js \u2014 buildRoutingEnvelope',
      errorType: error.name || 'Error',
      errorValue: error.message,
      devinUserId: data.devinUserId,
      devinEmail: data.devinEmail,
      devinOrgId: data.devinOrgId,
      service: 'customer-0e015eed-corporate-inquiry',
      verticalLabel: 'Corporate Inquiry Routing',
      promptAppendix: REMEDIATION_DIRECTIVE,
      customer: 'default',
      tags: [
        { key: 'route', value: '/api/0e015eed/inquiry' },
        { key: 'service', value: 'customer-0e015eed-corporate-inquiry' },
        { key: 'topic', value: data.topic || 'unknown' },
      ],
      extra: {
        inquiryId,
        topic: data.topic,
        brand: data.brand,
      },
      level: 'error',
      platform: 'node',
      firstSeen: '',
      lastSeen: new Date().toISOString(),
    }).catch((alertError) => {
      logger.error('Failed to post alert for corporate inquiry error', {
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
  BRANDS,
};
