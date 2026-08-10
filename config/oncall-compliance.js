/**
 * Compliance screening configuration — banking-api (on-call slice).
 */
module.exports = {
  banking: {
    screeningWindowDays: 90,
    screeningConcurrency: 1,
  },
};
