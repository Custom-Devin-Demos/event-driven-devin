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

module.exports = {
  isConfigured,
  createIncident,
};
