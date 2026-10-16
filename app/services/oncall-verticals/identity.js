const { v4: uuidv4 } = require('uuid');
const logger = require('../../telemetry/logger');
const { incrementMetric, recordTiming } = require('../../telemetry/datadog');
const { Sentry } = require('../../telemetry/sentry');

const ENVIRONMENTS_ROUTE = '/api/oncall/identity/environments';
const APPLICATIONS_ROUTE = '/api/oncall/identity/applications';
const SERVICE = 'pingone-environment-api';

/** Data-residency regions the organization's environments are registered in. */
const REGIONS = [
  { id: 'NA', host: 'api.pingone.com' },
  { id: 'CA', host: 'api.pingone.ca' },
  { id: 'EU', host: 'api.pingone.eu' },
  { id: 'AP', host: 'api.pingone.asia' },
  { id: 'AU', host: 'api.pingone.com.au' },
  { id: 'SG', host: 'api.pingone.sg' },
];
const HOME_REGION = 'NA';

const SERVICES = ['SSO', 'MFA', 'DAVINCI', 'PROTECT', 'VERIFY', 'AUTHORIZE'];
const USE_CASES = ['customer', 'workforce'];
const ENVIRONMENT_TYPES = ['SANDBOX', 'PRODUCTION'];
const LICENSE_TYPES = ['trial', 'paid'];
const APPLICATION_TYPES = ['OIDC_WEB_APP', 'SINGLE_PAGE_APP', 'NATIVE_APP', 'WORKER', 'SAML'];
const MAX_NAME_LENGTH = 256;

/** Environments already in the organization (seeded demo data). */
const ENVIRONMENTS = {
  'b8d1c2e4-6f0a-4c51-9a2e-11c0a7e3d001': { id: 'b8d1c2e4-6f0a-4c51-9a2e-11c0a7e3d001', name: 'Administrators', type: 'PRODUCTION', region: 'NA' },
  'c41e7a90-2b3d-4f8e-8d6c-5e2f9b1a0002': { id: 'c41e7a90-2b3d-4f8e-8d6c-5e2f9b1a0002', name: 'Customer Identity - Production', type: 'PRODUCTION', region: 'NA' },
  'd7f03b16-8e4c-4a2d-b1f9-3c6e0d8a0003': { id: 'd7f03b16-8e4c-4a2d-b1f9-3c6e0d8a0003', name: 'Customer Identity - Staging', type: 'SANDBOX', region: 'NA' },
  'e2a96c58-4d1f-4b7e-a3c8-9f0b2e6d0004': { id: 'e2a96c58-4d1f-4b7e-a3c8-9f0b2e6d0004', name: 'Workforce', type: 'PRODUCTION', region: 'NA' },
};

const PROVISION_DEADLINE_MS = 9000;
const REGISTRATION_LATENCY_MS = [1450, 1700];
const APPLICATION_LATENCY_MS = [70, 160];

const delay = ([minMs, maxMs]) => new Promise((resolve) => setTimeout(resolve, minMs + Math.random() * (maxMs - minMs)));

function invalidRequest(message, code) {
  const err = new Error(message);
  err.code = code;
  return err;
}

function withDeadline(promise, ms, label) {
  let timer;
  const deadline = new Promise((_, reject) => {
    timer = setTimeout(() => {
      const err = new Error(`${label} exceeded ${ms}ms`);
      err.code = 'PROVISION_TIMEOUT';
      reject(err);
    }, ms);
  });
  return Promise.race([promise, deadline]).finally(() => clearTimeout(timer));
}

function cleanName(value, code) {
  const name = typeof value === 'string' ? value.trim() : '';
  if (!name) throw invalidRequest('Name is required.', code);
  if (name.length > MAX_NAME_LENGTH) throw invalidRequest(`Name must be ${MAX_NAME_LENGTH} characters or fewer.`, code);
  return name;
}

function validateEnvironment(data) {
  const code = 'INVALID_ENVIRONMENT';
  const name = cleanName(data.name, code);
  const taken = Object.values(ENVIRONMENTS).some((env) => env.name.toLowerCase() === name.toLowerCase());
  if (taken) throw invalidRequest(`An environment named "${name}" already exists.`, code);
  if (!USE_CASES.includes(data.useCase)) throw invalidRequest('Select an environment use case.', code);
  if (!ENVIRONMENT_TYPES.includes(data.type)) throw invalidRequest('Select an environment type.', code);
  if (!LICENSE_TYPES.includes(data.licenseType)) throw invalidRequest('Select a license type.', code);
  const services = Array.isArray(data.services) ? [...new Set(data.services)] : [];
  if (!services.length || !services.every((s) => SERVICES.includes(s))) throw invalidRequest('Select at least one service.', code);
  if (!services.includes('SSO')) throw invalidRequest('PingOne SSO is required for every environment.', code);
  const description = typeof data.description === 'string' ? data.description.trim().slice(0, 1024) : '';
  return { name, description, useCase: data.useCase, type: data.type, licenseType: data.licenseType, services };
}

