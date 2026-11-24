module.exports = {
  label: 'Order Pickup',
  locale: 'en-kafka',
  triggerMode: 'api',
  githubOrg: 'COG-GTM',
  slackChannelId: process.env.B8D844E5_SLACK_CHANNEL_ID || process.env.SLACK_ONCALL_ALERTS_CHANNEL_ID || '#oncall-alerts',
};
