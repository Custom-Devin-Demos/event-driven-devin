const { v4: uuidv4 } = require('uuid');
const logger = require('../../telemetry/logger');
const { incrementMetric, recordTiming } = require('../../telemetry/datadog');
const { Sentry } = require('../../telemetry/sentry');
const { createSessionAndAlert } = require('../devin-session');

const SERVICE = 'mychart-provider-finder';
const ROUTE = '/api/a5bf9cf3/providers/search';

const SPECIALTIES = [
  { termId: 1034, id: 'family-medicine', label: 'Family Medicine', synonyms: ['primary care', 'family doctor', 'pcp', 'annual physical', 'checkup'] },
  { termId: 1082, id: 'obgyn', label: 'Obstetrics and Gynecology', synonyms: ['ob/gyn', 'obgyn', 'pregnancy', 'prenatal', "women's health", 'gynecology'] },
  { termId: 2031, id: 'orthopedics', label: 'Orthopedics', synonyms: ['orthopedic', 'knee', 'hip', 'joint pain', 'sports medicine', 'fracture'] },
  { termId: 1012, id: 'cardiology', label: 'Cardiology', synonyms: ['heart', 'cardiologist', 'afib', 'chest pain', 'hypertension'] },
  { termId: 1049, id: 'gastroenterology', label: 'Gastroenterology', synonyms: ['gi', 'colonoscopy', 'stomach', 'acid reflux', 'crohn'] },
  { termId: 1079, id: 'neurology', label: 'Neurology', synonyms: ['neurologist', 'migraine', 'seizure', 'stroke', 'memory'] },
];

const LOCATIONS = {
  'akron-campus': { code: 'AKC', name: 'Summa Health System – Akron Campus', address: '141 N Forge St, Akron, OH 44304', zip: '44304', lat: 41.0789, lng: -81.5106 },
  'barberton-campus': { code: 'BBC', name: 'Summa Health System – Barberton Campus', address: '155 5th St NE, Barberton, OH 44203', zip: '44203', lat: 41.0154, lng: -81.6018 },
  'green-medical': { code: 'GRN', name: 'Summa Health Green Medical Center', address: '1865 Town Park Blvd, Uniontown, OH 44685', zip: '44685', lat: 40.9437, lng: -81.4673 },
  'wadsworth-rittman': { code: 'WRM', name: 'Summa Health Wadsworth-Rittman Medical Center', address: '195 Wadsworth Rd, Wadsworth, OH 44281', zip: '44281', lat: 41.0237, lng: -81.7271 },
  'stow-medical': { code: 'STW', name: 'Summa Health Medical Group – Stow', address: '4389 Kent Rd, Stow, OH 44224', zip: '44224', lat: 41.1597, lng: -81.4176 },
};

