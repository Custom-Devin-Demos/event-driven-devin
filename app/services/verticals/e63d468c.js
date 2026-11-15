const { v4: uuidv4 } = require('uuid');
const logger = require('../../telemetry/logger');
const { incrementMetric, recordTiming } = require('../../telemetry/datadog');
const { Sentry } = require('../../telemetry/sentry');
const { createSessionAndAlert } = require('../devin-session');
const { renderDeployment } = require('./e63d468c-chart');
const { memoryLimitBytes, CGROUP_ROOT } = require('./e63d468c-memlimit');

const SERVICE = 'e63d468c-api';
const ROUTE = '/api/e63d468c/nodegroups/retire';
const MIB = 1024 * 1024;
const RUNTIME_OVERHEAD_BYTES = 42 * MIB;
const CRASH_ATTEMPTS = 4;

const MONITOR = {
  id: 148220391,
  name: 'telemetry-ingest pods not ready on {{kube_cluster_name.name}}',
  query: 'max(last_1m):sum:kubernetes_state.deployment.replicas_available'
    + '{kube_cluster_name:prod-east,kube_namespace:fleet,kube_deployment:telemetry-ingest} < 1',
  tags: ['env:prod', 'kube_cluster_name:prod-east', 'kube_namespace:fleet', 'service:telemetry-ingest', 'team:platform'],
  priority: 'P1',
  notify: ['@slack-automated-alerts'],
};

const NODE_GROUPS = [
  { name: 'fleet-al2', amiType: 'AL2_x86_64', osImage: 'Amazon Linux 2', kubelet: 'v1.32.9-eks-1d4f8e2', cgroupVersion: 1, instanceType: 'm6i.2xlarge', desired: 2 },
  { name: 'fleet', amiType: 'AL2023_x86_64_STANDARD', osImage: 'Amazon Linux 2023', kubelet: 'v1.33.5-eks-3a1b7c0', cgroupVersion: 2, instanceType: 'm6i.2xlarge', desired: 3 },
];

const NODES = [
  { name: 'ip-10-42-11-23.ec2.internal', nodeGroup: 'fleet-al2', zone: 'us-east-1a', memMiB: 31638 },
  { name: 'ip-10-42-12-87.ec2.internal', nodeGroup: 'fleet-al2', zone: 'us-east-1b', memMiB: 31638 },
  { name: 'ip-10-42-21-14.ec2.internal', nodeGroup: 'fleet', zone: 'us-east-1a', memMiB: 31638 },
  { name: 'ip-10-42-22-40.ec2.internal', nodeGroup: 'fleet', zone: 'us-east-1b', memMiB: 31638 },
  { name: 'ip-10-42-23-66.ec2.internal', nodeGroup: 'fleet', zone: 'us-east-1c', memMiB: 31638 },
];

const SEED_PODS = [
  { name: 'telemetry-ingest-6d8f7c9b54-k2x7p', node: 'ip-10-42-11-23.ec2.internal' },
  { name: 'telemetry-ingest-6d8f7c9b54-q9m4t', node: 'ip-10-42-12-87.ec2.internal' },
];
const RESCHEDULED_PODS = ['telemetry-ingest-6d8f7c9b54-w8rjn', 'telemetry-ingest-6d8f7c9b54-zt5hc'];

const STATE = {};

function nodeGroupOf(node) {
  return NODE_GROUPS.find((g) => g.name === node.nodeGroup);
}

function parseQuantity(q) {
  const m = /^(\d+)(Ki|Mi|Gi)?$/.exec(String(q));
  if (!m) return parseInt(q, 10);
  const unit = { Ki: 1024, Mi: MIB, Gi: 1024 * MIB }[m[2]] || 1;
  return parseInt(m[1], 10) * unit;
}

function resolveEnv(container) {
  const env = {};
  for (const item of container.env || []) {
    if (item.value !== undefined) {
      env[item.name] = String(item.value);
    } else if (item.valueFrom && item.valueFrom.resourceFieldRef) {
      const [section, resource] = item.valueFrom.resourceFieldRef.resource.split('.');
      env[item.name] = String(parseQuantity(container.resources[section][resource]));
    }
  }
  return env;
}

