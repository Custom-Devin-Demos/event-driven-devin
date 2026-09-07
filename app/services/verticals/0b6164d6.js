const { v4: uuidv4 } = require('uuid');
const logger = require('../../telemetry/logger');
const { incrementMetric, recordTiming } = require('../../telemetry/datadog');
const { Sentry } = require('../../telemetry/sentry');
const { createSessionAndAlert } = require('../devin-session');

/**
 * Worker node types offered by the workspace's compute policy, with the
 * per-instance shape the Spark UI sizes executors against.
 *
 * NOTE: `i4i.4xlarge` was added to the Photon-enabled pool in the FY26 compute
 * policy refresh; its instance shape was expected to be registered alongside it.
 */
const NODE_TYPE_SPECS = {
  'm5d.2xlarge': {
    label: 'm5d.2xlarge',
    vcpus: 8,
    memoryGb: 32,
    localDiskGb: 300,
    dbuPerHour: 1.5,
  },
  'r5d.xlarge': {
    label: 'r5d.xlarge',
    vcpus: 4,
    memoryGb: 32,
    localDiskGb: 150,
    dbuPerHour: 1.2,
  },
  'g4dn.xlarge': {
    label: 'g4dn.xlarge',
    vcpus: 4,
    memoryGb: 16,
    localDiskGb: 125,
    dbuPerHour: 0.9,
  },
};

/**
 * Clusters shown on the workspace Compute page. `nodeTypeId` is what the Spark
 * cluster UI resolves an instance shape from when it renders the executor table.
 */
const CLUSTERS = [
  {
    id: '0731-204512-photon7',
    name: 'prod-etl-photon',
    state: 'RUNNING',
    creator: 'data-eng@databricks-demo.com',
    runtime: '15.4 LTS (Photon, Scala 2.12, Spark 3.5.0)',
    nodeTypeId: 'i4i.4xlarge',
    workers: 8,
    driverNodeTypeId: 'm5d.2xlarge',
    uptimeMinutes: 412,
    activeJobs: 3,
    photon: true,
    tags: ['prod', 'etl'],
  },
  {
    id: '0731-190233-shard4',
    name: 'analytics-shared',
    state: 'RUNNING',
    creator: 'analytics@databricks-demo.com',
    runtime: '15.4 LTS (Scala 2.12, Spark 3.5.0)',
    nodeTypeId: 'm5d.2xlarge',
    workers: 4,
    driverNodeTypeId: 'm5d.2xlarge',
    uptimeMinutes: 1884,
    activeJobs: 1,
    photon: false,
    tags: ['shared'],
  },
  {
    id: '0728-113900-jobs9',
    name: 'jobs-nightly-agg',
    state: 'RUNNING',
    creator: 'jobs-service@databricks-demo.com',
    runtime: '14.3 LTS (Scala 2.12, Spark 3.5.0)',
    nodeTypeId: 'r5d.xlarge',
    workers: 6,
    driverNodeTypeId: 'r5d.xlarge',
    uptimeMinutes: 96,
    activeJobs: 2,
    photon: false,
    tags: ['jobs'],
  },
  {
    id: '0715-081122-mldev',
    name: 'ml-dev-interactive',
    state: 'RUNNING',
    creator: 'ml-platform@databricks-demo.com',
    runtime: '15.4 LTS ML (GPU, Scala 2.12, Spark 3.5.0)',
    nodeTypeId: 'g4dn.xlarge',
    workers: 2,
    driverNodeTypeId: 'g4dn.xlarge',
    uptimeMinutes: 37,
    activeJobs: 0,
    photon: false,
    tags: ['ml', 'dev'],
  },
  {
    id: '0702-145503-archv2',
    name: 'ingest-archive',
    state: 'TERMINATED',
    creator: 'data-eng@databricks-demo.com',
    runtime: '13.3 LTS (Scala 2.12, Spark 3.4.1)',
    nodeTypeId: 'm5d.2xlarge',
    workers: 2,
    driverNodeTypeId: 'm5d.2xlarge',
    uptimeMinutes: 0,
    activeJobs: 0,
    photon: false,
    tags: ['archive'],
  },
];

/**
 * Per-cluster executor telemetry the Spark UI reads: task counters and shuffle
 * volume reported by each running executor, keyed by cluster id.
 */
const EXECUTOR_TELEMETRY = {
  '0731-204512-photon7': {
    activeTasks: 214, completedTasks: 1848233, failedTasks: 41, shuffleReadGb: 812.4, shuffleWriteGb: 640.1, gcTimeSeconds: 388,
  },
  '0731-190233-shard4': {
    activeTasks: 36, completedTasks: 402118, failedTasks: 2, shuffleReadGb: 91.7, shuffleWriteGb: 74.2, gcTimeSeconds: 122,
  },
  '0728-113900-jobs9': {
    activeTasks: 88, completedTasks: 763904, failedTasks: 0, shuffleReadGb: 204.9, shuffleWriteGb: 188.3, gcTimeSeconds: 211,
  },
  '0715-081122-mldev': {
    activeTasks: 0, completedTasks: 5120, failedTasks: 0, shuffleReadGb: 3.1, shuffleWriteGb: 2.4, gcTimeSeconds: 9,
  },
};

