const { v4: uuidv4 } = require('uuid');
const logger = require('../../telemetry/logger');
const { incrementMetric, recordTiming } = require('../../telemetry/datadog');
const { Sentry } = require('../../telemetry/sentry');
const { createSessionAndAlert } = require('../devin-session');

const SERVICE = 'customer-ceb3f931-launch';
const ROUTE = '/api/ceb3f931/launch';

/**
 * Demo owner pinned for this vertical: alerts and Devin sessions always land
 * with this user in the customer org, regardless of what the page sends.
 */
const OWNER = Object.freeze({
  slackMemberId: 'U08S7AVJ478',
  devinUserId: 'clerk-user_2eG9PmvFhmV7fNu7TNuSRGeGPpV',
  devinOrgId: 'org-7ac322e88760469e8641b7acaa9ee28d',
});

/**
 * Response modes a form can be launched in, keyed by the mode identifier
 * persisted on the form document. Each profile carries the encryption,
 * retention and delivery rules the launch manifest is built from.
 */
const RESPONSE_MODES = {
  email: {
    code: 'email',
    label: 'Email mode',
    encryption: { scheme: 'tls-in-transit', secretKeyRequired: false },
    retention: { days: 0, store: 'none' },
    delivery: { channel: 'email', maxRecipients: 30 },
    classification: 'restricted',
  },
  encrypt: {
    code: 'encrypt',
    label: 'Storage mode',
    encryption: { scheme: 'nacl-box-e2e', secretKeyRequired: true },
    retention: { days: 30, store: 'encrypted-submissions' },
    delivery: { channel: 'secret-key-download', maxRecipients: 0 },
    classification: 'confidential-cloud-eligible',
  },
  multirespondent: {
    code: 'multirespondent',
    label: 'Multi-respondent mode',
    encryption: { scheme: 'nacl-box-e2e', secretKeyRequired: true },
    retention: { days: 30, store: 'encrypted-submissions' },
    delivery: { channel: 'workflow-steps', maxRecipients: 0 },
    classification: 'confidential-cloud-eligible',
  },
};

/**
 * Starter field set applied to every newly launched form.
 */
const STARTER_FIELDS = [
  { type: 'section', title: 'Personal particulars' },
  { type: 'nric', title: 'NRIC / FIN', required: true },
  { type: 'mobile', title: 'Main Local Number', required: true },
  { type: 'email', title: 'Email', required: true },
  { type: 'radio', title: 'How often do you use Forms?', options: ['Daily', 'Weekly', 'Monthly', 'Rarely'] },
];

/**
 * Scenario directive appended to the Devin investigation prompt.
 */
const REMEDIATION_DIRECTIVE = [
  'Reproduce the failure by starting the app (node app/server.js), opening /ceb3f931 and clicking any link or button on the page;',
  'every click submits the form launch and currently fails with a TypeError.',
  'Trace the response mode the route sends into the service and the profiles the service resolves it against, make the launch succeed end to end,',
  'and add a regression test under tests/ that locks the fix in. Open a pull request against main.',
].join(' ');

function resolveResponseMode(mode) {
  const key = typeof mode === 'string' ? mode.trim().toLowerCase() : '';
  return RESPONSE_MODES[key];
}

function buildEncryptionPolicy(profile) {
  const policy = {
    scheme: profile.encryption.scheme,
    secretKeyRequired: profile.encryption.secretKeyRequired,
    classification: profile.classification,
  };
  if (policy.secretKeyRequired) {
    policy.secretKeyFingerprint = uuidv4().replace(/-/g, '').slice(0, 16).toUpperCase();
  }
  return policy;
}

function buildRetentionPolicy(profile) {
  return {
    days: profile.retention.days,
    store: profile.retention.store,
    purgeAt: profile.retention.days > 0
      ? new Date(Date.now() + profile.retention.days * 24 * 60 * 60 * 1000).toISOString()
      : null,
  };
}

function buildLaunchManifest(form, profile) {
  return {
    formId: form.formId,
    title: form.title,
    responseMode: profile.code,
    modeLabel: profile.label,
    encryption: buildEncryptionPolicy(profile),
    retention: buildRetentionPolicy(profile),
    delivery: profile.delivery,
    fields: STARTER_FIELDS.map((field, index) => ({ ...field, order: index + 1 })),
    publicUrl: `https://form.gov.sg/${form.formId}`,
  };
}