function containerCgroupFs(node, container) {
  const limit = String(parseQuantity(container.resources.limits.memory));
  return nodeGroupOf(node).cgroupVersion === 1
    ? { [`${CGROUP_ROOT}/memory/memory.limit_in_bytes`]: limit, [`${CGROUP_ROOT}/memory/memory.usage_in_bytes`]: '0' }
    : { [`${CGROUP_ROOT}/memory.max`]: limit, [`${CGROUP_ROOT}/memory.current`]: '0', [`${CGROUP_ROOT}/cgroup.controllers`]: 'cpuset cpu io memory pids' };
}

function startContainer(node, container) {
  const limit = memoryLimitBytes({
    env: resolveEnv(container),
    fs: containerCgroupFs(node, container),
    hostMemBytes: node.memMiB * MIB,
  });
  const cacheBytes = Math.floor(limit / 2);
  const logs = [`memory limit detected: ${Math.floor(limit / MIB)} MiB; sizing cache to ${Math.floor(cacheBytes / MIB)} MiB`];
  const hardLimit = parseQuantity(container.resources.limits.memory);
  if (cacheBytes + RUNTIME_OVERHEAD_BYTES > hardLimit) {
    return { running: false, reason: 'OOMKilled', exitCode: 137, logs };
  }
  logs.push('telemetry-ingest listening on :8080');
  const memPct = Math.round(((cacheBytes + RUNTIME_OVERHEAD_BYTES) / hardLimit) * 100);
  return { running: true, logs, memPct };
}

function runPod(name, nodeName, deployment) {
  const node = NODES.find((n) => n.name === nodeName);
  const container = deployment.spec.template.spec.containers[0];
  let restarts = 0;
  let result = startContainer(node, container);
  while (!result.running && restarts < CRASH_ATTEMPTS) {
    restarts += 1;
    result = startContainer(node, container);
  }
  return {
    name,
    namespace: 'fleet',
    node: node.name,
    nodeGroup: node.nodeGroup,
    osImage: nodeGroupOf(node).osImage,
    kubelet: nodeGroupOf(node).kubelet,
    status: result.running ? 'Running' : 'CrashLoopBackOff',
    ready: result.running ? '1/1' : '0/1',
    restarts,
    memPct: result.running ? result.memPct : 0,
    env: Object.keys(resolveEnv(container)),
    resources: container.resources,
    image: container.image,
    logs: result.logs,
    lastState: result.running ? null : { reason: result.reason, exitCode: result.exitCode },
  };
}

function seedEvents(at) {
  const d = 86400 * 1000;
  return [
    { t: at - 6 * d - 3600e3, src: 'cloud', title: 'EKS cluster prod-east: control plane updated 1.32 → 1.33', body: 'UpdateClusterVersion by terraform (platform-ci) · kube_cluster_name:prod-east' },
    { t: at - 6 * d - 1800e3, src: 'cloud', title: 'Managed node group fleet created (AL2023_x86_64_STANDARD, 1.33, 3 × m6i.2xlarge)', body: 'No EKS-optimized AL2 AMI is published for 1.33. fleet-al2 kept on 1.32 while workloads drain.' },
    { t: at - 6 * d - 1700e3, src: 'k8s', title: 'telemetry-ingest 2.7.0 running on fleet-al2 (2/2)', body: 'helm revision 8 · chart telemetry-ingest-0.4.2' },
    { t: at - 2 * d, src: 'monitor', title: '[P3] fleet-api p99 latency above 800ms on prod-east', body: 'Recovered after 6 minutes', status: 'OK' },
  ];
}

function resetState() {
  const now = Date.now();
  const deployment = renderDeployment();
  STATE.seededAt = now;
  STATE.retiredAt = null;
  STATE.retiring = false;
  STATE.alertedAt = null;
  STATE.notification = null;
  STATE.status = 'OK';
  STATE.al2Desired = 2;
  STATE.pods = SEED_PODS.map((p) => ({ ...runPod(p.name, p.node, deployment), age: '6 days' }));
  STATE.events = seedEvents(now);
}
resetState();

