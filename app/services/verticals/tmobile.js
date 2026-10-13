const { v4: uuidv4 } = require('uuid');
const logger = require('../../telemetry/logger');
const { incrementMetric, recordTiming } = require('../../telemetry/datadog');
const { createSessionAndAlert } = require('../devin-session');

const SERVICE = 'customer-tmobile-device-upgrade';
const ROUTE = '/api/tmobile/upgrade/checkout';
const INSTALLMENT_MONTHS = 24;

/**
 * Billing markets. `eipRegion` selects which Equipment Installment Plan (EIP)
 * ledger shard books the line's device financing agreements.
 */
const MARKETS = {
  SEA: { label: 'Seattle', eipRegion: 'west' },
  DAL: { label: 'Dallas / Fort Worth', eipRegion: 'south' },
  CHI: { label: 'Chicago', eipRegion: 'central' },
  NYC: { label: 'New York', eipRegion: 'east' },
  'USC-MW': { label: 'Midwest (migrated UScellular)', eipRegion: 'usc-midwest' },
};

/**
 * EIP ledger shards by region. Every `eipRegion` referenced by a market must
 * resolve to an active shard here before an installment agreement can be booked.
 */
const EIP_LEDGER_SHARDS = {
  west: { id: 'eip-ledger-01', endpoint: 'eip-west.billing.tmo.internal', active: true },
  south: { id: 'eip-ledger-02', endpoint: 'eip-south.billing.tmo.internal', active: true },
  central: { id: 'eip-ledger-03', endpoint: 'eip-central.billing.tmo.internal', active: true },
  east: { id: 'eip-ledger-04', endpoint: 'eip-east.billing.tmo.internal', active: true },
};

/**
 * Devices sold in T-Life, keyed by SKU. Prices are full retail in USD.
 */
const DEVICES = {
  'iphone-17-pro-256-orange': { name: 'iPhone 17 Pro 256GB, Cosmic Orange', retailPrice: 1099.99 },
  'iphone-17-256-lavender': { name: 'iPhone 17 256GB, Lavender', retailPrice: 829.99 },
  'iphone-air-256-skyblue': { name: 'iPhone Air 256GB, Sky Blue', retailPrice: 999.99 },
  'galaxy-s25-ultra-256-silverblue': { name: 'Samsung Galaxy S25 Ultra 256GB, Titanium Silverblue', retailPrice: 1299.99 },
  'pixel-10-pro-128-moonstone': { name: 'Google Pixel 10 Pro 128GB, Moonstone', retailPrice: 999.99 },
};

/** Trade-in promo credit, spread across the installment term as bill credits. */
const TRADE_IN_CREDIT = 830;

/**
 * Demo accounts returned by the (stubbed) account directory, keyed by billing
 * account number (BAN). Line numbers are 10-digit MSISDNs.
 */
const ACCOUNTS = {
  '958204417': {
    name: 'Taylor Morgan',
    plan: 'Experience Beyond',
    lines: {
      '3125550187': { owner: 'Taylor Morgan', market: 'USC-MW', upgradeEligible: true },
      '3125550142': { owner: 'Sam Morgan', market: 'USC-MW', upgradeEligible: false },
    },
  },
  '471993025': {
    name: 'Jordan Reyes',
    plan: 'Experience More',
    lines: {
      '2145550110': { owner: 'Jordan Reyes', market: 'DAL', upgradeEligible: true },
    },
  },
};

/**
 * Scenario directive appended to the Devin investigation prompt.
 *
 * The alert pipeline passes only a prompt to the Devin API, so the
 * repositories involved and the expected remediation have to be named here.
 */