const PROVIDERS = [
  { id: 'P10241', name: 'Rachel M. Iannelli', credentials: 'MD', specialty: 'family-medicine', location: 'green-medical', department: 30410, acceptingNew: true, languages: ['English'], plans: ['summacare', 'medical-mutual', 'aetna', 'medicare'] },
  { id: 'P10387', name: 'David K. Osei', credentials: 'DO', specialty: 'family-medicine', location: 'stow-medical', department: 30455, acceptingNew: true, languages: ['English', 'Twi'], plans: ['summacare', 'anthem', 'united', 'medicare'] },
  { id: 'P10422', name: 'Megan L. Thornburg', credentials: 'CNP', specialty: 'family-medicine', location: 'wadsworth-rittman', department: 30470, acceptingNew: true, languages: ['English'], plans: ['summacare', 'medical-mutual', 'caresource'] },
  { id: 'P10518', name: 'Anil R. Patel', credentials: 'MD', specialty: 'family-medicine', location: 'akron-campus', department: 30401, acceptingNew: false, languages: ['English', 'Gujarati', 'Hindi'], plans: ['summacare', 'aetna', 'cigna', 'medicare'] },
  { id: 'P20114', name: 'Laura J. Kessler', credentials: 'MD, FACOG', specialty: 'obgyn', location: 'akron-campus', department: 41120, acceptingNew: true, languages: ['English'], plans: ['summacare', 'medical-mutual', 'anthem', 'caresource'] },
  { id: 'P20176', name: 'Tiffany A. Marsh', credentials: 'CNM', specialty: 'obgyn', location: 'barberton-campus', department: 41160, acceptingNew: true, languages: ['English', 'Spanish'], plans: ['summacare', 'united', 'caresource'] },
  { id: 'P30209', name: 'Gregory T. Halloran', credentials: 'MD', specialty: 'orthopedics', location: 'green-medical', department: 52210, acceptingNew: true, languages: ['English'], plans: ['summacare', 'medical-mutual', 'aetna', 'medicare'] },
  { id: 'P30244', name: 'Sarah N. Whitfield', credentials: 'DO', specialty: 'orthopedics', location: 'akron-campus', department: 52201, acceptingNew: true, languages: ['English'], plans: ['summacare', 'anthem', 'cigna'] },
  { id: 'P40311', name: 'Michael J. Abboud', credentials: 'MD, FACC', specialty: 'cardiology', location: 'akron-campus', department: 61301, acceptingNew: true, languages: ['English', 'Arabic'], plans: ['summacare', 'medical-mutual', 'united', 'medicare'] },
  { id: 'P40367', name: 'Jennifer R. Calloway', credentials: 'MD', specialty: 'cardiology', location: 'barberton-campus', department: 61340, acceptingNew: false, languages: ['English'], plans: ['summacare', 'aetna', 'medicare'] },
  { id: 'P50128', name: 'Robert E. Lindqvist', credentials: 'MD', specialty: 'gastroenterology', location: 'stow-medical', department: 72155, acceptingNew: true, languages: ['English'], plans: ['summacare', 'anthem', 'medical-mutual'] },
  { id: 'P60192', name: 'Priya S. Raman', credentials: 'MD, PhD', specialty: 'neurology', location: 'akron-campus', department: 83101, acceptingNew: true, languages: ['English', 'Tamil'], plans: ['summacare', 'united', 'cigna', 'medicare'] },
];

const DEPARTMENT_SCHEDULES = {
  'GRN:30410': { visitTypes: { NEW_PATIENT: { minutes: 40, leadDays: 6 }, ESTABLISHED: { minutes: 20, leadDays: 2 } }, clinicHours: ['08:00', '16:30'] },
  'STW:30455': { visitTypes: { NEW_PATIENT: { minutes: 40, leadDays: 9 }, ESTABLISHED: { minutes: 20, leadDays: 3 } }, clinicHours: ['07:30', '17:00'] },
  'WRM:30470': { visitTypes: { NEW_PATIENT: { minutes: 30, leadDays: 4 }, ESTABLISHED: { minutes: 20, leadDays: 1 } }, clinicHours: ['08:00', '17:00'] },
  'AKC:30401': { visitTypes: { NEW_PATIENT: { minutes: 40, leadDays: 21 }, ESTABLISHED: { minutes: 20, leadDays: 5 } }, clinicHours: ['08:00', '16:00'] },
  'AKC:41120': { visitTypes: { NEW_PATIENT: { minutes: 45, leadDays: 12 }, ESTABLISHED: { minutes: 20, leadDays: 4 } }, clinicHours: ['08:00', '16:30'] },
  'BBC:41160': { visitTypes: { NEW_PATIENT: { minutes: 45, leadDays: 8 }, ESTABLISHED: { minutes: 30, leadDays: 3 } }, clinicHours: ['08:30', '16:30'] },
  'GRN:52210': { visitTypes: { NEW_PATIENT: { minutes: 30, leadDays: 10 }, ESTABLISHED: { minutes: 15, leadDays: 4 } }, clinicHours: ['07:30', '15:30'] },
  'AKC:52201': { visitTypes: { NEW_PATIENT: { minutes: 30, leadDays: 14 }, ESTABLISHED: { minutes: 15, leadDays: 5 } }, clinicHours: ['08:00', '16:00'] },
  'AKC:61301': { visitTypes: { NEW_PATIENT: { minutes: 60, leadDays: 18 }, ESTABLISHED: { minutes: 30, leadDays: 7 } }, clinicHours: ['08:00', '16:30'] },
  'BBC:61340': { visitTypes: { NEW_PATIENT: { minutes: 60, leadDays: 24 }, ESTABLISHED: { minutes: 30, leadDays: 9 } }, clinicHours: ['08:00', '16:00'] },
  'STW:72155': { visitTypes: { NEW_PATIENT: { minutes: 45, leadDays: 16 }, ESTABLISHED: { minutes: 20, leadDays: 6 } }, clinicHours: ['07:00', '15:00'] },
  'AKC:83101': { visitTypes: { NEW_PATIENT: { minutes: 60, leadDays: 27 }, ESTABLISHED: { minutes: 30, leadDays: 10 } }, clinicHours: ['08:30', '16:30'] },
};

