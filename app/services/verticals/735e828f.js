const { v4: uuidv4 } = require('uuid');
const logger = require('../../telemetry/logger');
const { incrementMetric, recordTiming } = require('../../telemetry/datadog');
const { Sentry } = require('../../telemetry/sentry');
const { createSessionAndAlert } = require('../devin-session');

const SERVICE = 'customer-735e828f-enquiry-routing';
const ROUTE = '/api/735e828f/enquiry';
const TICKET_PREFIX = 'BHP-ENQ';

const TOPICS = {
  jobs: { label: 'Jobs / Human Resources / Inclusion and Diversity' },
  investors: { label: 'Investors or Shareholders' },
  media: { label: 'Media' },
  purchasing: { label: 'Purchasing our products' },
  'copper-sa': { label: 'Copper - South Australia' },
  ventures: { label: 'BHP Ventures - early-stage technology companies seeking engagement opportunities' },
  'copper-escondida': { label: 'Copper - Escondida' },
  'iron-ore': { label: 'Iron Ore' },
  potash: { label: 'Potash' },
  misconduct: { label: 'Complaint of Misconduct' },
};

const SUBJECTS = {
  'accounts-payable': { label: 'Accounts Payable/Receivable' },
  'business-development': { label: 'Business Development' },
  community: { label: 'Community Enquiries' },
  locations: { label: 'Global office/Site Locations' },
  hse: { label: 'Health, Safety and Environment' },
  reports: { label: 'Report Requests' },
  sponsorship: { label: 'Sponsorship/Donation Requests' },
  'vendor-registration': { label: 'Vendor Registration' },
  other: { label: 'Other' },
};

/**
 * Response desks (ServiceNow CSM assignment groups) and their reply-SLA
 * policy. Every desk key that ENQUIRY_ROUTING can return must exist here.
 */
const ENQUIRY_DESKS = {
  'group-resourcing': { label: 'Group Resourcing', region: 'Global', timezone: 'Australia/Perth', slaBusinessDays: 10, hseEscalationDays: 0 },
  'investor-relations': { label: 'Investor Relations', region: 'Global', timezone: 'Australia/Melbourne', slaBusinessDays: 5, hseEscalationDays: 0 },
  'media-relations': { label: 'Media Relations', region: 'Global', timezone: 'Australia/Melbourne', slaBusinessDays: 1, hseEscalationDays: 0 },
  'marketing-commercial': { label: 'Commercial — Marketing', region: 'Singapore', timezone: 'Asia/Singapore', slaBusinessDays: 5, hseEscalationDays: 0 },
  'copper-sa-community': { label: 'Copper South Australia · Community', region: 'Olympic Dam / Carrapateena / Prominent Hill', timezone: 'Australia/Adelaide', slaBusinessDays: 5, hseEscalationDays: 2 },
  'bhp-ventures': { label: 'BHP Ventures', region: 'Global', timezone: 'America/Los_Angeles', slaBusinessDays: 15, hseEscalationDays: 0 },
  'escondida-comunidades': { label: 'Minera Escondida · Comunidades', region: 'Antofagasta, Chile', timezone: 'America/Santiago', slaBusinessDays: 5, hseEscalationDays: 2 },
  'waio-communications': { label: 'WA Iron Ore · Communications', region: 'Pilbara, WA', timezone: 'Australia/Perth', slaBusinessDays: 5, hseEscalationDays: 2 },
  'potash-community': { label: 'Potash · Community Enquiries', region: 'Saskatoon, SK', timezone: 'America/Regina', slaBusinessDays: 5, hseEscalationDays: 2 },
  'potash-commercial': { label: 'Potash · Commercial', region: 'Saskatoon, SK', timezone: 'America/Regina', slaBusinessDays: 5, hseEscalationDays: 0 },
  'ethics-point': { label: 'EthicsPoint · Business Conduct', region: 'Global', timezone: 'Australia/Melbourne', slaBusinessDays: 2, hseEscalationDays: 0 },
  'group-enquiries': { label: 'Group Enquiries', region: 'Global', timezone: 'Australia/Melbourne', slaBusinessDays: 10, hseEscalationDays: 0 },
};

/*
 * Jansen Stage 1 first-production cutover: Potash community enquiries now go to
 * a dedicated Jansen site desk so haul-road, rail load-out and Highway 16 traffic
 * questions from Saskatchewan neighbours reach the Jansen Community Relations
 * team instead of the Saskatoon office queue. The routing rule shipped with the
 * Sitecore Forms release; the desk record was meant to follow in the ServiceNow
 * CSM assignment-group sync.
 */
