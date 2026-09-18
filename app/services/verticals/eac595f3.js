const crypto = require('crypto');
const logger = require('../../telemetry/logger');
const { incrementMetric } = require('../../telemetry/datadog');
const jira = require('../jira');
const servicenow = require('../servicenow');
const { createDevinSession } = require('../devin-api');
const { getCustomerConfig } = require('../../../config/customers');

/**
 * Cigna — Release Gate (slug eac595f3).
 *
 * Event: a build is submitted for release. The gate pulls the build manifest,
 * reads every linked Jira work item live from cog-gtm.atlassian.net, checks the
 * test evidence and the CAB metadata, and returns READY or BLOCKED.
 *
 *   BLOCKED → comment on the Jira story with the exact missing requirements,
 *             transition it back to "In Progress", assign the owning developer
 *             (Jira emails them natively — no Slack).
 *   READY   → create a ServiceNow change_request carrying the evidence, then
 *             comment the CHG number back on the Jira story.
 *
 * XL Release is mocked: a READY build is marked "handed to XL Release" with a
 * synthetic pipeline id.
 */
const CUSTOMER = 'eac595f3';
const SERVICE = 'cigna-release-gate';
const JIRA_APPROVED_STATUSES = ['done'];
const JIRA_BLOCKED_STATUS = 'In Progress';
const SN_ASSIGNMENT_GROUP = process.env.SERVICENOW_CHANGE_GROUP_EAC595F3 || '';

// Demo builds. Jira keys are real stories in the COG-GTM MBA project seeded
// with the label `cigna-release-gate`.
const BUILDS = {
  'claims-adjudication-svc@4.12.0': {
    id: 'claims-adjudication-svc@4.12.0',
    service: 'claims-adjudication-svc',
    version: '4.12.0',
    commit: '9f3c1e2',
    owner: { name: 'Priya Natarajan', email: 'priya.natarajan@cigna.example' },
    jiraKeys: ['MBA-2552'],
    tests: { suite: 'CLM-REG-118', passed: 1284, failed: 0, coverage: 87.4 },
    metadata: {
      changeWindow: '2026-09-20 02:00–04:00 ET',
      rollbackPlan: 'Redeploy 4.11.3 via Helm rollback; feature flag tiered_coinsurance=off',
      riskRating: 'Medium',
      qaSignoff: 'A. Whitfield (QA Lead) — 2026-09-17',
    },
  },
  'member-portal-web@7.3.1': {
    id: 'member-portal-web@7.3.1',
    service: 'member-portal-web',
    version: '7.3.1',
    commit: 'b71d0aa',
    owner: { name: 'Marcus Reyes', email: 'marcus.reyes@cigna.example' },
    jiraKeys: ['MBA-2553'],
    tests: { suite: 'MPW-E2E-42', passed: 611, failed: 0, coverage: 81.0 },
    metadata: {
      changeWindow: '2026-09-20 02:00–04:00 ET',
      rollbackPlan: 'Revert CDN release; previous bundle retained 14 days',
      riskRating: 'Low',
      qaSignoff: '',
    },
  },
  'pharmacy-benefits-api@2.8.0': {
    id: 'pharmacy-benefits-api@2.8.0',
    service: 'pharmacy-benefits-api',
    version: '2.8.0',
    commit: '4c88e01',
    owner: { name: 'Dana Okonkwo', email: 'dana.okonkwo@cigna.example' },
    jiraKeys: ['MBA-2554'],
    tests: { suite: 'PBM-REG-27', passed: 942, failed: 0, coverage: 90.2 },
    metadata: {
      changeWindow: '2026-09-21 01:00–03:00 ET',
      rollbackPlan: '',
      riskRating: 'High',
      qaSignoff: 'J. Lindqvist (QA) — 2026-09-16',
    },
  },
  'eligibility-batch@11.0.2': {
    id: 'eligibility-batch@11.0.2',
    service: 'eligibility-batch',
    version: '11.0.2',
    commit: 'e2a7f90',
    owner: { name: 'Tom Achterberg', email: 'tom.achterberg@cigna.example' },
    jiraKeys: ['MBA-2555'],
    tests: { suite: 'ELG-REG-9', passed: 402, failed: 3, coverage: 78.9 },
    metadata: {
      changeWindow: '2026-09-21 01:00–03:00 ET',
      rollbackPlan: 'Re-run prior image 11.0.1 with --replay-from-checkpoint',
      riskRating: 'Medium',
      qaSignoff: 'R. Bhatt (QA) — 2026-09-17',
    },
  },
};