const INSURANCE_PLANS = {
  none: 'No insurance',
  aetna: 'Aetna',
  'aetna-medicaid': 'Aetna Medicaid',
  'amish-church-fund': 'Amish Church Fund',
  anthem: 'Anthem',
  'anthem-medicaid': 'Anthem Medicaid',
  'anthem-medicare-advantage': 'Anthem Medicare Advantage',
  aultcare: 'Aultcare',
  'aultcare-primetime-medicare': 'Aultcare Primetime Medicare',
  'buckeye-ambetter-product': 'Buckeye (Ambetter Product)',
  'buckeye-medicaid': 'Buckeye Medicaid',
  'buckeye-medicare': 'Buckeye Medicare',
  caresource: 'Caresource',
  'caresource-medicaid': 'Caresource Medicaid',
  'caresource-medicare': 'Caresource Medicare',
  'christian-healthcare': 'Christian Healthcare',
  cigna: 'Cigna',
  'cigna-medicare': 'CIGNA MEDICARE',
  'communicare-advantage-medicare': 'Communicare Advantage Medicare',
  'first-health-network': 'First Health Network',
  'first-health-network-medicare': 'First Health Network Medicare',
  'health-plan-of-upper-ohio-valley': 'Health Plan of Upper Ohio Valley',
  'health-plan-of-upper-ohio-valley-medicare': 'Health Plan of Upper Ohio Valley Medicare',
  healthsmart: 'Healthsmart',
  'healthsmart-medicare': 'Healthsmart Medicare',
  'humana-commerical': 'Humana Commerical',
  'humana-medicaid': 'HUMANA MEDICAID',
  'humana-medicare-advantage': 'Humana Medicare Advantage',
  'mco-3-hab': 'MCO 3 HAB',
  'mco-aultcare': 'MCO Aultcare',
  'mco-compone': 'MCO COMPONE',
  'mco-corvel-corp': 'MCO CORVEL CORP',
  'mco-genex-care-ohio': 'MCO GENEX CARE OHIO',
  'mco-occupational-health': 'MCO OCCUPATIONAL HEALTH',
  'mco-promedica-medical-management': 'MCO PROMEDICA MEDICAL MANAGEMENT',
  'mco-sedwick': 'MCO SEDWICK',
  'mco-sheakley-unicomp': 'MCO SHEAKLEY UNICOMP',
  'mco-spooner-medical': 'MCO SPOONER MEDICAL',
  'medical-mutual': 'Medical Mutual',
  'medical-mutual-medicare': 'Medical Mutual Medicare',
  medicare: 'Medicare',
  'medicare-mutual-advantage': 'Medicare Mutual Advantage',
  molina: 'Molina',
  'molina-medicare-advantage': 'Molina Medicare Advantage',
  multiplan: 'Multiplan',
  'ohio-medicaid': 'Ohio Medicaid',
  'ohiohealth-choice': 'OhioHealth Choice',
  'paramount-advantage-medicaid': 'Paramount Advantage Medicaid',
  'perennial-advantage': 'Perennial Advantage',
  'primary-health-services': 'Primary Health Services',
  primetime: 'Primetime',
  'private-healthcare-systems': 'Private Healthcare Systems',
  'si-sedwick-cms': 'SI Sedwick CMS',
  summacare: 'SummaCare',
  'summacare-medicare-advantage': 'SummaCare Medicare Advantage',
  tricare: 'Tricare',
  united: 'United Healthcare',
  'united-healthcare-medicaid': 'United Healthcare Medicaid',
  'united-healthcare-medicare': 'United Healthcare Medicare',
  'valor-health-plan': 'Valor Health Plan',
  'wellcare-medicaid': 'Wellcare Medicaid',
  'wellcare-medicare': 'Wellcare Medicare',
  'not-listed': 'Not listed',
};

