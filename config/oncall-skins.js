/**
 * On-Call demo customer skins.
 *
 * A skin re-brands the /oncall demo experience (page chrome, incident card
 * copy, support portal products/templates) for a specific prospect without
 * touching any mechanics: incident modes, auto-revert, Slack routing, and the
 * template → repro mapping are shared code. Adding a customer = adding one
 * entry here. Served at /oncall/c/<slug> and /oncall/c/<slug>/report.
 *
 * What we deliberately do NOT personalize: telemetry service names, monitor
 * queries' service tags, and repo references in Slack investigation copy —
 * the responder investigates the real COG-GTM/event-driven-devin repo, so
 * those must stay truthful for the investigation to be believable.
 *
 * Bug portal templates reference existing BUG_CATALOG template ids (see
 * app/services/oncall.js) so backend-symptom reports keep activating the
 * matching real degradation; only the customer-facing copy changes.
 */

const ONCALL_SKINS = {
  brex: {
    slug: 'brex',
    company: 'Brex',
    brandMark: 'B',
    accent: '#F46A35',
    accentDark: '#d9552a',
    supportCenter: 'Brex Support',
    supportCenterSub: 'Customer Care & Incident Intake',
    heroTitle: 'BREX ON-CALL',
    heroSub:
      "Fire production-style events against the Brex demo stack and watch Devin's On-Call responders investigate on their own. No @mentions, no API calls — the responders just show up.",
    disclaimer: 'Internal demo only — not affiliated with, endorsed by, or a real Brex product.',
    infra: {
      latency: {
        title: 'DB Latency Spike',
        desc: 'Transaction search in the Brex dashboard genuinely slows to 1.5\u20133s \u2014 watch the live probe climb. Error rate stays normal \u2014 a degradation, not an outage.',
      },
      'dependency-timeout': {
        title: 'Card Network Timeouts',
        desc: 'The card-network dependency starts timing out intermittently \u2014 most payment authorizations succeed, some see a spinner then a 502. Watch the live success rate in the strip above.',
      },
      'memory-leak': {
        title: 'Memory Leak',
        desc: 'Process memory genuinely climbs (bounded and auto-freed at window end) \u2014 watch the live RSS number rise in the strip above while the responder sees real memory growth in Datadog.',
      },
      'slo-burn': {
        title: 'SLO Fast Burn',
        desc: 'Intermittent payment failures burn the availability error budget \u2014 the burn rate pages before the raw error alert would. Watch the live success rate in the strip above.',
      },
    },
    bugPortal: {
      products: [
        {
          area: 'retail',
          label: 'Brex Dashboard \u2014 Payments & Cards',
          persona: { name: 'Maya Sorensen', email: 'maya.sorensen@parcelworks.co', sev: 'Medium' },
          templates: [
            {
              id: 'retail-slow-search',
              label: 'Transaction search painfully slow',
              sev: 'Medium',
              text: "Is something wrong with the dashboard? Searching transactions takes like 3 seconds now \u2014 the spinner just sits there. It was instant last week. No errors, just really, really slow. I timed it: filtering by vendor took 2.8s to show results.",
            },
            {
              id: 'retail-checkout-hangs',
              label: 'Payments hang then error',
              sev: 'High',
              text: 'Trying to send a payment and about every third attempt it just hangs for ages and then shows a gateway error. If I retry immediately it usually goes through. Started within the last hour \u2014 my colleague sees the same thing from her account.',
            },
            {
              id: 'retail-orders-failing',
              label: 'Payments randomly failing',
              sev: 'High',
              text: "Payments are failing roughly half the time \u2014 sometimes it mentions limits, sometimes it's just a generic error. Retrying works eventually but our AP team is falling behind. Nothing changed on our side.",
            },
            {
              id: 'retail-site-sluggish',
              label: 'Dashboard getting slower over time',
              sev: 'Medium',
              text: "Not an outage, but the dashboard feels like it gets more sluggish the longer the day goes on \u2014 pages that were snappy this morning are noticeably laggy now. A refresh doesn't help. Feels like the server itself is running out of steam.",
            },
          ],
        },
        {
          area: 'banking',
          label: 'Brex Business Account \u2014 Transfers',
          persona: { name: 'Dana Whitfield', email: 'dana.whitfield@brightmail.io', sev: 'High' },
          templates: [
            {
              id: 'banking-transfer-failed',
              label: 'Transfers failing',
              sev: 'High',
              text: 'Hey team \u2014 our controller says transfers from the business account keep failing. Just a red "Transfer Failed" box every time, any amount, both accounts. Multiple people on our side hit this today.',
            },
            {
              id: 'banking-transfer-stuck',
              label: 'Payroll transfer blocked',
              sev: 'Critical',
              text: 'Escalating: we cannot move our payroll funding from the operating account \u2014 the website shows an error box every single time and payroll runs tomorrow. Tried two browsers and two admins, same red failure message. Please treat as urgent.',
            },
          ],
        },
      ],
    },
  },
};

function getOncallSkin(slug) {
  if (!slug || typeof slug !== 'string') return null;
  const key = slug.toLowerCase();
  return Object.prototype.hasOwnProperty.call(ONCALL_SKINS, key) ? ONCALL_SKINS[key] : null;
}

module.exports = { ONCALL_SKINS, getOncallSkin };
