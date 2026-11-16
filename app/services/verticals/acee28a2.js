const { randomUUID } = require('crypto');

const CUSTOMER = 'acee28a2';
const REVISION = 'Incident baseline';
const CLINIC = 'Twin Cities Heart Rhythm Clinic';

// Synthetic device families and patients. Nothing here is real patient data.
const DEVICE_MODELS = [
  { model: 'ICD-VR200', family: 'Transvenous ICD', released: '2021-03-02' },
  { model: 'CRTD-400', family: 'CRT-D', released: '2022-09-13' },
  { model: 'SICD-A300', family: 'Subcutaneous ICD', released: '2026-11-09', isNew: true },
];
const PATIENTS = [
  { id: 'PT-10482', name: 'Demo Patient A', age: 71, model: 'ICD-VR200', lastTransmissionDaysAgo: 1, finding: { severity: 'red', code: 'SHOCK_LEAD_IMPEDANCE', label: 'Shock lead impedance out of range' } },
  { id: 'PT-20917', name: 'Demo Patient B', age: 64, model: 'CRTD-400', lastTransmissionDaysAgo: 1, finding: { severity: 'yellow', code: 'AT_AF_BURDEN', label: 'Atrial arrhythmia burden above threshold' } },
  { id: 'PT-31266', name: 'Demo Patient C', age: 58, model: 'SICD-A300', lastTransmissionDaysAgo: 2, finding: { severity: 'yellow', code: 'UNTREATED_EPISODE', label: 'Untreated episode stored' } },
  { id: 'PT-31803', name: 'Demo Patient D', age: 66, model: 'SICD-A300', lastTransmissionDaysAgo: 3, finding: { severity: 'red', code: 'BATTERY_END_OF_LIFE', label: 'Battery reached end of life' } },
];

// Where a detected alert condition is routed for each device model.
const ALERT_ROUTING = {
  'ICD-VR200': {
    red: { worklist: 'red-alerts', notify: ['page', 'sms', 'email'], reviewWithinHours: 24 },
    yellow: { worklist: 'yellow-alerts', notify: ['email'], reviewWithinHours: 72 },
  },
  'CRTD-400': {
    red: { worklist: 'red-alerts', notify: ['page', 'sms', 'email'], reviewWithinHours: 24 },
    yellow: { worklist: 'yellow-alerts', notify: ['email'], reviewWithinHours: 72 },
  },
  'SICD-A300': {
    yellow: { worklist: 'yellow-alerts', notify: ['email'], reviewWithinHours: 72 },
  },
};

function invalid(message) {
  return Object.assign(new Error(message), { status: 400, code: 'INVALID_TRANSMISSION' });
}

function processTransmission({ patientId } = {}) {
  const patient = PATIENTS.find(p => p.id === patientId);
  if (typeof patientId !== 'string' || !patient) throw invalid('Choose a patient from the clinic list.');
  const { severity, code, label } = patient.finding;
  const route = ALERT_ROUTING[patient.model][severity];
  return {
    success: true, demo: true, clinic: CLINIC,
    transmissionId: `DEMO-TX-${randomUUID().slice(0, 8).toUpperCase()}`,
    patientId: patient.id, model: patient.model,
    alert: { severity, code, label, worklist: route.worklist, notify: route.notify, reviewWithinHours: route.reviewWithinHours },
    revision: REVISION,
  };
}

module.exports = { CUSTOMER, REVISION, CLINIC, DEVICE_MODELS, PATIENTS, processTransmission };