// Mutable demo state: per-build gate status + audit log (newest first).
const STATE = {};
const AUDIT = [];
const MAX_AUDIT = 200;

function resetState() {
  for (const id of Object.keys(BUILDS)) {
    STATE[id] = { status: 'queued', lastRun: null };
  }
  AUDIT.length = 0;
}
resetState();

function audit(entry) {
  const row = { id: crypto.randomUUID(), at: new Date().toISOString(), ...entry };
  AUDIT.unshift(row);
  if (AUDIT.length > MAX_AUDIT) AUDIT.length = MAX_AUDIT;
  logger.info('Release gate audit', row);
  return row;
}

/* --------------------------------------------------------------------------
 * Checks — pure functions over (build, jiraIssues)
 * ------------------------------------------------------------------------ */

function checkJira(build, issues) {
  const checks = [];
  if (!build.jiraKeys.length) {
    checks.push({
      id: 'jira.linked',
      label: 'Linked Jira work item',
      pass: false,
      detail: 'No Jira work item is linked to this build.',
      remediation: 'Link the delivering story to the build manifest.',
    });
    return checks;
  }
  for (const key of build.jiraKeys) {
    const issue = issues[key];
    if (!issue) {
      checks.push({
        id: `jira.${key}.exists`,
        label: `${key} resolvable in Jira`,
        pass: false,
        detail: `${key} could not be read from Jira.`,
        remediation: `Confirm ${key} exists and the release-gate account can read it.`,
      });
      continue;
    }
    const approved = JIRA_APPROVED_STATUSES.includes(issue.status.toLowerCase());
    checks.push({
      id: `jira.${key}.approved`,
      label: `${key} approved (status Done)`,
      pass: approved,
      detail: `${key} is "${issue.status}"${issue.assignee ? ` · assignee ${issue.assignee.displayName}` : ''}.`,
      remediation: approved ? '' : `Move ${key} to Done once product/QA approval is recorded.`,
      url: issue.url,
    });
  }
  return checks;
}

function checkTests(build) {
  const t = build.tests;
  const pass = t.failed === 0 && t.passed > 0;
  return [{
    id: 'tests.regression',
    label: `Regression suite ${t.suite} green`,
    pass,
    detail: `${t.passed} passed, ${t.failed} failed · coverage ${t.coverage}%`,
    remediation: pass ? '' : `Fix or re-run the ${t.failed} failing test(s) in ${t.suite} and attach the green run.`,
  }, {
    id: 'tests.coverage',
    label: 'Line coverage ≥ 75%',
    pass: t.coverage >= 75,
    detail: `${t.coverage}%`,
    remediation: t.coverage >= 75 ? '' : 'Raise coverage to at least 75%.',
  }];
}

function checkMetadata(build) {
  const m = build.metadata;
  return [{
    id: 'meta.qaSignoff',
    label: 'QA sign-off recorded',
    pass: Boolean(m.qaSignoff),
    detail: m.qaSignoff || 'none',
    remediation: m.qaSignoff ? '' : 'Record QA sign-off (name + date) on the build.',
  }, {
    id: 'meta.rollbackPlan',
    label: 'Rollback plan present',
    pass: Boolean(m.rollbackPlan),
    detail: m.rollbackPlan || 'none',
    remediation: m.rollbackPlan ? '' : 'Add a rollback plan to the release metadata.',
  }, {
    id: 'meta.changeWindow',
    label: 'Change window scheduled',
    pass: Boolean(m.changeWindow),
    detail: m.changeWindow || 'none',
    remediation: m.changeWindow ? '' : 'Schedule the change window with CAB.',
  }, {
    id: 'meta.riskRating',
    label: 'Risk rating set',
    pass: Boolean(m.riskRating),
    detail: m.riskRating || 'none',
    remediation: m.riskRating ? '' : 'Set the risk rating.',
  }];
}

function evaluateBuild(build, issues) {
  const checks = [...checkJira(build, issues), ...checkTests(build), ...checkMetadata(build)];
  const failures = checks.filter((c) => !c.pass);
  return {
    verdict: failures.length ? 'BLOCKED' : 'READY',
    checks,
    failures,
  };
}

/* --------------------------------------------------------------------------
 * Side effects — Jira, ServiceNow, (optional) Devin
 * ------------------------------------------------------------------------ */

async function fetchIssues(build) {
  const issues = {};
  if (!jira.isConfigured()) return issues;
  await Promise.all(build.jiraKeys.map(async (key) => {
    try {
      issues[key] = await jira.getIssue(key);
    } catch (error) {
      logger.warn('Release gate could not read Jira issue', { key, error: error.message });
    }
  }));
  return issues;
}

