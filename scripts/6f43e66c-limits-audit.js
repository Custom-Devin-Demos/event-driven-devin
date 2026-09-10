const logger = require('../app/telemetry/logger');
const {
  FUNDING_ACCOUNTS,
  LIMIT_PROFILES,
} = require('../app/services/verticals/6f43e66c-accounts');

const RECIPIENT_ID = 'rcp-maria';
const PROBE_AMOUNT = 1;

function installOfflineStubs() {
  const devinSessionPath = require.resolve('../app/services/devin-session');
  require.cache[devinSessionPath] = {
    id: devinSessionPath,
    filename: devinSessionPath,
    loaded: true,
    exports: {
      createSessionAndAlert: () => Promise.resolve({ triggered: false }),
    },
  };

  const { Sentry } = require('../app/telemetry/sentry');
  Sentry.captureException = () => undefined;
}

installOfflineStubs();

const { sendMoney, requestMoney } = require('../app/services/verticals/6f43e66c');

function serviceData(account, amount) {
  return {
    fromAccountId: account.id,
    recipientId: RECIPIENT_ID,
    amount,
    memo: 'Zelle limits audit',
  };
}

function expectedLimits(account) {
  return LIMIT_PROFILES[account.limits.profile];
}

function row(account, path, status, expected, effective, detail) {
  return {
    account: account.id,
    path,
    status,
    expected,
    effective,
    detail,
  };
}

async function auditPath(account, path) {
  const expected = expectedLimits(account);
  const fn = path === 'send' ? sendMoney : requestMoney;

  try {
    const result = await fn(serviceData(account, PROBE_AMOUNT));
    if (path === 'send') {
      const effectiveDailyCap = result.dailyHeadroom + PROBE_AMOUNT;
      if (effectiveDailyCap !== expected.dailyCap) {
        return row(
          account,
          path,
          'downgraded',
          expected.label,
          String(effectiveDailyCap),
          'effective daily cap differs',
        );
      }
      return row(account, path, 'ok', expected.label, String(effectiveDailyCap), 'probe completed');
    }
    if (result.limitProfile !== expected.label) {
      return row(account, path, 'downgraded', expected.label, result.limitProfile, 'effective label differs');
    }
    return row(account, path, 'ok', expected.label, result.limitProfile, 'probe completed');
  } catch (error) {
    if (path === 'request' && (error.name === 'LimitExceededError' || error.statusCode === 422)) {
      try {
        const result = await requestMoney(serviceData(account, expected.perTransactionCap));
        if (result.limitProfile !== expected.label) {
          return row(account, path, 'downgraded', expected.label, result.limitProfile, 'cap probe effective label differs');
        }
        return row(account, path, 'ok', expected.label, result.limitProfile, 'cap probe completed');
      } catch (capError) {
        return row(account, path, 'downgraded', expected.label, 'unknown', `cap probe: ${capError.message}`);
      }
    }

    const detail = `${error.name || 'Error'}: ${error.message}`;
    return row(account, path, 'unresolved', expected.label, '-', detail);
  }
}

async function auditAccounts() {
  const results = [];
  for (const account of FUNDING_ACCOUNTS) {
    results.push(await auditPath(account, 'send'));
    results.push(await auditPath(account, 'request'));
  }
  return results;
}

function render(results) {
  const headers = ['Account', 'Path', 'Status', 'Expected', 'Effective', 'Detail'];
  const lines = [
    'Zelle limit-profile audit',
    '',
    headers.join(' | '),
    headers.map(() => '---').join(' | '),
    ...results.map((result) => [
      result.account,
      result.path,
      result.status,
      result.expected,
      result.effective,
      result.detail,
    ].join(' | ')),
  ];
  return `${lines.join('\n')}\n`;
}

async function main() {
  logger.silent = true;
  const results = await auditAccounts();
  process.stdout.write(render(results));
  if (results.some((result) => result.status !== 'ok')) {
    process.exitCode = 1;
  }
  return results;
}

if (require.main === module) {
  main().catch((error) => {
    process.stderr.write(`Zelle limit-profile audit failed: ${error.message}\n`);
    process.exitCode = 1;
  });
}

module.exports = {
  auditAccounts,
  auditPath,
  render,
};
