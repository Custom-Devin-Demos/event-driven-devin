/**
 * On-Call demo customer skins.
 *
 * A skin generates ONE customer-branded product page for a specific prospect
 * without touching any mechanics. /oncall/c/<slug> serves the skin's chosen
 * vertical page (skin.vertical) rebranded with the customer's name, mark, and
 * theme, with the on-call shim active — that single URL is what a DE shares.
 * /oncall/c/<slug>/report serves the matching branded support portal, and
 * /oncall/c/<slug>/incident serves an opted-in incident console. The alerts
 * surface is enabled by default; bugPortal and incident are optional opt-in
 * surfaces. An incident may optionally define chatter.vocabulary as a flat
 * source-phrase-to-replacement map. The generic /oncall hub itself is never
 * skinned. Adding a customer = adding one entry here.
 *
 * Two separate theme keys, one per surface: page.theme themes the stock
 * vertical page served through the brand shim, while the top-level theme
 * themes the report portal and incident console. For stock-page skins without
 * page.file, the top-level theme falls back into the page shim too, so a
 * stock-page skin needs just one theme block. A natively branded page keeps
 * its own palette and is never overridden by the portal theme; set page.theme
 * only when the page needs different variables from the portal surfaces.
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
 *
 * A skin may set trigger: { kind: 'bug', templateId, persona, severity,
 * productArea } to make its page's primary action file a human-style support
 * ticket in #oncall-bugs (via /api/oncall/bug) instead of posting the
 * monitor-style alert card to #oncall-alerts. templateId must exist in
 * BUG_CATALOG. Two skins can share one page file to offer both flavors.
 */

