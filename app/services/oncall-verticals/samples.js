const { v4: uuidv4 } = require('uuid');
const logger = require('../../telemetry/logger');
const { incrementMetric, recordTiming } = require('../../telemetry/datadog');
const { Sentry } = require('../../telemetry/sentry');

const ROUTE = '/api/oncall/lifesciences/sample-order';
const SERVICE = 'hcp-sample-order-api';
const MAX_ITEMS_PER_ORDER = 8;

const SAMPLE_ORDER_TEST_HOOKS = {
  licenseVerificationLatencyMs: 600,
  verificationCalls: 0,
};

const PRESCRIBERS = [
  {
    hcpNpi: '1902846157',
    name: 'Marcus Oyelaran',
    credentials: 'MD',
    specialty: 'Internal Medicine',
    stateLicense: 'NY-2468013',
    licenseStatus: 'active',
    shipToAddresses: [
      {
        addressId: 'SHIP-1001',
        label: 'Oyelaran Medical Group · 480 Park Avenue, Suite 300, New York, NY 10022',
      },
      {
        addressId: 'SHIP-1002',
        label: 'Oyelaran Medical Group · 22 West 19th Street, New York, NY 10011',
      },
    ],
  },
  {
    hcpNpi: '1928465018',
    name: 'Sofia Chen',
    credentials: 'DO',
    specialty: 'Family Medicine',
    stateLicense: 'CA-5938214',
    licenseStatus: 'active',
    shipToAddresses: [
      {
        addressId: 'SHIP-2001',
        label: 'North Shore Family Care · 840 Market Street, San Francisco, CA 94102',
      },
    ],
  },
  {
    hcpNpi: '1938576149',
    name: 'Nadia Brooks',
    credentials: 'MD',
    specialty: 'Pediatrics',
    stateLicense: 'IL-3819472',
    licenseStatus: 'expired',
    shipToAddresses: [
      {
        addressId: 'SHIP-3001',
        label: 'Brooks Pediatric Center · 1500 Lake Shore Drive, Chicago, IL 60611',
      },
    ],
  },
];

const PRODUCTS = [
  {
    productId: 'CVT-1024',
    name: 'Corvane Auralis',
    strength: '18 mg',
    dosageForm: 'capsules',
    maxUnitsPerRequest: 8,
    controlled: false,
  },
  {
    productId: 'CVT-2048',
    name: 'Corvane Velorin',
    strength: '24 mg',
    dosageForm: 'tablets',
    maxUnitsPerRequest: 8,
    controlled: false,
  },
  {
    productId: 'CVT-3072',
    name: 'Corvane Novera',
    strength: '12 mg/mL',
    dosageForm: 'single-use vial',
    maxUnitsPerRequest: 6,
    controlled: false,
  },
  {
    productId: 'CVT-4096',
    name: 'Corvane Selvaris',
    strength: '30 mg',
    dosageForm: 'prefilled pen',
    maxUnitsPerRequest: 2,
    controlled: true,
  },
];