/**
 * Scenario directive appended to the Devin investigation prompt.
 *
 * The alert pipeline passes only a prompt to the Devin API, so the repository
 * to remediate has to be named explicitly here.
 */
const REMEDIATION_DIRECTIVE = [
  '*Repository to investigate and fix:* `COG-GTM/event-driven-devin`',
  '',
  'The failing code path is the Databricks Spark cluster UI vertical:',
  '- Service: `app/services/verticals/0b6164d6.js`',
  '- Route: `app/routes/verticals/0b6164d6.js`',
  '- Page: `app/public/verticals/0b6164d6.html` (served at `/databricks`)',
  '',
  'The Compute page renders an executor summary for the selected cluster. The summary sizes',
  'executors from the worker instance shape resolved out of `NODE_TYPE_SPECS`, so a cluster',
  'running a node type the compute policy offers but that map does not carry takes the whole',
  'cluster UI down rather than degrading that one column.',
  '',
  'Fix the missing instance shape, and make the resolver fail safe so a node type added to the',
  'policy in future cannot blank the Spark UI for a running cluster. Add regression coverage for',
  'every node type the cluster list can serve.',
  '',
  'Open a pull request against `main` with the fix.',
].join('\n');

function findCluster(clusterId) {
  return CLUSTERS.find((cluster) => cluster.id === clusterId);
}

/**
 * Resolve the instance shape a cluster's workers run on.
 */
function resolveNodeTypeSpec(nodeTypeId) {
  return NODE_TYPE_SPECS[nodeTypeId];
}

/**
 * Build the per-executor rows the Spark UI's Executors tab lists: the driver plus
 * one row per worker, each sized from the instance shape it runs on.
 */
function buildExecutorRows(cluster, telemetry) {
  const workerSpec = resolveNodeTypeSpec(cluster.nodeTypeId);
  const driverSpec = resolveNodeTypeSpec(cluster.driverNodeTypeId) || workerSpec;
  const perWorkerTasks = Math.round(telemetry.activeTasks / Math.max(cluster.workers, 1));

  const rows = [{
    executorId: 'driver',
    host: '10.139.64.4:40001',
    nodeType: driverSpec.label,
    cores: driverSpec.vcpus,
    storageMemoryGb: Math.round(driverSpec.memoryGb * 0.6 * 10) / 10,
    activeTasks: 0,
    completedTasks: 0,
    failedTasks: 0,
  }];

  for (let index = 0; index < cluster.workers; index += 1) {
    rows.push({
      executorId: String(index + 1),
      host: `10.139.64.${10 + index}:${40010 + index}`,
      nodeType: workerSpec.label,
      cores: workerSpec.vcpus,
      storageMemoryGb: Math.round(workerSpec.memoryGb * 0.6 * 10) / 10,
      activeTasks: perWorkerTasks,
      completedTasks: Math.round(telemetry.completedTasks / cluster.workers),
      failedTasks: index === 0 ? telemetry.failedTasks : 0,
    });
  }

  return rows;
}

/**
 * Build the cluster utilization header the Spark UI shows above the executor
 * table: total cores and memory across the cluster, and how much of it is busy.
 */
function buildUtilization(cluster, telemetry) {
  const workerSpec = resolveNodeTypeSpec(cluster.nodeTypeId);
  const driverSpec = resolveNodeTypeSpec(cluster.driverNodeTypeId) || workerSpec;

  const totalCores = workerSpec.vcpus * cluster.workers + driverSpec.vcpus;
  const totalMemoryGb = workerSpec.memoryGb * cluster.workers + driverSpec.memoryGb;
  const totalDiskGb = workerSpec.localDiskGb * cluster.workers + driverSpec.localDiskGb;

  return {
    totalCores,
    totalMemoryGb,
    totalDiskGb,
    coresInUse: Math.min(telemetry.activeTasks, totalCores),
    coreUtilization: Math.round(Math.min(telemetry.activeTasks / totalCores, 1) * 1000) / 1000,
    dbuPerHour: Math.round((workerSpec.dbuPerHour * cluster.workers + driverSpec.dbuPerHour) * 100) / 100,
    gcTimeSeconds: telemetry.gcTimeSeconds,
    shuffleReadGb: telemetry.shuffleReadGb,
    shuffleWriteGb: telemetry.shuffleWriteGb,
  };
}

/**
 * Render the Spark cluster UI payload for one cluster: utilization header,
 * executor table, and the job counters shown on the Jobs tab.
 */
