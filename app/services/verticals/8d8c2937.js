const crypto = require('crypto');
const Sentry = require('@sentry/node');
const { createSessionAndAlert } = require('../devin-session');
const logger = require('../../telemetry/logger');

const CUSTOMER = '8d8c2937';
const SERVICE = 'customer-8d8c2937-appointment-intake';
const ROUTE = 'POST /api/8d8c2937/appointment-requests';
const CULPRIT = 'app/services/verticals/8d8c2937.js — routeToTriageQueue';

const SPECIALTIES = [
  { id: 'cardiovascular-medicine', label: 'Cardiovascular Medicine', hint: 'Heart rhythm problems, chest pain, heart failure, valve disease' },
  { id: 'dermatology', label: 'Dermatology', hint: 'Skin, hair and nail conditions' },
  { id: 'endocrinology', label: 'Endocrinology, Diabetes and Nutrition', hint: 'Diabetes, thyroid and hormone disorders' },
  { id: 'gastroenterology-hepatology', label: 'Gastroenterology and Hepatology', hint: 'Digestive tract and liver conditions' },
  { id: 'neurology', label: 'Neurology', hint: 'Headache, seizures, memory and movement disorders' },
  { id: 'oncology', label: 'Cancer care (Oncology)', hint: 'New or suspected cancer diagnosis, second opinions' },
  { id: 'orthopedic-surgery', label: 'Orthopedic Surgery', hint: 'Joint, bone and sports injuries' },
];
const CAMPUSES = [
  { id: 'rochester', label: 'Rochester, Minnesota', zone: 'CT', timeZone: 'America/Chicago', phone: '507-538-3270' },
  { id: 'arizona', label: 'Phoenix/Scottsdale, Arizona', zone: 'MT', timeZone: 'America/Phoenix', phone: '480-301-8484' },
  { id: 'florida', label: 'Jacksonville, Florida', zone: 'ET', timeZone: 'America/New_York', phone: '904-953-0853' },
];
const INSURERS = [
  'Aetna', 'Blue Cross and Blue Shield of Minnesota', 'Cigna', 'Florida Blue', 'HealthPartners',
  'Humana', 'Medica', 'Medicare', 'UnitedHealthcare',
];

// The request form adopted the 2026 enterprise specialty taxonomy; intake triage still uses the legacy department key.
const TRIAGE_QUEUES = {
  cardiology: { queue: 'CV-NEWPT', callbackSlaHours: 24, nurseReview: true },
  dermatology: { queue: 'DERM-NEWPT', callbackSlaHours: 72, nurseReview: false },
  endocrinology: { queue: 'ENDO-NEWPT', callbackSlaHours: 72, nurseReview: false },
  'gastroenterology-hepatology': { queue: 'GIH-NEWPT', callbackSlaHours: 48, nurseReview: false },
  neurology: { queue: 'NEURO-NEWPT', callbackSlaHours: 48, nurseReview: true },
  oncology: { queue: 'ONC-NEWPT', callbackSlaHours: 24, nurseReview: true },
  'orthopedic-surgery': { queue: 'ORTHO-NEWPT', callbackSlaHours: 72, nurseReview: false },
};
const WINDOWS = [
  { slot: 'morning', label: '8:00 – 10:00 a.m.' },
  { slot: 'midday', label: '11:00 a.m. – 1:00 p.m.' },
  { slot: 'afternoon', label: '2:00 – 4:00 p.m.' },
];
const REMEDIATION_DIRECTIVE = [
  'Investigate and fix COG-GTM/event-driven-devin. Open a pull request against main; do not merge or deploy.',
  'Mayo Clinic "Request an appointment" (/mayo or /8d8c2937) crashes when a new patient submits Part 1 for Cardiovascular Medicine.',
  'Reproduce: New patients → keep the pre-filled patient (Cardiovascular Medicine, Rochester) → Next through every step → Submit request. Dermatology succeeds.',
  'Inspect app/services/verticals/8d8c2937.js, app/routes/verticals/8d8c2937.js and app/public/verticals/8d8c2937-assets/request.js.',
  'The specialty catalog uses id cardiovascular-medicine but TRIAGE_QUEUES is still keyed by the legacy cardiology department. Cardiovascular new-patient requests belong in queue CV-NEWPT with a 24-hour callback SLA and nurse review.',
  'Keep every specialty and campus available; preserve validation, follow-up windows and server-generated request IDs.',
  'Add regression coverage in tests/8d8c2937-mayo-appointments.test.js and update the planted-failure expectation after the fix.',
  'Do not disable Sentry/alerts, swallow errors, remove the specialty, or fake a successful response in the browser.',
].join('\n');

