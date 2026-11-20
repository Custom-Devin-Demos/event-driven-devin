module.exports = {
  label: 'Bloomberg Auction System — bid submission',
  triggerMode: 'api',
  aliases: ['bloomberg-auctions', 'bbg-auctions', 'bond-auctions'],
  // Bloomberg demos page their own channel (#bloomberg-oncall), never the shared alerts channel.
  slackChannelId: 'C0CKXTAMWQY',
};
