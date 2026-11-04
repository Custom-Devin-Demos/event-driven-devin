/* global setImmediate */

const { v4: uuidv4 } = require('uuid');
const logger = require('../../telemetry/logger');
const { incrementMetric, recordTiming } = require('../../telemetry/datadog');
const { Sentry } = require('../../telemetry/sentry');
const { createSessionAndAlert } = require('../devin-session');

const SLACK_MEMBER_ID = process.env.CUSTOMER_7CEF5900_SLACK_MEMBER_ID || '';

const SERVICE = 'customer-7cef5900-booking';
const ROUTE = '/api/7cef5900/appointments';
const TARGET_REPO = 'COG-GTM/doctolib-grand-public';

// Mirrors monolith/config/initializers/booking_slo.rb in the target repository.
const BOOKING_SLO = { statementTimeoutMs: 200 };

// State of DB1 after the deploy that ran 20261012141500_consolidate_appointment_indexes:
// the composite index used by the practitioner clash check no longer exists.
const DB1 = {
  appointmentsRows: 8_000_000,
  indexes: {
    index_appointments_on_practitioner_id_and_starts_at: false,
    index_appointments_on_status_and_starts_at: true,
    index_appointments_on_patient_id: true,
  },
  seqScanMs: [560, 720],
  indexScanMs: [1, 4],
};

const CLASH_QUERY = 'SELECT 1 AS one FROM "appointments" WHERE "appointments"."status" != $1 '
  + 'AND "appointments"."practitioner_id" = $2 AND (starts_at < $3 AND ends_at > $4) LIMIT $5';

const VISIT_MOTIVES = {
  consultation: 'Consultation de suivi',
  first: 'Première consultation',
  renewal: "Renouvellement d'ordonnance",
  vaccination: 'Vaccination',
};

const PRACTITIONERS = [
  { id: 'p-1042', name: 'Dr Claire Fontaine', gender: 'f', speciality: 'Médecin généraliste', address: '12 Rue de Rennes', city: '75006 Paris', sector: 'Conventionné secteur 1', fee: 30, slotsPerDay: [3, 4, 0, 2, 0] },
  { id: 'p-1187', name: 'Dr Mathieu Lefèvre', gender: 'm', speciality: 'Médecin généraliste', address: '48 Boulevard Voltaire', city: '75011 Paris', sector: 'Conventionné secteur 1', fee: 30, slotsPerDay: [0, 2, 3, 3, 1] },
  { id: 'p-1215', name: 'Centre de santé Belleville', gender: 'c', speciality: 'Centre de santé', subtitle: '4 médecins généralistes', address: '7 Rue de Belleville', city: '75020 Paris', sector: 'Établissement conventionné', fee: 30, slotsPerDay: [4, 4, 4, 2, 0] },
  { id: 'p-1302', name: 'Dr Sophie Nguyen', gender: 'f', speciality: 'Médecin généraliste', address: '3 Place de la République', city: '75003 Paris', sector: 'Conventionné secteur 2', fee: 50, slotsPerDay: [1, 0, 2, 0, 0] },
  { id: 'p-1376', name: 'Dr Antoine Mercier', gender: 'm', speciality: 'Médecin généraliste', address: '120 Rue de Vaugirard', city: '75015 Paris', sector: 'Conventionné secteur 1', fee: 30, slotsPerDay: [2, 3, 1, 0, 2] },
];

const SLOT_TIMES = ['09:00', '09:20', '10:40', '11:00', '14:20', '15:45', '16:00', '17:40'];

function startOfDay(date) {
  const d = new Date(date);
  d.setHours(0, 0, 0, 0);
  return d;
}

function buildSlots(practitioner, from = new Date()) {
  const base = startOfDay(from);
  return practitioner.slotsPerDay.map((count, dayIndex) => {
    const day = new Date(base);
    day.setDate(base.getDate() + dayIndex);
    const offset = (practitioner.id.charCodeAt(4) + dayIndex) % SLOT_TIMES.length;
    const times = Array.from({ length: count }, (_, i) => SLOT_TIMES[(offset + i * 2) % SLOT_TIMES.length]).sort();
    return { date: day.toISOString().slice(0, 10), times };
  });
}

