const { v4: uuidv4 } = require('uuid');
const logger = require('../../telemetry/logger');
const { incrementMetric, recordTiming } = require('../../telemetry/datadog');
const { Sentry } = require('../../telemetry/sentry');

const ROUTE = '/api/oncall/privatecloud/deployments';

/**
 * Validated blueprints as published by the blueprint catalog. `storageCode`
 * is the storage array model the blueprint's desired-state plan is rendered
 * against — a single code, or one per supported server model for
 * software-defined storage that lives on the nodes themselves.
 */
const BLUEPRINTS = {
  'dpc-vsphere': { name: 'Dell Private Cloud \u2014 VMware vSphere 8', version: '2.1.0', ecosystem: 'VMware', storageCode: 'PS-3200T-PRIME', minNodes: 4, maxNodes: 16, hardware: ['PowerEdge R760', 'PowerEdge R760xa'], targets: ['bare-metal', 'vcenter'], policies: ['default', 'performance', 'capacity'] },
  'dpc-openshift': { name: 'Dell Private Cloud \u2014 Red Hat OpenShift', version: '1.3.0', ecosystem: 'Red Hat', storageCode: 'PS-1200T', minNodes: 3, maxNodes: 16, hardware: ['PowerEdge R760', 'PowerEdge R760xa'], targets: ['bare-metal'], policies: ['default', 'performance', 'capacity'] },
  'dpc-nutanix': { name: 'Dell Private Cloud \u2014 Nutanix AHV', version: '1.0.2', ecosystem: 'Nutanix', storageCode: { 'PowerEdge R760': 'PF-R760', 'PowerEdge R760xa': 'PF-R760', 'PowerEdge XR8000': 'PF-XR8000' }, minNodes: 3, maxNodes: 16, hardware: ['PowerEdge R760', 'PowerEdge R760xa', 'PowerEdge XR8000'], targets: ['bare-metal'], policies: ['default', 'capacity'] },
};

/**
 * Storage policies an operator can pick in the wizard; `default` keeps the
 * blueprint's datastore template.
 */
const STORAGE_POLICIES = {
  default: { label: 'Blueprint default' },
  performance: { label: 'Performance (NVMe/TCP, no dedupe)', datastoreTemplate: 'perf-nodedupe' },
  capacity: { label: 'Capacity (compressed, replicated)', datastoreTemplate: 'capacity-replicated' },
};

const SECRETS = ['dpc-rr02-admin-credentials', 'dpc-shared-admin-credentials'];

/**
 * Storage profiles per array model, from the storage services catalog. The
 * planner reads the datastore template and data protocol from here.
 */
const STORAGE_PROFILES = {
  'PS-3200T': { array: 'PowerStore 3200T', protocol: 'NVMe/TCP', datastoreTemplate: 'vvol-gold', mobility: true },
  'PS-1200T': { array: 'PowerStore 1200T', protocol: 'NVMe/TCP', datastoreTemplate: 'block-standard', mobility: true },
  'PF-R760': { array: 'PowerFlex on PowerEdge R760', protocol: 'SDC', datastoreTemplate: 'sds-replicated', mobility: false },
  'PF-XR8000': { array: 'PowerFlex on PowerEdge XR8000', protocol: 'SDC', datastoreTemplate: 'sds-replicated-edge', mobility: false },
};

function storageCodeFor(blueprint, site) {
  return typeof blueprint.storageCode === 'string' ? blueprint.storageCode : blueprint.storageCode[site.model];
}

/**
 * Onboarded sites with their endpoint pools.
 */
const SITES = {
  'rr-dc02': { name: 'Round Rock DC-02', endpoints: 24, model: 'PowerEdge R760', vcenter: 'vcsa-rr02.corp.local' },
  'hop-dc01': { name: 'Hopkinton DC-01', endpoints: 16, model: 'PowerEdge R760xa' },
  'lim-edge04': { name: 'Limerick EDGE-04', endpoints: 8, model: 'PowerEdge XR8000' },
};

/**
 * Render the desired-state plan for a validated blueprint and start the
 * deployment on the selected site.
 */