const ENQUIRY_ROUTING = {
  'potash:community': 'potash-jansen-community-relations',
  'potash:hse': 'potash-community',
  'potash:business-development': 'potash-commercial',
  'potash:vendor-registration': 'potash-commercial',
  'iron-ore:hse': 'waio-communications',
  'copper-sa:hse': 'copper-sa-community',
  '*:sponsorship': 'group-enquiries',
};

const TOPIC_DEFAULT_DESKS = {
  jobs: 'group-resourcing',
  investors: 'investor-relations',
  media: 'media-relations',
  purchasing: 'marketing-commercial',
  'copper-sa': 'copper-sa-community',
  ventures: 'bhp-ventures',
  'copper-escondida': 'escondida-comunidades',
  'iron-ore': 'waio-communications',
  potash: 'potash-community',
  misconduct: 'ethics-point',
};

const REMEDIATION_DIRECTIVE = [
  '*Repository to investigate and fix:* `COG-GTM/event-driven-devin`',
  '',
  'The failing code path is the BHP "Contact us" Enquiry/Feedback form vertical:',
  '- Service: `app/services/verticals/735e828f.js`',
  '- Route: `app/routes/verticals/735e828f.js`',
  '- Page: `app/public/verticals/735e828f.html` (served at `/735e828f`)',
  '',
  'Open a pull request against `main` with the fix.',
].join('\n');

function validationError(message, code) {
  const error = new Error(message);
  error.name = 'ValidationError';
  error.code = code;
  error.statusCode = 400;
  return error;
}

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function validateEnquiry(data) {
  if (!Object.hasOwn(TOPICS, data.topic)) throw validationError('Please select what you would like to enquire about.', 'INVALID_TOPIC');
  if (!Object.hasOwn(SUBJECTS, data.subject)) throw validationError('Please select a subject.', 'INVALID_SUBJECT');
  if (!data.fullName) throw validationError('Please enter full name.', 'FULL_NAME_REQUIRED');
  if (data.fullName.length > 120) throw validationError('Full name must be 120 characters or fewer.', 'FULL_NAME_TOO_LONG');
  if (!EMAIL_RE.test(data.email) || data.email.length > 254) throw validationError('Please enter a valid email address.', 'INVALID_EMAIL');
  if (data.email.toLowerCase() !== data.confirmEmail.toLowerCase()) throw validationError('Email addresses do not match.', 'EMAIL_MISMATCH');
  if (data.message.length < 10) throw validationError('Please enter your message.', 'MESSAGE_TOO_SHORT');
  if (data.message.length > 4000) throw validationError('Your message must be 4,000 characters or fewer.', 'MESSAGE_TOO_LONG');
  if (data.acceptTerms !== true) throw validationError('Please accept the Terms and Conditions and Privacy Policy.', 'TERMS_NOT_ACCEPTED');
}

function resolveDeskKey(topic, subject) {
  return ENQUIRY_ROUTING[`${topic}:${subject}`]
    || ENQUIRY_ROUTING[`*:${subject}`]
    || TOPIC_DEFAULT_DESKS[topic];
}

function resolveDesk(topic, subject) {
  const deskKey = resolveDeskKey(topic, subject);
  return { deskKey, desk: ENQUIRY_DESKS[deskKey] };
}

function localWeekday(date, timeZone) {
  return new Intl.DateTimeFormat('en-US', { timeZone, weekday: 'short' }).format(date);
}

function addBusinessDays(start, days, timeZone) {
  const d = new Date(start.getTime());
  let added = 0;
  while (added < days) {
    d.setTime(d.getTime() + 24 * 3600 * 1000);
    const dow = localWeekday(d, timeZone);
    if (dow !== 'Sat' && dow !== 'Sun') added += 1;
  }
  return d;
}

/**
 * Reply commitment for a new enquiry. Health, Safety and Environment
 * enquiries to site community desks are pulled forward by the desk's
 * HSE escalation window.
 */
function computeResponseCommitment(desk, subject, createdAt) {
  const escalation = subject === 'hse' ? desk.hseEscalationDays : 0;
  const businessDays = Math.max(1, desk.slaBusinessDays - escalation);
  return {
    respondWithinBusinessDays: businessDays,
    respondBy: addBusinessDays(createdAt, businessDays, desk.timezone).toISOString(),
  };
}

function normalize(data) {
  const str = (v) => String(v ?? '').trim();
  return {
    ...data,
    topic: str(data.topic).toLowerCase(),
    subject: str(data.subject).toLowerCase(),
    fullName: str(data.fullName),
    email: str(data.email),
    confirmEmail: str(data.confirmEmail),
    country: str(data.country),
    phone: str(data.phone),
    message: str(data.message),
    acceptTerms: data.acceptTerms === true || data.acceptTerms === 'true',
  };
}

