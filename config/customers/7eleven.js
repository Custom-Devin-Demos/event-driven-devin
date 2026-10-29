// 7NOW — 7-Eleven delivery storefront (replica of 7-eleven.com/7now/home).
// Monitored by Amazon CloudWatch: alerts use the CloudWatch vocabulary and the
// Teams card is a CloudWatch alarm notification (see app/services/verticals/7eleven.js).
module.exports = {
  label: '7NOW — 7-Eleven Delivery',
  triggerMode: 'api',
  locale: 'en-cloudwatch',
};