const ONCALL_SKINS = {
  '8cc190d2': {
    slug: '8cc190d2',
    company: 'Brex',
    brandMark: 'B',
    vertical: 'banking',
    page: {
      // Natively branded custom page: served instead of the vertical's stock
      // page; the brand shim skips the title/logo rewrite for it.
      file: '8cc190d2.html',
      title: 'Brex — Business Banking',
    },
    accent: '#FF3D00',
    accentDark: '#d93400',
    theme: {
      '--accent': '#FF3D00',
      '--ink': '#15191E',
      '--surface': '#ffffff',
      '--chrome-bg': '#000710',
      '--chrome-text': '#fcfcfd',
    },
    supportCenter: 'Brex Support',
    supportCenterSub: 'Customer Care & Incident Intake',
    disclaimer: 'NOT ACTUALLY A BREX SITE — internal demo only, not affiliated with, endorsed by, or a real Brex product.',
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
  '70d04b0f': {
    slug: '70d04b0f',
    company: 'Cyera',
    brandMark: 'C',
    vertical: 'hightech',
    page: {
      // Natively branded custom page: served instead of the vertical's stock
      // page; the brand shim skips the title/logo rewrite for it.
      file: '70d04b0f.html',
      title: 'Cyera — Data Security Platform',
    },
    accent: '#6D2D93',
    accentDark: '#441363',
    theme: {
      '--accent': '#6D2D93',
      '--ink': '#160923',
      '--surface': '#ffffff',
      '--chrome-bg': '#160923',
      '--chrome-text': '#f6f5f1',
    },
    supportCenter: 'Cyera Support',
    supportCenterSub: 'Customer Care & Incident Intake',
    disclaimer: 'NOT ACTUALLY A CYERA SITE — internal demo only, not affiliated with, endorsed by, or a real Cyera product.',
  },
  '71dff37b': {
    slug: '71dff37b',
    company: 'Point72',
    brandMark: 'P',
    vertical: 'banking',
    page: {
      // Natively branded custom page: served instead of the vertical's stock
      // page; the brand shim skips the title/logo rewrite for it.
      file: '71dff37b.html',
      title: 'Point72 — Execution Desk',
    },
    accent: '#4D1A04',
    accentDark: '#3a1403',
    theme: {
      '--accent': '#4D1A04',
      '--ink': '#18181A',
      '--surface': '#F5F4EE',
      '--chrome-bg': '#18181A',
      '--chrome-text': '#F5F4EE',
    },
    supportCenter: 'Point72 Support',
    supportCenterSub: 'Trading Operations & Incident Intake',
    disclaimer: 'NOT ACTUALLY A POINT72 SITE — internal demo only, not affiliated with, endorsed by, or a real Point72 product.',
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
  '2ab8a463': {
    slug: '2ab8a463',
    company: 'You.com',
    brandMark: 'Y',
    vertical: 'hightech',
    page: {
      // Natively branded custom page: served instead of the vertical's stock
      // page; the brand shim skips the title/logo rewrite for it.
      file: '2ab8a463.html',
      title: 'You.com — API Platform',
    },
    accent: '#5368EE',
    accentDark: '#3f53d8',
    theme: {
      '--accent': '#5368EE',
      '--ink': '#121212',
      '--surface': '#ffffff',
      '--chrome-bg': '#222B5F',
      '--chrome-text': '#ffffff',
    },
    supportCenter: 'You.com Support',
    supportCenterSub: 'Developer Support & Incident Intake',
    disclaimer: 'NOT ACTUALLY A YOU.COM SITE — internal demo only, not affiliated with, endorsed by, or a real You.com product.',
    bugPortal: {
      products: [
        {
          area: 'hightech',
          label: 'API Platform \u2014 Capacity Provisioning',
          persona: { name: 'Devon Ashcroft', email: 'devon.ashcroft@brightmail.io', sev: 'High' },
          templates: [
            {
              id: 'hightech-provision-slowdown',
              label: 'Provisioning capacity is slow',
              sev: 'Medium',
              text: 'Provisioning rate-limit capacity in the API Platform is crawling \u2014 every request sits for seven or eight seconds before the key comes back. Nothing errors, and it seems to get a bit worse with each endpoint we provision.',
            },
            {
              id: 'hightech-renewal-slow',
              label: 'Bulk key provisioning stalling before launch',
              sev: 'High',
              text: 'Platform team here \u2014 we ship our agent to production Monday and are provisioning keys and QPS for four endpoints across two regions. Every provisioning call in the console hangs for ages before it completes, so the whole rollout is behind. Our launch reviewer is asking whether the platform is healthy.',
            },
          ],
        },
      ],
    },
  },
  'e7c9dc7a': {
    slug: 'e7c9dc7a',
    company: 'DoorDash',
    brandMark: 'D',
    vertical: 'banking',
    page: {
      // Natively branded custom page: served instead of the vertical's stock
      // page; the brand shim skips the title/logo rewrite for it.
      file: 'e7c9dc7a.html',
      title: 'DoorDash — Dasher Earnings',
    },
    accent: '#EB1700',
    accentDark: '#c41300',
    theme: {
      '--accent': '#EB1700',
      '--ink': '#191919',
      '--surface': '#ffffff',
      '--chrome-bg': '#4C0C3A',
      '--chrome-text': '#ffffff',
    },
    supportCenter: 'DoorDash Support',
    supportCenterSub: 'Dasher Support & Incident Intake',
    disclaimer: 'NOT ACTUALLY A DOORDASH SITE — internal demo only, not affiliated with, endorsed by, or a real DoorDash product.',
    incident: {
      kind: 'banking-transfers',
      chatter: {
        vocabulary: {
          'enterprise customers': 'high-volume Dashers',
          'the payments gateway': 'the payout processor',
          'settlement timeouts': 'payout settlement timeouts',
          'Gateway team': 'Payout processor team',
          // Keep this repo-truthful code-path wording shielded from the broader transfer keys.
          'transfer path': 'transfer path',
          'the gateway': 'the payout processor',
          'Fund transfers degraded': 'Fast Pay cash outs degraded',
          'Transfers': 'Fast Pay cash outs',
          'transfers': 'Fast Pay cash outs',
          'transfer': 'Fast Pay cash out',
          'customers': 'Dashers',
        },
      },
    },
    bugPortal: {
      products: [
        {
          area: 'banking',
          label: 'Dasher Earnings \u2014 Fast Pay',
          persona: { name: 'Alex Rivera', email: 'alex.rivera@brightmail.io', sev: 'High' },
          templates: [
            {
              id: 'banking-transfer-slow',
              label: 'Fast Pay cash outs stuck on a spinner',
              sev: 'High',
              text: 'Cashing out my earnings used to be quick, but now every cash out sits on a spinner for about ten seconds before it goes through. Tried different amounts and both my bank account and my DasherDirect card \u2014 same thing every time. Started today.',
            },
            {
              id: 'banking-payroll-cutoff',
              label: 'End-of-shift payouts running late',
              sev: 'Critical',
              text: 'Escalating on behalf of a market team: Dashers cashing out at the end of the dinner shift are queued one after another and each cash out now takes ~10 seconds, so the whole batch finishes well after the usual window. Nothing errors \u2014 it is just painfully slow, and it was fine yesterday.',
            },
          ],
        },
      ],
    },
  },
  '81fea074': {
    slug: '81fea074',
    company: 'Stellic',
    brandMark: 'S',
    vertical: 'hightech',
    page: {
      // Natively branded custom page: served instead of the vertical's stock
      // page; the brand shim skips the title/logo rewrite for it.
      file: '81fea074.html',
      title: 'Stellic — Registration',
    },
    accent: '#C1441A',
    accentDark: '#a53a15',
    theme: {
      '--accent': '#C1441A',
      '--ink': '#151B26',
      '--surface': '#ffffff',
      '--chrome-bg': '#151B26',
      '--chrome-text': '#F5F4ED',
    },
    supportCenter: 'Stellic Support',
    supportCenterSub: 'Institution Support & Incident Intake',
    disclaimer: 'NOT ACTUALLY A STELLIC SITE — internal demo only, not affiliated with, endorsed by, or a real Stellic product.',
  },
  '08d969be': {
    slug: '08d969be',
    company: 'Hadrian',
    brandMark: 'H',
    vertical: 'industrials',
    page: {
      file: '08d969be.html',
      title: 'Hadrian — Instant Quote',
    },
    accent: '#12325C',
    accentDark: '#0d2544',
    theme: {
      '--accent': '#12325C',
      '--ink': '#101820',
      '--surface': '#ffffff',
      '--chrome-bg': '#0A1626',
      '--chrome-text': '#ffffff',
    },
    supportCenter: 'Hadrian Support',
    supportCenterSub: 'Customer Care & Incident Intake',
    disclaimer: 'NOT ACTUALLY A HADRIAN SITE — internal demo only, not affiliated with, endorsed by, or a real Hadrian product.',
    bugPortal: {
      products: [
        {
          area: 'industrials',
          label: 'Hadrian Instant Quote — DFM Analysis',
          persona: { name: 'Morgan Reyes', email: 'morgan.reyes@brightmail.io', sev: 'High' },
          templates: [
            {
              id: 'industrials-quote-timeout',
              label: 'Instant quote taking too long',
              sev: 'High',
              text: 'Buyer at a defense prime here — our instant quote sits on “Running DFM analysis” for about 15 seconds before it finally returns. Same part and quantity every time, and this started recently.',
            },
            {
              id: 'industrials-program-quotes-blocked',
              label: 'Program quotes crawling',
              sev: 'Critical',
              text: 'Program manager escalation: every quote for one aerospace program crawls while quotes for other programs come back in about a second. We need the affected program quotes for today’s sourcing review.',
            },
          ],
        },
      ],
    },
  },
  'cdf0771d': {
    slug: 'cdf0771d',
    company: 'RadixArk',
    brandMark: 'R',
    vertical: 'inference',
    page: {
      // Natively branded custom page: served instead of the vertical's stock
      // page; the brand shim skips the title/logo rewrite for it.
      file: 'cdf0771d.html',
      title: 'RadixArk — Serving Console',
    },
    theme: {
      '--accent': '#D55816',
      '--ink': '#1A1512',
      '--surface': '#FBF7F2',
      '--chrome-bg': '#0C0B0A',
      '--chrome-text': '#F8F2EA',
    },
    supportCenter: 'RadixArk Support',
    supportCenterSub: 'Platform Support & Incident Intake',
    disclaimer: 'NOT ACTUALLY A RADIXARK SITE — internal demo only, not affiliated with, endorsed by, or a real RadixArk product.',
  },
  '2acc11fd': {
    slug: '2acc11fd',
    company: 'Wispr Flow',
    brandMark: 'F',
    vertical: 'voice',
    page: {
      // Natively branded custom page: served instead of the vertical's stock
      // page; the brand shim skips the title/logo rewrite for it.
      file: '2acc11fd.html',
      title: 'Wispr Flow — Dictation',
    },
    theme: {
      '--accent': '#1A1A1A',
      '--ink': '#1A1A1A',
      '--surface': '#FFFFEB',
      '--chrome-bg': '#1F1F1F',
      '--chrome-text': '#FFFFEB',
    },
    supportCenter: 'Wispr Flow Support',
    supportCenterSub: 'Workspace Support & Incident Intake',
    disclaimer: 'NOT ACTUALLY A WISPR FLOW SITE — internal demo only, not affiliated with, endorsed by, or a real Wispr Flow product.',
  },
  '3aea27ba': {
    slug: '3aea27ba',
    company: 'Happen Bank',
    brandMark: 'H',
    vertical: 'banking',
    page: {
      // Natively branded custom page: served instead of the vertical's stock
      // page; the brand shim skips the title/logo rewrite for it.
      file: '3aea27ba.html',
      title: 'Happen Bank — Move Money',
    },
    accent: '#2626FF',
    accentDark: '#1E1FCA',
    theme: {
      '--accent': '#2626FF',
      '--ink': '#232222',
      '--surface': '#fffdfb',
      '--chrome-bg': '#232222',
      '--chrome-text': '#F7F1ED',
    },
    supportCenter: 'Happen Bank Support',
    supportCenterSub: 'Customer Care & Incident Intake',
    disclaimer: 'NOT ACTUALLY A HAPPEN BANK SITE — internal demo only, not affiliated with, endorsed by, or a real Happen Bank product.',
  },
  '32715aba': {
    slug: '32715aba',
    company: 'Mercor',
    brandMark: 'M',
    vertical: 'banking',
    page: {
      // Natively branded custom page: served instead of the vertical's stock
      // page, so the brand shim skips the title/logo rewrite. Keep the file's
      // own <title> in sync with page.title.
      file: '32715aba.html',
      title: 'Mercor \u2014 Earnings',
    },
    accent: '#4F46E5',
    accentDark: '#4338CA',
    theme: {
      '--accent': '#4F46E5',
      '--ink': '#0b0b0f',
      '--surface': '#ffffff',
      '--chrome-bg': '#111116',
      '--chrome-text': '#f5f5f7',
    },
    supportCenter: 'Mercor Support',
    supportCenterSub: 'Customer Care & Incident Intake',
    disclaimer: 'NOT ACTUALLY A MERCOR SITE — internal demo only, not affiliated with, endorsed by, or a real Mercor product.',
  },
  'a198d45f': {
    slug: 'a198d45f',
    company: 'MediCodio',
    brandMark: 'M',
    vertical: 'insurance',
    page: {
      file: 'a198d45f.html',
      title: 'MediCodio AI — CODIO Coding Workspace',
    },
    theme: {
      '--accent': '#00309F',
      '--ink': '#141834',
      '--surface': '#ffffff',
      '--chrome-bg': '#141834',
      '--chrome-text': '#F5F7FC',
    },
    supportCenter: 'MediCodio Support',
    supportCenterSub: 'Customer Care & Incident Intake',
    disclaimer: 'NOT ACTUALLY A MEDICODIO SITE — internal demo only, not affiliated with, endorsed by, or a real MediCodio product.',
  },

  '03848ffe': {
    slug: '03848ffe',
    company: 'Genspark',
    brandMark: 'G',
    vertical: 'hightech',
    page: {
      file: '03848ffe.html',
      title: 'Genspark - Upgrade to Team Plan',
    },
    theme: {
      '--accent': '#0F7FFF',
      '--ink': '#232425',
      '--surface': '#ffffff',
      '--chrome-bg': '#000000',
      '--chrome-text': '#ffffff',
    },
    supportCenter: 'Genspark Support',
    supportCenterSub: 'Customer Care & Incident Intake',
    disclaimer: 'NOT ACTUALLY A GENSPARK SITE — internal demo only, not affiliated with, endorsed by, or a real Genspark product.',
    bugPortal: {
      products: [
        {
          area: 'hightech',
          label: 'AI Workspace \u2014 Team Seats & Provisioning',
          persona: { name: 'Elena Sorokin', email: 'elena.sorokin@northloop.io', sev: 'Medium' },
          templates: [
            {
              id: 'hightech-provision-slowdown',
              label: 'Adding seats is very slow',
              sev: 'Medium',
              text: 'Adding seats to our Team plan is painfully slow — every time I hit "Get Team seats" it sits for seven or eight seconds before the workspace updates. It does go through, it is just slow, and it feels a little worse each time we add another batch.',
            },
            {
              id: 'hightech-renewal-slow',
              label: 'Bulk seat expansion crawling before renewal',
              sev: 'High',
              text: 'We are expanding from 40 to 200 seats ahead of our renewal on Friday and every seat batch in the workspace admin sits there for ages before it completes. Our IT lead is convinced the platform cannot handle our org size.',
            },
          ],
        },
      ],
    },
  },
  'ec8c777e': {
    slug: 'ec8c777e',
    company: 'Shinhan Bank',
    brandMark: 'S',
    vertical: 'banking',
    page: {
      file: 'ec8c777e.html',
      title: '계좌이체 | 신한은행 개인뱅킹',
    },
    theme: {
      '--accent': '#2D71C4',
      '--ink': '#343434',
      '--surface': '#FFFFFF',
      '--chrome-bg': '#1F4E86',
      '--chrome-text': '#FFFFFF',
    },
    supportCenter: '신한은행 고객센터',
    disclaimer: 'NOT ACTUALLY A SHINHAN BANK SITE — internal demo only, not affiliated with, endorsed by, or a real Shinhan Bank product.',
  },
  '000e17f3': {
    slug: '000e17f3',
    company: '우리은행',
    brandMark: 'W',
    vertical: 'banking',
    page: {
      file: '000e17f3.html',
      title: '계좌이체 | 우리은행 개인뱅킹',
    },
    theme: {
      '--accent': '#0083cd',
      '--ink': '#222222',
      '--surface': '#ffffff',
      '--chrome-bg': '#0661c4',
      '--chrome-text': '#ffffff',
    },
    supportCenter: '우리은행 고객센터',
    disclaimer: 'NOT ACTUALLY A WOORI BANK SITE — internal demo only, not affiliated with, endorsed by, or a real Woori Bank product.',
  },
  'd5f6d175': {
    slug: 'd5f6d175',
    company: 'Shinsegae',
    brandMark: 'S',
    vertical: 'telco',
    page: {
      file: 'd5f6d175.html',
      title: '신세계 유니버스 클럽 멤버십 관리 | 신세계포인트',
    },
    theme: {
      '--accent': '#A3833F',
      '--ink': '#222222',
      '--surface': '#FFFFFF',
      '--chrome-bg': '#05071A',
      '--chrome-text': '#FFFFFF',
    },
    supportCenter: '신세계포인트 고객센터',
    disclaimer: 'NOT ACTUALLY A SHINSEGAE SITE — internal demo only, not affiliated with, endorsed by, or a real Shinsegae product.',
  },
  'c65bd444': {
    slug: 'c65bd444',
    company: 'Korean Air',
    brandMark: 'K',
    vertical: 'banking',
    page: {
      file: 'c65bd444.html',
      title: '스카이패스 마일리지 양도/합산 | 대한항공',
    },
    theme: {
      '--accent': '#051766',
      '--ink': '#1a1a1a',
      '--surface': '#ffffff',
      '--chrome-bg': '#051766',
      '--chrome-text': '#f2f7ff',
    },
    supportCenter: 'Korean Air Support',
    supportCenterSub: 'SKYPASS Member Care',
    disclaimer: 'NOT ACTUALLY A KOREAN AIR SITE — internal demo only, not affiliated with, endorsed by, or a real Korean Air product.',
  },
  'bcda19cc': {
    slug: 'bcda19cc',
    company: 'Hyundai',
    brandMark: 'H',
    vertical: 'telco',
    page: {
      file: 'bcda19cc.html',
      title: '블루링크 구독 관리 | 현대자동차',
    },
    theme: {
      '--accent': '#002C5F',
      '--ink': '#1B1B1B',
      '--surface': '#FFFFFF',
      '--chrome-bg': '#001C3D',
      '--chrome-text': '#FFFFFF',
    },
    supportCenter: '현대자동차 고객센터',
    disclaimer: 'NOT ACTUALLY A HYUNDAI SITE — internal demo only, not affiliated with, endorsed by, or a real Hyundai product.',
  },
  '4f8523aa': {
    slug: '4f8523aa',
    company: 'Kakao Pay',
    brandMark: 'K',
    vertical: 'banking',
    page: {
      file: '4f8523aa.html',
      title: '카카오페이 | 결제',
    },
    theme: {
      '--accent': '#FFEB00',
      '--ink': '#060B11',
      '--surface': '#FFFFFF',
      '--chrome-bg': '#191C20',
      '--chrome-text': '#FFFFFF',
    },
    supportCenter: 'Kakao Pay Support',
    disclaimer: 'NOT ACTUALLY A KAKAO PAY SITE — internal demo only, not affiliated with, endorsed by, or a real Kakao Pay product.',
  },
  '1ac469b4': {
    slug: '1ac469b4',
    company: '정부24',
    brandMark: 'G',
    vertical: 'banking',
    page: {
      file: '1ac469b4.html',
      title: '증명서 발급 수수료 결제 | 정부24',
    },
    theme: {
      '--accent': '#256ef4',
      '--ink': '#1e2124',
      '--surface': '#ffffff',
      '--chrome-bg': '#052b57',
      '--chrome-text': '#ffffff',
    },
    supportCenter: '정부24 고객센터',
    disclaimer: 'NOT ACTUALLY A GOV.KR (정부24) SITE — internal demo only, not affiliated with, endorsed by, or a real Government of Korea service.',
  },
  'bf5f21e3': {
    slug: 'bf5f21e3',
    company: 'Forrester',
    brandMark: 'F',
    vertical: 'hightech',
    page: {
      file: 'bf5f21e3.html',
      title: 'Forrester Decisions | Manage Seats',
    },
    theme: {
      '--accent': '#10398C',
      '--ink': '#1F2733',
      '--surface': '#FFFFFF',
      '--chrome-bg': '#000000',
      '--chrome-text': '#FFFFFF',
    },
    supportCenter: 'Forrester Client Support',
    disclaimer: 'NOT ACTUALLY A FORRESTER SITE — internal demo only, not affiliated with, endorsed by, or a real Forrester product.',
  },
  '0c15262a': {
    slug: '0c15262a',
    company: '하나은행',
    brandMark: 'H',
    vertical: 'banking',
    page: {
      file: '0c15262a.html',
      title: '계좌이체 | 하나은행',
    },
    theme: {
      '--accent': '#009591',
      '--ink': '#191919',
      '--surface': '#ffffff',
      '--chrome-bg': '#00605e',
      '--chrome-text': '#ffffff',
    },
    supportCenter: '하나은행 고객센터',
    disclaimer: 'NOT ACTUALLY A HANA BANK (하나은행) SITE — internal demo only, not affiliated with, endorsed by, or a real Hana Bank product.',
  },
  '5d5755c2': {
    slug: '5d5755c2',
    company: 'MegazoneCloud',
    brandMark: 'M',
    vertical: 'hightech',
    page: {
      file: '5d5755c2.html',
      title: '라이선스 프로비저닝 | MegazoneCloud',
    },
    theme: {
      '--accent': '#6C4CF1',
      '--ink': '#191919',
      '--surface': '#ffffff',
      '--chrome-bg': '#0A0F10',
      '--chrome-text': '#ffffff',
    },
    supportCenter: 'MegazoneCloud 고객지원',
    disclaimer: 'NOT ACTUALLY A MEGAZONECLOUD SITE — internal demo only, not affiliated with, endorsed by, or a real MegazoneCloud product.',
  },
  'f5a5bdad': {
    slug: 'f5a5bdad',
    company: 'KRAFTON',
    brandMark: 'K',
    vertical: 'banking',
    page: {
      file: 'f5a5bdad.html',
      title: 'G-COIN 충전 | KRAFTON',
    },
    theme: {
      '--accent': '#F73A31',
      '--ink': '#191919',
      '--surface': '#ffffff',
      '--chrome-bg': '#000000',
      '--chrome-text': '#ffffff',
    },
    supportCenter: 'KRAFTON 고객지원',
    disclaimer: 'NOT ACTUALLY A KRAFTON SITE — internal demo only, not affiliated with, endorsed by, or a real KRAFTON product.',
  },
  'd92336aa': {
    slug: 'd92336aa',
    company: '카카오톡 선물하기',
    brandMark: 'K',
    vertical: 'banking',
    page: {
      file: 'd92336aa.html',
      title: '선물 결제 | 카카오톡 선물하기',
    },
    theme: {
      '--accent': '#F6432F',
      '--ink': '#191919',
      '--surface': '#ffffff',
      '--chrome-bg': '#191919',
      '--chrome-text': '#ffffff',
    },
    supportCenter: '카카오 고객센터',
    disclaimer: 'NOT ACTUALLY A KAKAO SITE — internal demo only, not affiliated with, endorsed by, or a real Kakao product.',
  },
  'c70eca54': {
    slug: 'c70eca54',
    company: '삼성카드',
    brandMark: 'S',
    vertical: 'banking',
    page: {
      file: 'c70eca54.html',
      title: '카드대금 즉시결제 | 삼성카드',
    },
    theme: {
      '--accent': '#2090FF',
      '--ink': '#111111',
      '--surface': '#ffffff',
      '--chrome-bg': '#101010',
      '--chrome-text': '#ffffff',
    },
    supportCenter: '삼성카드 고객센터',
    disclaimer: 'NOT ACTUALLY A SAMSUNG CARD SITE — internal demo only, not affiliated with, endorsed by, or a real Samsung Card product.',
  },
  '9f7a8436': {
    slug: '9f7a8436',
    company: 'Mercedes-Benz',
    brandMark: 'M',
    vertical: 'telco',
    page: {
      file: '9f7a8436.html',
      title: 'Mercedes me connect — Digital Extras',
    },
    theme: {
      '--accent': '#0078D6',
      '--ink': '#141414',
      '--surface': '#ffffff',
      '--chrome-bg': '#000000',
      '--chrome-text': '#ffffff',
    },
    supportCenter: 'Mercedes-Benz Customer Assistance',
    disclaimer: 'NOT ACTUALLY A MERCEDES-BENZ SITE — internal demo only, not affiliated with, endorsed by, or a real Mercedes-Benz product.',
  },
  'd22a0a30': {
    slug: 'd22a0a30',
    company: 'Pearson',
    brandMark: 'P',
    vertical: 'telco',
    page: { file: 'd22a0a30.html', title: 'Pearson+ | Manage subscription' },
    theme: {
      '--accent': '#6D0176',
      '--ink': '#333333',
      '--surface': '#FFFFFF',
      '--chrome-bg': '#05112A',
      '--chrome-text': '#FFFFFF',
    },
    supportCenter: 'Pearson Support',
    disclaimer: 'NOT ACTUALLY A PEARSON SITE — internal demo only, not affiliated with, endorsed by, or a real Pearson product.',
  },
  '93f1b8ec': {
    slug: '93f1b8ec',
    company: 'הראל',
    brandMark: 'ה',
    vertical: 'insurance',
    page: { file: '93f1b8ec.html', title: 'הגשת תביעה | הראל ביטוח ופיננסים' },
    theme: {
      '--accent': '#106AE1',
      '--ink': '#1F1F1F',
      '--surface': '#FFFFFF',
      '--chrome-bg': '#1F1F1F',
      '--chrome-text': '#FFFFFF',
    },
    supportCenter: 'הראל שירות לקוחות',
    disclaimer: 'NOT ACTUALLY A HAREL SITE — internal demo only, not affiliated with, endorsed by, or a real Harel Insurance product.',
  },
  'd61e15a2': {
    slug: 'd61e15a2',
    company: 'BMW',
    brandMark: 'B',
    vertical: 'banking',
    page: { file: 'd61e15a2.html', title: 'Reserve your BMW | BMW Shop Online' },
    theme: {
      '--accent': '#1C69D4',
      '--ink': '#262626',
      '--surface': '#FFFFFF',
      '--chrome-bg': '#262626',
      '--chrome-text': '#FFFFFF',
    },
    supportCenter: 'BMW Customer Support',
    disclaimer: 'NOT ACTUALLY A BMW SITE — internal demo only, not affiliated with, endorsed by, or a real BMW product.',
  },
  'b258a21e': {
    slug: 'b258a21e',
    company: 'Telekom',
    brandMark: 'T',
    vertical: 'telco',
    page: { file: 'b258a21e.html', title: 'Tarifwechsel | Telekom' },
    theme: {
      '--accent': '#E20074',
      '--ink': '#262626',
      '--surface': '#FFFFFF',
      '--chrome-bg': '#262626',
      '--chrome-text': '#FFFFFF',
    },
    supportCenter: 'Telekom Kundenservice',
    disclaimer: 'NOT ACTUALLY A DEUTSCHE TELEKOM SITE — internal demo only, not affiliated with, endorsed by, or a real Deutsche Telekom product.',
  },
  'dec00361': {
    slug: 'dec00361',
    company: 'T-Systems',
    brandMark: 'T',
    vertical: 'hightech',
    page: { file: 'dec00361.html', title: 'Provision Licenses | T-Systems Cloud Services' },
    theme: {
      '--accent': '#E20074',
      '--ink': '#262626',
      '--surface': '#FFFFFF',
      '--chrome-bg': '#000000',
      '--chrome-text': '#FFFFFF',
    },
    supportCenter: 'T-Systems Service Desk',
    disclaimer: 'NOT ACTUALLY A T-SYSTEMS SITE — internal demo only, not affiliated with, endorsed by, or a real T-Systems / Deutsche Telekom product.',
  },
  '1c4b185f': {
    slug: '1c4b185f',
    company: 'Stellantis Financial Services',
    brandMark: 'S',
    vertical: 'banking',
    page: { file: '1c4b185f.html', title: 'Make a payment | Stellantis Financial Services' },
    theme: {
      '--accent': '#243882',
      '--ink': '#212529',
      '--surface': '#FFFFFF',
      '--chrome-bg': '#282B34',
      '--chrome-text': '#FFFFFF',
    },
    supportCenter: 'Stellantis Financial Services Customer Care',
    disclaimer: 'NOT ACTUALLY A STELLANTIS SITE — internal demo only, not affiliated with, endorsed by, or a real Stellantis product.',
  },
  'ae0823ea': {
    slug: 'ae0823ea',
    company: 'Raymond James',
    brandMark: 'RJ',
    vertical: 'banking',
    page: { file: 'ae0823ea.html', title: 'Transfer Funds | Client Access | Raymond James' },
    theme: {
      '--accent': '#002949',
      '--ink': '#000000',
      '--surface': '#FFFFFF',
      '--chrome-bg': '#002949',
      '--chrome-text': '#FFFFFF',
    },
    supportCenter: 'Client Access Support',
    disclaimer: 'NOT ACTUALLY A RAYMOND JAMES SITE — internal demo only, not affiliated with, endorsed by, or a real Raymond James product.',
  },
  '3febe675': {
    slug: '3febe675',
    company: 'Amadeus',
    brandMark: 'a',
    vertical: 'hightech',
    page: { file: '3febe675.html', title: 'Amadeus Enterprise API Portal | Provision access' },
    theme: {
      '--accent': '#0C66E1',
      '--ink': '#333333',
      '--surface': '#FFFFFF',
      '--chrome-bg': '#000835',
      '--chrome-text': '#FFFFFF',
    },
    supportCenter: 'Amadeus Developer Support',
    disclaimer: 'NOT ACTUALLY AN AMADEUS SITE — internal demo only, not affiliated with, endorsed by, or a real Amadeus product.',
  },
  'c789e3c0': {
    slug: 'c789e3c0',
    company: 'Nationale-Nederlanden',
    brandMark: 'N',
    vertical: 'insurance',
    page: { file: 'c789e3c0.html', title: 'Schade melden | Nationale-Nederlanden' },
    theme: {
      '--accent': '#EA650D',
      '--ink': '#404040',
      '--surface': '#FFFFFF',
      '--chrome-bg': '#1A1A1A',
      '--chrome-text': '#FFFFFF',
    },
    supportCenter: 'NN Klantenservice',
    disclaimer: 'NOT ACTUALLY A NATIONALE-NEDERLANDEN (NN GROUP) SITE — internal demo only, not affiliated with, endorsed by, or a real NN product.',
  },
  'b3387c66': {
    slug: 'b3387c66',
    company: 'British Airways',
    brandMark: 'BA',
    vertical: 'banking',
    page: { file: 'b3387c66.html', title: 'Pay for your booking | British Airways' },
    theme: {
      '--accent': '#3468AD',
      '--ink': '#000000',
      '--surface': '#FFFFFF',
      '--chrome-bg': '#01122C',
      '--chrome-text': '#FFFFFF',
    },
    supportCenter: 'British Airways Customer Relations',
    disclaimer: 'NOT ACTUALLY A BRITISH AIRWAYS SITE — internal demo only, not affiliated with, endorsed by, or a real British Airways product.',
  },
  'df86b36f': {
    slug: 'df86b36f',
    company: 'L&G',
    brandMark: 'L&G',
    vertical: 'banking',
    page: { file: 'df86b36f.html', title: 'Fund dealing | L&G Asset Management' },
    theme: {
      '--accent': '#005DBA',
      '--ink': '#1D1D1B',
      '--surface': '#ffffff',
      '--chrome-bg': '#002855',
      '--chrome-text': '#ffffff',
    },
    supportCenter: 'L&G Client Services',
    disclaimer: 'NOT ACTUALLY AN L&G SITE — internal demo only, not affiliated with, endorsed by, or a real L&G product.',
  },
  '290929de': {
    slug: '290929de',
    company: 'Bank Leumi',
    brandMark: 'L',
    vertical: 'banking',
    page: { file: '290929de.html', title: 'העברת כספים | לאומי דיגיטל' },
    theme: {
      '--accent': '#0066FF',
      '--ink': '#070762',
      '--surface': '#FFFFFF',
      '--chrome-bg': '#10069A',
      '--chrome-text': '#FFFFFF',
    },
    supportCenter: 'Bank Leumi Customer Service',
    disclaimer: 'NOT ACTUALLY A BANK LEUMI SITE — internal demo only, not affiliated with, endorsed by, or a real Bank Leumi product.',
  },
  '2e94691c': {
    slug: '2e94691c',
    company: 'Wiz',
    brandMark: 'W',
    vertical: 'hightech',
    page: { file: '2e94691c.html', title: 'Wiz — Cloud Connector Deployment' },
    accent: '#0254EC',
    accentDark: '#0143C0',
    theme: {
      '--accent': '#0254EC',
      '--ink': '#393F49',
      '--surface': '#FFFFFF',
      '--chrome-bg': '#25242F',
      '--chrome-text': '#F4F4F6',
    },
    supportCenter: 'Wiz Support',
    supportCenterSub: 'Deployment Support & Incident Intake',
    disclaimer: 'NOT ACTUALLY A WIZ SITE — internal demo only, not affiliated with, endorsed by, or a real Wiz product.',
  },
  'abb0d034': {
    slug: 'abb0d034',
    company: 'Monte Carlo',
    brandMark: 'MC',
    vertical: 'hightech',
    page: {
      file: 'abb0d034.html',
      title: 'Monte Carlo | Monitors',
    },
    theme: {
      '--accent': '#FF5700',
      '--ink': '#00111D',
      '--surface': '#ffffff',
      '--chrome-bg': '#00111D',
      '--chrome-text': '#ffffff',
    },
    supportCenter: 'Monte Carlo Support',
    supportCenterSub: 'Customer Care & Incident Intake',
    disclaimer: 'NOT ACTUALLY A MONTE CARLO SITE — internal demo only, not affiliated with, endorsed by, or a real Monte Carlo product.',
  },
};

function getOncallSkin(slug) {
  if (!slug || typeof slug !== 'string') return null;
  const key = slug.toLowerCase();
  return Object.prototype.hasOwnProperty.call(ONCALL_SKINS, key) ? ONCALL_SKINS[key] : null;
}

module.exports = { ONCALL_SKINS, getOncallSkin };
