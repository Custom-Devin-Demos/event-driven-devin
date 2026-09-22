const { v4: uuidv4 } = require('uuid');
const logger = require('../../telemetry/logger');
const { incrementMetric, recordTiming } = require('../../telemetry/datadog');
const { Sentry } = require('../../telemetry/sentry');
const { createSessionAndAlert } = require('../devin-session');

/**
 * Jobs on the Simpro dispatch board, as shown on the Job Dispatch page.
 */
const JOBS = [
  {
    jobNo: '1478',
    status: 'pending',
    statusColor: '#f5a623',
    customer: 'ABC Excavators',
    site: '22 Inglis Road, Rocklea QLD',
    orderNo: 'PO-55214',
    dueDate: 'Jun 18, 2025',
    stage: 'Rough-in',
    technician: null,
    jobType: 'Electrical — Commercial Fit-out',
    sellPrice: 4280.0,
  },
  {
    jobNo: '1481',
    status: 'pending',
    statusColor: '#f5a623',
    customer: 'Symonds Plumbing',
    site: '143 Symonds Road, Milton QLD',
    orderNo: 'PO-55231',
    dueDate: 'Jun 18, 2025',
    stage: 'Commissioning',
    technician: null,
    jobType: 'Plumbing — Backflow Test',
    sellPrice: 640.0,
  },
  {
    jobNo: '1485',
    status: 'pending',
    statusColor: '#f5a623',
    customer: 'Milton Body Corporate',
    site: '38 Baroona Road, Paddington QLD',
    orderNo: 'PO-55248',
    dueDate: 'Jun 19, 2025',
    stage: 'Maintenance',
    technician: null,
    jobType: 'HVAC — Split System Service',
    sellPrice: 1150.0,
  },
  {
    jobNo: '1490',
    status: 'pending',
    statusColor: '#f5a623',
    customer: 'Riverside Cafe',
    site: '7 Eagle Street Pier, Brisbane City QLD',
    orderNo: 'PO-55260',
    dueDate: 'Jun 20, 2025',
    stage: 'Install',
    technician: null,
    jobType: 'Refrigeration — Coolroom Repair',
    sellPrice: 2360.0,
  },
  {
    jobNo: '1467',
    status: 'progress',
    statusColor: '#4a90d9',
    customer: 'Queensland Rail',
    site: '305 Edward Street, Brisbane City QLD',
    orderNo: 'PO-55012',
    dueDate: 'Jun 16, 2025',
    stage: 'Fit-off',
    technician: 'Jake Morgan',
    jobType: 'Electrical — Switchboard Upgrade',
    sellPrice: 12400.0,
  },
  {
    jobNo: '1452',
    status: 'complete',
    statusColor: '#7ed321',
    customer: 'Harbour View Apartments',
    site: '18 Macrossan Street, South Brisbane QLD',
    orderNo: 'PO-54987',
    dueDate: 'Jun 12, 2025',
    stage: 'Invoicing',
    technician: 'Priya Nair',
    jobType: 'Fire — Alarm Panel Inspection',
    sellPrice: 890.0,
  },
];

/**
 * Field technicians available for dispatch.
 */
const TECHNICIANS = [
  {
    id: 'tech-jmorgan',
    name: 'Jake Morgan',
    trade: 'Electrical',
    region: 'Brisbane North',
    vehicle: 'UTE-04 · 812-KLM',
  },
  {
    id: 'tech-pnair',
    name: 'Priya Nair',
    trade: 'Fire Protection',
    region: 'Brisbane South',
    vehicle: 'VAN-11 · 420-QZD',
  },
  {
    id: 'tech-doconnor',
    name: "Dan O'Connor",
    trade: 'Plumbing',
    region: 'Brisbane West',
    vehicle: 'UTE-07 · 655-WTR',
  },
  {
    id: 'tech-lchen',
    name: 'Lisa Chen',
    trade: 'HVAC / Refrigeration',
    region: 'Brisbane CBD',
    vehicle: 'VAN-02 · 908-HTX',
  },
];

/**
 * Dispatch windows offered on the Job Dispatch page.
 */
const TIME_SLOTS = {
  morning: { label: 'Morning (7:00 AM – 11:00 AM)', startHour: 7, endHour: 11 },
  midday: { label: 'Midday (11:00 AM – 2:00 PM)', startHour: 11, endHour: 14 },
  afternoon: { label: 'Afternoon (2:00 PM – 6:00 PM)', startHour: 14, endHour: 18 },
};

