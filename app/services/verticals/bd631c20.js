const { v4: uuidv4 } = require('uuid');
const logger = require('../../telemetry/logger');
const { incrementMetric, recordTiming } = require('../../telemetry/datadog');
const { Sentry } = require('../../telemetry/sentry');
const { createSessionAndAlert } = require('../devin-session');
const { listOrgUsers, listEnterpriseAdmins } = require('../devin-api');
const { getCustomerConfig } = require('../../../config/customers');

const CLUSTERS = {
  'bmq-prod-east': {
    clusterId: 'bmq-prod-east',
    label: 'bmq-prod-east',
    region: 'us-east-1',
    nodes: 5,
    primaryNodeId: 'node-2',
  },
};

const QUEUES = {
  'bmq://bmq.prod.east/market-data.ticks': {
    queueUri: 'bmq://bmq.prod.east/market-data.ticks',
    domain: 'bmq.prod.east',
    name: 'market-data.ticks',
    mode: 'fanout',
    partitions: 4,
    storageTier: 'nvme_tiered_2026',
    storageTierLabel: 'NVMe Tiered (2026)',
    consumers: 18,
    backlogBytes: 412_339_712,
    producerRateMsgsSec: 84_500,
  },
  'bmq://bmq.prod.east/reference-data.updates': {
    queueUri: 'bmq://bmq.prod.east/reference-data.updates',
    domain: 'bmq.prod.east',
    name: 'reference-data.updates',
    mode: 'priority',
    partitions: 2,
    storageTier: 'standard_ssd',
    storageTierLabel: 'Standard SSD',
    consumers: 6,
    backlogBytes: 18_874_368,
    producerRateMsgsSec: 2_140,
  },
  'bmq://bmq.prod.east/trade-capture.events': {
    queueUri: 'bmq://bmq.prod.east/trade-capture.events',
    domain: 'bmq.prod.east',
    name: 'trade-capture.events',
    mode: 'broadcast',
    partitions: 3,
    storageTier: 'spinning_archive',
    storageTierLabel: 'Archive HDD',
    consumers: 11,
    backlogBytes: 96_468_992,
    producerRateMsgsSec: 9_780,
  },
};

const STORAGE_POLICIES = {
  // nvme_tiered_2026 joined the storage-tier catalogue with the Q3 2026 NVMe rollout; policy registration pending
  standard_ssd: {
    label: 'Standard SSD',
    maxUnconfirmedBytes: 268_435_456,
    maxUnconfirmedMessages: 500_000,
    bytesPerPartitionCap: 1_073_741_824,
    rebalanceQueue: 'storage-standard',
  },
  spinning_archive: {
    label: 'Archive HDD',
    maxUnconfirmedBytes: 1_073_741_824,
    maxUnconfirmedMessages: 2_000_000,
    bytesPerPartitionCap: 8_589_934_592,
    rebalanceQueue: 'storage-archive',
  },
};

const BLOOMBERG_SLACK_MEMBER_ID = process.env.BLOOMBERG_SLACK_MEMBER_ID || 'U0BU46F4WCU';
const BLOOMBERG_DEVIN_USER_ID = process.env.DEVIN_USER_ID_BD631C20
  || 'user-5e154bb05983499ba384fbeadd3f4478';

if (process.env.BLOOMBERG_SLACK_MEMBER_ID && !process.env.DEVIN_USER_ID_BD631C20) {
  logger.warn(
    'BLOOMBERG_SLACK_MEMBER_ID is set without DEVIN_USER_ID_BD631C20 — the bd631c20 alert '
    + 'and its Devin session will name different owners',
  );
}

const SENTRY_ISSUE_QUERY = 'is:unresolved maxUnconfirmedBytes';

/**
 * Scenario directive appended to the Devin investigation prompt.
 *
 * The alert pipeline passes only a prompt to the Devin API, so the repository
 * to remediate has to be named explicitly here.
 */
