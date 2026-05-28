const { v4: uuidv4 } = require('uuid');
const logger = require('../../telemetry/logger');
const { incrementMetric, recordTiming } = require('../../telemetry/datadog');
const { Sentry } = require('../../telemetry/sentry');
const { createSessionAndAlert } = require('../devin-session');

const DATACENTERS = [
  { code: 'hillsboro', name: 'Hillsboro D1X', nodes: 4200, region: 'US-OR', utilizationPct: 94 },
  { code: 'chandler', name: 'Chandler Fab 42', nodes: 3100, region: 'US-AZ', utilizationPct: 88 },
  { code: 'leixlip', name: 'Leixlip Ireland', nodes: 2400, region: 'IE-L', utilizationPct: 76 },
  { code: 'dalian', name: 'Dalian China', nodes: 1800, region: 'CN-LN', utilizationPct: 69 },
  { code: 'penang', name: 'Penang Malaysia', nodes: 2100, region: 'MY-07', utilizationPct: 82 },
];

const PROCESSOR_CATALOG = [
  { partNumber: 'i9-14900K', category: 'core', description: 'Core i9 14th Gen Desktop', unitCost: 589.00, stock: 8200, reorderPoint: 3000, leadTimeDays: 10, fab: 'Intel 7' },
  { partNumber: 'i7-14700K', category: 'core', description: 'Core i7 14th Gen Desktop', unitCost: 419.00, stock: 14500, reorderPoint: 5000, leadTimeDays: 8, fab: 'Intel 7' },
  { partNumber: 'W9-3595X', category: 'xeon', description: 'Xeon W9 Workstation', unitCost: 2499.00, stock: 1100, reorderPoint: 2000, leadTimeDays: 22, fab: 'Intel 4' },
  { partNumber: '8592+', category: 'xeon', description: 'Xeon 8592+ Scalable', unitCost: 1849.00, stock: 6800, reorderPoint: 2500, leadTimeDays: 14, fab: 'Intel 3' },
  { partNumber: 'Ultra-288V', category: 'ultra', description: 'Core Ultra 200V Mobile', unitCost: 394.00, stock: 420, reorderPoint: 3000, leadTimeDays: 30, fab: 'Intel 4' },
  { partNumber: 'N100', category: 'embedded', description: 'Intel N100 Efficient Core', unitCost: 128.00, stock: 45200, reorderPoint: 15000, leadTimeDays: 6, fab: 'Intel 7' },
  { partNumber: 'E810-XXVDA4', category: 'networking', description: 'Ethernet 800 Series Adapter', unitCost: 654.00, stock: 3200, reorderPoint: 1500, leadTimeDays: 16, fab: 'Intel 7' },
  { partNumber: 'i5-14600K', category: 'core', description: 'Core i5 14th Gen Desktop', unitCost: 319.00, stock: 22100, reorderPoint: 8000, leadTimeDays: 7, fab: 'Intel 7' },
];

const PRIORITY_MULTIPLIERS = {
  standard: { urgencyFactor: 1.0, expediteFee: 0 },
  expedited: { urgencyFactor: 0.7, expediteFee: 0.12 },
  emergency: { urgencyFactor: 0.4, expediteFee: 0.30 },
};

const DATACENTER_CAPACITY = {
  hillsboro: { maxFamilies: 5, yieldMultiplier: 1.15, shiftCount: 3 },
  chandler: { maxFamilies: 4, yieldMultiplier: 1.0, shiftCount: 3 },
  leixlip: { maxFamilies: 4, yieldMultiplier: 0.92, shiftCount: 2 },
  dalian: { maxFamilies: 3, yieldMultiplier: 0.80, shiftCount: 2 },
  penang: { maxFamilies: 3, yieldMultiplier: 0.88, shiftCount: 3 },
};

function normalizeSkuQuery(partNumber) {
  if (!partNumber) return null;
  const cleaned = partNumber.trim().toUpperCase();
  const segments = cleaned.split('-');
  if (segments.length < 2) return null;
  return {
    prefix: segments[0],
    model: segments.slice(1).join('-'),
  };
}

function resolveProcessors(category, partNumber) {
  let processors;
  if (partNumber) {
    const parsed = normalizeSkuQuery(partNumber);
    if (parsed) {
      processors = PROCESSOR_CATALOG.filter((p) => p.partNumber.toUpperCase().includes(parsed.model));
    }
  }
  if (!processors || processors.length === 0) {
    processors = PROCESSOR_CATALOG.filter((p) => p.category === category);
  }
  return processors;
}

function getDatacenterThroughput(dcCode) {
  const capacity = DATACENTER_CAPACITY[dcCode];
  const dc = DATACENTERS.find((d) => d.code === dcCode);
  return {
    waferOutput: {
      daily: dc.nodes * capacity.yieldMultiplier,
      perShift: dc.nodes * capacity.yieldMultiplier / capacity.shiftCount,
    },
    shifts: capacity.shiftCount,
  };
}

function computeAllocationMetrics(processors, dcCode) {
  const throughput = getDatacenterThroughput(dcCode);
  return processors.map((proc) => {
    const coverageDays = Math.floor(proc.stock / throughput.waferOutput.daily);
    const belowReorder = proc.stock < proc.reorderPoint;
    return {
      partNumber: proc.partNumber,
      description: proc.description,
      currentStock: proc.stock,
      coverageDays,
      belowReorder,
      fab: proc.fab,
      unitCost: proc.unitCost,
    };
  });
}

