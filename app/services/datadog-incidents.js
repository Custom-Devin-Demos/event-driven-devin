const axios = require('axios');

/**
 * Shared Datadog Incident Management client. With the Datadog Slack app
 * installed and "Create Slack channels for incidents" enabled, Datadog
 * creates the incident channel itself and names it from a template that
 * includes `incident-<publicId>-`.
 */

function ddIncidentEnv() {
  return {
    apiKey: process.env.DD_API_KEY,
    appKey: process.env.DD_INCIDENT_APP_KEY || process.env.DD_APPLICATION_KEY,
    site: process.env.DD_SITE || 'us5.datadoghq.com',
  };
}

function ddHeaders({ apiKey, appKey }) {
  return {
    'DD-API-KEY': apiKey,
    'DD-APPLICATION-KEY': appKey,
    'Content-Type': 'application/json',
  };
}

/**
 * Declare a SEV-1 incident in Datadog Incident Management.
 * Returns { id, publicId } or null when the Datadog keys are not configured.
 */
async function declareDatadogIncident({ title, summary, runRef, triggeredBy, repoUrl }) {
  const env = ddIncidentEnv();
  if (!env.apiKey || !env.appKey) {
    return null;
  }

  const response = await axios.post(
    `https://api.${env.site}/api/v2/incidents`,
    {
      data: {
        type: 'incidents',
        attributes: {
          // Severity is carried by the field (and the channel-name template);
          // keeping it out of the title avoids a doubled-up channel name.
          title: `${title} (${runRef})`,
          customer_impacted: true,
          fields: {
            severity: { type: 'dropdown', value: 'SEV-1' },
            summary: {
              type: 'textbox',
              value: `${summary} Incident Ref: ${runRef}.${triggeredBy ? ` Declared by: ${triggeredBy}.` : ''}${repoUrl ? ` Repo: ${repoUrl}` : ''}`,
            },
          },
        },
      },
    },
    { headers: ddHeaders(env), timeout: 10000 },
  );

  const incident = response.data && response.data.data;
  if (!incident || !incident.id) {
    return null;
  }
  return {
    id: incident.id,
    publicId: incident.attributes && incident.attributes.public_id,
  };
}

/**
 * Resolve a Datadog incident by id. The Datadog Slack integration then
 * auto-archives the incident channel on its own schedule.
 */
async function resolveDatadogIncident(incidentId) {
  const env = ddIncidentEnv();
  if (!env.apiKey || !env.appKey || !incidentId) return false;
  await axios.patch(
    `https://api.${env.site}/api/v2/incidents/${incidentId}`,
    {
      data: {
        id: incidentId,
        type: 'incidents',
        attributes: { fields: { state: { type: 'dropdown', value: 'resolved' } } },
      },
    },
    { headers: ddHeaders(env), timeout: 10000 },
  );
  return true;
}

module.exports = { declareDatadogIncident, resolveDatadogIncident };
