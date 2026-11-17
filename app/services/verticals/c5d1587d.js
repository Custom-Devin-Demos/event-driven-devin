const crypto = require('crypto');
const Sentry = require('@sentry/node');
const { createSessionAndAlert } = require('../devin-session');
const logger = require('../../telemetry/logger');

const CUSTOMER = 'c5d1587d';
const SERVICE = 'customer-c5d1587d-mortgage-offers';
const ROUTE = 'POST /api/c5d1587d/mortgage-offers';
const CULPRIT = 'app/services/verticals/c5d1587d.js — priceTrack';
const ERROR_CODE = 'MTG-PRC-5003';
const VERTICAL_LABEL = 'Mizrahi-Tefahot — Digital mortgage approval';

// Bank of Israel prime = policy rate 4.50% + 1.50%.
const PRIME_RATE = 6.0;

const PURPOSES = [
  { id: 'first-home', label: 'קניית דירה ראשונה', maxLtv: 0.75 },
  { id: 'replacement', label: 'החלפת דירה', maxLtv: 0.70 },
  { id: 'investment', label: 'קניית דירה להשקעה', maxLtv: 0.50 },
];

const TRACKS = {
  PRIME: { label: 'פריים', linked: false, fixed: false },
  KLTZ: { label: 'קבועה לא צמודה', linked: false, fixed: true },
  KTZ: { label: 'קבועה צמודה למדד', linked: true, fixed: true },
  MSH5_LTZ: { label: 'משתנה כל 5 שנים לא צמודה', linked: false, fixed: false },
  MSH5_TZ: { label: 'משתנה כל 5 שנים צמודה', linked: true, fixed: false },
  KLTZ_GREEN: { label: 'קבועה לא צמודה – משכנתא ירוקה', linked: false, fixed: true },
  KTZ_GREEN: { label: 'קבועה צמודה למדד – משכנתא ירוקה', linked: true, fixed: true },
};

// Indicative rate sheet (annual %, before personal risk premium). Rate desk, Nov 2026.
const TRACK_PRICING = {
  PRIME: { baseRate: PRIME_RATE, spread: -0.6, minYears: 4, maxYears: 30 },
  KLTZ: { baseRate: 5.05, spread: 0, minYears: 4, maxYears: 30 },
  KTZ: { baseRate: 3.65, spread: 0, minYears: 5, maxYears: 30 },
  MSH5_LTZ: { baseRate: 4.9, spread: 0, minYears: 5, maxYears: 30 },
  MSH5_TZ: { baseRate: 3.4, spread: 0, minYears: 5, maxYears: 30 },
  KLTZ_GREEN: { baseRate: 5.05, spread: -0.15, minYears: 4, maxYears: 30 },
};

const MIXES = [
  { id: 'recommended', label: 'התמהיל המומלץ של טפחות', hint: 'שליש פריים, שליש קבועה לא צמודה, שליש קבועה צמודה' },
  { id: 'uniform-1', label: 'תמהיל אחיד 1', hint: 'כל ההלוואה בריבית קבועה לא צמודה' },
  { id: 'uniform-2', label: 'תמהיל אחיד 2', hint: 'שליש קבועה לא צמודה, שליש פריים, שליש משתנה כל 5 שנים לא צמודה' },
  { id: 'uniform-3', label: 'תמהיל אחיד 3', hint: 'חצי קבועה לא צמודה, חצי פריים' },
];

