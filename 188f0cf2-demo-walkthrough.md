# Customer account demo — what I say

**One-liner:** This is a household waste-service account page. I’m going to report a missed pickup, watch the request break, and show how Devin helps the team respond.

## Screen 1 — My account
What I’m looking at is My Bluepoint, a fictional customer portal. I see Alex’s address, an active account, and the next trash, recycling, and yard-waste pickups. This is the kind of page a customer opens instead of calling customer care.

## Screen 2 — Service schedule and pickup history
I use the navigation to jump to the service schedule and pickup history. I see the next collection dates and three recent visits. Recycling says “Service exception,” which means the driver recorded a problem rather than a completed pickup.

## Screen 3 — Get help
I go to Get help. Recycling and November 17 are already selected. Say I’m Alex and my recycling is still outside. I click **Submit report**. Boom — a red message says the report couldn’t be submitted. I have no confirmation that anyone is coming back.

## What happens next
With the alert connections configured, the error is captured in Sentry, counted in Datadog, and an alert lands in Slack. Devin opens an investigation session. I follow it from the failed customer request back to the driver route app’s stop record. The tablet recorded “container not out,” but the explanation is blank. The claims service tries to read that missing explanation and crashes.

I watch Devin make the incomplete record safe to handle, route uncertain claims for a person to review, and add tests. Devin opens a pull request — a proposed code change for a human to approve — with a plain-English explanation of what failed and why. It does not merge or deploy the change.

## Why this matters
For a CIO, this connects a broken customer experience to its operational source, with evidence and a reviewable fix instead of a long handoff between teams.

## Honest caveat
We built this from public information about how waste collection works, not anyone’s internal systems. The brand, household, and records are fictional. Local verification does not send live alerts without configured credentials.

## Reset
I click the small **Reset** link under the report form. The error clears and the opening selections return, ready for the next run.
