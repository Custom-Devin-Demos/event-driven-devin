const { randomInt } = require('node:crypto');
const { v4: uuidv4 } = require('uuid');
const logger = require('../../telemetry/logger');
const { incrementMetric, recordTiming } = require('../../telemetry/datadog');
const { Sentry } = require('../../telemetry/sentry');
const { createSessionAndAlert } = require('../devin-session');

const SERVICE = 't1-pagos-payment-links';
const ROUTE = '/api/t1/payment-links';
const PAGE = '/t1';
const SLACK_MEMBER_ID_FALLBACK = process.env.T1_SLACK_MEMBER_ID || '';

const REMEDIATION_DIRECTIVE = [
  '*Repository to investigate and fix:* `COG-GTM/event-driven-devin`',
  '',
  'The failing code path is the T1 Pagos payment-link vertical:',
  '- Service: `app/services/verticals/t1.js`',
  '- Route: `app/routes/verticals/t1.js`',
  `- Page: \`app/public/verticals/t1.html\` (served at \`${PAGE}\`)`,
  '',
  "Start from the payment link that failed and work back to how the merchant's",
  'SPEI settlement rail resolves its receiving-CLABE provider — the crash site',
  'is downstream of a provider-code migration, not the cause of it.',
  '',
  'Open a pull request against `main` with the fix, and verify it end-to-end on',
  `the \`${PAGE}\` page.`,
].join('\n');

const MERCHANT = {
  id: 'MX-T1-004182',
  businessName: 'Gaby Yoga Studio',
  initials: 'GY',
  owner: 'Arturo López',
  ownerInitials: 'AL',
  onboardingStep: 1,
  onboardingTotal: 4,
  speiProvider: 'stp_v2',
  currency: 'MXN',
};

const PAYMENT_METHODS = {
  card: {
    label: 'Tarjetas de crédito o débito',
    min: 1,
    max: 250000,
    brands: ['visa', 'mastercard', 'amex', 'carnet'],
  },
  spei: {
    label: 'Transferencia bancaria',
    min: 10,
    max: 99999,
    network: 'SPEI',
  },
  msi: {
    label: 'Ofrecer pagos a MSI',
    minAmount: 300,
    terms: [3, 6, 9, 12],
  },
};

const RECENT_LINKS = [
  {
    code: 'T1L-8Q2KX',
    concept: 'Mensualidad Yoga Flow',
    amount: 1250,
    currency: 'MXN',
    status: 'activo',
    createdAt: '2026-09-14T16:42:00.000Z',
  },
  {
    code: 'T1L-4M7PA',
    concept: 'Clase privada',
    amount: 850,
    currency: 'MXN',
    status: 'pagado',
    createdAt: '2026-09-12T19:18:00.000Z',
  },
  {
    code: 'T1L-9C3WD',
    concept: 'Paquete 10 clases',
    amount: 4200,
    currency: 'MXN',
    status: 'pagado',
    createdAt: '2026-09-09T14:05:00.000Z',
  },
];

const SETTLEMENT_RAILS = {
  card: { processor: 't1-acquiring', settlementDays: 1 },
  spei: { provider: MERCHANT.speiProvider, settlementDays: 0 },
};

const CLABE_PROVIDERS = {
  stp: { bankCode: '646', clabePrefix: '646180', bankName: 'STP' },
};

class ValidationError extends Error {
  constructor(message) {
    super(message);
    this.name = 'ValidationError';
    this.statusCode = 400;
  }
}

function clabeCheckDigit(base) {
  if (!/^\d{17}$/.test(base)) {
    throw new TypeError('A CLABE check digit requires a 17-digit base.');
  }

  const weights = [3, 7, 1];
  const sum = [...base].reduce(
    (total, digit, index) => total + ((Number(digit) * weights[index % weights.length]) % 10),
    0,
  );
  return String((10 - (sum % 10)) % 10);
}

function assignReceivingClabe(merchant, rail) {
  const provider = CLABE_PROVIDERS[rail.provider];
  const prefix = provider.clabePrefix;
  const merchantDigits = merchant.id.replace(/\D/g, '').padStart(11, '0').slice(-11);
  const base = `${prefix}${merchantDigits}`;
  const clabe = `${base}${clabeCheckDigit(base)}`;

  return {
    clabe,
    bankName: provider.bankName,
    reference: merchantDigits.slice(-8),
  };
}

function validatePaymentLink(data) {
  const concept = typeof data.concept === 'string' ? data.concept.trim() : '';
  const amount = data.amount;
  const methods = data.methods || {};
  const card = Boolean(methods.card);
  const msi = Boolean(methods.msi);
  const spei = Boolean(methods.spei);

  if (!concept) {
    throw new ValidationError('Ingresa el concepto de pago.');
  }
  if (!Number.isFinite(amount) || amount <= 0) {
    throw new ValidationError('Ingresa un monto válido.');
  }
  if (!card && !spei) {
    throw new ValidationError('Selecciona al menos un método de pago.');
  }
  if (card && (amount < PAYMENT_METHODS.card.min || amount > PAYMENT_METHODS.card.max)) {
    throw new ValidationError('El monto debe estar entre $1.00 y $250,000.00 MXN para tarjeta.');
  }
  if (spei && (amount < PAYMENT_METHODS.spei.min || amount > PAYMENT_METHODS.spei.max)) {
    throw new ValidationError('El monto debe estar entre $10.00 y $99,999.00 MXN para transferencia.');
  }
  if (msi && !card) {
    throw new ValidationError('Los pagos a MSI requieren aceptar tarjetas.');
  }
  if (msi && amount < PAYMENT_METHODS.msi.minAmount) {
    throw new ValidationError('Los pagos a MSI requieren un monto mínimo de $300.00 MXN.');
  }

  return {
    amount,
    concept,
    methods: { card, msi, spei },
  };
}

