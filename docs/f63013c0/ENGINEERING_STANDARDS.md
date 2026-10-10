# Digital Commerce — Engineering Standards (payments and integrations)

1. Validate every third-party response against a schema. Contract tests must be built
   from the vendor's published examples and must fail on unknown breaking changes.
2. Every payment mutation (authorize, capture, refund, void) carries an Idempotency-Key
   derived from the order reference.
3. No card data or personal data in logs. Log order IDs and vendor references only.
4. Customer-facing errors map to a known error code and never expose internals.
5. Every change on the payment path ships with a regression test for the failure it fixes.
