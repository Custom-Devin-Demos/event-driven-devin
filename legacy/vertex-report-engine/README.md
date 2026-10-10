# Legacy quarterly tax-liability report engine

Legacy quarterly tax-liability report engine (Java 11). Predates the Vertex tax engine. Keeps its **own copy of the tax rules**: a flat per-account percentage in account-tax-rates.properties — no jurisdiction or province, not derived from JURISDICTIONS in app/services/verticals/513ad458.js. Rate changes are mirrored by hand, so the two can drift.

Build and test:

```sh
mvn -q -f legacy/vertex-report-engine/pom.xml test
```

Run a quarterly CSV report with `accountId,subtotal` rows:

```sh
mvn -q -f legacy/vertex-report-engine/pom.xml package
java -cp legacy/vertex-report-engine/target/classes com.vertex.legacy.report.TaxLiabilityReport quarterly-invoices.csv
```
