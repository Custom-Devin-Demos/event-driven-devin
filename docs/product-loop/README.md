# Acme Commerce self-driving product loop — signals

What the four Devin automations read for Acme Commerce (`checkout-api`). Channels and
automations live in Devin/Slack, not in this repo.

## Signals

| Signal | Source | Value |
|---|---|---|
| Adoption | Datadog metrics (DogStatsD prefix `demo.`, tags `env`, `service`, `version`, `route`, `persona`, `source`) | `demo.checkout.success`, `demo.checkout.failure`, `demo.search.requests`, `demo.login.success`, `demo.orders.lookup` |
| Latency | Datadog metrics | `demo.checkout.latency.95percentile`, `demo.orders.latency.95percentile` |
| Errors | Sentry (`SENTRY_RELEASE=acme-checkout@<sha7>`) and Datadog APM (`service:checkout-api`, `version:<sha7>`) | per-release error counts |
| Release | `Deploy to EC2` workflow (`.github/workflows/deploy.yml`), step "Notify release monitor" | webhook payload below + Datadog event tagged `event:release` |
| Customer issues | Linear project [Acme Commerce product loop](https://linear.app/cog-gtm/project/acme-commerce-product-loop-4a1ab7b6f343) (team `COG`) | Pylon-sourced tickets (`Source: Pylon` line) and fix tickets (`Metric:` line) |
| Feedback | Pylon issues | grouped into the Linear tickets above |

PostHog is not used: adoption comes from the Datadog metrics the app already emits.
Synthetic load (`loadgen/`, header `X-Synthetic`) emits the same metrics with the same
persona names and no synthetic tag, so it cannot be filtered out: read week-over-week
change, not absolute numbers.

## Weekly product review (#product-health)

Week over week, prod only:

```
sum:demo.checkout.success{env:prod,service:checkout-api,route IN (/checkout,/api/storefront/checkout)}.as_count().rollup(sum, 604800)
sum:demo.checkout.failure{env:prod,service:checkout-api,route IN (/checkout,/api/storefront/checkout)}.as_count().rollup(sum, 604800)
sum:demo.search.requests{env:prod,service:checkout-api,route:/search}.as_count().rollup(sum, 604800)
sum:demo.login.success{env:prod,service:checkout-api,route:/login}.as_count().rollup(sum, 604800)
sum:demo.orders.lookup{env:prod,service:checkout-api,route:/orders}.as_count().rollup(sum, 604800)
```

Always keep the `route` filter: every demo vertical in this app reports as
`service:checkout-api` and several reuse these metric names (e.g. Levi's checkout on
`route:/api/46d4846d/checkout`).

Checkout conversion = success / (success + failure). Flag any metric down more than 10%.

Fix verification: list issues in the Linear project *Acme Commerce product loop* completed
last week; each names its metric in a `Metric:` line (e.g.
`Metric: demo.checkout.failure{route:/api/storefront/checkout}` should fall). Compare that
query for the 7 days before and after the fix's deploy (Datadog event `event:release`
whose `version` matches the merge commit).

Top customer issues: open issues in that project with a `Source: Pylon` line, ordered by
number of linked Pylon issues.

## Investigate (#product-health replies)

Break down the flagged metric by `route`, `version`, `errorclass` and `persona`, e.g.

```
sum:demo.checkout.failure{env:prod,service:checkout-api,route IN (/checkout,/api/storefront/checkout)} by {route,errorclass,version}.as_count()
```

then pull matching Sentry issues for release `acme-checkout@<version>`. On "yes fix #N",
open a PR in `COG-GTM/event-driven-devin` (CI: `unit-tests.yml`; Devin Review) and a
Linear issue in the *Acme Commerce product loop* project (team `COG`) with a `Metric:`
line.

## Release monitor (#release-issues)

Triggered by the deploy workflow's webhook (Actions secrets
`RELEASE_MONITOR_WEBHOOK_URL`, optional `RELEASE_MONITOR_WEBHOOK_SECRET` sent as
`X-Webhook-Secret`; optional `DD_API_KEY` adds the Datadog event). Payload:

```json
{
  "event": "release",
  "service": "checkout-api",
  "env": "prod",
  "repository": "COG-GTM/event-driven-devin",
  "sha": "<full sha>",
  "version": "<sha7>",
  "dd_version_tag": "version:<sha7>",
  "sentry_release": "acme-checkout@<sha7>",
  "previous_sha": "<sha of the previous successful deploy>",
  "compare_url": "https://github.com/COG-GTM/event-driven-devin/compare/<prev>...<sha>",
  "merged_prs": [123, 124],
  "deploy_run_url": "https://github.com/COG-GTM/event-driven-devin/actions/runs/<id>",
  "deployed_at": "2026-11-18T20:00:00Z"
}
```

`scripts/deploy-ec2.sh` writes `DD_VERSION`, `APP_VERSION` and
`SENTRY_RELEASE=acme-checkout@<sha7>` to the host `.env`, so new errors can be compared
by version:

```
sum:demo.checkout.failure{env:prod,service:checkout-api,route IN (/checkout,/api/storefront/checkout)} by {version,errorclass}.as_count()
```

and Sentry issues first seen in `acme-checkout@<sha7>`. Attribute each new error to a PR
in `merged_prs` by the files it touched.

## Feedback triage (silent)

Read Pylon issues since the last run, group by product area, and create or update a
Linear issue per group in the *Acme Commerce product loop* project (team `COG`), with a
`Source: Pylon` line and a link to each Pylon issue.