function getClusterState() {
  const nodes = NODES
    .filter((n) => n.nodeGroup !== 'fleet-al2' || STATE.al2Desired > 0)
    .map((n) => ({ ...n, osImage: nodeGroupOf(n).osImage, kubelet: nodeGroupOf(n).kubelet, status: 'Ready' }));
  const ready = STATE.pods.filter((p) => p.ready === '1/1').length;
  return {
    monitor: MONITOR,
    status: STATE.status,
    nodeGroups: NODE_GROUPS.map((g) => ({ ...g, desired: g.name === 'fleet-al2' ? STATE.al2Desired : g.desired })),
    nodes,
    pods: STATE.pods,
    replicas: { ready, desired: renderDeployment().spec.replicas },
    events: [...STATE.events].sort((a, b) => b.t - a.t),
    retiredAt: STATE.retiredAt,
    alertedAt: STATE.alertedAt,
    notification: STATE.notification,
    seededAt: STATE.seededAt,
    now: Date.now(),
  };
}

function formatRollout(requestId) {
  return { success: true, requestId, ...getClusterState() };
}

const PROMPT_APPENDIX = [
  'This is a Datadog monitor on a Kubernetes workload that this repo simulates: the cluster and kubelet live in app/services/verticals/e63d468c.js, the Helm chart render for telemetry-ingest in app/services/verticals/e63d468c-chart.js, and the service\'s memory-limit detection in app/services/verticals/e63d468c-memlimit.js.',
  'Reproduce first (POST /api/e63d468c/nodegroups/retire, or a jest test calling retireNodeGroup), then post the pod status, the container\'s startup log line and the root cause in plain words in the Slack thread.',
  'The failure started with an environment change (the node OS image), so prefer fixing the deployment config (the chart) and let app hardening ride along in the same PR. Do not change the node or kubelet simulation to make it pass.',
  'Add a regression test in tests/e63d468c-*.test.js that fails without the fix. After fixing, verify on /e63d468c that Retire AL2 node group leaves telemetry-ingest 2/2 ready and the monitor OK.',
].join('\n');