function blockedComment(build, failures, runId) {
  const lines = [
    `Release gate: BLOCKED — ${build.service} ${build.version} (commit ${build.commit})`,
    '',
    `${failures.length} requirement(s) missing before this build can enter change creation:`,
    ...failures.map((f, i) => `${i + 1}. ${f.label} — ${f.detail}\n   Fix: ${f.remediation}`),
    '',
    `Owner: ${build.owner.name} <${build.owner.email}>. Resubmit the build once corrected; the gate re-runs automatically.`,
    `Gate run ${runId} · Devin Release Gate for Cigna Release Management`,
  ];
  return lines.join('\n');
}

function readyComment(build, change, pipelineId, runId) {
  return [
    `Release gate: READY — ${build.service} ${build.version} (commit ${build.commit})`,
    '',
    'All Jira, test-evidence and CAB metadata checks passed.',
    change
      ? `ServiceNow change ${change.number} created: ${change.url}`
      : 'ServiceNow change creation skipped (ServiceNow not configured).',
    `Handed to XL Release pipeline ${pipelineId}.`,
    `Gate run ${runId} · Devin Release Gate for Cigna Release Management`,
  ].join('\n');
}

function changeDescription(build, checks, issues) {
  const evidence = checks.map((c) => `[${c.pass ? 'PASS' : 'FAIL'}] ${c.label}: ${c.detail}`).join('\n');
  const stories = build.jiraKeys.map((k) => (issues[k] ? `${k} — ${issues[k].summary} (${issues[k].url})` : k)).join('\n');
  return [
    `Automated release-gate evidence for ${build.service} ${build.version} (commit ${build.commit}).`,
    '',
    'Linked work items:',
    stories,
    '',
    'Gate checks:',
    evidence,
    '',
    `Owner: ${build.owner.name} <${build.owner.email}>`,
    `Regression suite: ${build.tests.suite}`,
    `QA sign-off: ${build.metadata.qaSignoff}`,
  ].join('\n');
}

async function notifyBlocked(build, failures, issues, runId) {
  const actions = [];
  if (!jira.isConfigured()) {
    actions.push({ system: 'jira', action: 'skipped', detail: 'Jira not configured' });
    return actions;
  }
  for (const key of build.jiraKeys) {
    const issue = issues[key];
    if (!issue) continue;
    try {
      const comment = await jira.addComment(key, blockedComment(build, failures, runId));
      actions.push({ system: 'jira', action: 'comment', target: key, url: comment.url });
    } catch (error) {
      actions.push({ system: 'jira', action: 'comment-failed', target: key, detail: error.message });
    }
    if (JIRA_APPROVED_STATUSES.includes(issue.status.toLowerCase())) {
      // Story is approved but another requirement is missing — pull it back so
      // the board reflects that work remains.
      try {
        const moved = await jira.transitionTo(key, JIRA_BLOCKED_STATUS);
        if (moved) actions.push({ system: 'jira', action: 'transition', target: key, detail: `→ ${JIRA_BLOCKED_STATUS}` });
      } catch (error) {
        actions.push({ system: 'jira', action: 'transition-failed', target: key, detail: error.message });
      }
    }
    // Owning developer = the story's assignee when present, otherwise the
    // reporter. Jira emails the assignee on comment + assignment.
    const owner = issue.assignee || issue.reporter;
    if (owner && !issue.assignee) {
      try {
        await jira.assign(key, owner.accountId);
        actions.push({ system: 'jira', action: 'assign', target: key, detail: owner.displayName });
      } catch (error) {
        actions.push({ system: 'jira', action: 'assign-failed', target: key, detail: error.message });
      }
    } else if (owner) {
      actions.push({ system: 'jira', action: 'notify', target: key, detail: `${owner.displayName} notified via Jira` });
    }
  }
  return actions;
}