/**
 * Dispatch priorities and the SLA each carries.
 */
const PRIORITY_SLA_HOURS = {
  standard: 48,
  urgent: 8,
  emergency: 2,
};
const PRIORITIES = Object.keys(PRIORITY_SLA_HOURS);

/**
 * Shift roster keyed by crew shift code, mapping each shift to the dispatch
 * window it covers and the granularity of schedule slots.
 */
const SHIFT_ROSTER = {
  AM: { timeSlot: 'morning', slotMinutes: 30 },
  MID: { timeSlot: 'midday', slotMinutes: 30 },
  PM: { timeSlot: 'afternoon', slotMinutes: 30 },
};

/**
 * Scenario directive appended to the Devin investigation prompt.
 *
 * The alert pipeline passes only a prompt to the Devin API, so the repository
 * to remediate has to be named explicitly here.
 */
const REMEDIATION_DIRECTIVE = [
  '*Repository to investigate and fix:* `COG-GTM/event-driven-devin`',
  '',
  'The failing code path is the Simpro job dispatch vertical:',
  '- Service: `app/services/verticals/48f89daf.js`',
  '- Route: `app/routes/verticals/48f89daf.js`',
  '- Page: `app/public/verticals/48f89daf.html` (served at `/simpro`)',
  '',
  'Open a pull request against `main` with the fix.',
].join('\n');

function findJob(jobNo) {
  return JOBS.find((job) => job.jobNo === jobNo);
}

function findTechnician(technicianId) {
  return TECHNICIANS.find((technician) => technician.id === technicianId);
}

function formatTime(hour, minute) {
  return `${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}`;
}

/**
 * Build the technician's schedule for the selected dispatch window: the crew
 * shift covering the window and the bookable slots across it.
 */
function buildTechnicianSchedule(technician, timeSlotId) {
  const roster = SHIFT_ROSTER[timeSlotId];
  const window = TIME_SLOTS[timeSlotId];

  const schedule = {
    technicianId: technician.id,
    timeSlotId,
    shift: roster ? timeSlotId : undefined,
  };

  if (roster) {
    schedule.slots = [];
    for (let minutes = window.startHour * 60; minutes < window.endHour * 60; minutes += roster.slotMinutes) {
      schedule.slots.push({
        start: formatTime(Math.floor(minutes / 60), minutes % 60),
        end: formatTime(Math.floor((minutes + roster.slotMinutes) / 60), (minutes + roster.slotMinutes) % 60),
        available: true,
      });
    }
  }

  return schedule;
}

/**
 * Confirm the dispatch: lock the first available slot as the arrival window
 * and notify the technician on their Simpro Mobile app.
 */
function confirmDispatch(job, technician, schedule, priority) {
  const firstSlot = schedule.slots.find((slot) => slot.available);
  const lastSlot = schedule.slots[schedule.slots.length - 1];
  const dispatchRef = `DSP-${job.jobNo}-${uuidv4().slice(0, 4).toUpperCase()}`;

  return {
    dispatchRef,
    jobNo: job.jobNo,
    technician: technician.name,
    scheduledWindow: `${firstSlot.start} \u2013 ${lastSlot.end}`,
    priority,
    slaHours: PRIORITY_SLA_HOURS[priority],
    notifiedVia: 'Simpro Mobile push + SMS',
    etaMinutes: 15 + Math.floor(Math.random() * 30),
  };
}

/**
 * Dispatch a pending job to a field technician in the selected window.
 */