const REMEDIATION_DIRECTIVE = `Repository: COG-GTM/event-driven-devin. Scope: only the BlazingMQ cluster operations partition-rebalance failure below. This repository hosts many independent demo verticals, each with its own intentional bug and its own Sentry issues. Ignore every issue that is not from POST /api/bd631c20/rebalance, do not investigate or modify any other vertical, and do not widen the Sentry or Datadog search beyond this route. The failing surface is the BlazingMQ Cluster Operations console at app/public/verticals/bd631c20.html (page routes GET /bd631c20 and GET /bloomberg), whose "Apply rebalance" action posts to POST /api/bd631c20/rebalance in app/routes/verticals/bd631c20.js. The rebalance planning pipeline lives in app/services/verticals/bd631c20.js: applyRebalance -> planPartitionRebalance -> resolveStoragePolicy. Start at resolveStoragePolicy: it looks up STORAGE_POLICIES by the queue's storage tier, and the nvme_tiered_2026 tier joined the storage-tier catalogue with the Q3 2026 NVMe rollout without a registered storage policy, so the lookup returns undefined and planPartitionRebalance dereferences it while computing the per-partition unconfirmed-bytes budget. Register the missing tier's storage policy and make the lookup fail as a handled cluster-operations error routed to the appropriate rebalance queue instead of a TypeError. Do not change the page's look and feel, and do not touch any other vertical. Verify by starting the server (node app/server.js) and POSTing the default rebalance to /api/bd631c20/rebalance, which must return a successful rebalance plan, and confirm npm run lint passes.

Verification evidence is mandatory and must be visual, not curl-only: with the server running, open the /bloomberg page in a real browser, apply the pre-selected rebalance for the market-data.ticks queue, and record your screen for the whole submission so the recording shows the console, the click, and the successful rebalance plan that replaces the previous TypeError panel. Attach a screenshot of that successful rebalance plan and an animated webp of the recording to the pull request under a "Fix Verification" heading, and post the same evidence as a comment on the PR. Do not report the fix as complete, and do not leave the PR description saying verification is pending, until that browser evidence is attached.`;

/**
 * Resolve the Devin user behind an email the page supplied, so the session is
 * created as the same person the Slack card @-mentions. Returns '' when nobody
 * matches, in which case the caller drops the email and uses the configured
 * owner on both sides rather than splitting ownership.
 */
async function resolveUserIdByEmail(email, orgId) {
  const normalized = String(email || '').trim().toLowerCase();
  if (!normalized || !orgId) return '';
  try {
    const { apiKey } = getCustomerConfig('bd631c20');
    const auth = apiKey ? { apiKey } : {};
    const members = await listOrgUsers(orgId, auth);
    const member = members.find((u) => (u.email || '').toLowerCase() === normalized);
    if (member) return member.user_id;
    const admins = await listEnterpriseAdmins(auth);
    const admin = admins.find((u) => (u.email || '').toLowerCase() === normalized);
    if (admin) return admin.user_id;
    logger.warn('BlazingMQ rebalance reporter email not found in org', { orgId });
  } catch (err) {
    logger.warn('BlazingMQ rebalance reporter lookup failed', { error: err.message, orgId });
  }
  return '';
}

function resolveStoragePolicy(queue) {
  return STORAGE_POLICIES[queue.storageTier];
}

function assignRebalanceQueue(policy) {
  return policy.rebalanceQueue;
}

function validationError(message) {
  const error = new Error(message);
  error.name = 'ValidationError';
  error.code = 'INVALID_REBALANCE';
  error.statusCode = 400;
  return error;
}