async function promoteReady(build, checks, issues, runId) {
  const actions = [];
  let change = null;
  if (servicenow.isConfigured()) {
    change = await servicenow.createChangeRequest({
      shortDescription: `${build.service} ${build.version} — release (gate ${runId.slice(0, 8)})`,
      description: changeDescription(build, checks, issues),
      type: 'normal',
      risk: build.metadata.riskRating === 'High' ? '2' : build.metadata.riskRating === 'Medium' ? '3' : '4',
      assignmentGroup: SN_ASSIGNMENT_GROUP,
      justification: build.jiraKeys.map((k) => (issues[k] ? `${k}: ${issues[k].summary}` : k)).join('; '),
      implementationPlan: `Deploy ${build.service} ${build.version} (commit ${build.commit}) via XL Release during ${build.metadata.changeWindow}.`,
      backoutPlan: build.metadata.rollbackPlan,
      testPlan: `${build.tests.suite}: ${build.tests.passed} passed / ${build.tests.failed} failed, coverage ${build.tests.coverage}%. QA sign-off: ${build.metadata.qaSignoff}.`,
      correlationId: runId,
      correlationDisplay: SERVICE,
    });
    if (change) {
      actions.push({ system: 'servicenow', action: 'change-created', target: change.number, url: change.url });
      await servicenow.addChangeWorkNote(
        change.sysId,
        `Created automatically by Devin Release Gate. Linked Jira: ${build.jiraKeys.map(jira.issueUrl).join(', ')}`,
      );
    } else {
      actions.push({ system: 'servicenow', action: 'change-failed', detail: 'ServiceNow rejected the change request' });
    }
  } else {
    actions.push({ system: 'servicenow', action: 'skipped', detail: 'ServiceNow not configured' });
  }

  const pipelineId = `XLR-${build.service.toUpperCase().slice(0, 6)}-${crypto.randomInt(10000, 99999)}`;
  actions.push({ system: 'xl-release', action: 'handoff', target: pipelineId, detail: 'mocked' });

  if (jira.isConfigured()) {
    for (const key of build.jiraKeys) {
      if (!issues[key]) continue;
      try {
        const comment = await jira.addComment(key, readyComment(build, change, pipelineId, runId));
        actions.push({ system: 'jira', action: 'comment', target: key, url: comment.url });
      } catch (error) {
        actions.push({ system: 'jira', action: 'comment-failed', target: key, detail: error.message });
      }
    }
  }
  return { actions, change, pipelineId };
}

function buildDevinPrompt(build, failures, issues) {
  const story = build.jiraKeys.map((k) => (issues[k] ? `${k} (${issues[k].url})` : k)).join(', ');
  return [
    `Release gate BLOCKED for ${build.service} ${build.version} (commit ${build.commit}) in Cigna Release Management.`,
    '',
    'Missing requirements:',
    ...failures.map((f) => `- ${f.label}: ${f.detail}. Fix: ${f.remediation}`),
    '',
    `Linked Jira: ${story}. Owner: ${build.owner.name}.`,
    'Work with the owning developer to close each gap. Where the gap is evidence or metadata, gather it and attach it to the Jira story;',
    'where it is a code or test failure, investigate the failing tests in the service repository and open a fix PR. Do not merge.',
    'When every gap is closed, comment on the Jira story that the build is ready to be resubmitted to the release gate.',
  ].join('\n');
}

async function maybeTriggerDevin({ build, failures, issues, devinUserId, devinOrgId }) {
  const config = getCustomerConfig(CUSTOMER);
  if (!config.apiKey) return null;
  try {
    return await createDevinSession(buildDevinPrompt(build, failures, issues), {
      apiKey: config.apiKey,
      userId: devinUserId || config.devinUserId,
      orgId: devinOrgId || config.devinOrgId,
      title: `Release gate BLOCKED — ${build.service} ${build.version}`,
    });
  } catch (error) {
    logger.warn('Release gate could not create Devin session', { error: error.message });
    return null;
  }
}

/* --------------------------------------------------------------------------
 * Public API
 * ------------------------------------------------------------------------ */

function listBuilds() {
  return Object.values(BUILDS).map((b) => ({ ...b, gate: STATE[b.id] }));
}

function getAudit() {
  return AUDIT;
}

