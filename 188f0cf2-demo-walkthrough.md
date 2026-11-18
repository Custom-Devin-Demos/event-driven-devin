# Enterprise missed service demo: what I say

**One-liner:** This is the customer portal a big hospital network uses to manage waste service across 42 locations. I'm going to report a missed pickup at their main hospital, watch the report break, and show how Devin handles the on-call response.

## Screen 1: Today's collection
This is Northfield Health, a made-up hospital network, as their facilities director Dana sees it. The big blue card is this morning's trash and recycling run: 37 of 42 sites picked up, 61 tons collected, five trucks out on their routes, and one missed pickup. Below it are the month's numbers: tons collected, how much got recycled, and on-time service at 98.7% against a 99% contract target.

## Screen 2: The missed pickup
On the right, in coral, is the problem. The dumpster at the main hospital's loading dock was due at 5 AM and never got emptied. The contract says any missed pickup is recovered within 24 hours or credited. At a hospital that isn't a small thing. The dumpster overflows, it's a health and safety issue, and it counts against the contract.

## Screen 3: Sites and pickups
In the site table, Northfield Medical Center says **Missed pickup**, while the children's hospital down the road was serviced at 5:34. The weights come from the truck's scale, and the compactor's fill level comes from its own pressure sensor. Today's pickups shows the same story as a timeline: 5:00 AM, not serviced.

## Screen 4: Report a missed service
Dana does the right thing and reports it herself. Main hospital, front-load dumpster, today. I click **Submit report**. Boom, it fails: "We couldn't submit your report." No recovery pickup gets scheduled and no credit is applied. Now she's calling her account manager.

## The moment
This isn't one customer. Every enterprise customer whose missed stop came from the new driver app version hits the same wall, at every site, all morning. That's the blast radius: reports fail, recovery trips aren't scheduled, guarantee clocks keep running, and account managers' phones light up.

## What happens next
The error is captured and an alert lands in the on-call Slack channel. Devin picks it up right away, nobody gets paged at 2 AM. It follows the failed report back to the driver's stop record. The driver's tablet marked the stop "blocked" but sent no reason. The portal assumed there would always be one, and crashed.

Devin works out which reports and sites were affected, makes incomplete driver records go to a person for review instead of crashing, adds tests, and opens a pull request with a plain-English root cause. A human approves it. Devin doesn't merge or deploy anything itself.

## Why this matters
One team's app change quietly broke another team's customer-facing system, and the cost lands on your biggest contracts. Devin connects the customer symptom to the real cause in minutes, with evidence and a fix ready for review, instead of a day of tickets bouncing between teams.

## Honest caveat
The brand, customer, sites and numbers are all made up. They're built from how commercial waste service generally works, not from anyone's internal systems or contracts.

## Reset
After the failure I click the small **Reset** link under the form. It goes back to the opening state, ready for the next run.