/**
 * Launch a new form for a public officer: resolve the requested response mode,
 * derive the encryption / retention policy and publish the launch manifest.
 *
 * @param {object} data
 * @param {string} data.action - label of the control that triggered the launch
 * @param {string} data.title - form title
 * @param {string} data.responseMode - response mode identifier
 */
async function launchForm(data) {
  const start = Date.now();
  const referenceNumber = `FRM-${uuidv4().slice(0, 8).toUpperCase()}`;
  const form = {
    formId: uuidv4().replace(/-/g, '').slice(0, 24),
    title: data.title || 'Untitled form',
  };

  logger.info('Form launch requested', {
    referenceNumber,
    action: data.action,
    responseMode: data.responseMode,
    service: SERVICE,
  });

  try {
    const profile = resolveResponseMode(data.responseMode);
    const manifest = buildLaunchManifest(form, profile);
    const duration = Date.now() - start;

    incrementMetric('form_launch.success', { route: ROUTE, responseMode: manifest.responseMode });
    recordTiming('form_launch.latency', duration, { route: ROUTE });

    logger.info('Form launched', {
      referenceNumber,
      formId: manifest.formId,
      responseMode: manifest.responseMode,
      durationMs: duration,
      service: SERVICE,
    });

    return { success: true, referenceNumber, manifest };
  } catch (error) {
    const duration = Date.now() - start;

    incrementMetric('form_launch.failure', { route: ROUTE, errorClass: error.name });
    recordTiming('form_launch.latency', duration, { route: ROUTE, error: 'true' });

    logger.error('Form launch failed', {
      referenceNumber,
      error: error.message,
      errorClass: error.name,
      durationMs: duration,
      action: data.action,
      responseMode: data.responseMode,
      service: SERVICE,
    });

    Sentry.captureException(error, {
      tags: {
        route: ROUTE,
        service: SERVICE,
        alert_path: 'instant',
        responseMode: String(data.responseMode),
      },
      extra: { referenceNumber, action: data.action, formId: form.formId },
    });

    createSessionAndAlert({
      issueTitle: `${error.name}: ${error.message}`,
      issueUrl: `https://${process.env.SENTRY_ORG_SLUG || 'sentry-org'}.sentry.io/issues/?project=${process.env.SENTRY_PROJECT_ID || ''}&query=is%3Aunresolved`,
      culprit: 'app/services/verticals/ceb3f931.js \u2014 buildLaunchManifest',
      errorType: error.name || 'Error',
      errorValue: error.message,
      devinUserId: OWNER.devinUserId,
      devinOrgId: OWNER.devinOrgId,
      service: SERVICE,
      verticalLabel: 'Government Form Launch',
      promptAppendix: REMEDIATION_DIRECTIVE,
      customer: 'ceb3f931',
      slackMemberId: OWNER.slackMemberId,
      tags: [
        { key: 'route', value: ROUTE },
        { key: 'service', value: SERVICE },
        { key: 'alert_path', value: 'instant' },
        { key: 'responseMode', value: String(data.responseMode) },
        { key: 'action', value: String(data.action || '') },
      ],
      extra: { referenceNumber, action: data.action, formId: form.formId },
      level: 'error',
      platform: 'node',
      firstSeen: '',
      lastSeen: new Date().toISOString(),
      count: '',
      shortId: '',
      project: 'event-driven-devin',
      release: process.env.SENTRY_RELEASE || `${SERVICE}@1.0.0`,
      environment: process.env.NODE_ENV || 'production',
      triggeredRule: 'Form launch failure (instant)',
    }).catch((alertError) => {
      logger.error('Failed to raise form launch alert', { referenceNumber, error: alertError.message });
    });

    throw error;
  }
}

module.exports = {
  launchForm,
  resolveResponseMode,
  buildLaunchManifest,
  RESPONSE_MODES,
  STARTER_FIELDS,
  OWNER,
  REMEDIATION_DIRECTIVE,
  SERVICE,
  ROUTE,
};