const REMEDIATION_DIRECTIVE = [
  '*Repositories:*',
  '- Backend (source of the 500): `COG-GTM/event-driven-devin`',
  '  - Service: `app/services/verticals/tmobile.js`',
  `  - Route: \`app/routes/verticals/tmobile.js\` (\`POST ${ROUTE}\`)`,
  '- iOS client: `COG-GTM/ios-demos`, folder `apps/1735ce0a/` only (T-Life, Swift / SwiftUI)',
  '  - Checkout screen: `apps/1735ce0a/App/Views/CheckoutView.swift`',
  '  - Raw error screen it shows today: `apps/1735ce0a/App/Views/RawErrorView.swift`',
  '  - API client: `apps/1735ce0a/App/Services/TLifeAPI.swift`',
  '',
  '*Scope:* Diagnose the backend failure, but do NOT change the backend: the EIP ledger',
  'outage is owned by the billing platform team. Fix the iOS client instead. Today it',
  'dumps the raw Swift error, HTTP status, response body and call stack on the checkout',
  'screen. Replace that with the error state a customer would see in the real T-Life app,',
  'with every technical detail abstracted away:',
  '- one short sentence in T-Mobile\'s voice saying what happened and what to do next, e.g.',
  '  "We couldn\'t place your upgrade order right now. Your account hasn\'t been charged —',
  '  please try again in a few minutes.";',
  '- a *Try again* button that re-submits the same order, and a way back to Shop.',
  'Nothing technical may appear anywhere on screen: no error type, stack trace, HTTP status,',
  'backend `error` / `message` / `code`, request or trace ID, and no "support details" or',
  '"technical details" section, collapsed or otherwise. A customer must not be able to tell',
  'a ledger outage from a network timeout. Keep the backend fields in the app log',
  '(`os.Logger`) only. Showing any of the raw fields on screen fails the deliverable.',
  '',
  '*Deliverable:* Open a *draft* pull request against `main` in `COG-GTM/ios-demos` titled',
  '`[DEMO — DO NOT MERGE] ...` (main must keep the unfixed app so the demo can be re-run),',
  'touching only `apps/1735ce0a/`, with ONE continuous Simulator screen recording attached',
  '(`xcrun simctl io booted recordVideo`) that shows, in a single take:',
  '1. *Before*: the unfixed app (build it from a `git worktree` of `origin/main`): sign in,',
  '   Shop, pick a phone, Upgrade, Place order, and hold on the raw error long enough to read.',
  '2. *Rebuild*: the CLI rebuild and reinstall of your fixed app (`make run APP=1735ce0a`).',
  '3. *After*: the same taps ending in the new error state, held long enough to confirm that',
  '   no codes, IDs or technical text appear anywhere.',
  'The recording is the proof, so do not skip the before segment and do not substitute',
  'screenshots for a live run.',
  '',
  '*Verification target:* run the backend locally (`npm ci`, `PORT=3000 node app/server.js`',
  'in `COG-GTM/event-driven-devin`) and build the app with the default settings',
  '(`make run APP=1735ce0a`), which point at `http://localhost:3000` and reproduce the same',
  '500. Never point the app at the deployed backend, and never set `TMOBILE_DEMO_TOKEN`:',
  'that token belongs to the presenter build, and sending it turns a verification tap into',
  'a production page.',
].join('\n');

/**
 * Free-text fields flow into Slack alert cards and the Devin investigation
 * prompt, so callers must not be able to smuggle markup or instructions in.
 */