async function createDeployment(request, options = {}) {
  const startTime = Date.now();
  const deploymentId = uuidv4();
  const blueprintKey = String(request.blueprintId || '').toLowerCase();
  const siteKey = String(request.siteId || '').toLowerCase();
  const nodeCount = Number(request.nodeCount);
  const own = (table, key) => (Object.hasOwn(table, key) ? table[key] : undefined);
  const policyKey = String(request.storagePolicy || 'default').toLowerCase();
  const targetKey = String(request.target || 'bare-metal').toLowerCase();
  const secret = String(request.secret || SECRETS[0]);

  logger.info('Blueprint deployment request', {
    deploymentId, blueprint: blueprintKey, site: siteKey, nodeCount, storagePolicy: policyKey, target: targetKey, service: 'dap-orchestrator-api', route: ROUTE,
  });

  try {
    const blueprint = own(BLUEPRINTS, blueprintKey);
    const site = own(SITES, siteKey);
    if (!blueprint || !site) {
      const error = new Error(`Unknown blueprint or site: ${blueprintKey} @ ${siteKey}`);
      error.code = 'INVALID_DEPLOYMENT';
      throw error;
    }
    if (!blueprint.hardware.includes(site.model)) {
      const error = new Error(`${site.name} (${site.model}) is not a supported hardware profile for ${blueprint.name}`);
      error.code = 'INVALID_DEPLOYMENT';
      throw error;
    }
    if (!Number.isInteger(nodeCount) || nodeCount < blueprint.minNodes || nodeCount > Math.min(blueprint.maxNodes, site.endpoints)) {
      const error = new Error(`Node count ${nodeCount} is outside the range for ${blueprint.name} at ${site.name}`);
      error.code = 'INVALID_DEPLOYMENT';
      throw error;
    }
    const policy = blueprint.policies.includes(policyKey) ? own(STORAGE_POLICIES, policyKey) : undefined;
    const targetOk = blueprint.targets.includes(targetKey) && (targetKey !== 'vcenter' || Boolean(site.vcenter));
    if (!policy || !targetOk || !SECRETS.includes(secret)) {
      const error = new Error(`Unsupported deployment options for ${blueprint.name} at ${site.name}: policy=${policyKey} target=${targetKey}`);
      error.code = 'INVALID_DEPLOYMENT';
      throw error;
    }
    const profile = STORAGE_PROFILES[storageCodeFor(blueprint, site)];
    const storage = {
      array: profile.array,
      protocol: profile.protocol,
      datastoreTemplate: policy.datastoreTemplate || profile.datastoreTemplate,
      policy: policy.label,
    };
    const duration = Date.now() - startTime;

    incrementMetric('privatecloud.deployment.success', { route: ROUTE, blueprint: blueprintKey });
    recordTiming('privatecloud.deployment.latency', duration, { route: ROUTE });

    return {
      success: true,
      deploymentId,
      deploymentName: String(request.clusterName || `${blueprintKey}-${site.name.split(' ')[0].toLowerCase()}`),
      blueprint: `${blueprint.name} ${blueprint.version}`,
      site: site.name,
      nodes: `${nodeCount} \u00d7 ${site.model}`,
      target: targetKey === 'vcenter' ? `Existing vCenter \u00b7 ${site.vcenter}` : 'Bare metal (managed by orchestrator)',
      secret,
      storage,
      status: 'Creating deployments',
      progress: 2,
      estimatedMinutes: 150,
    };
  } catch (error) {
    const duration = Date.now() - startTime;
    incrementMetric('privatecloud.deployment.failure', { route: ROUTE, errorClass: error.name });
    recordTiming('privatecloud.deployment.latency', duration, { route: ROUTE, error: 'true' });
    logger.error('Blueprint deployment failed', {
      deploymentId, error: error.message, errorClass: error.name, code: error.code, durationMs: duration, blueprint: blueprintKey, site: siteKey,
    });
    if (error.code !== 'INVALID_DEPLOYMENT') {
      Sentry.captureException(error, {
        tags: { route: ROUTE, service: 'dap-orchestrator-api', ...(options.synthetic ? { synthetic_probe: 'true' } : {}) },
        extra: { deploymentId, blueprint: blueprintKey, site: siteKey, nodeCount, storagePolicy: policyKey },
      });
    }
    throw error;
  }
}

module.exports = { createDeployment, BLUEPRINTS, STORAGE_PROFILES, STORAGE_POLICIES, SITES };
