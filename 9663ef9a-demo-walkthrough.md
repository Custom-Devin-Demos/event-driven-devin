# Fleet firmware rollout — my three-minute walkthrough

## 0:00–0:40 · Select the mine sites
I open `/9663ef9a`, the firmware deployment screen for Copper Ridge Operations. This is a fictional operation with four mine sites, not a live equipment control system or an internal product screen.

I have ten haul trucks running across North, East, South and West. Six are operator-driven; four are third-party trucks with OEM autonomy kits. Each site shows its truck count. I select all four sites for this deployment. Nothing has been sent to the trucks yet: I'm defining the scope.

## 0:40–1:20 · Review and authorize
Autonomy deployments are being promised in weeks, not years. But deployment isn't the finish line: those trucks need continuous software updates too.

I click **Review scope**. I can see ten trucks across four sites, broken down by OEM and model, with the current firmware beside the target: autonomy telemetry firmware 4.8. This is a chance to catch the wrong site or the wrong fleet before deploying. I can change sites without sending an update.

I continue to confirmation. The dialog asks me to deploy to ten trucks across four sites. Only when I click **Deploy firmware 4.8** does the rollout start.

## 1:20–2:20 · Inspect the result and follow Teams
Four third-party autonomous trucks now show **Telemetry lost – safe-stopped**. Six trucks remain running. The inline error reports a telemetry problem after deployment. The safety behavior worked; this isn't a runaway-equipment story. But four unavailable trucks matter to this shift, and I need engineering help before proceeding.

I switch to the configured Teams channel. The failure is captured in Sentry and metrics in Datadog. One alert is dispatched for the failed deployment, not one per truck. The Teams responder investigates in that alert's thread.

I follow the investigation, supporting evidence and proposed pull request. I want reproduction, a reviewed change, regression coverage and verification of the selected fleet. A human still reviews the PR. Nothing automatically deploys a repair or authorizes equipment to move.

If no responder update has arrived, I say so: an accepted alert alone isn't proof of an investigation. This depends on the configured Teams webhook and automation; the shared Slack fallback remains if the webhook is absent.

## 2:20–3:00 · Capacity and reset
The point isn't that software updates should stop. Continuous updates are part of the promise of autonomy. Engineering capacity is the constraint: compatibility issues compete with the next release and the next deployment. Devin adds capacity to investigate and prepare reviewed changes while the team stays in control.

I return and click **Reset** beside the failed deployment status. The synthetic fleet is running again, the site selection is cleared and the screen is Ready. This restores the opening state, not the software. For another run, I select the sites, review the scope and authorize the deployment again.
