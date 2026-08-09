/**
 * Compliance screening configuration — banking-api (on-call slice).
 *
 * Every outgoing transfer is screened against the sender's recent activity
 * window before funds move. These parameters control how much history is
 * screened and how many screening-partner calls run in parallel.
 *
 * Change log:
 *  - apex-bank@1.0.2: screeningWindowDays 7, screeningConcurrency 4.
 *  - apex-bank@1.0.3: compliance directive AML-2026-014 widened the lookback
 *    window to 90 days ahead of the Q2 audit. Screening concurrency was
 *    dropped to 1 at the same time as a temporary workaround for the
 *    screening partner's per-client rate limit (VendorOps ticket VO-8821);
 *    revisit once the partner raises the limit.
 */
module.exports = {
  banking: {
    screeningWindowDays: 90,
    screeningConcurrency: 1,
  },
};
