const { v4: uuidv4 } = require('uuid');
const logger = require('../../telemetry/logger');
const { incrementMetric, recordTiming } = require('../../telemetry/datadog');
const { Sentry } = require('../../telemetry/sentry');
const { createSessionAndAlert } = require('../devin-session');

const FACILITIES = [
  { code: 'zhengzhou', name: 'Zhengzhou Campus', lines: 340, region: 'CN-HA', utilizationPct: 92 },
  { code: 'shenzhen', name: 'Shenzhen Campus', lines: 215, region: 'CN-GD', utilizationPct: 78 },
  { code: 'chennai', name: 'Chennai Plant', lines: 124, region: 'IN-TN', utilizationPct: 81 },
  { code: 'wisconsin', name: 'Wisconsin Facility', lines: 88, region: 'US-WI', utilizationPct: 64 },
  { code: 'vietnam', name: 'Vietnam Factory', lines: 96, region: 'VN-BN', utilizationPct: 87 },
];

const COMPONENT_CATALOG = [
  { partNumber: 'FC-PCB-2201', category: 'pcb', description: 'Main Logic Board', unitCost: 42.50, stock: 14200, reorderPoint: 5000, leadTimeDays: 12, supplier: 'Unimicron' },
  { partNumber: 'FC-DSP-3302', category: 'display', description: 'Display Assembly', unitCost: 78.20, stock: 8450, reorderPoint: 3000, leadTimeDays: 18, supplier: 'Innolux' },
  { partNumber: 'FC-BAT-4403', category: 'battery', description: 'Battery Module', unitCost: 15.80, stock: 1200, reorderPoint: 4000, leadTimeDays: 24, supplier: 'ATL' },
  { partNumber: 'FC-CAM-5504', category: 'camera', description: 'Camera Module', unitCost: 22.10, stock: 22800, reorderPoint: 8000, leadTimeDays: 8, supplier: 'LG Innotek' },
  { partNumber: 'FC-CHG-6605', category: 'semiconductor', description: 'Charging IC', unitCost: 3.45, stock: 350, reorderPoint: 10000, leadTimeDays: 32, supplier: 'Texas Instruments' },
  { partNumber: 'FC-MEM-7706', category: 'semiconductor', description: 'DRAM Module 8GB', unitCost: 8.90, stock: 31500, reorderPoint: 12000, leadTimeDays: 14, supplier: 'Micron' },
  { partNumber: 'FC-SEN-8807', category: 'mechanical', description: 'Proximity Sensor', unitCost: 1.95, stock: 45000, reorderPoint: 15000, leadTimeDays: 10, supplier: 'Alps Alpine' },
  { partNumber: 'FC-CON-9908', category: 'mechanical', description: 'USB-C Connector', unitCost: 0.82, stock: 68000, reorderPoint: 20000, leadTimeDays: 6, supplier: 'Foxlink' },
];

const PRIORITY_MULTIPLIERS = {
  standard: { urgencyFactor: 1.0, expediteFee: 0 },
  expedited: { urgencyFactor: 0.7, expediteFee: 0.15 },
  emergency: { urgencyFactor: 0.4, expediteFee: 0.35 },
};

const FACILITY_ALLOCATION_RULES = {
  zhengzhou: { maxCategories: 5, throughputMultiplier: 1.2, shiftCapacity: 3 },
  shenzhen: { maxCategories: 4, throughputMultiplier: 1.0, shiftCapacity: 3 },
  chennai: { maxCategories: 3, throughputMultiplier: 0.85, shiftCapacity: 2 },
  wisconsin: { maxCategories: 3, throughputMultiplier: 0.75, shiftCapacity: 2 },
  vietnam: { maxCategories: 4, throughputMultiplier: 0.9, shiftCapacity: 3 },
};

function normalizePartQuery(partNumber) {
  if (!partNumber) return null;
  const cleaned = partNumber.trim().toUpperCase();
  const segments = cleaned.split('-');
  if (segments.length < 3) return null;
  return {
    prefix: segments[0],
    type: segments[1],
    serial: segments.slice(2).join('-'),
  };
}

function resolveComponents(category, partNumber) {
  let components;
  if (partNumber) {
    const parsed = normalizePartQuery(partNumber);
    if (parsed) {
      components = COMPONENT_CATALOG.filter((c) => c.partNumber.includes(parsed.serial));
    }
  }
  if (!components || components.length === 0) {
    components = COMPONENT_CATALOG.filter((c) => c.category === category);
  }
  return components;
}

function getFacilityThroughput(facilityCode) {
  const rules = FACILITY_ALLOCATION_RULES[facilityCode];
  const facility = FACILITIES.find((f) => f.code === facilityCode);
  return {
    output: {
      daily: facility.lines * rules.throughputMultiplier,
      perShift: facility.lines * rules.throughputMultiplier / rules.shiftCapacity,
    },
    shifts: rules.shiftCapacity,
  };
}

function computeSupplyMetrics(components, facilityCode) {
  const throughput = getFacilityThroughput(facilityCode);
  return components.map((comp) => {
    const coverageDays = Math.floor(comp.stock / throughput.production.daily);
    const belowReorder = comp.stock < comp.reorderPoint;
    return {
      partNumber: comp.partNumber,
      description: comp.description,
      currentStock: comp.stock,
      coverageDays,
      belowReorder,
      supplier: comp.supplier,
      unitCost: comp.unitCost,
    };
  });
}