const MAX_STORED_REQUESTS = 500;
const requests = new Map();
const invalid = message => Object.assign(new Error(message), { name: 'ValidationError', status: 400, code: 'INVALID_APPOINTMENT_REQUEST' });
const text = (value, min, max) => typeof value === 'string' && value.trim().length >= min && value.trim().length <= max;

function validateRequest(input, now = new Date()) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw invalid('Complete the appointment request.');
  const { patient, concern, insurance } = input;
  if (typeof input.isPatient !== 'boolean') throw invalid('Tell us whether you are the patient.');
  if (!input.isPatient && !text(input.requesterRelationship, 2, 40)) throw invalid('Tell us your relationship to the patient.');
  if (!patient || typeof patient !== 'object') throw invalid('Enter the patient information.');
  if (!text(patient.firstName, 1, 60) || !text(patient.lastName, 1, 60)) throw invalid("Enter the patient's first and last name.");
  const dob = /^\d{4}-\d{2}-\d{2}$/.test(patient.dateOfBirth || '') ? new Date(`${patient.dateOfBirth}T00:00:00Z`) : null;
  if (!dob || Number.isNaN(dob.getTime()) || dob.toISOString().slice(0, 10) !== patient.dateOfBirth || dob >= now || now.getUTCFullYear() - dob.getUTCFullYear() > 120) throw invalid('Enter a valid date of birth.');
  if (typeof patient.email !== 'string' || !/^[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+$/.test(patient.email) || patient.email.length > 120) throw invalid('Enter a valid email address.');
  const phone = typeof patient.phone === 'string' ? patient.phone.replace(/\D/g, '') : '';
  if (phone.length !== 10) throw invalid('Enter a 10-digit U.S. phone number.');
  if (!SPECIALTIES.some(s => s.id === input.specialty)) throw invalid('Choose the type of care you need.');
  if (!text(concern, 10, 1000)) throw invalid('Describe your medical concern (at least 10 characters).');
  if (!insurance || !['insurance', 'self-pay'].includes(insurance.type)) throw invalid('Tell us how you will pay for care.');
  if (insurance.type === 'insurance' && (!INSURERS.includes(insurance.carrier) || !/^[A-Za-z0-9-]{3,30}$/.test(insurance.memberId || ''))) throw invalid('Enter your insurance carrier and member ID.');
  if (!CAMPUSES.some(c => c.id === input.campus)) throw invalid('Choose a Mayo Clinic location.');
  if (!['phone', 'email'].includes(input.contactPreference)) throw invalid('Choose how we should contact you.');
  return {
    isPatient: input.isPatient,
    requesterRelationship: input.isPatient ? null : input.requesterRelationship.trim(),
    patient: { firstName: patient.firstName.trim(), lastName: patient.lastName.trim(), dateOfBirth: patient.dateOfBirth, email: patient.email.trim(), phone },
    specialty: input.specialty,
    concern: concern.trim(),
    insurance: insurance.type === 'insurance' ? { type: 'insurance', carrier: insurance.carrier, memberId: insurance.memberId } : { type: 'self-pay' },
    campus: input.campus,
    contactPreference: input.contactPreference,
  };
}

function routeToTriageQueue(request, now = new Date()) {
  const queue = TRIAGE_QUEUES[request.specialty];
  const callbackDueBy = new Date(now.getTime() + queue.callbackSlaHours * 3600 * 1000);
  return { queue: queue.queue, nurseReview: queue.nurseReview, callbackSlaHours: queue.callbackSlaHours, callbackDueBy: callbackDueBy.toISOString() };
}