/**
 * Register the new environment with one region's directory so its name and
 * license entitlement are reserved there (one round trip to that region).
 */
async function registerInRegion(region, environmentId) {
  await delay(REGISTRATION_LATENCY_MS);
  return { region: region.id, environmentId, registrationRef: `REG-${region.id}-${environmentId.slice(0, 8)}` };
}

/**
 * Reserve the environment in every data-residency region before it is
 * activated in the home region, so environment names stay unique org-wide.
 */
async function registerAcrossRegions(environmentId) {
  const registrations = [];
  for (const region of REGIONS) {
    const startedAt = Date.now();
    const registration = await registerInRegion(region, environmentId);
    logger.info('Regional directory registration', {
      environmentId,
      region: region.id,
      host: region.host,
      durationMs: Date.now() - startedAt,
      service: SERVICE,
      endpoint: 'directory/v1/environment-registrations',
    });
    registrations.push(registration);
  }
  return registrations;
}

/** Create a new environment from the Add New Environment setup assistant. */
async function createEnvironment(data = {}) {
  const startTime = Date.now();
  const environmentId = uuidv4();
  logger.info('Environment creation started', { environmentId, service: SERVICE, route: ENVIRONMENTS_ROUTE });

  try {
    const env = validateEnvironment(data);
    const registrations = await withDeadline(registerAcrossRegions(environmentId), PROVISION_DEADLINE_MS, 'Environment provisioning');

    incrementMetric('identity.environment.create.success', { route: ENVIRONMENTS_ROUTE });
    recordTiming('identity.environment.create.latency', Date.now() - startTime, { route: ENVIRONMENTS_ROUTE, service: SERVICE });

    return {
      success: true,
      environment: {
        id: environmentId,
        name: env.name,
        description: env.description,
        type: env.type,
        useCase: env.useCase,
        licenseType: env.licenseType,
        region: HOME_REGION,
        services: env.services,
        createdAt: new Date().toISOString(),
      },
      regionsRegistered: registrations.length,
    };
  } catch (error) {
    const duration = Date.now() - startTime;
    if (error.code === 'INVALID_ENVIRONMENT') {
      logger.warn('Environment creation rejected', { environmentId, error: error.message, service: SERVICE });
      throw error;
    }
    incrementMetric('identity.environment.create.failure', { route: ENVIRONMENTS_ROUTE, errorClass: error.name });
    recordTiming('identity.environment.create.latency', duration, { route: ENVIRONMENTS_ROUTE, service: SERVICE, error: 'true' });
    logger.error('Environment creation failed', {
      environmentId, error: error.message, errorClass: error.name, code: error.code, durationMs: duration, service: SERVICE,
    });
    Sentry.captureException(error, { tags: { route: ENVIRONMENTS_ROUTE, service: SERVICE }, extra: { environmentId } });
    throw error;
  }
}

/** Add an application to an existing environment (home region only). */
async function createApplication(data = {}) {
  const startTime = Date.now();
  const code = 'INVALID_APPLICATION';
  const env = ENVIRONMENTS[data.environmentId];
  if (!env) throw invalidRequest('Unknown environment.', code);
  const name = cleanName(data.name, code);
  if (!APPLICATION_TYPES.includes(data.type)) throw invalidRequest('Select an application type.', code);

  await delay(APPLICATION_LATENCY_MS);
  const duration = Date.now() - startTime;
  incrementMetric('identity.application.create.success', { route: APPLICATIONS_ROUTE });
  recordTiming('identity.application.create.latency', duration, { route: APPLICATIONS_ROUTE, service: SERVICE });
  logger.info('Application created', { environmentId: env.id, type: data.type, durationMs: duration, service: SERVICE, route: APPLICATIONS_ROUTE });

  return {
    success: true,
    application: {
      id: uuidv4(),
      clientId: uuidv4(),
      environmentId: env.id,
      name,
      type: data.type,
      enabled: false,
      createdAt: new Date().toISOString(),
    },
  };
}

module.exports = {
  createEnvironment,
  createApplication,
  ENVIRONMENTS,
  REGIONS,
  SERVICES,
  APPLICATION_TYPES,
  PROVISION_DEADLINE_MS,
};
