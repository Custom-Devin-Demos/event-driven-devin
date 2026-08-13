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
  '8bdcfab6': {
    slug: '8bdcfab6',
    company: 'Robinhood',
    brandMark: 'R',
    vertical: 'banking',
    page: {
      // Natively branded custom page: served instead of the vertical's stock
      // page; the brand shim skips the title/logo rewrite for it.
      file: '8bdcfab6.html',
      title: 'Robinhood Banking',
    },
    accent: '#00C805',
    accentDark: '#00a304',
    theme: {
      '--accent': '#00C805',
      '--ink': '#111111',
      '--surface': '#ffffff',
      '--chrome-bg': '#000000',
      '--chrome-text': '#ffffff',
    },
    supportCenter: 'Robinhood Support',
    supportCenterSub: 'Customer Care & Incident Intake',
    disclaimer: 'NOT ACTUALLY A ROBINHOOD SITE — internal demo only, not affiliated with, endorsed by, or a real Robinhood product.',
    bugPortal: {
      products: [
        {
          area: 'banking',
          label: 'Robinhood Banking \u2014 Transfers',
          persona: { name: 'Marcus Delgado', email: 'marcus.delgado@brightmail.io', sev: 'High' },
          templates: [
            {
              id: 'banking-transfer-slow',
              label: 'Transfers stuck on a spinner',
              sev: 'High',
              text: 'Transfers between my banking and brokerage accounts are supposed to be instant, but every transfer sits on a spinner for about ten seconds before it completes. Tried different amounts and both directions \u2014 same thing every time. Started today.',
            },
            {
              id: 'banking-payroll-cutoff',
              label: 'Recurring transfers running late',
              sev: 'Critical',
              text: 'Escalating: my scheduled recurring transfers run one after another and each one now takes ~10 seconds, so the whole batch is finishing way later than usual. Nothing fails \u2014 it is just painfully slow, and it was fine yesterday. During market hours this really matters.',
            },
          ],
        },
      ],
    },
  },
  '704831b7': {
    slug: '704831b7',
    company: 'Hippocratic AI',
    brandMark: 'H',
    vertical: 'hightech',
    page: {
      // Natively branded custom page: served instead of the vertical's stock
      // page; the brand shim skips the title/logo rewrite for it.
      file: '704831b7.html',
      title: 'Hippocratic AI — Agent Deployment Console',
    },
    accent: '#15CC44',
    accentDark: '#10a838',
    theme: {
      '--accent': '#15CC44',
      '--ink': '#10163A',
      '--surface': '#ffffff',
      '--chrome-bg': '#0E2FAE',
      '--chrome-text': '#f2f6ff',
    },
    supportCenter: 'Hippocratic AI Support',
    supportCenterSub: 'Deployment Support & Incident Intake',
    disclaimer: 'NOT ACTUALLY A HIPPOCRATIC AI SITE — internal demo only, not affiliated with, endorsed by, or a real Hippocratic AI product.',
    bugPortal: {
      products: [
        {
          area: 'hightech',
          label: 'Agent Deployment Console \u2014 Campaign Provisioning',
          persona: { name: 'Priya Raghavan', email: 'priya.raghavan@brightmail.io', sev: 'High' },
          templates: [
            {
              id: 'hightech-provision-slowdown',
              label: 'Campaign provisioning noticeably slow',
              sev: 'Medium',
              text: 'Our deployment team flagged that provisioning a new outreach campaign in the console is painfully slow \u2014 every request sits for seven or eight seconds before completing. Nothing fails, it just crawls, and it seems to get a little worse with every campaign we provision.',
            },
            {
              id: 'hightech-renewal-slow',
              label: 'Cohort expansion crawling before go-live',
              sev: 'High',
              text: 'Clinical ops here \u2014 our health system goes live Monday and we are expanding the chronic care cohort by a couple hundred patients. Every provisioning call in the console sits there for ages before completing. The program director is on our call asking if the platform is falling over.',
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