async function submitBuild({ buildId, devinUserId, devinOrgId, triggerDevin = false }) {
  const build = BUILDS[buildId];
  if (!build) {
    const error = new Error(`Unknown build: ${buildId}`);
    error.status = 404;
    throw error;
  }
  const runId = crypto.randomUUID();
  const startedAt = Date.now();
  STATE[build.id] = { ...STATE[build.id], status: 'evaluating' };
  audit({ runId, buildId: build.id, event: 'build.submitted', detail: `${build.service} ${build.version}` });
  incrementMetric('release_gate.submitted', [`service:${build.service}`]);

  const issues = await fetchIssues(build);
  const evaluation = evaluateBuild(build, issues);

  let actions;
  let change = null;
  let pipelineId = null;
  let devinSession = null;

  if (evaluation.verdict === 'BLOCKED') {
    actions = await notifyBlocked(build, evaluation.failures, issues, runId);
    if (triggerDevin) {
      devinSession = await maybeTriggerDevin({ build, failures: evaluation.failures, issues, devinUserId, devinOrgId });
      if (devinSession) actions.push({ system: 'devin', action: 'session', target: devinSession.sessionId, url: devinSession.url });
    }
  } else {
    ({ actions, change, pipelineId } = await promoteReady(build, evaluation.checks, issues, runId));
  }

  const result = {
    runId,
    buildId: build.id,
    verdict: evaluation.verdict,
    durationMs: Date.now() - startedAt,
    checks: evaluation.checks,
    failures: evaluation.failures,
    actions,
    change,
    pipelineId,
    devinSession,
    jira: Object.values(issues),
    at: new Date().toISOString(),
  };

  STATE[build.id] = {
    status: evaluation.verdict === 'READY' ? 'ready' : 'blocked',
    lastRun: result,
  };
  audit({
    runId,
    buildId: build.id,
    event: `gate.${evaluation.verdict.toLowerCase()}`,
    detail: evaluation.verdict === 'READY'
      ? `${change ? change.number : 'no CHG'} · ${pipelineId}`
      : evaluation.failures.map((f) => f.label).join('; '),
    actions,
  });
  incrementMetric(`release_gate.${evaluation.verdict.toLowerCase()}`, [`service:${build.service}`]);
  return result;
}

/**
 * Demo helper: the developer "fixes" the gap. Applies the correction the gate
 * asked for — approving the Jira story live, adding the rollback plan, or
 * re-running the failing suite — so the build can be resubmitted.
 */
async function remediateBuild(buildId) {
  const build = BUILDS[buildId];
  if (!build) {
    const error = new Error(`Unknown build: ${buildId}`);
    error.status = 404;
    throw error;
  }
  const applied = [];
  if (!build.metadata.qaSignoff) {
    build.metadata.qaSignoff = `A. Whitfield (QA Lead) — ${new Date().toISOString().slice(0, 10)}`;
    applied.push('QA sign-off recorded');
  }
  if (!build.metadata.rollbackPlan) {
    build.metadata.rollbackPlan = `Redeploy previous ${build.service} image; disable feature flag`;
    applied.push('Rollback plan added');
  }
  if (build.tests.failed > 0) {
    build.tests.passed += build.tests.failed;
    build.tests.failed = 0;
    applied.push(`Regression suite ${build.tests.suite} re-run green`);
  }
  if (jira.isConfigured()) {
    for (const key of build.jiraKeys) {
      try {
        const issue = await jira.getIssue(key);
        if (!JIRA_APPROVED_STATUSES.includes(issue.status.toLowerCase())) {
          if (await jira.transitionTo(key, 'Done')) applied.push(`${key} approved (→ Done)`);
        }
      } catch (error) {
        logger.warn('Release gate remediation could not update Jira', { key, error: error.message });
      }
    }
  }
  STATE[build.id] = { ...STATE[build.id], status: 'corrected' };
  audit({ buildId: build.id, event: 'build.corrected', detail: applied.join('; ') || 'nothing to correct' });
  return { buildId: build.id, applied };
}

// Jira status each seeded story starts the demo in.
const JIRA_SEED_STATUS = {
  'MBA-2552': 'Done',
  'MBA-2553': 'In Progress',
  'MBA-2554': 'Done',
  'MBA-2555': 'Done',
};

async function resetDemo() {
  BUILDS['member-portal-web@7.3.1'].metadata.qaSignoff = '';
  BUILDS['pharmacy-benefits-api@2.8.0'].metadata.rollbackPlan = '';
  BUILDS['eligibility-batch@11.0.2'].tests.passed = 402;
  BUILDS['eligibility-batch@11.0.2'].tests.failed = 3;
  resetState();
  const jiraReset = [];
  if (jira.isConfigured()) {
    for (const [key, status] of Object.entries(JIRA_SEED_STATUS)) {
      try {
        const issue = await jira.getIssue(key);
        if (issue.status.toLowerCase() !== status.toLowerCase() && await jira.transitionTo(key, status)) {
          jiraReset.push(`${key} → ${status}`);
        }
      } catch (error) {
        logger.warn('Release gate reset could not update Jira', { key, error: error.message });
      }
    }
  }
  return { jiraReset };
}

module.exports = {
  CUSTOMER,
  SERVICE,
  BUILDS,
  evaluateBuild,
  listBuilds,
  getAudit,
  submitBuild,
  remediateBuild,
  resetDemo,
  integrations: () => ({ jira: jira.isConfigured(), servicenow: servicenow.isConfigured(), jiraBaseUrl: jira.getBaseUrl() }),
};
