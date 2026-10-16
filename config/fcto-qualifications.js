'use strict';

// Request qualifications for the Field CTO reservation app: who the meeting is
// with (audience), where (country) and what kind of customer (industry), plus
// the routing rules that pre-select a Field CTO in the request form.

const AUDIENCES = [
  { key: 'C_LEVEL', label: 'C-level', eligible: true },
  { key: 'VP', label: 'VP', eligible: true },
  { key: 'DIRECTOR', label: 'Director', eligible: true },
  { key: 'BELOW', label: 'Below Director', eligible: false },
];

const BELOW_MESSAGE = 'Field CTOs join meetings with Director-level and above. For this audience, please work with your SE/AE team.';

// 20 largest economies by GDP, then "Other". `zone` drives routing.
const COUNTRIES = [
  { key: 'US', label: 'United States', zone: 'NA' },
  { key: 'CN', label: 'China', zone: 'APAC' },
  { key: 'DE', label: 'Germany', zone: 'EU' },
  { key: 'JP', label: 'Japan', zone: 'JP' },
  { key: 'IN', label: 'India', zone: 'APAC' },
  { key: 'GB', label: 'United Kingdom', zone: 'EU' },
  { key: 'FR', label: 'France', zone: 'EU' },
  { key: 'IT', label: 'Italy', zone: 'EU' },
  { key: 'CA', label: 'Canada', zone: 'NA' },
  { key: 'BR', label: 'Brazil', zone: 'LATAM' },
  { key: 'RU', label: 'Russia', zone: 'EU' },
  { key: 'ES', label: 'Spain', zone: 'EU' },
  { key: 'MX', label: 'Mexico', zone: 'LATAM' },
  { key: 'AU', label: 'Australia', zone: 'APAC' },
  { key: 'KR', label: 'South Korea', zone: 'APAC' },
  { key: 'ID', label: 'Indonesia', zone: 'APAC' },
  { key: 'NL', label: 'Netherlands', zone: 'EU' },
  { key: 'TR', label: 'Turkey', zone: 'EU' },
  { key: 'SA', label: 'Saudi Arabia', zone: 'MEA' },
  { key: 'CH', label: 'Switzerland', zone: 'EU' },
  { key: 'OTHER', label: 'Other', zone: 'OTHER' },
];

const INDUSTRIES = [
  { key: 'FINANCE', label: 'Finance' },
  { key: 'TECH_NATIVE', label: 'Tech Native' },
  { key: 'INDUSTRIAL', label: 'Industrial' },
  { key: 'HEALTHCARE', label: 'Healthcare' },
  { key: 'PUBLIC_SECTOR', label: 'Public Sector' },
  { key: 'OTHER', label: 'Other' },
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
