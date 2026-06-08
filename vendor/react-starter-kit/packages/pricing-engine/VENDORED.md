# Vendored: `@repo/pricing-engine`

This directory is a **vendored CommonJS build** of the `@repo/pricing-engine`
package that lives in a **separate repository**:

> **Source:** `COG-GTM/react-starter-kit` → `packages/pricing-engine/`
> (`catalog.ts`, `pricing.ts`, `receipt.ts`, `index.ts`)

The Home Depot vertical (`app/services/verticals/homedepot.js`) `require()`s this
package for catalog lookups, tax/discount math, and receipt formatting. The
event-driven-devin app is plain CommonJS Node and runs on EC2 where the
react-starter-kit monorepo is **not** present, so the package is vendored here
(rather than imported from a sibling clone) to keep `require()` resolvable both
locally and in the production Docker image.

## Why this matters for the demo

The latent checkout bug does **not** live in this repo. It originates in the
shared library in `react-starter-kit`: `formatLineItems()` in `receipt.ts`
assumes every cart SKU exists in `CATALOG_BY_SKU` and dereferences
`product.name` without a guard. When the Home Depot checkout injects the
`HD-PROXTRA-REWARD` loyalty SKU (which is not a catalog product), the lookup
returns `undefined` and the access throws a `TypeError` — surfaced here via the
import chain `homedepot.js → buildCheckoutReceipt → formatLineItems`.

The triggered Devin session must trace this import chain across the repo
boundary and patch the **root cause in `COG-GTM/react-starter-kit`**, not the
vendored copy.

## Keeping in sync

This is a faithful 1:1 port of the TypeScript source (same functions, same
structure, same bug). If the upstream package changes, re-port the `.ts` files
to CommonJS here. There is intentionally no build tooling — the files are small
and hand-maintained to keep the demo dependency-free.