function searchPractitioners({ from } = {}) {
  return PRACTITIONERS.map((p) => ({
    id: p.id,
    name: p.name,
    gender: p.gender,
    speciality: p.speciality,
    subtitle: p.subtitle || null,
    address: p.address,
    city: p.city,
    sector: p.sector,
    fee: p.fee,
    days: buildSlots(p, from),
  }));
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function between([min, max]) {
  return Math.round(min + Math.random() * (max - min));
}

function explainClashQuery() {
  if (DB1.indexes.index_appointments_on_practitioner_id_and_starts_at) {
    return { node: 'Index Scan using index_appointments_on_practitioner_id_and_starts_at on appointments', estimatedMs: between(DB1.indexScanMs), rowsScanned: 12 };
  }
  return { node: 'Seq Scan on appointments (Parallel, 2 workers)', estimatedMs: between(DB1.seqScanMs), rowsScanned: DB1.appointmentsRows };
}

function validateBooking(data) {
  const practitioner = PRACTITIONERS.find((p) => p.id === data.practitionerId);
  const validDate = /^\d{4}-\d{2}-\d{2}$/.test(String(data.date || ''));
  const validTime = SLOT_TIMES.includes(String(data.time || ''));
  const validMotive = Object.hasOwn(VISIT_MOTIVES, data.motive);
  if (!practitioner || !validDate || !validTime || !validMotive) {
    const error = new Error('Choisissez un soignant, un créneau et un motif de consultation valides.');
    error.name = 'ValidationError';
    error.code = 'BOOKING_INVALID';
    error.statusCode = 400;
    throw error;
  }
  return practitioner;
}

function buildDirective({ practitioner, plan, requestId }) {
  return [
    `*Repository to investigate and fix:* \`${TARGET_REPO}\` (Rails monolith in \`monolith/\`, DB1 schema in \`monolith/db/\`). Do not modify \`COG-GTM/event-driven-devin\`.`,
    '',
    '*What patients see:* "Confirmer le rendez-vous" fails with HTTP 503 "Service momentanément indisponible" on the patient booking site. Every confirmation for every practitioner is failing (patient NPS impact).',
    '',
    '*Error:* `ActiveRecord::QueryCanceled: PG::QueryCanceled: ERROR: canceling statement due to statement timeout`',
    '- Endpoint: `POST /api/v1/appointments` → `Api::V1::AppointmentsController#create`',
    '- Raised in `Booking::BookAppointment#ensure_practitioner_is_free!` (`monolith/app/services/booking/book_appointment.rb`)',
    `- The booking transaction caps statements at ${BOOKING_SLO.statementTimeoutMs}ms (\`monolith/config/initializers/booking_slo.rb\`). Do not raise or remove that timeout.`,
    '',
    '*Datadog Database Monitoring (service `db1-postgres`, env `prod`):*',
    `- Query: \`${CLASH_QUERY}\``,
    `- Plan: \`${plan.node}\` over ~${(plan.rowsScanned / 1e6).toFixed(1)}M rows, ~${plan.estimatedMs}ms per call (was ~3ms before the last deploy)`,
    '- Regression starts with the deploy that ran `monolith/db/migrate/20261012141500_consolidate_appointment_indexes.rb`',
    `- Sample request: ${requestId}, practitioner ${practitioner.id}`,
    '',
    '*What to do:*',
    '1. Reproduce locally: `docker compose up -d --build db1 monolith` (first boot seeds ~8M appointments), then book an open slot with the curl in `README.md` and confirm the 503. Capture `EXPLAIN (ANALYZE, BUFFERS)` of the clash query.',
    '2. Fix it with a new, safe migration following `playbooks/safe-migrations.md` and `playbooks/slow-query-remediation.md` (concurrent index, `disable_ddl_transaction!`, strong_migrations). Do not edit migrations that already ran and do not remove the clash check. Keep the index the Pro dashboard needs.',
    '3. Re-run EXPLAIN and the booking request, and record before/after timings.',
    '4. In `monolith/`, run `bundle exec rspec`, `bundle exec rubocop` and `bundle exec brakeman -q`.',
    '5. Open a pull request against `main` with the root cause, the before/after plan and timings, migration safety notes and the impact on patient NPS (booking) and Pro NPS (agenda).',
  ].join('\n');
}

function reportBookingOutage({ requestId, durationMs, plan, practitioner, data }) {
  const error = new Error(`POST /api/v1/appointments canceled after ${BOOKING_SLO.statementTimeoutMs}ms (statement timeout)`);
  error.name = 'ActiveRecord::QueryCanceled';

  Sentry.captureException(error, {
    tags: { route: ROUTE, service: SERVICE, alert_path: 'booking', practitioner: practitioner.id },
    extra: { requestId, durationMs, plan: plan.node, estimatedMs: plan.estimatedMs },
  });

  return createSessionAndAlert({
    issueTitle: 'ActiveRecord::QueryCanceled: prise de rendez-vous en échec (DB1 statement timeout)',
    issueUrl: `https://${process.env.SENTRY_ORG_SLUG || 'sentry-org'}.sentry.io/issues/?project=${process.env.SENTRY_PROJECT_ID || ''}&query=is%3Aunresolved`,
    culprit: 'monolith/app/services/booking/book_appointment.rb — Booking::BookAppointment#ensure_practitioner_is_free!',
    errorType: 'ActiveRecord::QueryCanceled',
    errorValue: 'PG::QueryCanceled: ERROR: canceling statement due to statement timeout',
    devinUserId: data.devinUserId,
    devinEmail: data.devinEmail,
    devinOrgId: data.devinOrgId,
    service: SERVICE,
    verticalLabel: 'Prise de rendez-vous patient',
    promptAppendix: buildDirective({ practitioner, plan, requestId }),
    customer: '7cef5900',
    slackMemberId: data.devinEmail ? '' : SLACK_MEMBER_ID,
    slackMemberIdFallback: SLACK_MEMBER_ID,
    tags: [
      { key: 'route', value: 'POST /api/v1/appointments' },
      { key: 'service', value: 'monolith' },
      { key: 'db', value: 'db1-postgres' },
      { key: 'statement_timeout_ms', value: String(BOOKING_SLO.statementTimeoutMs) },
      { key: 'kpi', value: 'patient_nps' },
    ],
    extra: { requestId, durationMs, plan: plan.node, estimatedMs: plan.estimatedMs, repo: TARGET_REPO },
    level: 'error',
    platform: 'ruby',
    firstSeen: '',
    lastSeen: new Date().toISOString(),
    count: '',
    shortId: '',
    project: 'monolith',
    release: 'monolith@2026.11.03',
    environment: 'prod',
    triggeredRule: 'Booking confirmation errors > 5% for 2 min',
  }).catch((alertError) => {
    logger.error('Failed to create Devin session for booking outage', { error: alertError.message, requestId });
  });
}

async function bookAppointment(data = {}) {
  const startTime = Date.now();
  const requestData = data && typeof data === 'object' ? data : {};
  const requestId = `RDV-${uuidv4().slice(0, 8).toUpperCase()}`;
  const practitioner = validateBooking(requestData);

  const plan = explainClashQuery();
  await sleep(Math.min(plan.estimatedMs, BOOKING_SLO.statementTimeoutMs));

  if (plan.estimatedMs > BOOKING_SLO.statementTimeoutMs) {
    const durationMs = Date.now() - startTime;
    incrementMetric('booking.confirmation_failed', { route: ROUTE, reason: 'statement_timeout' });
    recordTiming('booking.confirmation.latency', durationMs, { route: ROUTE, outcome: 'error' });
    logger.error('Booking confirmation failed: DB1 statement timeout — triggering Devin session', {
      requestId, practitioner: practitioner.id, plan: plan.node, estimatedMs: plan.estimatedMs, service: SERVICE,
    });
    setImmediate(() => reportBookingOutage({ requestId, durationMs, plan, practitioner, data: requestData }));

    const error = new Error('Service momentanément indisponible. Veuillez réessayer.');
    error.name = 'ServiceUnavailable';
    error.code = 'BOOKING_DB_TIMEOUT';
    error.statusCode = 503;
    error.requestId = requestId;
    throw error;
  }

  const durationMs = Date.now() - startTime;
  incrementMetric('booking.confirmation_success', { route: ROUTE });
  recordTiming('booking.confirmation.latency', durationMs, { route: ROUTE, outcome: 'success' });
  return {
    success: true,
    requestId,
    appointment: {
      practitioner: practitioner.name,
      address: `${practitioner.address}, ${practitioner.city}`,
      date: requestData.date,
      time: requestData.time,
      motive: VISIT_MOTIVES[requestData.motive],
    },
    durationMs,
  };
}

module.exports = {
  bookAppointment,
  searchPractitioners,
  buildDirective,
  PRACTITIONERS,
  VISIT_MOTIVES,
  SLOT_TIMES,
  BOOKING_SLO,
  DB1,
};
