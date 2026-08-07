/**
 * On-Call demo customer skins.
 *
 * A skin generates ONE customer-branded product page for a specific prospect
 * without touching any mechanics. /oncall/c/<slug> serves the skin's chosen
 * vertical page (skin.vertical) rebranded with the customer's name, mark, and
 * theme, with the on-call shim active — that single URL is what a DE shares.
 * /oncall/c/<slug>/report serves the matching branded support portal. The
 * generic /oncall hub itself is never skinned. Adding a customer = adding one
 * entry here.
 *
 * Slugs are anonymous 8-char hex ids (generate with `openssl rand -hex 4`),
 * never the customer's name, so shared URLs don't leak who a demo is for.
 * Customer names appear only in rendered copy values, not in slugs, keys,
 * identifiers, or comments.
 *
 * What we deliberately do NOT personalize: telemetry service names, monitor
 * queries' service tags, and repo references in Slack investigation copy —
 * the responder investigates the repo that REPO_URL (app/services/oncall.js)
 * points at, so those must stay truthful for the investigation to be
 * believable.
 *
 * Bug portal templates reference existing BUG_CATALOG template ids (see
 * app/services/oncall.js) so backend-symptom reports keep activating the
 * matching real degradation; only the customer-facing copy changes.
 */

const ONCALL_SKINS = {
  '8cc190d2': {
    slug: '8cc190d2',
    company: 'Brex',
    brandMark: 'B',
    vertical: 'banking',
    page: {
      title: 'Brex — Business Account',
      theme: {
        '--navy': '#211b18',
        '--navy-light': '#3a2f28',
        '--gold': '#F46A35',
        '--gold-dim': 'rgba(244,106,53,0.08)',
      },
    },
    accent: '#F46A35',
    accentDark: '#d9552a',
    theme: {
      '--accent': '#F46A35',
      '--ink': '#241c18',
      '--surface': '#fffdfb',
      '--chrome-bg': '#211b18',
      '--chrome-text': '#fff8f2',
    },
    supportCenter: 'Brex Support',
    supportCenterSub: 'Customer Care & Incident Intake',
    disclaimer: 'Internal demo only — not affiliated with, endorsed by, or a real Brex product.',
    bugPortal: {
      products: [
        {
          area: 'banking',
          label: 'Brex Business Account \u2014 Transfers',
          persona: { name: 'Dana Whitfield', email: 'dana.whitfield@brightmail.io', sev: 'High' },
          templates: [
            {
              id: 'banking-transfer-slow',
              label: 'Transfers extremely slow',
              sev: 'High',
              text: 'Hey team \u2014 transfers from the business account take about ten seconds now. The spinner sits there on every single transfer before it finally completes. Any amount, both accounts. Multiple people on our side hit this today.',
            },
            {
              id: 'banking-payroll-cutoff',
              label: 'Payroll batch missing cutoff',
              sev: 'Critical',
              text: 'Escalating: our payroll batch runs transfers one after another and each one now takes ~10 seconds, so the batch will miss the wire cutoff. Nothing errors \u2014 it is just painfully slow, and it was fine on Friday. Please treat as urgent.',
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
