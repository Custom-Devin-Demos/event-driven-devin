# Fleet firmware rollout — my three-minute walkthrough

## 0:00–0:40 · Fleet overview
I open `/9663ef9a`. This is Copper Ridge, a fictional surface mine. I'm showing a demonstration console, not a live control system or an internal product screen.

I have ten haul trucks running. Six are operator-driven; four are third-party trucks running OEM autonomy kits. The mixed fleet feeds into one health view through a telemetry adapter. On the left I can see the trucks, engine hours, payload and status. On the right I can see exactly which four trucks are targeted for the next firmware release.

## 0:40–1:20 · Roll out the update
Autonomy deployments are being promised in weeks, not years. But deployment isn't the finish line: those trucks need continuous software updates too.

I click **Roll out OEM firmware update**. This applies release 4.8 only to the four autonomous trucks. Now four trucks show **Telemetry lost – safe-stopped**. Six trucks remain running. The red message tells me the adapter couldn't read vehicle data after the update.

The trucks have stopped safely; this isn't a runaway-equipment story. But four unavailable trucks matter to this shift. I need an engineer to investigate before I can confidently resume this rollout.

## 1:20–2:20 · Follow the investigation in Teams
I switch to the configured Teams alert channel. The console reports the failure to Sentry and records metrics in Datadog. One alert is dispatched per click. The Teams responder investigates in the alert's thread rather than starting a second, separate app-side session.

I follow that thread for the investigation, supporting evidence and proposed pull request. I want the engineer to reproduce the failure, make the change, add regression coverage and verify the rollout. A human still reviews the PR. Nothing here automatically deploys a repair or authorizes equipment to move.

If a responder update hasn't arrived yet, I say so. An accepted alert alone isn't evidence that the investigation has started. This part depends on the configured webhook and Teams automation; without the shared webhook the app retains its Slack fallback.

## 2:20–3:00 · Capacity and reset
The point isn't that software updates should stop. Continuous updates are part of the promise of autonomy. Engineering capacity is the constraint: compatibility issues compete with the next release and the next deployment. Devin adds capacity to investigate and prepare reviewed changes while the team stays in control.

I return to the console and click the small **Reset** beside the failed rollout status. All ten trucks are running again in this synthetic fleet and the rollout is Ready. Reset restores the opening demonstration state; it does not repair the software. I can click the rollout again for the next audience.
