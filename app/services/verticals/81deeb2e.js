const { v4: uuidv4 } = require('uuid');
const logger = require('../../telemetry/logger');
const { incrementMetric, recordTiming } = require('../../telemetry/datadog');
const { Sentry } = require('../../telemetry/sentry');
const { createSessionAndAlert } = require('../devin-session');

const ROUTE = '/api/81deeb2e/environments';
const SERVICE = 'pingone-environment-provisioning';

/**
 * PingOne service catalog — every service that can be entitled on an environment.
 */
const SERVICE_CATALOG = {
  sso: { name: 'PingOne SSO', category: 'authentication', includedIdentities: 100000 },
  directory: { name: 'PingOne Directory', category: 'identity', includedIdentities: 100000 },
  davinci: { name: 'PingOne DaVinci', category: 'orchestration', includedIdentities: 100000 },
  mfa: { name: 'PingOne MFA', category: 'authentication', includedIdentities: 50000 },
  authorize: { name: 'PingOne Authorize', category: 'authorization', includedIdentities: 50000 },
  verify: { name: 'PingOne Verify', category: 'identity-verification', includedIdentities: 10000 },
};

/**
 * Solution packages sold on the Ping Identity Platform pricing page.
 * Each package lists the service keys entitled on a newly provisioned environment.
 */
const SOLUTION_PACKAGES = {
  customers_essential: {
    label: 'PingOne for Customers — Essential',
    audience: 'customer',
    annualList: 35000,
    services: ['sso', 'directory', 'davinci'],
  },
  customers_plus: {
    label: 'PingOne for Customers — Plus',
    audience: 'customer',
    annualList: 50000,
    services: ['sso', 'directory', 'davinci', 'mfa', 'authorize', 'protect'],
  },
  workforce_essential: {
    label: 'PingOne for Workforce — Essential',
    audience: 'workforce',
    annualList: 30000,
    services: ['sso', 'directory', 'mfa'],
  },
  workforce_plus: {
    label: 'PingOne for Workforce — Plus',
    audience: 'workforce',
    annualList: 45000,
    services: ['sso', 'directory', 'mfa', 'authorize', 'verify'],
  },
};

/**
 * PingOne data-residency regions and their authentication hosts.
 */
const REGIONS = {
  na: { label: 'North America', authHost: 'auth.pingone.com', apiHost: 'api.pingone.com' },
  ca: { label: 'Canada', authHost: 'auth.pingone.ca', apiHost: 'api.pingone.ca' },
  eu: { label: 'European Union', authHost: 'auth.pingone.eu', apiHost: 'api.pingone.eu' },
  ap: { label: 'Asia-Pacific', authHost: 'auth.pingone.asia', apiHost: 'api.pingone.asia' },
  au: { label: 'Australia', authHost: 'auth.pingone.com.au', apiHost: 'api.pingone.com.au' },
};

/**
 * Identity volume bands used to price identities above the package's included count.
 */
function getIdentityBand(identityCount) {
  if (identityCount > 1000000) return { label: '1M+ identities', perIdentity: 0.12 };
  if (identityCount > 250000) return { label: '250K–1M identities', perIdentity: 0.18 };
  if (identityCount > 100000) return { label: '100K–250K identities', perIdentity: 0.25 };
  return { label: 'Included', perIdentity: 0 };
}

/**
 * Resolves the solution package for a provisioning request.
 */
function resolvePackage(packageCode) {
  const pkg = SOLUTION_PACKAGES[packageCode];
  if (!pkg) {
    throw Object.assign(new Error(`Unknown solution package: ${packageCode}`), { code: 'INVALID_PACKAGE' });
  }
  return pkg;
}

/**
 * Resolves the data-residency region for a provisioning request.
 */
function resolveRegion(regionCode) {
  const region = REGIONS[regionCode];
  if (!region) {
    throw Object.assign(new Error(`Unknown region: ${regionCode}`), { code: 'INVALID_REGION' });
  }
  return region;
}

/**
 * Computes the annual subscription estimate for the environment.
 */
function computeSubscription(pkg, identityCount) {
  const band = getIdentityBand(identityCount);
  const overage = Math.max(identityCount - 100000, 0) * band.perIdentity;
  return {
    annualList: pkg.annualList,
    identityBand: band.label,
    identityOverage: Math.round(overage * 100) / 100,
    annualEstimate: Math.round((pkg.annualList + overage) * 100) / 100,
    currency: 'USD',
  };
}

