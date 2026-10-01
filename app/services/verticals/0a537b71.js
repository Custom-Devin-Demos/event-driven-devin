const crypto = require('crypto');
const logger = require('../../telemetry/logger');
const { incrementMetric, recordTiming } = require('../../telemetry/datadog');
const { Sentry } = require('../../telemetry/sentry');
const { createSessionAndAlert } = require('../devin-session');

const REPAIR_ORDER = {
  id: 'RO-0410875',
  tag: 'abc',
  vehicle: '2023 Nebula Nimbus',
  vin: '1HGCM82633A004352',
  stockNumber: '1231313',
  mileage: 40000,
  customer: { name: 'Samuel Wilson', phone: '+1 (715) 555-0111' },
  advisor: 'Dana Kowalski',
  technician: 'Tech Assigned',
  status: 'in_progress',
};

const INSPECTION_SECTIONS = [
  {
    id: 'tires',
    label: 'Tires',
    groups: [
      {
        id: 'tire-wear',
        label: 'Check damages',
        items: [
          { id: 'tire-lf', label: 'Left Front', measurements: ['treadDepth', 'pressure'], status: 'fail' },
          { id: 'tire-rf', label: 'Right Front', measurements: ['treadDepth', 'pressure'], status: 'pass' },
          { id: 'tire-lr', label: 'Left Rear', measurements: ['treadDepth', 'pressure'], status: 'pass' },
          { id: 'tire-rr', label: 'Right Rear', measurements: ['treadDepth', 'pressure'], status: 'needs_attention' },
        ],
      },
      {
        id: 'tire-condition',
        label: 'Tire Pressure, Condition & Age',
        items: [
          { id: 'tire-lf-pressure', label: 'Left Front Tire Condition & Pressure', status: 'pass' },
          { id: 'tire-lf-age', label: 'Left Front Tire Age', status: 'pass' },
          { id: 'tire-rf-pressure', label: 'Right Front Tire Condition & Pressure', status: 'pass' },
          { id: 'tire-rf-age', label: 'Right Front Tire Age', status: 'pass' },
        ],
      },
    ],
  },
  {
    id: 'under-hood',
    label: 'Under Hood',
    groups: [
      {
        id: 'fluids',
        label: 'Fluid Levels',
        items: [
          { id: 'uh-engine-oil', label: 'Engine Oil Level & Condition', status: 'pass' },
          { id: 'uh-coolant', label: 'Coolant Level & Protection', status: 'pass' },
          { id: 'uh-brake-fluid', label: 'Brake Fluid Level & Moisture', status: 'needs_attention' },
          { id: 'uh-washer-fluid', label: 'Washer Fluid Level', status: 'pass' },
        ],
      },
      {
        id: 'filters-belts-battery',
        label: 'Filters, Belts & Battery',
        items: [
          { id: 'uh-cabin-air-filter', label: 'Cabin Air Filter', status: 'fail' },
          { id: 'uh-engine-air-filter', label: 'Engine Air Filter', status: 'pass' },
          { id: 'uh-serpentine-belt', label: 'Serpentine Belt Condition', status: 'pass' },
          { id: 'uh-battery', label: 'Battery Health & Terminals', status: 'pass' },
        ],
      },
    ],
  },
  {
    id: 'brakes',
    label: 'Brakes',
    groups: [
      {
        id: 'brake-wear',
        label: 'Brake Pad & Rotor Wear',
        items: [
          { id: 'brk-front-pads', label: 'Front Brake Pads', measurements: ['padDepth'], status: 'pass' },
          { id: 'brk-rear-pads', label: 'Rear Brake Pads', measurements: ['padDepth'], status: 'pass' },
          { id: 'brk-rotors', label: 'Rotor Condition & Runout', status: 'pass' },
        ],
      },
    ],
  },
  {
    id: 'interior',
    label: 'Interior',
    groups: [
      {
        id: 'interior-checks',
        label: 'Cabin Checks',
        items: [
          { id: 'int-hvac', label: 'HVAC Operation', status: 'pass' },
          { id: 'int-wipers', label: 'Wiper Blades & Washers', status: 'pass' },
          { id: 'int-lights', label: 'Interior Lights & Instruments', status: 'pass' },
        ],
      },
    ],
  },
  {
    id: 'exterior',
    label: 'Exterior',
    groups: [
      {
        id: 'exterior-checks',
        label: 'Exterior Checks',
        items: [
          { id: 'ext-headlights', label: 'Headlights & Turn Signals', status: 'pass' },
          { id: 'ext-glass', label: 'Glass & Mirrors', status: 'pass' },
          { id: 'ext-body', label: 'Body Panels & Paint', status: 'pass' },
        ],
      },
    ],
  },
];

