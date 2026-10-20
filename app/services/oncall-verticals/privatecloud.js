const { v4: uuidv4 } = require('uuid');
const logger = require('../../telemetry/logger');
const { incrementMetric, recordTiming } = require('../../telemetry/datadog');
const { Sentry } = require('../../telemetry/sentry');

const ROUTE = '/api/oncall/privatecloud/deployments';

/**
 * Validated blueprints as published by the blueprint catalog. `storageCode`
 * is the storage array model the blueprint's desired-state plan is rendered
 * against.
 */
const BLUEPRINTS = {
  'dpc-vsphere': { name: 'Dell Private Cloud \u2014 VMware vSphere 8', version: '2.1.0', ecosystem: 'VMware', storageCode: 'PS-3200T-PRIME', minNodes: 4, maxNodes: 16 },
  'dpc-openshift': { name: 'Dell Private Cloud \u2014 Red Hat OpenShift', version: '1.3.0', ecosystem: 'Red Hat', storageCode: 'PS-1200T', minNodes: 3, maxNodes: 16 },
  'dpc-nutanix': { name: 'Dell Private Cloud \u2014 Nutanix AHV', version: '1.0.2', ecosystem: 'Nutanix', storageCode: 'PF-R760', minNodes: 3, maxNodes: 16 },
};

/**
 * Storage profiles per array model, from the storage services catalog. The
 * planner reads the datastore template and data protocol from here.
 */
const STORAGE_PROFILES = {
  'PS-3200T': { array: 'PowerStore 3200T', protocol: 'NVMe/TCP', datastoreTemplate: 'vvol-gold', mobility: true },
  'PS-1200T': { array: 'PowerStore 1200T', protocol: 'NVMe/TCP', datastoreTemplate: 'block-standard', mobility: true },
  'PF-R760': { array: 'PowerFlex on PowerEdge R760', protocol: 'SDC', datastoreTemplate: 'sds-replicated', mobility: false },
};

/**
 * Onboarded sites with their endpoint pools.
 */
const SITES = {
  'rr-dc02': { name: 'Round Rock DC-02', endpoints: 24, model: 'PowerEdge R760' },
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

  logger.info('Blueprint deployment request', {
    deploymentId, blueprint: blueprintKey, site: siteKey, nodeCount, service: 'dap-orchestrator-api', route: ROUTE,
  });

  try {
    const blueprint = BLUEPRINTS[blueprintKey];
    const site = SITES[siteKey];
    if (!blueprint || !site) {
      const error = new Error(`Unknown blueprint or site: ${blueprintKey} @ ${siteKey}`);
      error.code = 'INVALID_DEPLOYMENT';
      throw error;
    }
    if (!Number.isInteger(nodeCount) || nodeCount < blueprint.minNodes || nodeCount > Math.min(blueprint.maxNodes, site.endpoints)) {
      const error = new Error(`Node count ${nodeCount} is outside the range for ${blueprint.name} at ${site.name}`);
      error.code = 'INVALID_DEPLOYMENT';
      throw error;
    }
    const profile = STORAGE_PROFILES[blueprint.storageCode];
    const storage = {
      array: profile.array,
      protocol: profile.protocol,
      datastoreTemplate: profile.datastoreTemplate,
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
        extra: { deploymentId, blueprint: blueprintKey, site: siteKey, nodeCount },
      });
    }
    throw error;
  }
}

module.exports = { createDeployment, BLUEPRINTS, STORAGE_PROFILES, SITES };