const REMEDIATION_DIRECTIVE = [
  'Repository: COG-GTM/event-driven-devin. Open a ready-for-review (not draft) pull request against main with a conventional title (e.g. "fix(mortgage-offers): ..."); never merge or deploy.',
  'FIRST, before reading any code: reply in the alert\'s Slack thread (channel and thread_ts are at the end of this prompt; curl chat.postMessage with $SLACK_BOT_TOKEN) with your Devin session link only, e.g. ":robot_face: Investigating — <your session URL>".',
  'Treat this alert as a new incident even if the same error alerted before: do not look for, wait on, reuse or link earlier alerts, threads, sessions, branches or PRs. The client reports every failure.',
  'Customer impact: Mizrahi-Tefahot digital mortgage approval (/mizrahi or /c5d1587d → "אישור משכנתא בדיגיטל") returns HTTP 500 ' + ERROR_CODE + ' when a first-home buyer in a green-certified building (SI 5281) asks for an offer on the recommended mix. Uniform mixes 1–3 and non-green properties succeed.',
  'Reproduce: open /mizrahi?reports=off#offer, keep the pre-filled application (new apartment, Ramat Gan, ₪2,650,000, green-certified, recommended mix) and press "לקבלת אישור עקרוני". Untick the green-building box and it succeeds.',
  'Inspect app/services/verticals/c5d1587d.js (buildMix, priceTrack, TRACK_PRICING), app/routes/verticals/c5d1587d.js and app/public/verticals/c5d1587d-assets/offer.js. Find and state the root cause before changing code.',
  'Green-mortgage tracks are priced off their non-green counterpart with the same terms and a 0.15 percentage-point green discount (spread -0.15).',
  'Keep every track, mix and Bank of Israel check (LTV by purpose, 1/3 fixed-rate floor, 2/3 prime cap, 50% payment-to-income) intact; keep error reporting and the server-generated offer reference.',
  'Add regression coverage in tests/c5d1587d-mizrahi-mortgage.test.js and update the existing failure expectation after the fix. Run npx jest tests/c5d1587d-mizrahi-mortgage.test.js and npm run lint.',
  'Do not disable Sentry/alerts, swallow the error, drop the green track from the mix, or fake a successful response in the browser.',
  'After opening the PR, request Devin Review on it and wait for the Devin Review checks to finish; fix every actionable finding on the same branch and reply to each review comment. Then post a short root-cause + PR + Devin Review summary to the Slack thread and stop for human approval.',
].join('\n');

const MAX_STORED_OFFERS = 500;
const offers = new Map();
const invalid = (message, field) => Object.assign(new Error(message), { name: 'ValidationError', status: 400, code: 'INVALID_MORTGAGE_APPLICATION', field });
const num = v => (typeof v === 'number' ? v : Number(String(v ?? '').replace(/[^\d.]/g, '')));

function isValidIsraeliId(id) {
  const digits = String(id || '').replace(/\D/g, '');
  if (!digits || digits.length > 9) return false;
  const padded = digits.padStart(9, '0');
  let sum = 0;
  for (let i = 0; i < 9; i += 1) {
    let d = Number(padded[i]) * ((i % 2) + 1);
    if (d > 9) d -= 9;
    sum += d;
  }
  return sum % 10 === 0;
}

function validateApplication(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw invalid('יש למלא את פרטי הבקשה.');
  const { property = {}, borrower = {}, loan = {} } = input;
  const purpose = PURPOSES.find(p => p.id === property.purpose);
  if (!purpose) throw invalid('יש לבחור את מטרת המשכנתא.', 'purpose');
  const price = num(property.price);
  if (!(price >= 400000 && price <= 10000000)) throw invalid('יש להזין מחיר נכס בין 400 אלף ל-10 מיליון ש"ח.', 'price');
  if (typeof property.city !== 'string' || property.city.trim().length < 2) throw invalid('יש לבחור יישוב.', 'city');
  if (typeof borrower.fullName !== 'string' || borrower.fullName.trim().length < 2) throw invalid('יש להזין שם מלא.', 'fullName');
  if (!isValidIsraeliId(borrower.idNumber)) throw invalid('מספר תעודת הזהות אינו תקין.', 'idNumber');
  const phone = String(borrower.phone || '').replace(/\D/g, '');
  if (!/^05\d{8}$/.test(phone)) throw invalid('יש להזין מספר טלפון נייד תקין.', 'phone');
  const income = num(borrower.netIncome);
  if (!(income >= 3000 && income <= 500000)) throw invalid('יש להזין הכנסה חודשית נטו.', 'netIncome');
  const obligations = num(borrower.obligations || 0);
  if (!(obligations >= 0 && obligations < income)) throw invalid('ההתחייבויות החודשיות אינן תקינות.', 'obligations');
  const amount = num(loan.amount);
  if (!(amount >= 100000)) throw invalid('יש להזין סכום משכנתא של 100,000 ש"ח לפחות.', 'amount');
  const years = num(loan.years);
  if (!(Number.isInteger(years) && years >= 4 && years <= 30)) throw invalid('תקופת המשכנתא היא בין 4 ל-30 שנה.', 'years');
  if (!MIXES.some(m => m.id === loan.mix)) throw invalid('יש לבחור תמהיל.', 'mix');
  if (amount / price > purpose.maxLtv + 1e-9) {
    throw invalid(`שיעור המימון המרבי ל${purpose.label} הוא ${Math.round(purpose.maxLtv * 100)}% משווי הנכס.`, 'amount');
  }
  return {
    property: { purpose: purpose.id, price, city: property.city.trim(), greenCertified: property.greenCertified === true, newBuild: property.newBuild === true },
    borrower: { fullName: borrower.fullName.trim(), idNumber: String(borrower.idNumber).replace(/\D/g, '').padStart(9, '0'), phone, netIncome: income, obligations },
    loan: { amount, years, mix: loan.mix },
  };
}