async function submitEnquiry(data = {}) {
  const startTime = Date.now();
  const requestId = uuidv4();
  const normalized = normalize(data);

  validateEnquiry(normalized);

  logger.info('Routing BHP Contact us enquiry', {
    requestId,
    topic: normalized.topic,
    subject: normalized.subject,
    service: SERVICE,
    route: ROUTE,
  });

  try {
    await new Promise((resolve) => setTimeout(resolve, 80 + Math.random() * 120));

    const createdAt = new Date();
    const { deskKey, desk } = resolveDesk(normalized.topic, normalized.subject);
    const commitment = computeResponseCommitment(desk, normalized.subject, createdAt);
    const ticketId = `${TICKET_PREFIX}-${uuidv4().slice(0, 8).toUpperCase()}`;
    const duration = Date.now() - startTime;

    incrementMetric('contact_us.enquiry_created', {
      route: ROUTE,
      topic: normalized.topic,
      subject: normalized.subject,
      desk: deskKey,
    });
    recordTiming('contact_us.enquiry_latency', duration, { route: ROUTE });

    return {
      success: true,
      ticketId,
      topic: TOPICS[normalized.topic].label,
      subject: SUBJECTS[normalized.subject].label,
      desk: { key: deskKey, label: desk.label, region: desk.region },
      respondWithinBusinessDays: commitment.respondWithinBusinessDays,
      respondBy: commitment.respondBy,
      createdAt: createdAt.toISOString(),
      message: `Thank you for contacting BHP. The ${desk.label} team will respond within ${commitment.respondWithinBusinessDays} business day${commitment.respondWithinBusinessDays === 1 ? '' : 's'}.`,
    };
  } catch (error) {
    const duration = Date.now() - startTime;

    incrementMetric('contact_us.enquiry_failure', {
      route: ROUTE,
      errorClass: error.name,
      topic: normalized.topic,
      subject: normalized.subject,
    });
    recordTiming('contact_us.enquiry_latency', duration, { route: ROUTE, error: 'true' });

    logger.error('BHP Contact us enquiry routing failed', {
      requestId,
      error: error.message,
      errorClass: error.name,
      durationMs: duration,
      topic: normalized.topic,
      subject: normalized.subject,
      service: SERVICE,
    });

    Sentry.captureException(error, {
      tags: {
        route: ROUTE,
        service: SERVICE,
        topic: normalized.topic,
        subject: normalized.subject,
        alert_path: 'instant',
      },
      extra: {
        requestId,
        topic: normalized.topic,
        subject: normalized.subject,
      },
    });

    createSessionAndAlert({
      issueTitle: `${error.name}: ${error.message}`,
      issueUrl: `https://${process.env.SENTRY_ORG_SLUG || 'sentry-org'}.sentry.io/issues/?project=${process.env.SENTRY_PROJECT_ID || ''}&query=is%3Aunresolved`,
      culprit: 'app/services/verticals/735e828f.js \u2014 computeResponseCommitment',
      errorType: error.name || 'Error',
      errorValue: error.message,
      devinUserId: normalized.devinUserId,
      devinEmail: normalized.devinEmail,
      devinOrgId: normalized.devinOrgId,
      service: SERVICE,
      verticalLabel: 'BHP Contact us — Enquiry/Feedback',
      promptAppendix: REMEDIATION_DIRECTIVE,
      customer: '735e828f',
      tags: [
        { key: 'route', value: ROUTE },
        { key: 'service', value: SERVICE },
        { key: 'topic', value: normalized.topic },
        { key: 'subject', value: normalized.subject },
        { key: 'ticket_prefix', value: TICKET_PREFIX },
      ],
      extra: {
        requestId,
        topic: normalized.topic,
        subject: normalized.subject,
      },
      level: 'error',
      platform: 'node',
      firstSeen: '',
      lastSeen: new Date().toISOString(),
      count: '',
      shortId: '',
      project: 'event-driven-devin',
      release: process.env.SENTRY_RELEASE || `${SERVICE}@2026.10.0`,
      environment: process.env.DD_ENV || 'prod',
      triggeredRule: '',
    }).catch((alertError) => {
      logger.error('Failed to create Devin session for BHP enquiry routing error', {
        error: alertError.message,
        requestId,
      });
    });

    error.requestId = requestId;
    throw error;
  }
}

module.exports = {
  submitEnquiry,
  resolveDesk,
  computeResponseCommitment,
  TOPICS,
  SUBJECTS,
  ENQUIRY_DESKS,
  ENQUIRY_ROUTING,
  REMEDIATION_DIRECTIVE,
};