// Labor op-code catalog keyed by inspection item id. Populated from the
// fixed-operations price book; every flaggable item must have an entry.
const OP_CODES = {
  'tire-lf': { code: 'TIR-REP-LF', description: 'Replace left front tire', laborHours: 0.4, partsCost: 189.95 },
  'tire-rf': { code: 'TIR-REP-RF', description: 'Replace right front tire', laborHours: 0.4, partsCost: 189.95 },
  'tire-lr': { code: 'TIR-REP-LR', description: 'Replace left rear tire', laborHours: 0.4, partsCost: 189.95 },
  'tire-rr': { code: 'TIR-REP-RR', description: 'Replace right rear tire', laborHours: 0.4, partsCost: 189.95 },
  'tire-lf-pressure': { code: 'TIR-PRS-ADJ', description: 'TPMS reset & pressure adjust', laborHours: 0.1, partsCost: 0 },
  'tire-lf-age': { code: 'TIR-AGE-INSP', description: 'Tire age inspection', laborHours: 0.1, partsCost: 0 },
  'tire-rf-pressure': { code: 'TIR-PRS-ADJ', description: 'TPMS reset & pressure adjust', laborHours: 0.1, partsCost: 0 },
  'tire-rf-age': { code: 'TIR-AGE-INSP', description: 'Tire age inspection', laborHours: 0.1, partsCost: 0 },
  'uh-engine-oil': { code: 'OIL-CHG-SYN', description: 'Synthetic oil & filter change', laborHours: 0.5, partsCost: 64.9 },
  'uh-coolant': { code: 'CLT-EXCH', description: 'Coolant exchange', laborHours: 0.8, partsCost: 49.5 },
  'uh-brake-fluid': { code: 'BRK-FLD-EX', description: 'Brake fluid exchange', laborHours: 0.5, partsCost: 24.95 },
  'uh-washer-fluid': { code: 'WSH-FLD-TOP', description: 'Washer fluid top-off', laborHours: 0.05, partsCost: 4.95 },
  'uh-engine-air-filter': { code: 'FLT-ENG-REP', description: 'Engine air filter replacement', laborHours: 0.2, partsCost: 32.5 },
  'uh-serpentine-belt': { code: 'BLT-SRP-REP', description: 'Serpentine belt replacement', laborHours: 0.9, partsCost: 58.4 },
  'uh-battery': { code: 'BAT-REP-AGM', description: 'AGM battery replacement', laborHours: 0.4, partsCost: 214.0 },
  'brk-front-pads': { code: 'BRK-PAD-F', description: 'Front brake pad replacement', laborHours: 1.2, partsCost: 148.75 },
  'brk-rear-pads': { code: 'BRK-PAD-R', description: 'Rear brake pad replacement', laborHours: 1.1, partsCost: 132.2 },
  'brk-rotors': { code: 'BRK-RTR-RSF', description: 'Rotor resurface & measure', laborHours: 0.8, partsCost: 45.0 },
  'int-hvac': { code: 'INT-HVAC-DIAG', description: 'HVAC performance check', laborHours: 0.3, partsCost: 0 },
  'int-wipers': { code: 'INT-WPR-SET', description: 'Wiper blade set', laborHours: 0.1, partsCost: 42.9 },
  'int-lights': { code: 'INT-LGT-CHk', description: 'Instrument cluster lamp check', laborHours: 0.1, partsCost: 0 },
  'ext-headlights': { code: 'EXT-HDL-ALN', description: 'Headlamp aim & bulb service', laborHours: 0.3, partsCost: 28.5 },
  'ext-glass': { code: 'EXT-GLS-RPR', description: 'Glass chip repair', laborHours: 0.4, partsCost: 36.0 },
  'ext-body': { code: 'EXT-BDY-EST', description: 'Body panel estimate', laborHours: 0.5, partsCost: 0 },
};

const LABOR_RATE = 185;

function allItems() {
  return INSPECTION_SECTIONS.flatMap((section) => section.groups.flatMap((group) => group.items));
}

function getInspectionItems() {
  return INSPECTION_SECTIONS.map((section) => ({
    id: section.id,
    label: section.label,
    groups: section.groups.map((group) => ({
      id: group.id,
      label: group.label,
      items: group.items,
    })),
  }));
}

function effectiveStatus(item, overrides) {
  if (overrides && overrides[item.id]) return overrides[item.id];
  return item.status;
}

function buildEstimate(items, overrides) {
  const recommendations = [];
  let laborHours = 0;
  let partsCost = 0;

  for (const item of items) {
    const status = effectiveStatus(item, overrides);
    if (status === 'pass') continue;
    const op = OP_CODES[item.id];
    laborHours += op.laborHours;
    partsCost += op.partsCost;
    recommendations.push({
      itemId: item.id,
      label: item.label,
      status,
      opCode: op.code,
      description: op.description,
      laborHours: op.laborHours,
      partsCost: op.partsCost,
    });
  }

  return {
    recommendations,
    laborHours: Math.round(laborHours * 100) / 100,
    laborCost: Math.round(laborHours * LABOR_RATE * 100) / 100,
    partsCost: Math.round(partsCost * 100) / 100,
    totalEstimate: Math.round((laborHours * LABOR_RATE + partsCost) * 100) / 100,
  };
}

