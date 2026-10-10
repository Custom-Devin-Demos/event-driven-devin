# Vertex tax data lineage

`JURISDICTIONS` in `app/services/verticals/513ad458.js` is the source of truth for Vertex jurisdiction names, currencies, tax types, authorities, and rates.

- The invoice register service reads the seed book in `config/seeds/513ad458-accounts.json` and calculates tax using the current `JURISDICTIONS` values at call time.
- Golden tax cases in `tests/fixtures/513ad458-tax-fixtures.json` cover each jurisdiction and validate authority-level calculations.
- The quarterly Java report engine in `legacy/vertex-report-engine` is a separate, hand-maintained copy of flat per-account percentages. It has no jurisdiction or province field and is not derived from `JURISDICTIONS`, so rates can drift until mirrored manually.
