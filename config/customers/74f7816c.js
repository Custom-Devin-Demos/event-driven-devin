module.exports = {
  label: 'Stitch Fix Freestyle',
  triggerMode: 'api',
  aliases: ['stitchfix', 'stitch-fix'],
  slackChannelId: process.env.SLACK_CHANNEL_ID_74F7816C || process.env.SLACK_CHANNEL_ID_B25C3F24 || '',
};
