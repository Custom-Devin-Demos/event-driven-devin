module.exports = {
  label: 'Bloomberg Terminal — EMSX order routing',
  triggerMode: 'api',
  aliases: ['bloomberg-terminal', 'bbg-terminal', 'emsx'],
  // Bloomberg demos page their own channel (#bloomberg-oncall), never the shared alerts channel.
  slackChannelId: 'C0CKXTAMWQY',
};
