# UKG Pro Payroll Gateway — pay run run sheet

Flow 1 (alert → Slack → Devin → PR) for a UKG audience, built to the same shape
as the CommBank NetBank demo (`docs/DEMO-CBA-NETBANK.md`). The talk track is:
*a production payroll failure raises itself, Devin investigates without anyone
steering it, and the result comes back as a PR your engineers review.*

- Page: `/ukg` (aliases `/ukgpro`, `/e33c0578`) — unlisted, not on the hub
- Endpoints: `GET /api/e33c0578/pay-run`, `POST /api/e33c0578/pay-run`
- Service: `app/services/verticals/e33c0578.js`
- Route: `app/routes/verticals/e33c0578.js`
- Page source: `app/public/verticals/e33c0578.html`
- Customer slug: `e33c0578` (`DEVIN_API_KEY_E33C0578`, `DEVIN_USER_ID_E33C0578`,
  `UKG_SLACK_MEMBER_ID`)

## The scenario

Riverbend Health System runs semi-monthly payroll for pay group
`PG-US-SEMI-01` in UKG Pro. Timecards are approved; the payroll admin is on the
final **Review & submit** step, which converts worked hours into gross pay and
releases funding instructions to treasury.

Riverbend opened a new site this period — Northgate Surgery Center. Its
weekend-rotation work rule was created in Workforce Management and assigned to
staff, but the matching rule was never added to the payroll rule set. One
employee in the pay group (Grace Okonkwo, surgical tech, `US-WEEKEND-ROTATION`)
therefore has hours that payroll cannot price.

`submitPayRun()` → `calculateGrossPay()` → `resolveWorkRule()` returns
`undefined` →
`TypeError: Cannot read properties of undefined (reading 'shiftDifferential')`.

The whole pay run fails on **Submit pay run**; nothing is released to treasury.
It is a configuration/rollout gap between two modules rather than a generic null
dereference, which is what makes it read as a real payroll incident to a UKG
audience: one unmapped work rule blocks pay for every employee in the group.

## Run it

1. `PORT=3100 node app/server.js`, open `http://localhost:3100/ukg`.
2. The pay run is pre-loaded: 6 employees, 392 regular hours, 26.5 premium
   hours, ~$20,996 estimated gross, pay date Sep 20 2026. Grace Okonkwo's row
   shows the **New location** flag and the raw `US-WEEKEND-ROTATION` work rule —
   every other row shows a human-readable rule name.
3. Click **Submit pay run**. The red "We couldn't submit this pay run" panel
   shows the `TypeError`, the `PAY_RUN_SUBMISSION_FAILED` code and a reference
   ID.
4. Behind it: Sentry captures the exception, Datadog records
   `pay_run.submission_failure` / `pay_run.submission_latency`, an alert card
   posts to Slack, and a Devin session is created from the alert with
   `REMEDIATION_DIRECTIVE` appended — scoped to this route only.
5. Devin reproduces the failure, registers the missing work rule (and turns an
   unknown work rule into a handled payroll error rather than a crash), verifies
   the same pay run submitting successfully, and opens a PR.

Happy path for contrast (no alert fires): un-tick **Include** for Grace Okonkwo
and submit — the remaining five employees price normally and the page returns a
confirmation ID, pay date and total gross.

```bash
# fails (full pay group — includes the unmapped work rule)
curl -s -X POST localhost:3100/api/e33c0578/pay-run \
  -H 'Content-Type: application/json' \
  -d '{"payGroupId":"PG-US-SEMI-01","employeeIds":["E-100341","E-100503"]}'

# succeeds (registered work rules only)
curl -s -X POST localhost:3100/api/e33c0578/pay-run \
  -H 'Content-Type: application/json' \
  -d '{"payGroupId":"PG-US-SEMI-01","employeeIds":["E-100341","E-100388"]}'
```

## What the fix looks like

`WORK_RULES` in `app/services/verticals/e33c0578.js` has no
`US-WEEKEND-ROTATION` entry. A correct fix registers that rule *and* stops one
unmapped rule from taking down the whole run — surfacing it as a validation
error naming the employee and rule, instead of a `TypeError`. Existing rules
must keep producing identical amounts; `tests/e33c0578-pay-run.test.js` pins
both the current failure and the post-fix behaviour:

```bash
npx jest tests/e33c0578-pay-run.test.js --runInBand
npm run lint
```

## Skinning notes

The page recreates the UKG Pro product chrome rather than the ukg.com marketing
site: UKG green `#005151` sidebar, DM Sans (the typeface ukg.com serves from
`/themes/custom/ukg_theme/fonts/`), and the UKG wordmark drawn from the official
`https://www.ukg.com/themes/custom/ukg_theme/logo.svg` paths, recoloured white
on the green rail. The product screen itself is a constructed illustration of a
payroll review step — it is not a capture of UKG Pro, which is behind customer
login — so treat the layout as representative, not as UKG's actual UI. Riverbend
Health System, its employees and all amounts are fictional.

## Reset

Nothing to reset: the failure is deterministic and stateless. Every submission
that includes employee `E-100503` fails the same way, and each one raises a
fresh Sentry event, Slack alert and Devin session.
