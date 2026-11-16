// Posts to the dedicated eashan-demo Teams Workflow that the Lowe's cart demo
// already has deployed, unless this demo is given its own target.
module.exports = {
  label: 'Boston Scientific — LATITUDE Clinic Alerts',
  triggerMode: 'api',
  githubOrg: 'COG-GTM',
  teamsWebhookEnv: process.env.LATITUDE_TEAMS_WEBHOOK_URL ? 'LATITUDE_TEAMS_WEBHOOK_URL' : 'LOWES_TEAMS_WEBHOOK_URL',
  teamsAutomationUrl: process.env.LATITUDE_TEAMS_AUTOMATION_URL || 'https://devin-gtm.devinenterprise.com/org/eashan-dev/automations',
  aliases: ['latitude', 'latitude-clinic', 'bsci'],
};