function buildMix(application) {
  const green = application.property.greenCertified;
  const fixed = green ? 'KLTZ_GREEN' : 'KLTZ';
  switch (application.loan.mix) {
    case 'recommended':
      return [
        { code: 'PRIME', share: 1 / 3 },
        { code: fixed, share: 1 / 3 },
        { code: green ? 'KTZ_GREEN' : 'KTZ', share: 1 / 3 },
      ];
    case 'uniform-1': return [{ code: fixed, share: 1 }];
    case 'uniform-2': return [{ code: fixed, share: 1 / 3 }, { code: 'PRIME', share: 1 / 3 }, { code: 'MSH5_LTZ', share: 1 / 3 }];
    case 'uniform-3': return [{ code: fixed, share: 1 / 2 }, { code: 'PRIME', share: 1 / 2 }];
    default: throw invalid('יש לבחור תמהיל.', 'mix');
  }
}

// Bank of Israel Directive 329: at least 1/3 fixed-rate, at most 2/3 prime.
function checkMixRules(mix) {
  const fixedShare = mix.filter(t => TRACKS[t.code].fixed).reduce((s, t) => s + t.share, 0);
  const primeShare = mix.filter(t => t.code === 'PRIME').reduce((s, t) => s + t.share, 0);
  if (fixedShare + 1e-9 < 1 / 3) throw invalid('לפחות שליש מההלוואה צריך להיות בריבית קבועה.', 'mix');
  if (primeShare > 2 / 3 + 1e-9) throw invalid('חלק הפריים אינו יכול לעלות על שני שלישים מההלוואה.', 'mix');
}

function spitzerPayment(principal, annualRate, years) {
  const r = annualRate / 100 / 12;
  const n = years * 12;
  if (r === 0) return principal / n;
  return (principal * r) / (1 - (1 + r) ** -n);
}

function priceTrack(track, amount, years) {
  const sheet = TRACK_PRICING[track.code];
  const rate = Math.round((sheet.baseRate + sheet.spread) * 100) / 100;
  if (years < sheet.minYears || years > sheet.maxYears) throw invalid(`תקופה לא נתמכת למסלול ${TRACKS[track.code].label}.`, 'years');
  const principal = Math.round(amount * track.share);
  const monthly = spitzerPayment(principal, rate, years);
  return {
    code: track.code, label: TRACKS[track.code].label, linked: TRACKS[track.code].linked,
    share: Math.round(track.share * 1000) / 10, principal, annualRate: rate, monthlyPayment: Math.round(monthly),
  };
}

function remember(id, record) {
  offers.set(id, record);
  if (offers.size > MAX_STORED_OFFERS) offers.delete(offers.keys().next().value);
}