async function retireNodeGroup(data) {
  const startTime = Date.now();
  const requestId = uuidv4();

  logger.info('Scaling node group', {
    requestId, nodeGroup: 'fleet-al2', from: STATE.al2Desired, to: 0, service: SERVICE,
  });

  if (STATE.retiredAt || STATE.retiring) {
    return formatRollout(requestId);
  }
  STATE.retiring = true;

  try {
    await new Promise((resolve) => setTimeout(resolve, 70 + Math.random() * 110));

    const t0 = Date.now() - 35000;
    STATE.retiredAt = t0;
    STATE.al2Desired = 0;
    const deployment = renderDeployment();
    const targets = NODES.filter((n) => n.nodeGroup === 'fleet');
    const evicted = STATE.pods.map((p) => p.name);
    STATE.pods = RESCHEDULED_PODS.map((name, i) => ({
      ...runPod(name, targets[(i * 2) % targets.length].name, deployment),
      age: '35s',
    }));

    STATE.events.push(
      { t: t0, src: 'cloud', title: 'Managed node group fleet-al2 update: desired size 2 → 0', body: 'UpdateNodegroupConfig by terraform (platform-ci) · retiring the last Amazon Linux 2 nodes' },
      { t: t0 + 2000, src: 'k8s', title: 'Node ip-10-42-11-23.ec2.internal cordoned; draining', body: 'kube_node_group:fleet-al2' },
      { t: t0 + 3000, src: 'k8s', title: `Pod ${evicted[0]} evicted, rescheduled to fleet nodes`, body: 'kube_namespace:fleet kube_deployment:telemetry-ingest' },
    );

    const crashed = STATE.pods.filter((p) => p.ready !== '1/1');
    if (crashed.length) {
      STATE.events.push(
        { t: t0 + 12000, src: 'k8s', title: `Container telemetry-ingest ${crashed[0].lastState.reason} (exit code ${crashed[0].lastState.exitCode})`, body: `pod ${crashed[0].name} · node ${crashed[0].node} · limits.memory ${crashed[0].resources.limits.memory}`, status: 'ALERT' },
        { t: t0 + 24000, src: 'k8s', title: 'Back-off restarting failed container telemetry-ingest', body: `CrashLoopBackOff · ${STATE.pods.length - crashed.length}/${STATE.pods.length} ready`, status: 'ALERT' },
      );
    }

    const ready = STATE.pods.length - crashed.length;
    if (ready < 1) {
      const err = new Error(
        `telemetry-ingest ${ready}/${STATE.pods.length} ready on prod-east: container ${crashed[0].lastState.reason} (exit code ${crashed[0].lastState.exitCode}) after rescheduling onto node group fleet; last log: ${crashed[0].logs[0]}`,
      );
      err.name = 'CrashLoopBackOff';
      throw err;
    }

    STATE.events.push({ t: Date.now(), src: 'k8s', title: `telemetry-ingest ${ready}/${STATE.pods.length} ready on fleet (Amazon Linux 2023)`, body: STATE.pods[0].logs[0], status: 'OK' });

    incrementMetric('nodegroup.retire.success', { route: ROUTE });
    recordTiming('nodegroup.retire.latency', Date.now() - startTime, { route: ROUTE });
    return formatRollout(requestId);
  } catch (error) {
    const duration = Date.now() - startTime;
    incrementMetric('nodegroup.retire.failure', { route: ROUTE, errorClass: error.name });
    recordTiming('nodegroup.retire.latency', duration, { route: ROUTE, error: 'true' });

    logger.error('Workload unhealthy after node group scale-down', {
      requestId, error: error.message, errorClass: error.name, durationMs: duration, service: SERVICE,
    });

    STATE.status = 'ALERT';
    STATE.alertedAt = Date.now();
    STATE.notification = { status: 'pending', detail: 'posting to #automated-alerts' };
    STATE.events.push({ t: STATE.alertedAt, src: 'monitor', title: `[Triggered] ${MONITOR.name.replace('{{kube_cluster_name.name}}', 'prod-east')}`, body: 'replicas_available = 0 (threshold < 1)', status: 'ALERT' });

    Sentry.captureException(error, {
      tags: {
        route: ROUTE, service: SERVICE, alert_path: 'instant', kube_cluster_name: 'prod-east', kube_deployment: 'telemetry-ingest',
      },
      extra: { requestId, pods: STATE.pods.map((p) => ({ name: p.name, status: p.status, node: p.node })) },
    });

    createSessionAndAlert({
      issueTitle: `${error.name}: ${error.message}`,
      issueUrl: `https://app.datadoghq.com/monitors/${MONITOR.id}`,
      culprit: 'app/services/verticals/e63d468c.js — startContainer',
      errorType: error.name || 'Error',
      errorValue: error.message,
      devinUserId: data.devinUserId,
      devinEmail: data.devinEmail,
      devinOrgId: data.devinOrgId,
      service: SERVICE,
      verticalLabel: 'Datadog Monitor · telemetry-ingest (prod-east)',
      tags: [
        { key: 'route', value: ROUTE },
        { key: 'service', value: SERVICE },
        { key: 'kube_cluster_name', value: 'prod-east' },
        { key: 'kube_deployment', value: 'telemetry-ingest' },
        { key: 'monitor_id', value: String(MONITOR.id) },
      ],
      promptAppendix: PROMPT_APPENDIX,
      extra: { requestId, monitorId: MONITOR.id, pods: STATE.pods.map((p) => `${p.name} ${p.status} on ${p.node}`) },
      level: 'error',
      platform: 'node',
      firstSeen: '',
      lastSeen: new Date().toISOString(),
      count: '',
      shortId: '',
      project: 'event-driven-devin',
      release: process.env.SENTRY_RELEASE || 'telemetry-ingest@2.7.0',
      environment: process.env.DD_ENV || 'prod',
      triggeredRule: `Monitor ${MONITOR.id}`,
    }).then((result) => {
      STATE.notification = result
        ? { status: 'sent', detail: 'alert posted, Devin session started' }
        : { status: 'skipped', detail: 'Slack not configured or alert suppressed' };
    }).catch((err) => {
      STATE.notification = { status: 'error', detail: err.message };
      logger.error('Failed to trigger Devin session', { error: err.message });
    });

    throw error;
  } finally {
    STATE.retiring = false;
  }
}

function resetCluster() {
  const cleared = STATE.events.length - seedEvents(0).length;
  resetState();
  logger.info('Demo state reset', { cleared, service: SERVICE });
  incrementMetric('nodegroup.reset', { route: `${ROUTE}/reset` });
  return { success: true, cleared, ...getClusterState() };
}

module.exports = {
  retireNodeGroup, resetCluster, getClusterState, MONITOR, NODE_GROUPS, NODES,
};