function createError(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

function validateOrder({ hcpNpi, stateLicense, shipToAddressId, items, signature }) {
  const prescriber = PRESCRIBERS.find((candidate) => candidate.hcpNpi === String(hcpNpi || ''));
  if (!prescriber || prescriber.licenseStatus !== 'active' || prescriber.stateLicense !== stateLicense) {
    throw createError('LICENSE_NOT_VALID', 'The prescriber state license is not valid.');
  }

  if (!prescriber.shipToAddresses.some((address) => address.addressId === shipToAddressId)) {
    throw createError('SHIP_TO_ADDRESS_NOT_FOUND', 'The selected ship-to address is not registered for this prescriber.');
  }

  if (typeof signature !== 'string' || !signature.trim()) {
    throw createError('SIGNATURE_REQUIRED', 'A typed signature is required to submit sample requests.');
  }

  if (!Array.isArray(items) || items.length === 0 || items.length > MAX_ITEMS_PER_ORDER) {
    throw createError('INVALID_ORDER', 'Select between one and eight sample products.');
  }

  const validatedItems = items.map((item) => {
    const product = PRODUCTS.find((candidate) => candidate.productId === String((item && item.productId) || ''));
    if (!product) {
      throw createError('PRODUCT_NOT_SAMPLEABLE', 'The selected product is not available for samples.');
    }
    if (product.controlled) {
      throw createError('PRODUCT_NOT_SAMPLEABLE', 'The selected product is not available for samples.');
    }
    const quantity = Number(item.quantity);
    if (!Number.isInteger(quantity) || quantity < 1) {
      throw createError('QUANTITY_LIMIT_EXCEEDED', 'Sample quantity must be a positive whole number.');
    }
    if (quantity > product.maxUnitsPerRequest) {
      throw createError('QUANTITY_LIMIT_EXCEEDED', `The sample quantity for ${product.name} exceeds the per-request limit.`);
    }
    return { product, quantity };
  });

  const quantitiesByProduct = new Map();
  for (const { product, quantity } of validatedItems) {
    const total = (quantitiesByProduct.get(product.productId) || 0) + quantity;
    if (total > product.maxUnitsPerRequest) {
      throw createError('QUANTITY_LIMIT_EXCEEDED', `The sample quantity for ${product.name} exceeds the per-request limit.`);
    }
    quantitiesByProduct.set(product.productId, total);
  }

  return { prescriber, validatedItems };
}

async function verifyStateLicense(prescriber, stateLicense) {
  SAMPLE_ORDER_TEST_HOOKS.verificationCalls++;
  await new Promise((resolve) => setTimeout(resolve, SAMPLE_ORDER_TEST_HOOKS.licenseVerificationLatencyMs));
  return prescriber.licenseStatus === 'active' && prescriber.stateLicense === stateLicense;
}

async function submitSampleOrder({
  hcpNpi,
  stateLicense,
  shipToAddressId,
  items,
  signature,
} = {}, options = {}) {
  const startedAt = Date.now();
  const orderId = `SO-${uuidv4().replace(/-/g, '').slice(0, 8).toUpperCase()}`;

  logger.info('Submitting HCP sample order', {
    orderId,
    hcpNpi,
    shipToAddressId,
    itemCount: Array.isArray(items) ? items.length : 0,
    service: SERVICE,
    route: ROUTE,
  });

  try {
    const { prescriber, validatedItems } = validateOrder({
      hcpNpi,
      stateLicense,
      shipToAddressId,
      items,
      signature,
    });

    for (const line of validatedItems) {
      for (let allocation = 0; allocation < line.quantity; allocation++) {
        const licenseValid = await verifyStateLicense(prescriber, stateLicense);
        if (!licenseValid) {
          throw createError('LICENSE_NOT_VALID', 'The prescriber state license could not be verified.');
        }
      }
    }

    const durationMs = Date.now() - startedAt;
    const estimatedDelivery = new Date(Date.now() + 4 * 24 * 60 * 60 * 1000).toISOString();
    const resultItems = validatedItems.map(({ product, quantity }) => ({
      productId: product.productId,
      name: product.name,
      strength: product.strength,
      dosageForm: product.dosageForm,
      quantity,
      lotAllocations: Array.from({ length: quantity }, (_, index) => ({
        lotId: `${orderId}-${product.productId}-${String(index + 1).padStart(2, '0')}`,
        quantity: 1,
      })),
    }));

    incrementMetric('samples.order.success', { route: ROUTE });
    recordTiming('samples.order.latency', durationMs, { route: ROUTE });
    logger.info('HCP sample order confirmed', {
      orderId,
      status: 'CONFIRMED',
      durationMs,
      itemCount: resultItems.length,
      service: SERVICE,
    });

    return {
      success: true,
      orderId,
      status: 'CONFIRMED',
      estimatedDelivery,
      items: resultItems,
      durationMs,
    };
  } catch (error) {
    const durationMs = Date.now() - startedAt;
    incrementMetric('samples.order.error', { route: ROUTE, errorClass: error.name });
    recordTiming('samples.order.latency', durationMs, { route: ROUTE, error: 'true' });
    logger.error('HCP sample order failed', {
      orderId,
      error: error.message,
      errorClass: error.name,
      code: error.code,
      durationMs,
      hcpNpi,
      service: SERVICE,
      route: ROUTE,
    });
    Sentry.captureException(error, {
      tags: {
        route: ROUTE,
        service: SERVICE,
        ...(options.synthetic ? { synthetic_probe: 'true' } : {}),
      },
      extra: { orderId, hcpNpi, shipToAddressId },
    });
    throw error;
  }
}

module.exports = {
  submitSampleOrder,
  PRESCRIBERS,
  PRODUCTS,
  SAMPLE_ORDER_TEST_HOOKS,
};