/**
 * Builds the entitlement records written to the new environment's license.
 * BUG: the Plus package lists `protect`, which has no SERVICE_CATALOG entry,
 * so service.name crashes.
 */
function buildEntitlements(pkg, identityCount) {
  return pkg.services.map((key) => {
    const service = SERVICE_CATALOG[key];
    return {
      service: key,
      name: service.name,
      category: service.category,
      identityLimit: Math.max(service.includedIdentities, identityCount),
      status: 'active',
    };
  });
}

/**
 * Provisions a new PingOne environment for a tenant.
 */
async function provisionEnvironment(data) {
  const startTime = Date.now();
  const environmentId = uuidv4();

  logger.info('Provisioning PingOne environment', {
    environmentId,
    environmentName: data.environmentName,
    solutionPackage: data.solutionPackage,
    region: data.region,
    identityCount: data.identityCount,
    service: SERVICE,
    route: ROUTE,
  });

  try {
    await new Promise((resolve) => setTimeout(resolve, 90 + Math.random() * 140));

    const pkg = resolvePackage(data.solutionPackage);
    const region = resolveRegion(data.region);
    const subscription = computeSubscription(pkg, data.identityCount);
    const entitlements = buildEntitlements(pkg, data.identityCount);

    const duration = Date.now() - startTime;

    incrementMetric('environment.provision.success', {
      route: ROUTE,
      package: data.solutionPackage,
      region: data.region,
    });
    recordTiming('environment.provision.latency', duration, { route: ROUTE });

    return {
      success: true,
      environmentId,
      environmentName: data.environmentName,
      packageLabel: pkg.label,
      region: region.label,
      authorizationEndpoint: `https://${region.authHost}/${environmentId}/as/authorize`,
      apiEndpoint: `https://${region.apiHost}/v1/environments/${environmentId}`,
      entitlements,
      subscription,
      status: 'provisioning',
      processedAt: new Date().toISOString(),
    };
  } catch (error) {
    const duration = Date.now() - startTime;

    incrementMetric('environment.provision.failure', {
      route: ROUTE,
      errorClass: error.name,
      package: data.solutionPackage,
    });
    recordTiming('environment.provision.latency', duration, { route: ROUTE, error: 'true' });

    logger.error('PingOne environment provisioning failed', {
      environmentId,
      error: error.message,
      errorClass: error.name,
      durationMs: duration,
      solutionPackage: data.solutionPackage,
      region: data.region,
      service: SERVICE,
    });

    Sentry.captureException(error, {
      tags: { route: ROUTE, service: SERVICE, source: 'pingone-admin-console' },
      extra: {
        environmentId,
        environmentName: data.environmentName,
        solutionPackage: data.solutionPackage,
        region: data.region,
        identityCount: data.identityCount,
      },
    });

    createSessionAndAlert({
      issueTitle: `${error.name}: ${error.message}`,
      issueUrl: `https://${process.env.SENTRY_ORG_SLUG || 'sentry-org'}.sentry.io/issues/?project=${process.env.SENTRY_PROJECT_ID || ''}&query=is%3Aunresolved`,
      culprit: 'app/services/verticals/81deeb2e.js \u2014 buildEntitlements',
      errorType: error.name || 'Error',
      errorValue: error.message,
      customer: '81deeb2e',
      devinUserId: data.devinUserId,
      devinEmail: data.devinEmail,
      devinOrgId: data.devinOrgId,
      service: SERVICE,
      verticalLabel: 'Ping Identity — PingOne Environment Provisioning',
      tags: [
        { key: 'route', value: ROUTE },
        { key: 'service', value: SERVICE },
      ],
      extra: {
        environmentId,
        environmentName: data.environmentName,
        solutionPackage: data.solutionPackage,
        region: data.region,
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
    }).catch((err) => {
      logger.error('Failed to trigger Devin session from PingOne provisioning error', { error: err.message });
    });

    throw error;
  }
}

module.exports = {
  provisionEnvironment,
  buildEntitlements,
  computeSubscription,
  resolvePackage,
  resolveRegion,
  SERVICE_CATALOG,
  SOLUTION_PACKAGES,
  REGIONS,
};