async function requestOffer(data = {}, now = new Date()) {
  const application = validateApplication(data.application);
  let offerId;
  do offerId = `TF-${now.getUTCFullYear()}-${String(crypto.randomInt(0, 1e7)).padStart(7, '0')}`; while (offers.has(offerId));
  const traceId = crypto.randomUUID();
  try {
    const mix = buildMix(application);
    checkMixRules(mix);
    const tracks = mix.map(t => priceTrack(t, application.loan.amount, application.loan.years));
    const monthlyPayment = tracks.reduce((s, t) => s + t.monthlyPayment, 0);
    const disposable = application.borrower.netIncome - application.borrower.obligations;
    const paymentToIncome = Math.round((monthlyPayment / disposable) * 1000) / 10;
    if (paymentToIncome > 50) throw invalid('ההחזר החודשי עולה על 50% מההכנסה הפנויה. נסו להאריך את התקופה או להקטין את הסכום.', 'amount');
    const validUntil = new Date(now.getTime() + 24 * 24 * 3600 * 1000).toISOString().slice(0, 10);
    const offer = {
      success: true, offerId, status: 'APPROVED_IN_PRINCIPLE', amount: application.loan.amount, years: application.loan.years,
      ltv: Math.round((application.loan.amount / application.property.price) * 1000) / 10,
      mix: MIXES.find(m => m.id === application.loan.mix).label, tracks, monthlyPayment, paymentToIncome, validUntil,
      firstName: application.borrower.fullName.split(/\s+/)[0],
    };
    remember(offerId, { application, offer });
    logger.info('Mortgage approval in principle issued', { service: SERVICE, offerId, mix: application.loan.mix, green: application.property.greenCertified, amount: application.loan.amount });
    return offer;
  } catch (error) {
    if (error.name === 'ValidationError') throw error;
    const context = {
      offerId, traceId, purpose: application.property.purpose, city: application.property.city, mix: application.loan.mix,
      greenCertified: application.property.greenCertified, amount: application.loan.amount, years: application.loan.years, errorCode: ERROR_CODE,
    };
    const tags = { route: ROUTE, service: SERVICE, customer: CUSTOMER, error_code: ERROR_CODE, alert_path: 'instant' };
    Sentry.captureException(error, { tags, extra: context });
    logger.error('Mortgage offer pricing failed', { ...context, service: SERVICE, error: error.message });
    if (!data.suppressAlerts) {
      logger.info('Posting alert and triggering Devin', { service: SERVICE, offerId });
      createSessionAndAlert({
        issueTitle: `${error.name}: ${error.message}`,
        issueUrl: `https://${process.env.SENTRY_ORG_SLUG || 'sentry-org'}.sentry.io/issues/?project=${process.env.SENTRY_PROJECT_ID || ''}&query=is%3Aunresolved`,
        culprit: CULPRIT, errorType: error.name, errorValue: error.message,
        customer: CUSTOMER, service: SERVICE, verticalLabel: VERTICAL_LABEL,
        level: 'error', platform: 'node', release: 'mortgage-offers@2026.11.2', environment: process.env.DD_ENV || 'prod',
        devinUserId: data.devinUserId, devinOrgId: data.devinOrgId, devinEmail: data.devinEmail,
        promptAppendix: `Incident Ref: ${offerId}\n${REMEDIATION_DIRECTIVE}`,
        tags: Object.entries(tags).map(([key, value]) => ({ key, value })), extra: context,
      }).catch(err => logger.error('Failed to create Devin session for mortgage offer failure', { error: err.message, offerId }));
    }
    throw Object.assign(error, { status: 500, code: ERROR_CODE, reference: offerId });
  }
}

function getOffer(offerId) {
  const record = typeof offerId === 'string' ? offers.get(offerId) : undefined;
  if (!record) throw Object.assign(new Error('ההצעה לא נמצאה.'), { name: 'NotFoundError', status: 404, code: 'OFFER_NOT_FOUND' });
  return record.offer;
}

module.exports = {
  CUSTOMER, SERVICE, ROUTE, CULPRIT, ERROR_CODE, PRIME_RATE, PURPOSES, TRACKS, TRACK_PRICING, MIXES, REMEDIATION_DIRECTIVE,
  isValidIsraeliId, validateApplication, buildMix, checkMixRules, spitzerPayment, priceTrack, requestOffer, getOffer,
};