async function renderClusterUi(data) {
  const startTime = Date.now();
  const renderId = uuidv4();
  const cluster = findCluster(data.clusterId);

  logger.info('Rendering Spark cluster UI', {
    renderId,
    clusterId: data.clusterId,
    service: 'customer-0b6164d6-compute-ui',
    route: '/api/0b6164d6/cluster-ui',
  });

  if (!cluster) {
    const error = new Error(`Unknown cluster: ${data.clusterId || '(none)'}`);
    error.name = 'ValidationError';
    error.statusCode = 400;
    error.code = 'CLUSTER_NOT_FOUND';
    throw error;
  }

  if (cluster.state !== 'RUNNING') {
    const error = new Error(`${cluster.name} is ${cluster.state} \u2014 the Spark UI is only available while a cluster is running`);
    error.name = 'ValidationError';
    error.statusCode = 400;
    error.code = 'CLUSTER_NOT_RUNNING';
    throw error;
  }

  try {
    await new Promise((resolve) => setTimeout(resolve, 80 + Math.random() * 120));

    const telemetry = EXECUTOR_TELEMETRY[cluster.id];
    const utilization = buildUtilization(cluster, telemetry);
    const executors = buildExecutorRows(cluster, telemetry);

    incrementMetric('compute_ui.render_success', {
      route: '/api/0b6164d6/cluster-ui',
      clusterId: cluster.id,
    });
    recordTiming('compute_ui.render_latency', Date.now() - startTime, {
      route: '/api/0b6164d6/cluster-ui',
      error: 'false',
    });

    logger.info('Spark cluster UI rendered', {
      renderId,
      clusterId: cluster.id,
      executors: executors.length,
      totalCores: utilization.totalCores,
    });

    return {
      success: true,
      renderId,
      cluster: {
        id: cluster.id,
        name: cluster.name,
        state: cluster.state,
        runtime: cluster.runtime,
        nodeTypeId: cluster.nodeTypeId,
        workers: cluster.workers,
        photon: cluster.photon,
        uptimeMinutes: cluster.uptimeMinutes,
      },
      utilization,
      executors,
      jobs: {
        active: cluster.activeJobs,
        completedTasks: telemetry.completedTasks,
        failedTasks: telemetry.failedTasks,
      },
      renderedAt: new Date().toISOString(),
    };
  } catch (error) {
    const duration = Date.now() - startTime;

    incrementMetric('compute_ui.render_failure', {
      route: '/api/0b6164d6/cluster-ui',
      errorClass: error.name,
      clusterId: cluster.id,
    });
    recordTiming('compute_ui.render_latency', duration, {
      route: '/api/0b6164d6/cluster-ui',
      error: 'true',
    });

    logger.error('Spark cluster UI render failed', {
      renderId,
      clusterId: cluster.id,
      nodeTypeId: cluster.nodeTypeId,
      error: error.message,
      errorClass: error.name,
      durationMs: duration,
      service: 'customer-0b6164d6-compute-ui',
    });

    Sentry.captureException(error, {
      tags: {
        service: 'customer-0b6164d6-compute-ui',
        route: '/api/0b6164d6/cluster-ui',
        clusterId: cluster.id,
        nodeTypeId: cluster.nodeTypeId,
      },
      extra: {
        renderId,
        cluster: cluster.name,
        workers: cluster.workers,
        runtime: cluster.runtime,
      },
    });

    createSessionAndAlert({
      issueTitle: `${error.name}: ${error.message}`,
      issueUrl: `https://${process.env.SENTRY_ORG_SLUG || 'sentry-org'}.sentry.io/issues/?project=${process.env.SENTRY_PROJECT_ID || ''}&query=is%3Aunresolved`,
      culprit: 'app/services/verticals/0b6164d6.js \u2014 buildUtilization',
      errorType: error.name || 'Error',
      errorValue: error.message,
      devinUserId: data.devinUserId,
      devinEmail: data.devinEmail,
      devinOrgId: data.devinOrgId,
      service: 'customer-0b6164d6-compute-ui',
      verticalLabel: 'Databricks \u2014 Compute / Spark Cluster UI',
      promptAppendix: REMEDIATION_DIRECTIVE,
      customer: '0b6164d6',
      tags: [
        { key: 'route', value: '/api/0b6164d6/cluster-ui' },
        { key: 'service', value: 'customer-0b6164d6-compute-ui' },
        { key: 'cluster_id', value: cluster.id },
        { key: 'node_type_id', value: cluster.nodeTypeId },
      ],
      extra: {
        renderId,
        cluster: cluster.name,
        workers: cluster.workers,
        runtime: cluster.runtime,
        activeJobs: cluster.activeJobs,
      },
      level: 'error',
      platform: 'node',
      firstSeen: '',
      lastSeen: new Date().toISOString(),
    }).catch((alertError) => {
      logger.error('Failed to post alert for Spark cluster UI error', {
        renderId,
        error: alertError.message,
      });
    });

    throw error;
  }
}

module.exports = {
  renderClusterUi,
  resolveNodeTypeSpec,
  buildExecutorRows,
  buildUtilization,
  CLUSTERS,
  NODE_TYPE_SPECS,
  EXECUTOR_TELEMETRY,
};
