const { v4: uuidv4 } = require('uuid');
const logger = require('../../telemetry/logger');
const { incrementMetric, recordTiming } = require('../../telemetry/datadog');
const { Sentry } = require('../../telemetry/sentry');
const { createSessionAndAlert } = require('../devin-session');

const SERVICE = 'bofa-appointment-scheduler';
const ROUTE = '/api/e7fd3fee/appointments';
const PAGE = '/e7fd3fee';
const REFERENCE_PREFIX = 'BAC-APT';

/**
 * Scenario directive appended to the Devin investigation prompt.
 *
 * The alert pipeline passes only a prompt to the Devin API, so the repository
 * to remediate has to be named explicitly here.
 */
const REMEDIATION_DIRECTIVE = [
  '*Repository to investigate and fix:* `COG-GTM/event-driven-devin`',
  '',
  'The failing code path is the Bank of America "Schedule an appointment" vertical:',
  '- Service: `app/services/verticals/e7fd3fee.js`',
  '- Route: `app/routes/verticals/e7fd3fee.js`',
  '- Page: `app/public/verticals/e7fd3fee.html` (served at `/e7fd3fee`)',
  '',
  'Start from the topic the customer picked and work back through the',
  'specialist line it routes to.',
  '',
  'Open a pull request against `main` with the fix.',
].join('\n');

class ValidationError extends Error {
  constructor(message) {
    super(message);
    this.name = 'ValidationError';
    this.statusCode = 400;
  }
}

/**
 * "What would you like to talk about?" — owned by Digital Experience and
 * shipped with the scheduler front end. Each topic routes to a specialist
 * line in the WFM roster.
 */
const TOPICS = [
  { id: 'home-loans-cals', label: 'Home loans — Community Affordable Loan Solution™', specialistLine: 'affordable-homeownership' },
  { id: 'home-loans-purchase', label: 'Home loans — Buying a home', specialistLine: 'mortgage-lending' },
  { id: 'checking-savings', label: 'Checking & savings', specialistLine: 'consumer-banking' },
  { id: 'credit-cards', label: 'Credit cards', specialistLine: 'consumer-banking' },
  { id: 'auto-loans', label: 'Auto loans', specialistLine: 'consumer-lending' },
  { id: 'merrill-investing', label: 'Investing with Merrill', specialistLine: 'merrill-advisory' },
  { id: 'small-business', label: 'Small business', specialistLine: 'small-business' },
];

/**
 * Specialist lines, generated nightly from the Workforce Management (WFM)
 * roster export.
 *
 * The 2026 Home Lending reorg folded the Community Affordable Loan Solution™
 * and America's Home Grant® desks into a single Affordable Homeownership line.
 * Digital Experience repointed the topic catalog in the same release; the WFM
 * export is still on the pre-reorg desk list.
 */
const SPECIALIST_LINES = {
  'consumer-banking': {
    title: 'Relationship Banker', durationMinutes: 30, leadTimeHours: 2, channels: ['in-person', 'phone', 'video'],
  },
  'mortgage-lending': {
    title: 'Lending Specialist', durationMinutes: 60, leadTimeHours: 24, channels: ['in-person', 'phone', 'video'],
  },
  'community-lending': {
    title: 'Community Lending Specialist', durationMinutes: 60, leadTimeHours: 24, channels: ['in-person', 'phone'],
  },
  'consumer-lending': {
    title: 'Consumer Lending Specialist', durationMinutes: 30, leadTimeHours: 4, channels: ['in-person', 'phone'],
  },
  'merrill-advisory': {
    title: 'Merrill Financial Solutions Advisor', durationMinutes: 45, leadTimeHours: 48, channels: ['in-person', 'phone', 'video'],
  },
  'small-business': {
    title: 'Small Business Specialist', durationMinutes: 45, leadTimeHours: 24, channels: ['in-person', 'phone', 'video'],
  },
};

const FINANCIAL_CENTERS = [
  { id: 'FC-NC-28255', name: 'Bank of America Corporate Center', address: '100 N Tryon St, Charlotte, NC 28255', timeZone: 'America/New_York' },
  { id: 'FC-NY-10036', name: 'One Bryant Park', address: '1101 Avenue of the Americas, New York, NY 10036', timeZone: 'America/New_York' },
  { id: 'FC-IL-60603', name: 'LaSalle & Adams', address: '135 S LaSalle St, Chicago, IL 60603', timeZone: 'America/Chicago' },
  { id: 'FC-CA-94104', name: 'Montgomery & Pine', address: '345 Montgomery St, San Francisco, CA 94104', timeZone: 'America/Los_Angeles' },
];

const CHANNELS = {
  'in-person': 'In person at a financial center',
  phone: 'By phone',
  video: 'Video call',
};

function findTopic(id) {
  return TOPICS.find((t) => t.id === id);
}

function findCenter(id) {
  return FINANCIAL_CENTERS.find((c) => c.id === id);
}

function resolveSpecialistLine(topic) {
  return SPECIALIST_LINES[topic.specialistLine];
}