function calculateFulfillment(supplyMetrics, priorityConfig, facilityCode) {
  const throughput = getFacilityThroughput(facilityCode);
  const results = supplyMetrics.map((metric) => {
    const adjustedLead = Math.ceil(metric.coverageDays * priorityConfig.urgencyFactor);
    const expediteSurcharge = metric.unitCost * priorityConfig.expediteFee * metric.currentStock;
    const dailyThroughput = throughput.production.perShift * throughput.shifts;

    return {
      partNumber: metric.partNumber,
      component: metric.description,
      available: metric.currentStock,
      estimatedLeadDays: adjustedLead,
      expediteCost: Math.round(expediteSurcharge * 100) / 100,
      throughputPerDay: Math.round(dailyThroughput),
      restockUrgency: metric.belowReorder ? 'REORDER_NOW' : 'ADEQUATE',
      supplier: metric.supplier,
    };
  });

  return results;
}

function buildInquiryResponse(fulfillmentData, facility, priority) {
  const criticalItems = fulfillmentData.filter((f) => f.restockUrgency === 'REORDER_NOW');
  const totalAvailable = fulfillmentData.reduce((sum, f) => sum + f.available, 0);
  const avgLeadDays = fulfillmentData.reduce((sum, f) => sum + f.estimatedLeadDays, 0) / fulfillmentData.length;
  const totalExpediteCost = fulfillmentData.reduce((sum, f) => sum + f.expediteCost, 0);

  return {
    facility: facility.name,
    facilityCode: facility.code,
    region: facility.region,
    availableUnits: totalAvailable,
    estimatedLeadDays: Math.ceil(avgLeadDays),
    criticalShortages: criticalItems.length,
    expediteCost: totalExpediteCost.toFixed(2),
    priority,
    lineItems: fulfillmentData.map((f) => ({
      partNumber: f.partNumber,
      component: f.component,
      available: f.available,
      leadDays: f.estimatedLeadDays,
      urgency: f.restockUrgency,
    })),
    recommendations: [],
  };
}

async function runInquiry(data) {
  const startTime = Date.now();
  const inquiryId = uuidv4();

  logger.info('Processing component supply inquiry', {
    inquiryId,
    facility: data.facility,
    category: data.category,
    priority: data.priority,
    service: 'foxconn-supply-chain',
  });

  try {
    await new Promise((resolve) => setTimeout(resolve, 80 + Math.random() * 120));

    const facility = FACILITIES.find((f) => f.code === data.facility);
    const components = resolveComponents(data.category, data.partNumber);
    const supplyMetrics = computeSupplyMetrics(components, data.facility);
    const priorityConfig = PRIORITY_MULTIPLIERS[data.priority];
    const fulfillment = calculateFulfillment(supplyMetrics, priorityConfig, data.facility);
    const response = buildInquiryResponse(fulfillment, facility, data.priority);

    response.inquiryId = inquiryId;
    response.completedAt = new Date().toISOString();

    if (response.criticalShortages > 0) {
      response.recommendations.push('Initiate emergency procurement for critical components');
      response.recommendations.push('Contact backup suppliers for expedited delivery');
    }
    if (response.estimatedLeadDays > 20) {
      response.recommendations.push('Consider cross-facility inventory transfer');
    }

    const duration = Date.now() - startTime;

    incrementMetric('inquiry.success', {
      route: '/api/foxconn/inquiry',
      facility: data.facility,
    });
    recordTiming('inquiry.latency', duration, {
      route: '/api/foxconn/inquiry',
    });

    return response;
  } catch (error) {
    const duration = Date.now() - startTime;

    incrementMetric('inquiry.failure', {
      route: '/api/foxconn/inquiry',
      errorClass: error.name,
    });
    recordTiming('inquiry.latency', duration, {
      route: '/api/foxconn/inquiry',
      error: 'true',
    });

    logger.error('Component supply inquiry failed', {
      inquiryId,
      error: error.message,
      errorClass: error.name,
      durationMs: duration,
      facility: data.facility,
    });

    Sentry.captureException(error, {
      tags: {
        route: '/api/foxconn/inquiry',
        service: 'foxconn-supply-chain',
        facility: data.facility,
      },
      extra: { inquiryId, facility: data.facility, category: data.category },
    });

    createSessionAndAlert({
      issueTitle: `${error.name}: ${error.message}`,
      issueUrl: `https://${process.env.SENTRY_ORG_SLUG || 'devin-gtm'}.sentry.io/issues/?project=${process.env.SENTRY_PROJECT_ID || '4511033758449664'}&query=is%3Aunresolved`,
      culprit: 'app/services/verticals/foxconn.js — runInquiry',
      errorType: error.name || 'Error',
      errorValue: error.message,
      devinUserId: data.devinUserId,
      devinOrgId: data.devinOrgId,
      service: 'foxconn-supply-chain',
      verticalLabel: 'Supply Chain Inquiry',
      customer: 'foxconn',
      tags: [
        { key: 'route', value: '/api/foxconn/inquiry' },
        { key: 'service', value: 'foxconn-supply-chain' },
        { key: 'facility', value: data.facility },
      ],
      extra: { inquiryId, facility: data.facility, category: data.category },
      level: 'error',
      platform: 'node',
      firstSeen: '',
      lastSeen: new Date().toISOString(),
      count: '',
      shortId: '',
      project: 'event-driven-devin',
      release: process.env.SENTRY_RELEASE || 'foxconn-scm@3.8.2',
      environment: process.env.DD_ENV || 'prod',
      triggeredRule: '',
    }).catch((err) => {
      logger.error('Failed to trigger Devin session from inquiry error', { error: err.message });
    });

    throw error;
  }
}

module.exports = { runInquiry, FACILITIES, COMPONENT_CATALOG };