const SEARCH_TERMS = [
  ...SPECIALTIES.map(({ label }) => ({ text: label, kind: 'specialty' })),
  ...['Allergy and Immunology', 'Dermatology', 'Endocrinology', 'Internal Medicine', 'Pediatrics', 'Pulmonology', 'Urology', 'Oncology', 'Ophthalmology', 'Otolaryngology', 'Podiatry', 'Psychiatry', 'Rheumatology', 'Sleep Medicine', 'Cardiothoracic Surgery', 'Gynecologic Oncology', 'Neurosurgery']
    .map((text) => ({ text, kind: 'specialty' })),
  ...['Cardiomegaly', 'Cardiac Tumor', 'Cardiac Shock', 'Cardiomyopathy', 'Cardiac Arrest', 'Cardiac Murmur', 'Atrial Fibrillation', 'Chest Pain', 'Heart Failure', 'Hypertension', 'Migraine', 'Seizure', 'Stroke', 'Memory Loss', 'Multiple Sclerosis', 'Neuropathy', "Crohn's Disease", 'Acid Reflux', 'Irritable Bowel Syndrome', 'Knee Pain', 'Hip Pain', 'Back Pain', 'Fracture', 'Carpal Tunnel Syndrome', 'Pregnancy', 'Menopause', 'Diabetes', 'Asthma', 'Sleep Apnea']
    .map((text) => ({ text, kind: 'condition' })),
  ...['Cardiac Cath', 'Cardioversion', 'Cardiac Stent', 'Cardiac Rehabilitation', 'Echocardiogram', 'Colonoscopy', 'Upper Endoscopy', 'Knee Replacement', 'Hip Replacement', 'Arthroscopy', 'Prenatal Care', 'Mammogram', 'Annual Physical', 'EEG', 'Physical Therapy']
    .map((text) => ({ text, kind: 'treatment' })),
];

function normalize(text) {
  return String(text || '').trim().toLowerCase();
}

function matchSpecialty(query) {
  const term = normalize(query);
  if (!term) return null;
  return SPECIALTIES.find((specialty) => normalize(specialty.label).includes(term)
    || specialty.synonyms.some((synonym) => synonym.includes(term) || term.includes(synonym))) || null;
}

function selectProviders(query, specialty) {
  if (specialty) return PROVIDERS.filter((provider) => provider.specialty === specialty.id);
  const term = normalize(query);
  const byName = term ? PROVIDERS.filter((provider) => normalize(provider.name).includes(term)) : [];
  return byName.length ? byName : PROVIDERS.filter((provider) => provider.specialty === 'family-medicine');
}

function distanceMiles(criteria, location) {
  const origin = criteria.origin || Object.values(LOCATIONS).find((candidate) => candidate.zip === criteria.zip);
  if (!origin) return null;
  const toRad = (deg) => (deg * Math.PI) / 180;
  const dLat = toRad(location.lat - origin.lat);
  const dLng = toRad(location.lng - origin.lng);
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(origin.lat)) * Math.cos(toRad(location.lat)) * Math.sin(dLng / 2) ** 2;
  return Math.round(3958.8 * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a)) * 10) / 10;
}

function scheduleKey(provider) {
  return `${provider.location}:${provider.department}`.toUpperCase();
}

function visitTypeFor(provider) {
  return provider.acceptingNew ? 'new-patient' : 'established';
}

function firstAvailable(provider, visitType, now) {
  const template = DEPARTMENT_SCHEDULES[scheduleKey(provider)].visitTypes[visitType];
  const date = new Date(now);
  date.setDate(date.getDate() + template.leadDays);
  while (date.getDay() === 0 || date.getDay() === 6) date.setDate(date.getDate() + 1);
  return { date: date.toISOString().slice(0, 10), minutes: template.minutes };
}

function buildResult(provider, criteria, now) {
  const location = LOCATIONS[provider.location];
  const opening = firstAvailable(provider, visitTypeFor(provider), now);
  return {
    providerId: provider.id,
    displayName: `${provider.name}, ${provider.credentials}`,
    specialty: SPECIALTIES.find((specialty) => specialty.id === provider.specialty).label,
    location: { name: location.name, address: location.address },
    distanceMiles: distanceMiles(criteria, location),
    acceptingNewPatients: provider.acceptingNew,
    inNetwork: criteria.insurance ? provider.plans.includes(criteria.insurance) : null,
    languages: provider.languages,
    firstAvailable: opening.date,
    visitLengthMinutes: opening.minutes,
  };
}