function buildFollowUpWindows(request, now = new Date()) {
  const campus = CAMPUSES.find(c => c.id === request.campus);
  const day = new Date(`${now.toLocaleDateString('en-CA', { timeZone: campus.timeZone })}T00:00:00Z`);
  const days = [];
  while (days.length < 2) {
    day.setUTCDate(day.getUTCDate() + 1);
    if (day.getUTCDay() !== 0 && day.getUTCDay() !== 6) days.push(new Date(day));
  }
  return days.flatMap(d => WINDOWS.map(w => {
    const date = d.toISOString().slice(0, 10);
    const dayLabel = d.toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric', timeZone: 'UTC' });
    return { id: `${date}-${w.slot}`, date, label: `${dayLabel}, ${w.label} ${campus.zone}` };
  }));
}

function remember(id, record) {
  requests.set(id, record);
  if (requests.size > MAX_STORED_REQUESTS) requests.delete(requests.keys().next().value);
}

async function submitAppointmentRequest(data = {}, now = new Date()) {
  const request = validateRequest(data.request, now);
  let requestId;
  do requestId = `MC-${now.getUTCFullYear()}-${String(crypto.randomInt(0, 1e6)).padStart(6, '0')}`; while (requests.has(requestId));
  const traceId = crypto.randomUUID();
  try {
    const triage = routeToTriageQueue(request, now);
    const followUpWindows = buildFollowUpWindows(request, now);
    remember(requestId, { request, triage, followUpWindows, followUp: null });
    logger.info('Mayo Clinic appointment request received', { service: SERVICE, requestId, specialty: request.specialty, campus: request.campus, queue: triage.queue });
    const campus = CAMPUSES.find(c => c.id === request.campus);
    return {
      success: true, requestId, specialty: SPECIALTIES.find(s => s.id === request.specialty).label,
      campus: campus.label, campusPhone: campus.phone, callbackDueBy: triage.callbackDueBy, followUpWindows,
    };
  } catch (error) {
    const context = { requestId, traceId, specialty: request.specialty, campus: request.campus, insuranceType: request.insurance.type, isPatient: request.isPatient };
    const tags = { route: ROUTE, service: SERVICE, customer: CUSTOMER, alert_path: 'instant' };
    Sentry.captureException(error, { tags, extra: context });
    logger.error('Mayo Clinic appointment intake failed', { ...context, service: SERVICE, error: error.message });
    logger.info('Posting alert and triggering Devin', { service: SERVICE, requestId });
    createSessionAndAlert({
      issueTitle: `${error.name}: ${error.message}`,
      issueUrl: `https://${process.env.SENTRY_ORG_SLUG || 'sentry-org'}.sentry.io/issues/?project=${process.env.SENTRY_PROJECT_ID || ''}&query=is%3Aunresolved`,
      culprit: CULPRIT, errorType: error.name, errorValue: error.message,
      customer: CUSTOMER, service: SERVICE, verticalLabel: 'Mayo Clinic — Request an Appointment',
      level: 'error', platform: 'node',
      devinUserId: data.devinUserId, devinOrgId: data.devinOrgId, devinEmail: data.devinEmail,
      promptAppendix: REMEDIATION_DIRECTIVE,
      tags: Object.entries(tags).map(([key, value]) => ({ key, value })), extra: context,
    }).catch(err => logger.error('Failed to create Devin session for Mayo Clinic appointment intake', { error: err.message, requestId }));
    throw Object.assign(error, { status: 500, code: 'APPOINTMENT_REQUEST_FAILED', requestId });
  }
}

function confirmFollowUp(requestId, windowId) {
  const record = typeof requestId === 'string' ? requests.get(requestId) : undefined;
  if (!record) throw Object.assign(new Error('We could not find that appointment request.'), { name: 'NotFoundError', status: 404, code: 'REQUEST_NOT_FOUND' });
  const window = record.followUpWindows.find(w => w.id === windowId);
  if (!window) throw invalid('Choose one of the available follow-up times.');
  record.followUp = window;
  logger.info('Mayo Clinic follow-up time confirmed', { service: SERVICE, requestId, windowId });
  return { success: true, requestId, followUp: window, contactPreference: record.request.contactPreference, firstName: record.request.patient.firstName };
}

module.exports = {
  CUSTOMER, SERVICE, ROUTE, CULPRIT, SPECIALTIES, CAMPUSES, INSURERS, REMEDIATION_DIRECTIVE,
  validateRequest, routeToTriageQueue, buildFollowUpWindows, submitAppointmentRequest, confirmFollowUp,
};