async function dispatchJob(data) {
  const startTime = Date.now();
  const dispatchId = uuidv4();
  const job = findJob(data.jobNo);
  const technician = findTechnician(data.technicianId);

  logger.info('Dispatching job', {
    dispatchId,
    jobNo: data.jobNo,
    technicianId: data.technicianId,
    timeSlot: data.timeSlot,
    service: 'customer-48f89daf-job-dispatch',
    route: '/api/48f89daf/dispatch',
  });

  if (!job) {
    const error = new Error(`Unknown job: ${data.jobNo || '(none)'}`);
    error.name = 'ValidationError';
    error.statusCode = 400;
    error.code = 'JOB_NOT_FOUND';
    throw error;
  }

  if (job.status !== 'pending') {
    const error = new Error(`Job ${job.jobNo} is ${job.status}, not pending`);
    error.name = 'ValidationError';
    error.statusCode = 400;
    error.code = 'JOB_NOT_PENDING';
    throw error;
  }

  if (!technician) {
    const error = new Error(`Unknown technician: ${data.technicianId || '(none)'}`);
    error.name = 'ValidationError';
    error.statusCode = 400;
    error.code = 'TECHNICIAN_NOT_FOUND';
    throw error;
  }

  if (!TIME_SLOTS[data.timeSlot]) {
    const error = new Error(`Unknown time slot: ${data.timeSlot || '(none)'}`);
    error.name = 'ValidationError';
    error.statusCode = 400;
    error.code = 'INVALID_TIME_SLOT';
    throw error;
  }

  if (!PRIORITIES.includes(data.priority)) {
    const error = new Error(`Unknown priority: ${data.priority || '(none)'}`);
    error.name = 'ValidationError';
    error.statusCode = 400;
    error.code = 'INVALID_PRIORITY';
    throw error;
  }

  try {
    await new Promise((resolve) => setTimeout(resolve, 80 + Math.random() * 120));

    const schedule = buildTechnicianSchedule(technician, data.timeSlot);
    const confirmation = confirmDispatch(job, technician, schedule, data.priority);

    incrementMetric('job_dispatch.confirmed', {
      route: '/api/48f89daf/dispatch',
      timeSlot: data.timeSlot,
      priority: data.priority,
    });
    recordTiming('job_dispatch.latency', Date.now() - startTime, {
      route: '/api/48f89daf/dispatch',
      error: 'false',
    });

    logger.info('Job dispatched', {
      dispatchId,
      jobNo: job.jobNo,
      technician: technician.name,
      timeSlot: data.timeSlot,
      dispatchRef: confirmation.dispatchRef,
    });

    return confirmation;
  } catch (error) {
    const duration = Date.now() - startTime;

    incrementMetric('job_dispatch.failure', {
      route: '/api/48f89daf/dispatch',
      errorClass: error.name,
      jobNo: job.jobNo,
      timeSlot: data.timeSlot,
    });
    recordTiming('job_dispatch.latency', duration, {
      route: '/api/48f89daf/dispatch',
      error: 'true',
    });

    logger.error('Job dispatch failed', {
      dispatchId,
      jobNo: job.jobNo,
      technician: technician.name,
      timeSlot: data.timeSlot,
      error: error.message,
      errorClass: error.name,
      durationMs: duration,
      service: 'customer-48f89daf-job-dispatch',
    });

    Sentry.captureException(error, {
      tags: {
        service: 'customer-48f89daf-job-dispatch',
        route: '/api/48f89daf/dispatch',
        jobNo: job.jobNo,
        timeSlot: data.timeSlot,
      },
      extra: {
        dispatchId,
        jobNo: job.jobNo,
        technician: technician.name,
        timeSlot: data.timeSlot,
        priority: data.priority,
      },
    });

    createSessionAndAlert({
      issueTitle: `${error.name}: ${error.message}`,
      issueUrl: `https://${process.env.SENTRY_ORG_SLUG || 'sentry-org'}.sentry.io/issues/?project=${process.env.SENTRY_PROJECT_ID || ''}&query=is%3Aunresolved`,
      culprit: 'app/services/verticals/48f89daf.js \u2014 confirmDispatch',
      errorType: error.name || 'Error',
      errorValue: error.message,
      devinUserId: data.devinUserId,
      devinEmail: data.devinEmail,
      devinOrgId: data.devinOrgId,
      service: 'customer-48f89daf-job-dispatch',
      verticalLabel: 'Simpro Job Dispatch',
      promptAppendix: REMEDIATION_DIRECTIVE,
      customer: '48f89daf',
      slackMemberId: 'U0BQZBHCNMA',
      tags: [
        { key: 'route', value: '/api/48f89daf/dispatch' },
        { key: 'service', value: 'customer-48f89daf-job-dispatch' },
        { key: 'jobNo', value: job.jobNo },
        { key: 'timeSlot', value: data.timeSlot },
      ],
      extra: {
        dispatchId,
        jobNo: job.jobNo,
        technician: technician.name,
        timeSlot: data.timeSlot,
        priority: data.priority,
      },
      level: 'error',
      platform: 'node',
      firstSeen: '',
      lastSeen: new Date().toISOString(),
    }).catch((alertError) => {
      logger.error('Failed to post alert for job dispatch error', {
        dispatchId,
        error: alertError.message,
      });
    });

    throw error;
  }
}

module.exports = {
  dispatchJob,
  JOBS,
  TECHNICIANS,
  TIME_SLOTS,
};