function planPartitionRebalance(queue, request) {
  const policy = resolveStoragePolicy(queue);
  const maxUnconfirmedBytes = policy.maxUnconfirmedBytes;
  const targetPartitions = request.targetPartitions;

  if (targetPartitions === queue.partitions) {
    throw validationError(
      `Queue ${queue.name} already has ${queue.partitions} partitions — nothing to rebalance`,
    );
  }

  const perPartitionBudget = Math.floor(maxUnconfirmedBytes / targetPartitions);
  const projectedBacklogPerPartition = Math.floor(queue.backlogBytes / targetPartitions);

  if (projectedBacklogPerPartition > policy.bytesPerPartitionCap) {
    throw validationError(
      `Projected backlog of ${projectedBacklogPerPartition} bytes per partition exceeds the `
      + `${policy.label} per-partition cap of ${policy.bytesPerPartitionCap} bytes`,
    );
  }

  return {
    policy,
    maxUnconfirmedBytes,
    maxUnconfirmedMessages: policy.maxUnconfirmedMessages,
    perPartitionBudget,
    projectedBacklogPerPartition,
    partitionsMoved: Math.abs(targetPartitions - queue.partitions),
    rebalanceQueue: assignRebalanceQueue(policy),
  };
}

function makePlanId() {
  const digits = uuidv4().replace(/\D/g, '').slice(0, 8).padEnd(8, '0');
  return `BMQ-RBL-${digits}`;
}

