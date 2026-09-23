const express = require('express');
const {
  placeVialOrder,
  previousStrength,
  isCalendarDate,
  daysBetween,
  VIAL_CATALOG,
  SELF_PAY_PRICING,
  FILL_TYPES,
  SHIPPING_OPTIONS,
  DISPENSING_PHARMACIES,
  SHIP_TO_STATES,
  MAX_REFILL_GAP_DAYS,
} = require('../../services/verticals/eda0e2e5');

const router = express.Router();

router.get('/api/eda0e2e5/catalog', (_req, res) => {
  res.json({
    vials: Object.values(VIAL_CATALOG).sort((a, b) => a.strengthMg - b.strengthMg).map((v) => ({
      strengthMg: v.strengthMg,
      ndc: v.ndc,
      label: v.label,
      role: v.role,
      vialsPerFill: v.vialsPerFill,
      launched: v.launched,
      pricing: SELF_PAY_PRICING[String(v.strengthMg)] || null,
    })),
    fillTypes: Object.entries(FILL_TYPES).map(([code, f]) => ({ code, label: f.label, description: f.description })),
    shippingOptions: Object.entries(SHIPPING_OPTIONS).map(([code, s]) => ({ code, label: s.label, transitDays: s.transitDays, fee: s.fee })),
    pharmacies: Object.entries(DISPENSING_PHARMACIES).map(([pharmacyId, p]) => ({ pharmacyId, name: p.name, shipsTo: p.shipsTo })),
    shipToStates: SHIP_TO_STATES,
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

router.post('/api/eda0e2e5/orders', async (req, res) => {
  const body = req.body || {};
  const patientFirstName = typeof body.patientFirstName === 'string' ? body.patientFirstName.trim() : '';
  const prescriberName = typeof body.prescriberName === 'string' ? body.prescriberName.trim() : '';
  const rxNumber = typeof body.rxNumber === 'string' ? body.rxNumber.trim() : '';
  const strengthMg = numberField(body.strengthMg);
  const fillType = stringField(body.fillType, 'first_fill');
  const priorDeliveryDate = typeof body.priorDeliveryDate === 'string' ? body.priorDeliveryDate.trim() : '';
  const state = stringField(body.state, 'IN');
  const zip = typeof body.zip === 'string' ? body.zip.trim() : '';
  const shipping = stringField(body.shipping, 'standard');

  if (!patientFirstName) {
    return res.status(400).json({ success: false, error: 'patientFirstName is required', code: 'VALIDATION_ERROR' });
  }
  if (!prescriberName) {
    return res.status(400).json({ success: false, error: 'prescriberName is required', code: 'VALIDATION_ERROR' });
  }
  if (!/^RX-\d{7}$/.test(rxNumber)) {
    return res.status(400).json({ success: false, error: 'rxNumber must look like RX-1234567', code: 'VALIDATION_ERROR' });
  }
  if (!Number.isFinite(strengthMg) || !has(VIAL_CATALOG, String(strengthMg))) {
    return res.status(400).json({ success: false, error: `Unsupported vial strength: ${body.strengthMg} mg`, code: 'VALIDATION_ERROR' });
  }
  if (!has(FILL_TYPES, fillType)) {
    return res.status(400).json({ success: false, error: `Unknown fill type: ${fillType}`, code: 'VALIDATION_ERROR' });
  }
  if (fillType === 'dose_increase' && previousStrength(strengthMg) === null) {
    return res.status(400).json({
      success: false,
      error: `${strengthMg} mg is the starter dose — a dose increase must step up from a lower strength`,
      code: 'VALIDATION_ERROR',
    });
  }
  if (fillType !== 'first_fill') {
    if (!isCalendarDate(priorDeliveryDate)) {
      return res.status(400).json({ success: false, error: 'priorDeliveryDate must be a valid YYYY-MM-DD calendar date for refills and dose increases', code: 'VALIDATION_ERROR' });
    }
    const gap = daysBetween(priorDeliveryDate, new Date());
    if (gap < 0) {
      return res.status(400).json({ success: false, error: 'priorDeliveryDate cannot be in the future', code: 'VALIDATION_ERROR' });
    }
    if (gap > MAX_REFILL_GAP_DAYS) {
      return res.status(400).json({
        success: false,
        error: `Last delivery was ${gap} days ago — a new prescription is required after ${MAX_REFILL_GAP_DAYS} days`,
        code: 'VALIDATION_ERROR',
      });
    }
  }
  if (!/^[A-Z]{2}$/.test(state || '') || !SHIP_TO_STATES.includes(state)) {
    return res.status(400).json({ success: false, error: `LillyDirect does not ship to ${state}`, code: 'VALIDATION_ERROR' });
  }
  if (!/^\d{5}$/.test(zip)) {
    return res.status(400).json({ success: false, error: 'zip must be a 5-digit ZIP code', code: 'VALIDATION_ERROR' });
  }
  if (!has(SHIPPING_OPTIONS, shipping)) {
    return res.status(400).json({ success: false, error: `Unknown shipping option: ${shipping}`, code: 'VALIDATION_ERROR' });
  }

  try {
    const result = await placeVialOrder({
      patientFirstName,
      prescriberName,
      rxNumber,
      strengthMg,
      fillType,
      priorDeliveryDate,
      state,
      zip,
      shipping,
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
      code: error.code || 'VIAL_ORDER_FAILED',
      requestId: req.requestId,
    });
  }
});

module.exports = router;
