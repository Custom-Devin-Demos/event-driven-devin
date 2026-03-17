const { v4: uuidv4 } = require('uuid');
const logger = require('../../telemetry/logger');
const { incrementMetric, recordTiming } = require('../../telemetry/datadog');
const { Sentry } = require('../../telemetry/sentry');
const { createSessionAndAlert } = require('../devin-session');

/**
 * Equipment registry for the plant monitoring dashboard
 */
const EQUIPMENT = [
  { id: 'EQ-001', name: 'Turbine Generator A', category: 'rotating', status: 'running', temp: 185, rpm: 3600, lastService: '2026-01-15' },
  { id: 'EQ-002', name: 'Compressor Unit B', category: 'rotating', status: 'running', temp: 142, rpm: 1800, lastService: '2026-02-20' },
  { id: 'EQ-003', name: 'Main Transformer', category: 'electrical', status: 'warning', temp: 98, rpm: 0, lastService: '2025-11-10' },
  { id: 'EQ-004', name: 'Hydraulic Press #1', category: 'hydraulic', status: 'running', temp: 72, rpm: 0, lastService: '2026-03-01' },
  { id: 'EQ-005', name: 'Conveyor Belt C', category: 'structural', status: 'idle', temp: 45, rpm: 120, lastService: '2026-02-05' },
  { id: 'EQ-006', name: 'Cooling Tower', category: 'rotating', status: 'running', temp: 38, rpm: 900, lastService: '2025-12-20' },
];

/**
 * Equipment class configurations.
 * Keys are lowercase: "rotating", "electrical", "hydraulic", "structural"
 */
const EQUIPMENT_CLASSES = {
  rotating: { laborRate: 85, minHours: 4, certRequired: 'mechanical', partsMultiplier: 1.2 },
  electrical: { laborRate: 95, minHours: 2, certRequired: 'electrical', partsMultiplier: 1.5 },
  hydraulic: { laborRate: 110, minHours: 3, certRequired: 'hydraulic', partsMultiplier: 1.3 },
  structural: { laborRate: 75, minHours: 6, certRequired: 'civil', partsMultiplier: 1.0 },
};

/**
 * Look up the equipment class configuration.
 */
function getEquipmentClass(category) {
  // BUG: frontend sends display value "Rotating" (capitalized from dropdown)
  // but config keys are lowercase "rotating"
  // Returns undefined due to case mismatch
  return EQUIPMENT_CLASSES[category];
}

/**
 * Estimate maintenance cost for a work order.
 */
function estimateMaintenanceCost(workOrder) {
  const equipClass = getEquipmentClass(workOrder.equipmentCategory);
  const laborCost = equipClass.laborRate * workOrder.estimatedHours;
  const materialCost = (workOrder.partsEstimate || 0) * equipClass.partsMultiplier;
  return {
    labor: Math.round(laborCost * 100) / 100,
    materials: Math.round(materialCost * 100) / 100,
    total: Math.round((laborCost + materialCost) * 100) / 100,
  };
}

/**
 * Create a maintenance work order.
 */
async function createWorkOrder(data) {
  const startTime = Date.now();
  const workOrderId = uuidv4();

  logger.info('Creating work order', {
    workOrderId,
    equipmentId: data.equipmentId,
    equipmentCategory: data.equipmentCategory,
    issueType: data.issueType,
    priority: data.priority,
    service: 'maintenance-api',
  });

  try {
    await new Promise((resolve) => setTimeout(resolve, 90 + Math.random() * 110));

    const costEstimate = estimateMaintenanceCost(data);

    const equipment = EQUIPMENT.find((e) => e.id === data.equipmentId);

    const duration = Date.now() - startTime;

    incrementMetric('workorder.success', {
      route: '/api/maintenance/workorder',
      priority: data.priority,
    });
    recordTiming('workorder.latency', duration, {
      route: '/api/maintenance/workorder',
    });

    return {
      success: true,
      workOrderId,
      equipmentId: data.equipmentId,
      equipmentName: equipment ? equipment.name : data.equipmentId,
      issueType: data.issueType,
      priority: data.priority,
      costEstimate,
      certRequired: EQUIPMENT_CLASSES[data.equipmentCategory.toLowerCase()]?.certRequired || 'general',
      status: 'created',
      createdAt: new Date().toISOString(),
    };
  } catch (error) {
    const duration = Date.now() - startTime;

    incrementMetric('workorder.failure', {
      route: '/api/maintenance/workorder',
      errorClass: error.name,
    });
    recordTiming('workorder.latency', duration, {
      route: '/api/maintenance/workorder',
      error: 'true',
    });

    logger.error('Work order creation failed', {
      workOrderId,
      error: error.message,
      errorClass: error.name,
      durationMs: duration,
      equipmentId: data.equipmentId,
    });

    Sentry.captureException(error, {
      tags: {
        route: '/api/maintenance/workorder',
        service: 'maintenance-api',
        priority: data.priority,
      },
      extra: { workOrderId, equipmentId: data.equipmentId, equipmentCategory: data.equipmentCategory },
    });

    createSessionAndAlert({
      issueTitle: `${error.name}: ${error.message}`,
      issueUrl: `https://${process.env.SENTRY_ORG_SLUG || 'devin-gtm'}.sentry.io/issues/?project=${process.env.SENTRY_PROJECT_ID || '4511033758449664'}&query=is%3Aunresolved`,
      culprit: 'app/services/verticals/industrials.js — createWorkOrder',
      errorType: error.name || 'Error',
      errorValue: error.message,
      service: 'maintenance-api',
      verticalLabel: 'Work Order',
      tags: [
        { key: 'route', value: '/api/maintenance/workorder' },
        { key: 'service', value: 'maintenance-api' },
      ],
      extra: { workOrderId, equipmentId: data.equipmentId },
      level: 'error',
      platform: 'node',
      firstSeen: '',
      lastSeen: new Date().toISOString(),
      count: '',
      shortId: '',
      project: 'event-driven-devin',
      release: process.env.SENTRY_RELEASE || 'titan-mfg@1.0.2',
      environment: process.env.DD_ENV || 'prod',
      triggeredRule: '',
    }).catch((err) => {
      logger.error('Failed to trigger Devin session from workorder error', { error: err.message });
    });

    throw error;
  }
}

module.exports = { createWorkOrder, EQUIPMENT, EQUIPMENT_CLASSES };
