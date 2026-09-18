const axios = require('axios');
const logger = require('../telemetry/logger');

function getInstanceUrl() {
  return (process.env.SERVICENOW_INSTANCE_URL || '').replace(/\/+$/, '');
}

function isConfigured() {
  return Boolean(
    getInstanceUrl()
    && process.env.SERVICENOW_USER
    && process.env.SERVICENOW_PASSWORD
  );
}

/**
 * Create a ServiceNow incident for an actionable application failure.
 * Returns null when ServiceNow is not configured or the request fails.
 */
async function createIncident({
  shortDescription,
  description,
  impact = '2',
  urgency = '1',
  category = 'software',
  assignmentGroup,
  cmdbCi,
  correlationId,
  correlationDisplay = 'event-driven-devin',
}) {
  if (!isConfigured()) {
    return null;
  }

  const instanceUrl = getInstanceUrl();
  const body = {
    short_description: shortDescription,
    description,
    impact,
    urgency,
    category,
    assignment_group: assignmentGroup,
    correlation_id: correlationId,
    correlation_display: correlationDisplay,
    contact_type: 'monitoring',
  };

  if (cmdbCi) {
    body.cmdb_ci = cmdbCi;
  }

  try {
    const response = await axios.post(
      `${instanceUrl}/api/now/table/incident`,
      body,
      {
        auth: {
          username: process.env.SERVICENOW_USER,
          password: process.env.SERVICENOW_PASSWORD,
        },
        headers: {
          'Content-Type': 'application/json',
          Accept: 'application/json',
        },
        timeout: 10000,
      }
    );

    const result = response.data?.result;
    if (!result?.number || !result?.sys_id) {
      logger.warn('ServiceNow incident response was missing incident identifiers');
      return null;
    }

    return {
      number: result.number,
      sysId: result.sys_id,
      url: `${instanceUrl}/nav_to.do?uri=incident.do?sys_id=${result.sys_id}`,
    };
  } catch (error) {
    logger.error('Failed to create ServiceNow incident', {
      error: error.message,
      status: error.response?.status,
    });
    return null;
  }
}

function authOptions() {
  return {
    auth: {
      username: process.env.SERVICENOW_USER,
      password: process.env.SERVICENOW_PASSWORD,
    },
    headers: {
      'Content-Type': 'application/json',
      Accept: 'application/json',
    },
    timeout: 10000,
  };
}

/**
 * Create a ServiceNow change request (Change Enablement) for a release that
 * has passed the release gate. Returns null when ServiceNow is not configured
 * or the request fails.
 */
async function createChangeRequest({
  shortDescription,
  description,
  type = 'standard',
  category = 'Software',
  risk = '3',
  impact = '3',
  priority = '3',
  assignmentGroup,
  cmdbCi,
  justification,
  implementationPlan,
  backoutPlan,
  testPlan,
  startDate,
  endDate,
  correlationId,
  correlationDisplay = 'event-driven-devin',
}) {
  if (!isConfigured()) {
    return null;
  }

  const instanceUrl = getInstanceUrl();
  const body = {
    short_description: shortDescription,
    description,
    type,
    category,
    risk,
    impact,
    priority,
    justification,
    implementation_plan: implementationPlan,
    backout_plan: backoutPlan,
    test_plan: testPlan,
    start_date: startDate,
    end_date: endDate,
    correlation_id: correlationId,
    correlation_display: correlationDisplay,
  };
  if (assignmentGroup) body.assignment_group = assignmentGroup;
  if (cmdbCi) body.cmdb_ci = cmdbCi;

  try {
    const response = await axios.post(
      `${instanceUrl}/api/now/table/change_request`,
      body,
      authOptions(),
    );

    const result = response.data?.result;
    if (!result?.number || !result?.sys_id) {
      logger.warn('ServiceNow change request response was missing identifiers');
      return null;
    }

    return {
      number: result.number,
      sysId: result.sys_id,
      state: result.state,
      url: `${instanceUrl}/nav_to.do?uri=change_request.do?sys_id=${result.sys_id}`,
    };
  } catch (error) {
    logger.error('Failed to create ServiceNow change request', {
      error: error.message,
      status: error.response?.status,
    });
    return null;
  }
}

/**
 * Append a work note to an existing change request. Best-effort: failures are
 * logged and swallowed so the release flow never depends on the note landing.
 */
async function addChangeWorkNote(sysId, note) {
  if (!isConfigured() || !sysId) {
    return false;
  }
  try {
    await axios.patch(
      `${getInstanceUrl()}/api/now/table/change_request/${sysId}`,
      { work_notes: note },
      authOptions(),
    );
    return true;
  } catch (error) {
    logger.warn('Failed to add ServiceNow change work note', {
      error: error.message,
      status: error.response?.status,
    });
    return false;
  }
}

module.exports = {
  isConfigured,
  createIncident,
  createChangeRequest,
  addChangeWorkNote,
};
