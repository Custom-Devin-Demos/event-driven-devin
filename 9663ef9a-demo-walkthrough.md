# Fleet health demo — what I say

**One-liner:** I am looking at a mine's truck health console. One sweep turns truck readings into maintenance priorities.

## The opening screen
I can see ten trucks online, four driving autonomously, four incoming warnings, and 96.8% availability. This is a fictional mine, not a customer's live system.

## The fleet
On the left, I see each truck's engine hours, load weight and coolant temperature. Four trucks have the autonomy kit and send the newer telemetry format — the structure of the readings they transmit.

On the right, I see the warnings waiting to be assessed. The numbered codes identify a sensor and the kind of fault it reports. Two examples are high coolant temperature and low exhaust-treatment fluid.

## The moment
I click **Run health sweep**. The console should score these warnings and prepare work orders. Instead, I get a red error and the sweep fails. No partial work orders are published.

## What happens next
The service reports the exception to Sentry and sends failure metrics to Datadog. It invokes the configured Slack and Devin alert flow. In a configured environment, Devin investigates why the two reading formats disagree, proposes a fix, and opens a pull request with a regression test for a human to review. It does not deploy the change.

## Why this matters
The story is autonomy deployments in weeks, followed by continuous updates. Engineers are the capacity constraint. Devin adds engineering capacity so a small compatibility issue does not hold up the next rollout.

## Honest caveat
We built this from public information, not internal product screens or live mine data. The fleet and readings are synthetic.

## Reset
I click the small **Reset** link beside the sweep status. The console returns to Ready for the next run.