function rankResults(results) {
  return results.sort((a, b) => {
    if (a.acceptingNewPatients !== b.acceptingNewPatients) return a.acceptingNewPatients ? -1 : 1;
    if (a.distanceMiles !== null && b.distanceMiles !== null && a.distanceMiles !== b.distanceMiles) return a.distanceMiles - b.distanceMiles;
    return a.firstAvailable.localeCompare(b.firstAvailable);
  });
}

async function searchProviders(data) {
  const startTime = Date.now();
  const searchId = `pfs_${uuidv4().slice(0, 8)}`;
  const criteria = {
    query: String(data.query || '').slice(0, 200),
    insurance: data.insurance || '',
    zip: String(data.zip || '').replace(/\D/g, '').slice(0, 5),
    origin: Number.isFinite(Number(data.lat)) && Number.isFinite(Number(data.lng)) && data.lat !== '' && data.lat != null
      ? { lat: Number(data.lat), lng: Number(data.lng) }
      : null,
  };
  logger.info('Running provider search', { searchId, query: criteria.query, insurance: criteria.insurance, service: SERVICE, route: ROUTE });
  try {
    await new Promise((resolve) => setTimeout(resolve, 60 + Math.random() * 90));
    const specialty = matchSpecialty(criteria.query);
    const now = Date.now();
    const results = rankResults(selectProviders(criteria.query, specialty).map((provider) => buildResult(provider, criteria, now)));
    incrementMetric('providers.search.success', { route: ROUTE, specialty: specialty ? specialty.id : 'none' });
    recordTiming('providers.search.latency', Date.now() - startTime, { route: ROUTE });
    return {
      success: true,
      searchId,
      specialty: specialty ? specialty.label : null,
      insurance: criteria.insurance ? INSURANCE_PLANS[criteria.insurance] || null : null,
      total: results.length,
      results,
    };
  } catch (error) {
    const duration = Date.now() - startTime;
    incrementMetric('providers.search.failure', { route: ROUTE, errorClass: error.name });
    recordTiming('providers.search.latency', duration, { route: ROUTE, error: 'true' });
    logger.error('Provider search failed', {
      searchId,
      error: error.message,
      errorClass: error.name,
      durationMs: duration,
      query: criteria.query,
      service: SERVICE,
    });
    Sentry.captureException(error, {
      tags: { route: ROUTE, service: SERVICE, source: 'provider-finder', alert_path: 'instant' },
      extra: { searchId, criteria },
    });
    createSessionAndAlert({
      issueTitle: `${error.name}: ${error.message}`,
      issueUrl: `https://${process.env.SENTRY_ORG_SLUG || 'sentry-org'}.sentry.io/issues/?project=${process.env.SENTRY_PROJECT_ID || ''}&query=is%3Aunresolved`,
      culprit: 'app/services/verticals/a5bf9cf3.js — firstAvailable',
      errorType: error.name || 'Error',
      errorValue: error.message,
      customer: 'a5bf9cf3',
      devinUserId: data.devinUserId,
      devinEmail: data.devinEmail,
      devinOrgId: data.devinOrgId,
      service: SERVICE,
      verticalLabel: 'Summa Health — MyChart Find a Provider',
      tags: [
        { key: 'route', value: ROUTE },
        { key: 'service', value: SERVICE },
      ],
      extra: { searchId, criteria },
      level: 'error',
      platform: 'node',
      firstSeen: '',
      lastSeen: new Date().toISOString(),
      count: '',
      shortId: '',
      project: 'event-driven-devin',
      release: process.env.SENTRY_RELEASE || `${SERVICE}@1.0.0`,
      environment: process.env.DD_ENV || 'prod',
      triggeredRule: '',
    }).catch((alertError) => {
      logger.error('Failed to trigger Devin session from provider search error', { error: alertError.message });
    });
    throw error;
  }
}

function getSearchCatalog() {
  return {
    specialties: SPECIALTIES.map(({ termId, id, label }) => ({ termId, id, label })),
    insurancePlans: Object.entries(INSURANCE_PLANS).map(([id, label]) => ({ id, label })),
    searchTerms: SEARCH_TERMS,
    providers: PROVIDERS.map(({ id, name, credentials }) => ({ id, label: `${name}, ${credentials}` })),
    locations: Object.values(LOCATIONS).map(({ name, address }) => ({ name, address })),
  };
}

module.exports = {
  searchProviders,
  getSearchCatalog,
  SPECIALTIES,
  PROVIDERS,
};
