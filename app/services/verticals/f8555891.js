const crypto = require('crypto');
const logger = require('../../telemetry/logger');
const { incrementMetric, recordTiming } = require('../../telemetry/datadog');
const { Sentry } = require('../../telemetry/sentry');
const { declareDatadogIncident } = require('../datadog-incidents');
const { postOncallAlert, postOncallBugReport } = require('../oncall');

const SERVICE = 'customer-f8555891-payroll';
const ROUTE = '/api/f8555891/release-batch';
const SUPPORT_CENTER = 'Gusto Support';
const SUPPORT_PAGE_URL = () =>
  `${(process.env.ONCALL_DEMO_BASE_URL || `https://${process.env.DOMAIN_NAME || 'devindemos.com'}`).replace(/\/$/, '')}/gusto`;
const SUPPORT_SEVERITIES = ['Low', 'Medium', 'High', 'Critical'];
const MAX_TICKETS_PER_REPORT = 6;
const MAX_TICKET_CHARS = 2500;
const MAX_SUBJECT_CHARS = 200;
const MAX_REPORTER_CHARS = 120;
const MAX_EMAIL_CHARS = 254;
const EMAIL_PATTERN = /^[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+$/;
const TICKET_PREFIX = 'GUS';
const PARENT_TRIAGE_HINT =
  'Triage: mention @Devin in this thread with `swarm this ticket` to open one child session per sub-ticket and consolidate the findings here.';

function makeTicketId() {
  return `${TICKET_PREFIX}-${1000 + crypto.randomInt(9000)}`;
}

// Slack mrkdwn treats <...> as mentions/links; escaping the control characters
// keeps customer-supplied text inert (no @channel, no spoofed links).
function escapeMrkdwn(value) {
  return String(value).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function cleanText(value, maxChars) {
  if (typeof value !== 'string') return '';
  const printable = Array.from(value).filter((ch) => {
    const code = ch.charCodeAt(0);
    return code === 9 || code === 10 || code === 13 || (code >= 32 && code !== 127);
  }).join('');
  return escapeMrkdwn(printable.trim()).slice(0, maxChars);
}

const BATCH = {
  id: 'PB-2026-09-15-A',
  payDate: '2026-09-17',
  debitWindow: '2026-09-15 14:00 PT',
  achCutoff: '2026-09-15 17:30 PT',
  processor: 'ach-origination-east',
};

const COMPANIES = [
  {
    id: 'CO-48211',
    name: 'Harbor Light Coffee Roasters',
    industry: 'Food & Beverage',
    plan: 'Plus',
    employees: 42,
    workStates: ['CA'],
    grossPay: 148200,
    status: 'ready',
  },
  {
    id: 'CO-50934',
    name: 'Redwood Ridge Veterinary',
    industry: 'Healthcare',
    plan: 'Premium',
    employees: 27,
    workStates: ['CA', 'WA'],
    grossPay: 96400,
    status: 'ready',
  },
  {
    id: 'CO-51177',
    name: 'Northstar Dental Group',
    industry: 'Healthcare',
    plan: 'Plus',
    employees: 19,
    workStates: ['MN'],
    grossPay: 71300,
    status: 'ready',
    newState: true,
  },
  {
    id: 'CO-47102',
    name: 'Brightline Architecture Studio',
    industry: 'Professional Services',
    plan: 'Simple',
    employees: 11,
    workStates: ['NY'],
    grossPay: 58900,
    status: 'ready',
  },
  {
    id: 'CO-52260',
    name: 'Mesa Verde Landscaping',
    industry: 'Field Services',
    plan: 'Simple',
    employees: 34,
    workStates: ['TX'],
    grossPay: 64800,
    status: 'ready',
  },
];

const STATE_PAYROLL_PROGRAMS = {
  CA: { jurisdiction: 'California', programs: ['ca_sdi', 'ca_ett', 'ca_ui'], employerRate: 0.034, employeeRate: 0.011 },
  WA: { jurisdiction: 'Washington', programs: ['wa_pfml', 'wa_cares', 'wa_ui'], employerRate: 0.028, employeeRate: 0.0132 },
  NY: { jurisdiction: 'New York', programs: ['ny_pfl', 'ny_sdi', 'ny_ui'], employerRate: 0.041, employeeRate: 0.00455 },
  TX: { jurisdiction: 'Texas', programs: ['tx_ui'], employerRate: 0.027, employeeRate: 0 },
};

function resolveStatePrograms(state) {
  return STATE_PAYROLL_PROGRAMS[state];
}

function computeCompanyDebit(company) {
  let employerContributions = 0;
  let employeeWithholding = 0;
  const jurisdictions = [];

  company.workStates.forEach((state) => {
    const programs = resolveStatePrograms(state);
    const share = company.grossPay / company.workStates.length;
    employerContributions += share * programs.employerRate;
    employeeWithholding += share * programs.employeeRate;
    jurisdictions.push(programs.jurisdiction);
  });

  const round = (value) => Math.round(value * 100) / 100;
  return {
    employerContributions: round(employerContributions),
    employeeWithholding: round(employeeWithholding),
    totalDebit: round(company.grossPay + employerContributions),
    jurisdictions,
  };
}

function getBatchCompanies() {
  return COMPANIES.map((company) => {
    const round = (value) => Math.round(value * 100) / 100;
    const employerContributions = company.workStates.reduce((sum, state) => {
      const programs = resolveStatePrograms(state);
      return programs ? sum + (company.grossPay / company.workStates.length) * programs.employerRate : sum;
    }, 0);
    return {
      ...company,
      employerContributions: round(employerContributions),
      totalDebit: round(company.grossPay + employerContributions),
    };
  });
}

async function releaseBatch(data) {
  const startTime = Date.now();
  const batchId = data.batchId;
  let companyIds;

  const validationError = (message, code) => {
    const err = new Error(message);
    err.name = 'ValidationError';
    err.code = code;
    err.statusCode = 400;
    return err;
  };

  if (batchId !== BATCH.id) {
    throw validationError(`Unknown payroll batch: ${batchId || '(none)'}`, 'UNKNOWN_BATCH');
  }

  if (data.companyIds === undefined) {
    companyIds = COMPANIES.map((company) => company.id);
  } else if (!Array.isArray(data.companyIds)) {
    throw validationError('companyIds must be an array of company IDs', 'INVALID_COMPANY_SELECTION');
  } else {
    companyIds = [...new Set(data.companyIds)];
  }

  if (companyIds.length === 0) {
    throw validationError('Batch release must include at least one company', 'EMPTY_BATCH');
  }

  const unknownCompanyIds = companyIds.filter((id) => !COMPANIES.some((company) => company.id === id));
  if (unknownCompanyIds.length > 0) {
    throw validationError(`Unknown company ID(s): ${unknownCompanyIds.join(', ')}`, 'UNKNOWN_COMPANY');
  }

  const selectedCompanies = COMPANIES.filter((company) => companyIds.includes(company.id));
  let failingCompany = null;

  logger.info('Releasing Gusto payroll batch', {
    batchId,
    companyCount: selectedCompanies.length,
    service: SERVICE,
    route: ROUTE,
  });

  try {
    await new Promise((resolve) => setTimeout(resolve, 80 + Math.random() * 120));

    const debits = selectedCompanies.map((company) => {
      failingCompany = company;
      const debit = computeCompanyDebit(company);
      return {
        companyId: company.id,
        companyName: company.name,
        employees: company.employees,
        grossPay: company.grossPay,
        employerContributions: debit.employerContributions,
        employeeWithholding: debit.employeeWithholding,
        totalDebit: debit.totalDebit,
        jurisdictions: debit.jurisdictions,
      };
    });
    failingCompany = null;

    const totalDebit = debits.reduce((sum, debit) => sum + debit.totalDebit, 0);
    const totalEmployees = debits.reduce((sum, debit) => sum + debit.employees, 0);
    const duration = Date.now() - startTime;

    incrementMetric('gusto_payroll.batch_release_success', { batchId });
    recordTiming('gusto_payroll.batch_release_latency', duration, { batchId, error: 'false' });

    return {
      batchId,
      status: 'released',
      achFileId: `ACH-${crypto.randomBytes(4).toString('hex').toUpperCase()}`,
      payDate: BATCH.payDate,
      companyCount: debits.length,
      totalEmployees,
      totalDebit: Math.round(totalDebit * 100) / 100,
      debits,
    };
  } catch (error) {
    const duration = Date.now() - startTime;
    const state = failingCompany
      ? failingCompany.workStates.find((workState) => !resolveStatePrograms(workState)) || failingCompany.workStates[0]
      : undefined;

    incrementMetric('gusto_payroll.batch_release_failure', {
      batchId,
      ...(state ? { state } : {}),
    });
    recordTiming('gusto_payroll.batch_release_latency', duration, {
      batchId,
      ...(state ? { state } : {}),
      error: 'true',
    });

    logger.error('Gusto payroll batch release failed', {
      error: error.message,
      errorClass: error.name,
      durationMs: duration,
      batchId,
      companyId: failingCompany ? failingCompany.id : undefined,
      state,
      service: SERVICE,
    });

    Sentry.captureException(error, {
      tags: {
        route: ROUTE,
        service: SERVICE,
        batchId,
        state: state || 'unknown',
        alert_path: 'instant',
      },
      extra: {
        batchId,
        ...(failingCompany ? { companyId: failingCompany.id } : {}),
      },
    });

    declareDatadogIncident({
      title: 'Payroll batch release failing for Minnesota employers',
      summary: `${error.name}: ${error.message}. Batch ${batchId} cannot compute employer contributions for companies with employees working in MN; ACH debits for the batch are blocked ahead of the ${BATCH.achCutoff} cutoff.`,
      runRef: batchId,
      service: SERVICE,
      triggeredBy: data.devinEmail || 'payroll-oncall',
      repoUrl: 'https://github.com/COG-GTM/event-driven-devin',
      severity: 'SEV-2',
    }).catch((err) => logger.warn('Failed to declare Datadog incident for Gusto payroll', { error: err.message, batchId }));

    postOncallAlert('f8555891', {
      runRef: batchId,
      devinEmail: data.devinEmail,
    }).catch((err) => logger.warn('Gusto payroll on-call alert failed', { error: err.message, batchId }));

    throw error;
  }
}

/**
 * Split a free-form customer report into one symptom per paragraph or list
 * item so each can be filed as its own ticket. Falls back to the whole text
 * when no separators are present.
 */
function splitSymptoms(text) {
  const paragraphs = text
    .split(/\n\s*\n/)
    .map((part) => part.trim())
    .filter(Boolean);
  const source = paragraphs.length > 1 ? paragraphs : text.split('\n');
  const symptoms = source
    .map((part) => part.replace(/^\s*(?:[-*\u2022]|\d+[.)])\s+/, '').trim())
    .filter(Boolean);
  return symptoms.length > 0 ? symptoms : [text.trim()];
}

/**
 * File a customer-reported problem from the on-call console as a human-style
 * support ticket in the on-call bugs channel. With `split`, the report is
 * filed as a parent ticket whose symptoms become numbered sub-tickets in its
 * thread (`GUS-1041` -> `GUS-1041.1`, `.2`, ...), so a triage responder can
 * fan one investigation out per sub-ticket and consolidate on the parent.
 */
async function submitSupportTicket(data) {
  const validationError = (message, code) => {
    const err = new Error(message);
    err.name = 'ValidationError';
    err.code = code;
    err.statusCode = 400;
    return err;
  };

  const text = cleanText(data.text, Infinity);
  if (!text) {
    throw validationError('A support ticket needs a description of the problem', 'EMPTY_TICKET');
  }
  const subject = cleanText(data.subject, MAX_SUBJECT_CHARS);
  const severity = SUPPORT_SEVERITIES.includes(data.severity) ? data.severity : 'High';
  const productArea = cleanText(data.productArea, MAX_SUBJECT_CHARS) || 'Payroll · ACH release';
  let reporter;
  if (data.reporter && typeof data.reporter === 'object') {
    const name = cleanText(data.reporter.name, MAX_REPORTER_CHARS);
    const rawEmail = typeof data.reporter.email === 'string' ? data.reporter.email.trim() : '';
    if (rawEmail && (rawEmail.length > MAX_EMAIL_CHARS || !EMAIL_PATTERN.test(rawEmail))) {
      throw validationError('Reporter email is not a valid address', 'INVALID_REPORTER_EMAIL');
    }
    reporter = { name: name || undefined, email: rawEmail || undefined };
  }

  const symptoms = data.split ? splitSymptoms(text) : [text];
  if (symptoms.length > MAX_TICKETS_PER_REPORT) {
    throw validationError(
      `A report splits into at most ${MAX_TICKETS_PER_REPORT} tickets; this one has ${symptoms.length}`,
      'TOO_MANY_SYMPTOMS'
    );
  }
  const tooLong = symptoms.find((symptom) => symptom.length + subject.length > MAX_TICKET_CHARS);
  if (tooLong) {
    throw validationError(
      `Each ticket is limited to ${MAX_TICKET_CHARS} characters; split the report into shorter symptoms`,
      'TICKET_TOO_LONG'
    );
  }

  const submittedFrom = SUPPORT_PAGE_URL();
  const ticketId = makeTicketId();
  const hierarchical = symptoms.length > 1;
  const common = { reporter, severity, productArea, devinEmail: data.devinEmail, supportCenter: SUPPORT_CENTER, submittedFrom };
  const tickets = [];
  let parent = null;

  const partialDelivery = (index, error) => {
    // Slack posts are not atomic: report what already landed so the client
    // can retry only the remainder instead of re-filing every ticket.
    const err = new Error(`Ticket ${index + 1} of ${symptoms.length} failed to post: ${error.message}`);
    err.name = 'PartialDeliveryError';
    err.code = 'PARTIAL_DELIVERY';
    err.statusCode = 502;
    err.tickets = tickets;
    err.ticketCount = symptoms.length;
    if (parent) err.parentTicket = parent;
    incrementMetric('gusto_payroll.support_ticket', { service: SERVICE, outcome: 'failed', split: String(hierarchical) });
    logger.error('Gusto support ticket post failed', { index, total: symptoms.length, ticketId, error: error.message });
    return err;
  };

  if (hierarchical) {
    const summary = symptoms.map((symptom, index) => `• *${ticketId}.${index + 1}* — ${symptom.split('\n')[0].slice(0, 140)}`);
    let posted;
    try {
      posted = await postOncallBugReport({
        ...common,
        ticketId,
        text: [
          subject ? `*${subject}*` : `*Customer report with ${symptoms.length} symptoms*`,
          '',
          `${symptoms.length} sub-tickets for this report (filed as replies in this thread):`,
          ...summary,
          '',
          PARENT_TRIAGE_HINT,
        ].join('\n'),
      });
    } catch (error) {
      throw partialDelivery(0, error);
    }
    parent = { id: ticketId, ok: Boolean(posted.ok), skipped: Boolean(posted.skipped), ts: posted.ts || null };
  }

  for (let index = 0; index < symptoms.length; index += 1) {
    const subId = hierarchical ? `${ticketId}.${index + 1}` : ticketId;
    const parts = [];
    if (subject) parts.push(hierarchical ? `[${index + 1}/${symptoms.length}] ${subject}` : subject);
    else if (hierarchical) parts.push(`[${index + 1}/${symptoms.length}]`);
    parts.push(symptoms[index]);
    // Sequential so the tickets land in the thread in report order.
    let posted;
    try {
      posted = await postOncallBugReport({
        ...common,
        text: parts.join('\n\n'),
        ticketId: subId,
        ...(hierarchical && parent.ts ? { threadTs: parent.ts, parentTicketId: ticketId } : {}),
      });
    } catch (error) {
      throw partialDelivery(index, error);
    }
    const outcome = posted.ok ? 'delivered' : posted.skipped ? 'skipped' : 'rejected';
    incrementMetric('gusto_payroll.support_ticket', { service: SERVICE, outcome, split: String(hierarchical) });
    tickets.push({ id: subId, ok: Boolean(posted.ok), skipped: Boolean(posted.skipped), ts: posted.ts || null, symptom: symptoms[index] });
  }

  const skipped = tickets.length > 0 && tickets.every((ticket) => ticket.skipped);
  logger.info(skipped ? 'Gusto support ticket prepared but Slack not configured' : 'Gusto support ticket filed', {
    ticketId,
    tickets: tickets.length,
    split: Boolean(data.split),
    skipped,
    severity,
    productArea,
  });

  return {
    ok: !skipped,
    skipped,
    ...(skipped ? { error: 'SLACK_ONCALL_BUGS_CHANNEL_ID or bot token not configured' } : {}),
    supportCenter: SUPPORT_CENTER,
    ticketId,
    ...(parent ? { parentTicket: parent } : {}),
    ticketCount: tickets.length,
    tickets,
  };
}

module.exports = {
  releaseBatch,
  submitSupportTicket,
  splitSymptoms,
  BATCH,
  COMPANIES,
  getBatchCompanies,
  STATE_PAYROLL_PROGRAMS,
};