async function applyRebalance(data) {
  const startTime = Date.now();
  const planId = makePlanId();
  const clusterId = data.clusterId;
  const queueUri = data.queueUri;
  const cluster = CLUSTERS[clusterId];
  const queue = QUEUES[queueUri];
  const targetPartitions = Number(data.targetPartitions);

  if (!clusterId || !String(clusterId).trim() || !cluster) {
    throw validationError(`Unknown cluster: ${clusterId || '(none)'}`);
  }
  if (!queueUri || !String(queueUri).trim() || !queue) {
    throw validationError(`Unknown queue URI: ${queueUri || '(none)'}`);
  }
  if (!Number.isInteger(targetPartitions) || targetPartitions < 1 || targetPartitions > 64) {
    throw validationError('Target partitions must be an integer between 1 and 64');
  }

  logger.info('Applying BlazingMQ partition rebalance', {
    planId,
    clusterId,
    queueUri,
    targetPartitions,
    service: 'customer-bloomberg-bmq-rebalance',
    route: '/api/bd631c20/rebalance',
  });

  try {
    const plan = planPartitionRebalance(queue, { targetPartitions });
    const appliedAt = new Date().toISOString();
    const duration = Date.now() - startTime;

    incrementMetric('bloomberg_bmq_rebalance.success', {
      route: '/api/bd631c20/rebalance',
      storageTier: queue.storageTier,
      clusterId,
    });
    recordTiming('bloomberg_bmq_rebalance.latency', duration, {
      route: '/api/bd631c20/rebalance',
    });

    return {
      success: true,
      status: 'applied',
      planId,
      clusterId,
      clusterLabel: cluster.label,
      primaryNodeId: cluster.primaryNodeId,
      queueUri,
      queueName: queue.name,
      mode: queue.mode,
      storageTier: queue.storageTier,
      storageTierLabel: queue.storageTierLabel,
      currentPartitions: queue.partitions,
      targetPartitions,
      partitionsMoved: plan.partitionsMoved,
      maxUnconfirmedBytes: plan.maxUnconfirmedBytes,
      maxUnconfirmedMessages: plan.maxUnconfirmedMessages,
      perPartitionBudget: plan.perPartitionBudget,
      projectedBacklogPerPartition: plan.projectedBacklogPerPartition,
      rebalanceQueue: plan.rebalanceQueue,
      appliedAt,
    };
  } catch (error) {
    const duration = Date.now() - startTime;

    incrementMetric('bloomberg_bmq_rebalance.failure', {
      route: '/api/bd631c20/rebalance',
      errorClass: error.name,
      storageTier: queue.storageTier,
      clusterId,
    });
    recordTiming('bloomberg_bmq_rebalance.latency', duration, {
      route: '/api/bd631c20/rebalance',
      error: 'true',
    });

    if (error.name === 'ValidationError') {
      throw error;
    }

    logger.error('BlazingMQ partition rebalance failed', {
      planId,
      clusterId,
      queueUri,
      targetPartitions,
      error: error.message,
      errorClass: error.name,
      durationMs: duration,
      service: 'customer-bloomberg-bmq-rebalance',
    });

    Sentry.captureException(error, {
      tags: {
        route: '/api/bd631c20/rebalance',
        service: 'customer-bloomberg-bmq-rebalance',
        storageTier: queue.storageTier,
        clusterId,
        alert_path: 'instant',
      },
      extra: {
        planId,
        queueUri,
        queueMode: queue.mode,
        currentPartitions: queue.partitions,
        targetPartitions,
        backlogBytes: queue.backlogBytes,
      },
    });

    const raiseAlert = (owner) => createSessionAndAlert({
      issueTitle: `${error.name}: ${error.message}`,
      issueUrl: `https://${process.env.SENTRY_ORG_SLUG || 'sentry-org'}.sentry.io/issues/?project=${process.env.SENTRY_PROJECT_ID || ''}&query=${encodeURIComponent(SENTRY_ISSUE_QUERY)}`,
      culprit: 'app/services/verticals/bd631c20.js — planPartitionRebalance',
      errorType: error.name || 'Error',
      errorValue: error.message,
      service: 'customer-bloomberg-bmq-rebalance',
      verticalLabel: 'BlazingMQ Cluster Operations — Partition Rebalance',
      customer: 'bd631c20',
      slackMemberId: owner.devinEmail ? '' : BLOOMBERG_SLACK_MEMBER_ID,
      slackMemberIdFallback: BLOOMBERG_SLACK_MEMBER_ID,
      devinUserId: owner.devinUserId,
      devinEmail: owner.devinEmail,
      devinOrgId: data.devinOrgId,
      promptAppendix: REMEDIATION_DIRECTIVE,
      tags: [
        { key: 'route', value: '/api/bd631c20/rebalance' },
        { key: 'service', value: 'customer-bloomberg-bmq-rebalance' },
        { key: 'storageTier', value: queue.storageTier },
        { key: 'clusterId', value: clusterId },
        { key: 'queueMode', value: queue.mode },
      ],
      extra: {
        planId,
        queueUri,
        currentPartitions: queue.partitions,
        targetPartitions,
        backlogBytes: queue.backlogBytes,
      },
      level: 'error',
      platform: 'node',
      firstSeen: '',
      lastSeen: new Date().toISOString(),
      count: '',
      shortId: '',
      project: 'event-driven-devin',
      release: 'customer-bloomberg-bmq-rebalance@1.0.0',
      environment: process.env.DD_ENV || 'prod',
      triggeredRule: '',
    });

    const configuredOwner = { devinUserId: BLOOMBERG_DEVIN_USER_ID, devinEmail: '' };
    const needsLookup = !data.devinUserId && data.devinEmail && data.devinOrgId;

    (needsLookup
      ? resolveUserIdByEmail(data.devinEmail, data.devinOrgId).then((userId) => (userId
        ? raiseAlert({ devinUserId: userId, devinEmail: data.devinEmail })
        : raiseAlert(configuredOwner)))
      : raiseAlert(data.devinUserId
        ? { devinUserId: data.devinUserId, devinEmail: data.devinEmail }
        : configuredOwner)
    ).catch((alertError) => {
      logger.error('Failed to create Devin session for BlazingMQ rebalance error', {
        planId,
        error: alertError.message,
      });
    });

    throw error;
  }
}

module.exports = {
  applyRebalance,
  planPartitionRebalance,
  resolveStoragePolicy,
  assignRebalanceQueue,
  CLUSTERS,
  QUEUES,
  STORAGE_POLICIES,
  REMEDIATION_DIRECTIVE,
};