function calculateFulfillment(allocationMetrics, priorityConfig, dcCode) {
  const throughput = getDatacenterThroughput(dcCode);
  const results = allocationMetrics.map((metric) => {
    const adjustedLead = Math.ceil(metric.coverageDays * priorityConfig.urgencyFactor);
    const expediteSurcharge = metric.unitCost * priorityConfig.expediteFee * metric.currentStock;
    const dailyThroughput = throughput.waferOutput.perShift * throughput.shifts;

    return {
      partNumber: metric.partNumber,
      processor: metric.description,
      available: metric.currentStock,
      estimatedLeadDays: adjustedLead,
      expediteCost: Math.round(expediteSurcharge * 100) / 100,
      throughputPerDay: Math.round(dailyThroughput),
      restockUrgency: metric.belowReorder ? 'REORDER_NOW' : 'ADEQUATE',
      fab: metric.fab,
    };
  });

  return results;
}

function buildInquiryResponse(fulfillmentData, datacenter, priority) {
  const criticalItems = fulfillmentData.filter((f) => f.restockUrgency === 'REORDER_NOW');
  const totalAvailable = fulfillmentData.reduce((sum, f) => sum + f.available, 0);
  const avgLeadDays = fulfillmentData.reduce((sum, f) => sum + f.estimatedLeadDays, 0) / fulfillmentData.length;
  const totalExpediteCost = fulfillmentData.reduce((sum, f) => sum + f.expediteCost, 0);

  return {
    facility: datacenter.name,
    facilityCode: datacenter.code,
    region: datacenter.region,
    availableUnits: totalAvailable,
    estimatedLeadDays: Math.ceil(avgLeadDays),
    criticalShortages: criticalItems.length,
    expediteCost: totalExpediteCost.toFixed(2),
    priority,
    lineItems: fulfillmentData.map((f) => ({
      partNumber: f.partNumber,
      processor: f.processor,
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

  logger.info('Processing processor allocation inquiry', {
    inquiryId,
    facility: data.facility,
    category: data.category,
    priority: data.priority,
    service: 'customer-1a459b91-platform-eng',
  });

  try {
    await new Promise((resolve) => setTimeout(resolve, 80 + Math.random() * 120));

    const datacenter = DATACENTERS.find((d) => d.code === data.facility);
    const processors = resolveProcessors(data.category, data.partNumber);
    const allocationMetrics = computeAllocationMetrics(processors, data.facility);
    const priorityConfig = PRIORITY_MULTIPLIERS[data.priority];
    const fulfillment = calculateFulfillment(allocationMetrics, priorityConfig, data.facility);
    const response = buildInquiryResponse(fulfillment, datacenter, data.priority);

    response.inquiryId = inquiryId;
    response.completedAt = new Date().toISOString();

    if (response.criticalShortages > 0) {
      response.recommendations.push('Initiate emergency wafer allocation for critical SKUs');
      response.recommendations.push('Contact backup fabs for expedited production');
    }
    if (response.estimatedLeadDays > 20) {
      response.recommendations.push('Consider cross-facility inventory transfer');
    }

    const duration = Date.now() - startTime;

    incrementMetric('inquiry.success', {
      route: '/api/1a459b91/inquiry',
      facility: data.facility,
    });
    recordTiming('inquiry.latency', duration, {
      route: '/api/1a459b91/inquiry',
    });

    return response;
  } catch (error) {
    const duration = Date.now() - startTime;

    incrementMetric('inquiry.failure', {
      route: '/api/1a459b91/inquiry',
      errorClass: error.name,
    });
    recordTiming('inquiry.latency', duration, {
      route: '/api/1a459b91/inquiry',
      error: 'true',
    });

    logger.error('Processor allocation inquiry failed', {
      inquiryId,
      error: error.message,
      errorClass: error.name,
      durationMs: duration,
      facility: data.facility,
    });

    Sentry.captureException(error, {
      tags: {
        route: '/api/1a459b91/inquiry',
        service: 'customer-1a459b91-platform-eng',
        facility: data.facility,
      },
      extra: { inquiryId, facility: data.facility, category: data.category },
    });

    createSessionAndAlert({
      issueTitle: `${error.name}: ${error.message}`,
      issueUrl: `https://${process.env.SENTRY_ORG_SLUG || 'sentry-org'}.sentry.io/issues/?project=${process.env.SENTRY_PROJECT_ID || ''}&query=is%3Aunresolved`,
      culprit: 'app/services/verticals/1a459b91.js \u2014 runInquiry',
      errorType: error.name || 'Error',
      errorValue: error.message,
      devinUserId: data.devinUserId,
      devinEmail: data.devinEmail,
      devinOrgId: data.devinOrgId,
      service: 'customer-1a459b91-platform-eng',
      verticalLabel: 'Processor Allocation Inquiry',
      customer: '1a459b91',
      slackMemberId: 'U08S7AVJ478',
      tags: [
        { key: 'route', value: '/api/1a459b91/inquiry' },
        { key: 'service', value: 'customer-1a459b91-platform-eng' },
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
      release: process.env.SENTRY_RELEASE || 'customer-1a459b91-platform@4.2.1',
      environment: process.env.DD_ENV || 'prod',
      triggeredRule: '',
    }).catch((err) => {
      logger.error('Failed to trigger Devin session from inquiry error', { error: err.message });
    });

    throw error;
  }
}

module.exports = { runInquiry, DATACENTERS, PROCESSOR_CATALOG };
