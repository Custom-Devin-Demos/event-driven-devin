const express = require('express');
const {
  runQuoteComparison,
  carriersAppointedIn,
  zipInRatingArea,
  isCalendarDate,
  planFEligible,
  STATES,
  PLANS,
  CARRIERS,
  GENDER_FACTORS,
  ENROLLMENT_WINDOWS,
  EFFECTIVE_DATES,
  PLAN_F_ELIGIBILITY_CUTOFF,
  AGE_MIN,
  AGE_MAX,
} = require('../../services/verticals/64e85fcf');

const router = express.Router();

router.get('/api/64e85fcf/carriers', (req, res) => {
  const state = typeof req.query.state === 'string' ? req.query.state.toUpperCase() : null;
  const carriers = state && Object.hasOwn(STATES, state)
    ? carriersAppointedIn(state)
    : Object.entries(CARRIERS).map(([carrierId, c]) => ({ carrierId, ...c }));
  res.json({
    carriers,
    states: Object.entries(STATES).map(([code, s]) => ({ code, name: s.name, ratingArea: s.ratingArea, zipPrefixes: s.zipPrefixes, sampleZip: s.sampleZip })),
    plans: Object.entries(PLANS).map(([code, p]) => ({ code, label: p.label, description: p.description, newlyEligible: p.newlyEligible })),
    enrollmentWindows: Object.entries(ENROLLMENT_WINDOWS).map(([code, w]) => ({ code, label: w.label, description: w.description })),
    effectiveDates: Object.entries(EFFECTIVE_DATES).map(([code, d]) => ({ code, label: d.label })),
    ageRange: [AGE_MIN, AGE_MAX],
  });
});

function numberField(value) {
  if (typeof value === 'number') return value;
  if (typeof value === 'string' && value.trim() !== '') return Number(value);
  return NaN;
}

function stringField(value, fallback) {
  if (value === undefined || value === null || value === '') return fallback;
  return typeof value === 'string' ? value : null;
}

function has(map, key) {
  return typeof key === 'string' && Object.hasOwn(map, key);
}

router.post('/api/64e85fcf/quotes', async (req, res) => {
  const body = req.body || {};
  const agentName = typeof body.agentName === 'string' ? body.agentName.trim() : '';
  const clientFirstName = typeof body.clientFirstName === 'string' ? body.clientFirstName.trim() : '';
  const state = stringField(body.state, 'MO');
  const zip = typeof body.zip === 'string' ? body.zip.trim() : '';
  const medicareEligibleDate = typeof body.medicareEligibleDate === 'string' ? body.medicareEligibleDate.trim() : '';
  const age = numberField(body.age);
  const gender = stringField(body.gender, 'female');
  const tobacco = body.tobacco === true || body.tobacco === 'true' || body.tobacco === 'yes';
  const plan = stringField(body.plan, 'G');
  const enrollmentWindow = stringField(body.enrollmentWindow, 'open_enrollment');
  const effectiveDate = stringField(body.effectiveDate, 'next_month');

  if (!agentName) {
    return res.status(400).json({ success: false, error: 'agentName is required', code: 'VALIDATION_ERROR' });
  }
  if (!clientFirstName) {
    return res.status(400).json({ success: false, error: 'clientFirstName is required', code: 'VALIDATION_ERROR' });
  }
  if (!has(STATES, state)) {
    return res.status(400).json({ success: false, error: `Unsupported state: ${state}`, code: 'VALIDATION_ERROR' });
  }
  if (!/^\d{5}$/.test(zip)) {
    return res.status(400).json({ success: false, error: 'zip must be a 5-digit ZIP code', code: 'VALIDATION_ERROR' });
  }
  if (!zipInRatingArea(state, zip)) {
    return res.status(400).json({
      success: false,
      error: `ZIP ${zip} is outside the ${STATES[state].ratingArea} rating area filed for ${STATES[state].name}`,
      code: 'VALIDATION_ERROR',
    });
  }
  if (medicareEligibleDate && !isCalendarDate(medicareEligibleDate)) {
    return res.status(400).json({ success: false, error: 'medicareEligibleDate must be a valid YYYY-MM-DD calendar date', code: 'VALIDATION_ERROR' });
  }
  if (!Number.isSafeInteger(age) || age < AGE_MIN || age > AGE_MAX) {
    return res.status(400).json({
      success: false,
      error: `age must be a whole number between ${AGE_MIN} and ${AGE_MAX}`,
      code: 'VALIDATION_ERROR',
    });
  }
  if (!has(GENDER_FACTORS, gender)) {
    return res.status(400).json({ success: false, error: `Unknown gender: ${gender}`, code: 'VALIDATION_ERROR' });
  }
  if (!has(PLANS, plan)) {
    return res.status(400).json({ success: false, error: `Unknown plan: ${plan}`, code: 'VALIDATION_ERROR' });
  }
  if (!PLANS[plan].newlyEligible && !planFEligible(medicareEligibleDate)) {
    return res.status(400).json({
      success: false,
      error: `${PLANS[plan].label} is only available to clients first eligible for Medicare before ${PLAN_F_ELIGIBILITY_CUTOFF}`,
      code: 'VALIDATION_ERROR',
    });
  }
  if (!has(ENROLLMENT_WINDOWS, enrollmentWindow)) {
    return res.status(400).json({ success: false, error: `Unknown enrollment window: ${enrollmentWindow}`, code: 'VALIDATION_ERROR' });
  }
  const window = ENROLLMENT_WINDOWS[enrollmentWindow];
  if (window.eligiblePlans && !window.eligiblePlans.includes(plan)) {
    return res.status(400).json({
      success: false,
      error: `${PLANS[plan].label} is not available under a guaranteed issue right`,
      code: 'VALIDATION_ERROR',
    });
  }
  if (!has(EFFECTIVE_DATES, effectiveDate)) {
    return res.status(400).json({ success: false, error: `Unknown effective date option: ${effectiveDate}`, code: 'VALIDATION_ERROR' });
  }

  try {
    const result = await runQuoteComparison({
      agentName,
      clientFirstName,
      state,
      zip,
      medicareEligibleDate,
      age,
      gender,
      tobacco,
      plan,
      enrollmentWindow,
      effectiveDate,
      devinUserId: body.devinUserId,
      devinOrgId: body.devinOrgId,
      devinEmail: body.devinEmail,
    });
    return res.json(result);
  } catch (error) {
    return res.status(500).json({
      success: false,
      error: error.message,
      errorClass: error.name,
      code: error.code || 'QUOTE_COMPARISON_FAILED',
      requestId: req.requestId,
    });
  }
});

module.exports = router;