function sanitizeText(value, maxLength = 80) {
  return String(value == null ? '' : value)
    .replace(/[\r\n\t]+/g, ' ')
    .replace(/[`*_~<>|@#\\]/g, '')
    .replace(/\s{2,}/g, ' ')
    .trim()
    .slice(0, maxLength);
}

function digitsOnly(value) {
  return String(value == null ? '' : value).replace(/\D/g, '');
}

/**
 * Owner shown on the T-Mobile alert card. The iOS client is unauthenticated,
 * so the demo owner is fixed here rather than taken from the request.
 */
const OWNER_EMAIL = 'yubin.jee@cognition.ai';

/**
 * Kill switch. The deployment has no T-Mobile-specific host configuration, so
 * this is a code constant — flipping it is a merge. False keeps the intentional
 * 500 and drops the Slack card and the Devin session.
 */
const alerting = { enabled: true };

/**
 * Only the presenter's build alerts. The iOS client sends this token only when
 * it is built with `TMOBILE_DEMO_TOKEN`, which the default build a triggered
 * session produces does not set — so a session that reaches this endpoint while
 * verifying its fix gets the intentional 500 and nothing else, instead of
 * paging and spawning another session. The value is not a secret: the guard
 * works because every other build sends no token at all.
 */
const DEMO_TOKEN = 'tmobile-presenter-demo';

function alertBlockReason(demoToken) {
  if (!alerting.enabled) return 'T-Mobile alerting is switched off';
  if (String(demoToken || '') !== DEMO_TOKEN) {
    return 'request did not carry the presenter demo token';
  }
  return null;
}

/**
 * The checkout endpoint is unauthenticated, so a Devin identity in the request
 * body is never honoured — sessions are always attributed to the demo owner.
 */
function resolveDevinIdentity(data) {
  const requestedOrgId = String(data.devinOrgId || '').trim();

  if (requestedOrgId) {
    logger.warn('Ignoring caller-supplied Devin identity for T-Mobile upgrade checkout', {
      requestedOrgId,
      service: SERVICE,
    });
  }

  return { devinOrgId: undefined, devinUserId: undefined, devinEmail: OWNER_EMAIL };
}

function domainError(name, code, statusCode, message) {
  const error = new Error(message);
  error.name = name;
  error.code = code;
  error.statusCode = statusCode;
  return error;
}

function findLine(accountNumber, lineNumber) {
  const account = ACCOUNTS[digitsOnly(accountNumber)];
  if (!account) {
    throw domainError('AccountNotFound', 'ACCOUNT_NOT_FOUND', 404, 'Billing account not found.');
  }
  const line = account.lines[digitsOnly(lineNumber)];
  if (!line) {
    throw domainError('LineNotFound', 'LINE_NOT_FOUND', 404, 'Line is not on this billing account.');
  }
  if (!line.upgradeEligible) {
    throw domainError(
      'UpgradeNotEligible',
      'UPGRADE_NOT_ELIGIBLE',
      409,
      'This line is not eligible for an upgrade yet.',
    );
  }
  return { account, line };
}

/**
 * Price the device over a 24-month EIP, with trade-in credit applied monthly.
 */
function priceInstallments(device, tradeIn) {
  const monthlyPayment = Math.round((device.retailPrice / INSTALLMENT_MONTHS) * 100) / 100;
  const monthlyCredit = tradeIn ? Math.round((TRADE_IN_CREDIT / INSTALLMENT_MONTHS) * 100) / 100 : 0;
  return {
    retailPrice: device.retailPrice,
    months: INSTALLMENT_MONTHS,
    monthlyPayment,
    monthlyCredit,
    monthlyAfterCredits: Math.round((monthlyPayment - monthlyCredit) * 100) / 100,
  };
}

/**
 * Resolve the EIP ledger shard that books installment agreements for a market.
 */
function resolveEipLedgerShard(marketCode) {
  const market = MARKETS[marketCode];
  const region = market ? market.eipRegion : String(marketCode).toLowerCase();
  const shard = EIP_LEDGER_SHARDS[region];
  if (!shard || !shard.active) {
    const shardId = shard ? shard.id : `eip-ledger-${region}`;
    throw domainError(
      'EipLedgerUnavailable',
      'EIP_LEDGER_UNAVAILABLE',
      500,
      `Equipment installment ledger is unavailable: shard ${shardId} for market ${marketCode} is not registered`,
    );
  }
  return shard;
}

/**
 * Book the installment agreement on the line's EIP ledger shard.
 */
function bookInstallmentAgreement(line, pricing) {
  const shard = resolveEipLedgerShard(line.market);
  return {
    shard: shard.id,
    agreementId: `EIP-${uuidv4().replace(/-/g, '').slice(0, 10).toUpperCase()}`,
    financedAmount: pricing.retailPrice,
  };
}

/**
 * Places a device upgrade order on an existing line, financed on EIP.
 */
async function checkoutUpgrade(data) {
  const startTime = Date.now();
  const orderId = uuidv4();
  const client = sanitizeText(data.client, 40) || 'unknown';
  const deviceSku = sanitizeText(data.deviceSku, 60);
  const device = DEVICES[deviceSku];
  const lineNumber = digitsOnly(data.lineNumber);

  if (!device || !digitsOnly(data.accountNumber) || lineNumber.length !== 10) {
    throw domainError(
      'ValidationError',
      'INVALID_UPGRADE_REQUEST',
      400,
      'Choose a device and a line to upgrade.',
    );
  }

  logger.info('Placing T-Mobile device upgrade order', {
    orderId,
    deviceSku,
    lineLast4: lineNumber.slice(-4),
    tradeIn: !!data.tradeIn,
    service: SERVICE,
    route: ROUTE,
  });

  try {
    await new Promise((resolve) => setTimeout(resolve, 150 + Math.random() * 200));

    const { line } = findLine(data.accountNumber, lineNumber);
    const pricing = priceInstallments(device, !!data.tradeIn);
    const agreement = bookInstallmentAgreement(line, pricing);

    const duration = Date.now() - startTime;
    incrementMetric('tmobile_upgrade.success', { route: ROUTE, market: line.market });
    recordTiming('tmobile_upgrade.latency', duration, { route: ROUTE });

    return {
      success: true,
      orderId,
      orderNumber: `TM${orderId.replace(/-/g, '').slice(0, 9).toUpperCase()}`,
      status: 'submitted',
      device: device.name,
      lineLast4: lineNumber.slice(-4),
      tradeIn: !!data.tradeIn,
      ...pricing,
      eipAgreementId: agreement.agreementId,
      eipLedgerShard: agreement.shard,
    };
  } catch (error) {
    const duration = Date.now() - startTime;

    incrementMetric('tmobile_upgrade.failure', { route: ROUTE, errorClass: error.name });
    recordTiming('tmobile_upgrade.latency', duration, { route: ROUTE, error: 'true' });

    if (error.statusCode && error.statusCode < 500) {
      logger.warn('T-Mobile device upgrade rejected', {
        orderId,
        error: error.message,
        errorClass: error.name,
        durationMs: duration,
        service: SERVICE,
      });
      throw error;
    }

    logger.error('T-Mobile device upgrade checkout failed', {
      orderId,
      error: error.message,
      errorClass: error.name,
      durationMs: duration,
      deviceSku,
      service: SERVICE,
    });

    // Deliberately not reported to Sentry: this vertical raises its own branded
    // alert and Devin session below, and a Sentry issue would fan the same 500
    // out to the generic webhook path as a second, unguarded card and session.

    const blockReason = alertBlockReason(data.demoToken);
    if (blockReason) {
      logger.warn(`Suppressing T-Mobile alert — ${blockReason}`, {
        orderId,
        client,
        service: SERVICE,
      });
      throw error;
    }

    createSessionAndAlert({
      issueTitle: `${error.name}: ${sanitizeText(error.message, 200)}`,
      issueUrl: `https://${process.env.SENTRY_ORG_SLUG || 'sentry-org'}.sentry.io/issues/?project=${process.env.SENTRY_PROJECT_ID || ''}&query=is%3Aunresolved`,
      culprit: 'app/services/verticals/tmobile.js \u2014 resolveEipLedgerShard',
      errorType: error.name || 'Error',
      errorValue: error.message,
      ...resolveDevinIdentity(data),
      service: SERVICE,
      verticalLabel: 'T-Mobile T-Life Device Upgrade (iOS)',
      promptAppendix: REMEDIATION_DIRECTIVE,
      customer: 'tmobile',
      sessionPlatform: 'macos',
      tags: [
        { key: 'route', value: ROUTE },
        { key: 'service', value: SERVICE },
        { key: 'client', value: client },
        { key: 'device', value: deviceSku },
      ],
      extra: { orderId, deviceSku, lineLast4: lineNumber.slice(-4), tradeIn: !!data.tradeIn },
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
      logger.error('Failed to create Devin session for T-Mobile upgrade error', {
        error: err.message,
        orderId,
      });
    });

    throw error;
  }
}

module.exports = {
  checkoutUpgrade,
  alerting,
  REMEDIATION_DIRECTIVE,
  MARKETS,
  EIP_LEDGER_SHARDS,
  DEVICES,
  ACCOUNTS,
};