function generateLinkCode() {
  const characters = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
  let suffix = '';
  for (let index = 0; index < 5; index += 1) {
    suffix += characters[randomInt(characters.length)];
  }
  return `T1L-${suffix}`;
}

async function createPaymentLink(data = {}) {
  const startTime = Date.now();
  const linkId = uuidv4();
  let selectedMethods;

  try {
    selectedMethods = validatePaymentLink(data);
  } catch (error) {
    if (error instanceof ValidationError) {
      incrementMetric('t1_payment_link.rejected', { route: ROUTE });
      throw error;
    }
    throw error;
  }

  const methodLabels = [];
  if (selectedMethods.methods.card) methodLabels.push(PAYMENT_METHODS.card.label);
  if (selectedMethods.methods.msi) methodLabels.push(PAYMENT_METHODS.msi.label);
  if (selectedMethods.methods.spei) methodLabels.push(PAYMENT_METHODS.spei.label);
  const methodsTag = methodLabels.join(',');

  logger.info('Creating T1 payment link', {
    linkId,
    amount: selectedMethods.amount,
    concept: selectedMethods.concept,
    methods: methodsTag,
    service: SERVICE,
    route: ROUTE,
  });

  try {
    await new Promise((resolve) => setTimeout(resolve, 80 + randomInt(120)));

    const code = generateLinkCode();
    const link = {
      code,
      url: `https://payments.t1.com/l/${code}`,
      concept: selectedMethods.concept,
      amount: selectedMethods.amount.toFixed(2),
      currency: 'MXN',
      methods: methodLabels,
    };

    if (selectedMethods.methods.msi) {
      link.installments = PAYMENT_METHODS.msi.terms.map((months) => ({
        months,
        monthly: (selectedMethods.amount / months).toFixed(2),
      }));
    }

    if (selectedMethods.methods.spei) {
      const receiving = assignReceivingClabe(MERCHANT, SETTLEMENT_RAILS.spei);
      link.spei = {
        clabe: receiving.clabe,
        bank: receiving.bankName,
        reference: receiving.reference,
      };
    }

    const duration = Date.now() - startTime;
    const createdAt = new Date().toISOString();
    incrementMetric('t1_payment_link.success', { route: ROUTE, methods: methodsTag });
    recordTiming('t1_payment_link.latency', duration, { route: ROUTE });

    logger.info('T1 payment link created', {
      linkId,
      code,
      durationMs: duration,
      service: SERVICE,
    });

    return {
      success: true,
      linkId,
      link,
      status: 'activo',
      createdAt,
    };
  } catch (error) {
    const duration = Date.now() - startTime;

    incrementMetric('t1_payment_link.failure', { route: ROUTE, errorClass: error.name });
    recordTiming('t1_payment_link.latency', duration, { route: ROUTE, error: 'true' });

    logger.error('T1 payment link creation failed', {
      linkId,
      error: error.message,
      errorClass: error.name,
      durationMs: duration,
      amount: selectedMethods.amount,
      methods: methodsTag,
      service: SERVICE,
    });

    Sentry.captureException(error, {
      tags: {
        route: ROUTE, service: SERVICE, page: PAGE, alert_path: 'instant',
      },
      extra: {
        linkId,
        amount: selectedMethods.amount,
        concept: selectedMethods.concept,
        methods: selectedMethods.methods,
      },
    });

    createSessionAndAlert({
      issueTitle: `${error.name}: ${error.message}`,
      issueUrl: `https://${process.env.SENTRY_ORG_SLUG || 'sentry-org'}.sentry.io/issues/?project=${process.env.SENTRY_PROJECT_ID || ''}&query=is%3Aunresolved`,
      culprit: 'app/services/verticals/t1.js — createPaymentLink',
      errorType: error.name || 'Error',
      errorValue: error.message,
      devinUserId: data.devinUserId,
      devinEmail: data.devinEmail,
      devinOrgId: data.devinOrgId,
      service: SERVICE,
      verticalLabel: 'T1 Pagos — Crear link de pago',
      promptAppendix: REMEDIATION_DIRECTIVE,
      customer: 't1',
      slackMemberIdFallback: SLACK_MEMBER_ID_FALLBACK,
      tags: [
        { key: 'route', value: ROUTE },
        { key: 'service', value: SERVICE },
        { key: 'page', value: PAGE },
        { key: 'methods', value: methodsTag },
      ],
      extra: {
        linkId, amount: selectedMethods.amount, concept: selectedMethods.concept, methods: selectedMethods.methods,
      },
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
      logger.error('Failed to trigger Devin session from T1 payment link error', {
        linkId,
        error: alertError.message,
      });
    });

    error.linkId = linkId;
    throw error;
  }
}

module.exports = {
  createPaymentLink,
  MERCHANT,
  PAYMENT_METHODS,
  RECENT_LINKS,
  SETTLEMENT_RAILS,
  CLABE_PROVIDERS,
  REMEDIATION_DIRECTIVE,
  ValidationError,
  clabeCheckDigit,
};
