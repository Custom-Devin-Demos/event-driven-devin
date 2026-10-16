'use strict';

// Request qualifications for the Field CTO reservation app: who the meeting is
// with (audience), where (country) and what kind of customer (industry), plus
// the routing rules that pre-select a Field CTO in the request form.

const AUDIENCES = [
  { key: 'C_LEVEL', emoji: ':crown:', label: 'C-level', eligible: true },
  { key: 'VP', emoji: ':briefcase:', label: 'VP', eligible: true },
  { key: 'DIRECTOR', emoji: ':necktie:', label: 'Director', eligible: true },
  { key: 'BELOW', emoji: ':no_entry:', label: 'Below Director', eligible: false },
];

// `emoji` is a Slack shortcode shown next to the label in the form and on cards.
const BELOW_MESSAGE = 'Field CTOs join meetings with Director-level and above. For this audience, please work with your SE/AE team.';

// 20 largest economies by GDP, then "Other". `zone` drives routing.
const COUNTRIES = [
  { key: 'US', emoji: ':flag-us:', label: 'United States', zone: 'NA' },
  { key: 'CN', emoji: ':flag-cn:', label: 'China', zone: 'APAC' },
  { key: 'DE', emoji: ':flag-de:', label: 'Germany', zone: 'EU' },
  { key: 'JP', emoji: ':flag-jp:', label: 'Japan', zone: 'JP' },
  { key: 'IN', emoji: ':flag-in:', label: 'India', zone: 'APAC' },
  { key: 'GB', emoji: ':flag-gb:', label: 'United Kingdom', zone: 'EU' },
  { key: 'FR', emoji: ':flag-fr:', label: 'France', zone: 'EU' },
  { key: 'IT', emoji: ':flag-it:', label: 'Italy', zone: 'EU' },
  { key: 'CA', emoji: ':flag-ca:', label: 'Canada', zone: 'NA' },
  { key: 'BR', emoji: ':flag-br:', label: 'Brazil', zone: 'LATAM' },
  { key: 'RU', emoji: ':flag-ru:', label: 'Russia', zone: 'EU' },
  { key: 'ES', emoji: ':flag-es:', label: 'Spain', zone: 'EU' },
  { key: 'MX', emoji: ':flag-mx:', label: 'Mexico', zone: 'LATAM' },
  { key: 'AU', emoji: ':flag-au:', label: 'Australia', zone: 'APAC' },
  { key: 'KR', emoji: ':flag-kr:', label: 'South Korea', zone: 'APAC' },
  { key: 'ID', emoji: ':flag-id:', label: 'Indonesia', zone: 'APAC' },
  { key: 'NL', emoji: ':flag-nl:', label: 'Netherlands', zone: 'EU' },
  { key: 'TR', emoji: ':flag-tr:', label: 'Turkey', zone: 'EU' },
  { key: 'SA', emoji: ':flag-sa:', label: 'Saudi Arabia', zone: 'MEA' },
  { key: 'CH', emoji: ':flag-ch:', label: 'Switzerland', zone: 'EU' },
  { key: 'OTHER', emoji: ':globe_with_meridians:', label: 'Other', zone: 'OTHER' },
];

const INDUSTRIES = [
  { key: 'FINANCE', emoji: ':bank:', label: 'Finance' },
  { key: 'TECH_NATIVE', emoji: ':rocket:', label: 'Tech Native' },
  { key: 'INDUSTRIAL', emoji: ':factory:', label: 'Industrial' },
  { key: 'HEALTHCARE', emoji: ':hospital:', label: 'Healthcare' },
  { key: 'PUBLIC_SECTOR', emoji: ':classical_building:', label: 'Public Sector' },
  { key: 'OTHER', emoji: ':jigsaw:', label: 'Other' },
];

// First match wins. `when` keys: country, zone, industry. `who` is a request
// form value: MEMBER:<roster key> or ANY:<US|EU|JP>.
const ROUTING_RULES = [
  { when: { country: 'JP' }, who: 'MEMBER:AKIRA_SHIBATA', reason: 'Japan' },
  { when: { zone: 'EU', industry: 'FINANCE' }, who: 'MEMBER:AMAN_THIND', reason: 'Europe + Finance' },
  { when: { zone: 'EU' }, who: 'MEMBER:KATRIN_LEHMANN', reason: 'Europe' },
  { when: { industry: 'FINANCE' }, who: 'MEMBER:AMAN_THIND', reason: 'Finance' },
  { when: { zone: 'APAC' }, who: 'MEMBER:AKIRA_SHIBATA', reason: 'APAC' },
  { when: { zone: 'NA' }, who: 'ANY:US', reason: 'North America' },
  { when: { zone: 'LATAM' }, who: 'ANY:US', reason: 'Latin America' },
  { when: { zone: 'MEA' }, who: 'ANY:EU', reason: 'Middle East' },
];

const byKey = (list) => Object.fromEntries(list.map((x) => [x.key, x]));
const AUDIENCE = byKey(AUDIENCES);
const COUNTRY = byKey(COUNTRIES);
const INDUSTRY = byKey(INDUSTRIES);

// Suggested request-form "who" value for a country/industry pair, or null.
function suggestWho({ country, industry } = {}) {
  const c = COUNTRY[country];
  const facts = { country: c ? c.key : null, zone: c ? c.zone : null, industry: INDUSTRY[industry] ? industry : null };
  if (!facts.country && !facts.industry) return null;
  const rule = ROUTING_RULES.find((r) => Object.entries(r.when).every(([k, v]) => facts[k] === v));
  return rule ? { who: rule.who, reason: rule.reason } : null;
}

module.exports = { AUDIENCES, AUDIENCE, COUNTRIES, COUNTRY, INDUSTRIES, INDUSTRY, ROUTING_RULES, BELOW_MESSAGE, suggestWho };