async function submitInspection(data) {
  const startTime = Date.now();
  const repairOrderId = data.repairOrderId;

  if (repairOrderId !== REPAIR_ORDER.id) {
    const validationError = new Error(`Unknown repair order: ${repairOrderId || '(none)'}`);
    validationError.name = 'ValidationError';
    validationError.code = 'UNKNOWN_REPAIR_ORDER';
    validationError.statusCode = 400;
    throw validationError;
  }

  if (data.itemStatuses !== undefined && (typeof data.itemStatuses !== 'object' || Array.isArray(data.itemStatuses) || data.itemStatuses === null)) {
    const validationError = new Error('itemStatuses must be an object keyed by item ID');
    validationError.name = 'ValidationError';
    validationError.code = 'INVALID_ITEM_STATUSES';
    validationError.statusCode = 400;
    throw validationError;
  }

  const items = allItems();
  const overrides = data.itemStatuses || {};

  logger.info('Submitting Tekion multi-point inspection', {
    repairOrderId,
    vin: REPAIR_ORDER.vin,
    itemCount: items.length,
    service: 'customer-0a537b71-mpi',
    route: '/api/0a537b71/submit-mpi',
  });

  try {
    await new Promise((resolve) => setTimeout(resolve, 80 + Math.random() * 120));

    const estimate = buildEstimate(items, overrides);
    const duration = Date.now() - startTime;

    incrementMetric('tekion_mpi.submit_success', { repairOrderId });
    recordTiming('tekion_mpi.submit_latency', duration, {
      repairOrderId,
      error: 'false',
    });

    return {
      success: true,
      repairOrderId,
      status: 'submitted',
      confirmation: `MPI-${crypto.randomBytes(4).toString('hex').toUpperCase()}`,
      vin: REPAIR_ORDER.vin,
      itemCount: items.length,
      flaggedCount: estimate.recommendations.length,
      estimate,
    };
  } catch (error) {
    const duration = Date.now() - startTime;

    incrementMetric('tekion_mpi.submit_failure', { repairOrderId });
    recordTiming('tekion_mpi.submit_latency', duration, {
      repairOrderId,
      error: 'true',
    });

    logger.error('Tekion MPI submission failed', {
      error: error.message,
      errorClass: error.name,
      durationMs: duration,
      repairOrderId,
      vin: REPAIR_ORDER.vin,
      service: 'customer-0a537b71-mpi',
    });

    Sentry.captureException(error, {
      tags: {
        route: '/api/0a537b71/submit-mpi',
        service: 'customer-0a537b71-mpi',
        repairOrderId,
        vin: REPAIR_ORDER.vin,
        alert_path: 'instant',
      },
      extra: {
        repairOrderId,
        vin: REPAIR_ORDER.vin,
      },
    });

    await createSessionAndAlert({
      issueTitle: `${error.name}: ${error.message}`,
      issueUrl: `https://${process.env.SENTRY_ORG_SLUG || 'sentry-org'}.sentry.io/issues/?project=${process.env.SENTRY_PROJECT_ID || ''}&query=is%3Aunresolved`,
      culprit: 'app/services/verticals/0a537b71.js — buildEstimate',
      errorType: error.name || 'Error',
      errorValue: error.message,
      devinUserId: data.devinUserId,
      devinEmail: data.devinEmail,
      devinOrgId: data.devinOrgId,
      service: 'customer-0a537b71-mpi',
      verticalLabel: 'Tekion MPI Inspection Submit',
      customer: '0a537b71',
      tags: [
        { key: 'route', value: '/api/0a537b71/submit-mpi' },
        { key: 'service', value: 'customer-0a537b71-mpi' },
        { key: 'repairOrderId', value: repairOrderId },
        { key: 'vin', value: REPAIR_ORDER.vin },
      ],
      extra: {
        repairOrderId,
        vin: REPAIR_ORDER.vin,
      },
      level: 'error',
      platform: 'node',
      firstSeen: '',
      lastSeen: new Date().toISOString(),
      count: '',
      shortId: '',
      project: 'event-driven-devin',
      release: process.env.SENTRY_RELEASE || 'customer-0a537b71-mpi@1.0.0',
      environment: process.env.DD_ENV || 'prod',
      triggeredRule: '',
    });

    throw error;
  }
}

module.exports = {
  submitInspection,
  REPAIR_ORDER,
  INSPECTION_SECTIONS,
  OP_CODES,
  getInspectionItems,
  buildEstimate,
};
