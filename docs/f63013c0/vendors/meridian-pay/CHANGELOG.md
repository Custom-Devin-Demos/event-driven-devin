# Meridian Pay — API changelog

## 2026-10 (effective 5 October 2026)
- BREAKING: `paymentId` in authorization responses is renamed `pspReference`.
- Clients should send an `Idempotency-Key` header on POST /v1/payments to make retries safe.
- Example response: { "status": "AUTHORISED", "pspReference": "psp_…", "amount": 568.00, "currency": "USD" }

## 2025-06
- Initial v1 payments API; authorization responses return `paymentId`.
- Example response: { "status": "AUTHORISED", "paymentId": "psp_…", "amount": 568.00, "currency": "USD" }