function buildAppointmentSlot(line, start, channel) {
  const earliest = Date.now() + line.leadTimeHours * 60 * 60 * 1000;
  if (start.getTime() < earliest) {
    throw new ValidationError(`The earliest available time for this topic is ${line.leadTimeHours} hours from now. Please choose a later time.`);
  }
  if (!line.channels.includes(channel)) {
    throw new ValidationError(`${CHANNELS[channel]} isn't available for this topic. Please choose another way to meet.`);
  }
  const end = new Date(start.getTime() + line.durationMinutes * 60 * 1000);
  return { start: start.toISOString(), end: end.toISOString(), durationMinutes: line.durationMinutes };
}

function validateRequest(data) {
  const topic = findTopic(data.topic);
  if (!topic) throw new ValidationError('Please choose what you would like to talk about.');
  if (!CHANNELS[data.channel]) throw new ValidationError('Please choose how you would like to meet.');
  const center = findCenter(data.centerId);
  if (!center) throw new ValidationError('Please choose a financial center.');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(data.date || '')) || !/^\d{2}:\d{2}$/.test(String(data.time || ''))) {
    throw new ValidationError('Please choose a date and time.');
  }
  const start = new Date(`${data.date}T${data.time}:00`);
  if (Number.isNaN(start.getTime())) throw new ValidationError('Please choose a valid date and time.');
  if (!String(data.firstName || '').trim() || !String(data.lastName || '').trim()) {
    throw new ValidationError('Please enter your first and last name.');
  }
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(data.email || ''))) {
    throw new ValidationError('Please enter a valid email address.');
  }
  return { topic, center, start };
}

async function scheduleAppointment(data) {
  const startTime = Date.now();
  const referenceId = uuidv4();
  const { topic, center, start } = validateRequest(data);

  logger.info('Scheduling Bank of America appointment', {
    referenceId,
    topic: topic.id,
    specialistLine: topic.specialistLine,
    centerId: center.id,
    channel: data.channel,
    service: SERVICE,
  });

  try {
    await new Promise((resolve) => setTimeout(resolve, 80 + Math.random() * 120));

    const line = resolveSpecialistLine(topic);
    const slot = buildAppointmentSlot(line, start, data.channel);
    const duration = Date.now() - startTime;

    incrementMetric('bofa_appointment.success', { route: ROUTE, topic: topic.id });
    recordTiming('bofa_appointment.latency', duration, { route: ROUTE });

    return {
      success: true,
      referenceId,
      status: 'confirmed',
      appointment: {
        confirmationNumber: `${REFERENCE_PREFIX}-${Date.now().toString().slice(-8)}`,
        topic: topic.label,
        specialist: line.title,
        channel: CHANNELS[data.channel],
        center: center.name,
        address: center.address,
        start: slot.start,
        durationMinutes: slot.durationMinutes,
      },
    };
  } catch (error) {
    if (error instanceof ValidationError) throw error;

    const duration = Date.now() - startTime;

    incrementMetric('bofa_appointment.failure', { route: ROUTE, errorClass: error.name, topic: topic.id });
    recordTiming('bofa_appointment.latency', duration, { route: ROUTE, error: 'true' });

    logger.error('Bank of America appointment booking failed', {
      referenceId,
      error: error.message,
      errorClass: error.name,
      durationMs: duration,
      topic: topic.id,
      specialistLine: topic.specialistLine,
      centerId: center.id,
      channel: data.channel,
    });

    const extra = {
      referenceId, topic: topic.id, specialistLine: topic.specialistLine, centerId: center.id, channel: data.channel,
    };

    Sentry.captureException(error, {
      tags: {
        route: ROUTE, service: SERVICE, topic: topic.id, page: PAGE,
      },
      extra,
    });

    createSessionAndAlert({
      issueTitle: `${error.name}: ${error.message}`,
      issueUrl: `https://${process.env.SENTRY_ORG_SLUG || 'sentry-org'}.sentry.io/issues/?project=${process.env.SENTRY_PROJECT_ID || ''}&query=is%3Aunresolved`,
      culprit: 'app/services/verticals/e7fd3fee.js — buildAppointmentSlot',
      errorType: error.name || 'Error',
      errorValue: error.message,
      devinUserId: data.devinUserId,
      devinEmail: data.devinEmail,
      devinOrgId: data.devinOrgId,
      service: SERVICE,
      verticalLabel: 'Bank of America — Schedule an Appointment',
      customer: 'e7fd3fee',
      promptAppendix: REMEDIATION_DIRECTIVE,
      tags: [
        { key: 'route', value: ROUTE },
        { key: 'service', value: SERVICE },
        { key: 'topic', value: topic.id },
        { key: 'center', value: center.id },
        { key: 'page', value: PAGE },
      ],
      extra,
      level: 'error',
      platform: 'node',
      firstSeen: '',
      lastSeen: new Date().toISOString(),
      count: '',
      shortId: `${REFERENCE_PREFIX}-${referenceId.slice(0, 8).toUpperCase()}`,
      project: 'event-driven-devin',
      release: process.env.SENTRY_RELEASE || 'bofa-appointment-scheduler@4.12.0',
      environment: process.env.DD_ENV || 'prod',
      triggeredRule: '',
    }).catch((err) => {
      logger.error('Failed to trigger Devin session from Bank of America appointment error', { error: err.message });
    });

    error.referenceId = referenceId;
    throw error;
  }
}

module.exports = {
  scheduleAppointment, ValidationError, TOPICS, SPECIALIST_LINES, FINANCIAL_CENTERS,
};
