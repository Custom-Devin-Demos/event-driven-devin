# CAT-SEC Secure Coding Standard — Converge integration services (excerpt)

Applies to every .NET service in the Cat Converge integration layer. Enforced by `npx jest tests/b6e7eac1-catsec-gate.test.js` (fast regex gate, runs first in CI) and by code review.

| Rule | Requirement | Gate |
|---|---|---|
| CAT-SEC-01 | No secrets, keys, SAS tokens or connection strings in source or config files. Use Azure Key Vault references / environment variables (`DEVIN_WEBHOOK_SECRET_B6E7EAC1`, `ServiceBus__ConnectionString`). | regex |
| CAT-SEC-02 | All outbound calls use TLS. `http://` is permitted only for `localhost` / `127.0.0.1`. | regex |
| CAT-SEC-03 | OData `$filter` expressions must be parameterised (typed query builder or escaped literals). No string concatenation or interpolation of caller input into `$filter`. | regex |
| CAT-SEC-04 | Machine serial numbers, VINs and customer PII are never written to logs, Teams, PR descriptions or exception messages. Log contract IDs and event IDs instead. | regex |
| CAT-SEC-05 | Every D365 read or write is scoped to one legal entity (`dataAreaId`); no `cross-company=true` queries. API responses expose only the requested legal entity. | regex + review |
| CAT-SEC-06 | Inbound payloads are validated at the edge; validation failures return `400` with RFC 7807 `ProblemDetails`, never a stack trace. | review + tests |
| CAT-SEC-07 | Dead-letter bodies are retained for replay but are not exported outside the service boundary. | review |

Suppress a false positive on one line with a `// catsec:allow <rule>` comment and a reviewer sign-off.
