const logger = require('../app/telemetry/logger');
const {
  MEMBERS,
  PLAN_CONFIG,
} = require('../app/services/verticals/7c6a6ef9-members');

const PROBE_SERVICE_ID = 'specialist';

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

const { lookupCoverage, estimateVisitCost } = require('../app/services/verticals/7c6a6ef9');

function enrolledPlan(member) {
  return PLAN_CONFIG[member.enrollment.planType];
}

function row(member, path, status, effective, detail) {
  return {
    member: member.id,
    path,
    status,
    expected: member.enrollment.planType,
    effective,
    detail,
  };
}

async function auditPath(member, path) {
  const expected = enrolledPlan(member);

  try {
    if (path === 'coverage-status') {
      const result = await lookupCoverage({ email: member.email, memberId: member.id });
      if (result.planName !== expected.name || result.deductible !== expected.deductible) {
        return row(member, path, 'downgraded', result.planName, 'effective plan differs from enrollment');
      }
      return row(member, path, 'ok', member.enrollment.planType, 'probe completed');
    }

    const result = await estimateVisitCost({ memberId: member.id, serviceId: PROBE_SERVICE_ID });
    if (result.planType !== member.enrollment.planType) {
      return row(member, path, 'downgraded', result.planType, 'quoted under a plan the member is not enrolled in');
    }
    return row(member, path, 'ok', result.planType, 'probe completed');
  } catch (error) {
    return row(member, path, 'unresolved', '-', `${error.name || 'Error'}: ${error.message}`);
  }
}

async function auditMembers() {
  const results = [];
  for (const member of MEMBERS) {
    results.push(await auditPath(member, 'coverage-status'));
    results.push(await auditPath(member, 'cost-estimate'));
  }
  return results;
}

function render(results) {
  const headers = ['Member', 'Path', 'Status', 'Enrolled', 'Effective', 'Detail'];
  const lines = [
    'enGen member benefits audit',
    '',
    headers.join(' | '),
    headers.map(() => '---').join(' | '),
    ...results.map((result) => [
      result.member,
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
  const results = await auditMembers();
  process.stdout.write(render(results));
  if (results.some((result) => result.status !== 'ok')) {
    process.exitCode = 1;
  }
  return results;
}

if (require.main === module) {
  main().catch((error) => {
    process.stderr.write(`enGen member benefits audit failed: ${error.message}\n`);
    process.exitCode = 1;
  });
}

module.exports = {
  auditMembers,
  auditPath,
  render,
  main,
};
