/**
 * Synthetic EA Account directory for the 4491bcfa demo portal.
 *
 * All records are fabricated. No real player data is represented here. The
 * directory is generated deterministically so the demo renders the same player
 * profiles on every run and across every container.
 */

const COUNTRIES = [
  { code: 'US', city: 'Austin, TX' },
  { code: 'US', city: 'Seattle, WA' },
  { code: 'GB', city: 'Manchester' },
  { code: 'DE', city: 'Köln' },
  { code: 'BR', city: 'São Paulo' },
  { code: 'JP', city: 'Osaka' },
  { code: 'CA', city: 'Toronto' },
  { code: 'AU', city: 'Melbourne' },
  { code: 'FR', city: 'Lyon' },
  { code: 'SE', city: 'Malmö' },
];

const PLATFORMS = ['PlayStation Network', 'Xbox Live', 'Steam', 'Nintendo Switch', 'Epic Games'];

const FIRST = ['Alex', 'Jordan', 'Riley', 'Casey', 'Morgan', 'Taylor', 'Sam', 'Jamie', 'Avery', 'Quinn',
  'Noah', 'Mia', 'Liam', 'Emma', 'Lucas', 'Olivia', 'Ethan', 'Aria', 'Mateo', 'Zoe'];
const LAST = ['Carter', 'Nguyen', 'Silva', 'Keller', 'Okafor', 'Rossi', 'Haas', 'Berg', 'Flores', 'Yamamoto',
  'Novak', 'Petrov', 'Dubois', 'Costa', 'Lindqvist', 'Walsh', 'Moreau', 'Reyes', 'Khan', 'Fischer'];

const BASE_ID = 100000;
const COUNT = 260;

function seededInt(seed, max) {
  // xorshift-ish deterministic pseudo-random from an integer seed
  let x = (seed ^ 0x9e3779b9) >>> 0;
  x ^= x << 13; x >>>= 0;
  x ^= x >> 17;
  x ^= x << 5; x >>>= 0;
  return x % max;
}

function buildAccount(index) {
  const num = BASE_ID + index;
  const accountId = `EA-${num}`;
  const first = FIRST[seededInt(num * 7, FIRST.length)];
  const last = LAST[seededInt(num * 13, LAST.length)];
  const persona = `${first.toLowerCase()}_${last.toLowerCase()}${(num % 97)}`;
  const country = COUNTRIES[seededInt(num * 3, COUNTRIES.length)];
  const platformCount = 1 + seededInt(num * 5, 3);
  const linkedPlatforms = [];
  for (let i = 0; i < platformCount; i += 1) {
    const p = PLATFORMS[seededInt(num * (i + 2) + 11, PLATFORMS.length)];
    if (!linkedPlatforms.find((lp) => lp.platform === p)) {
      linkedPlatforms.push({
        platform: p,
        handle: `${persona}`,
        linkedOn: `202${3 + (num % 3)}-0${1 + (num % 9)}-1${num % 9}`,
      });
    }
  }
  const octetA = 24 + seededInt(num * 17, 180);
  const octetB = seededInt(num * 19, 255);
  const octetC = seededInt(num * 23, 255);
  const lastLoginIp = `${octetA}.${octetB}.${octetC}.${seededInt(num * 29, 254) + 1}`;
  const twoFactor = seededInt(num * 31, 10) > 3;

  return {
    accountId,
    eaId: persona,
    displayName: `${first} ${last}`,
    email: `${persona}@example-mail.test`,
    country: country.code,
    location: country.city,
    memberSince: `20${13 + (num % 11)}`,
    avatarColor: `hsl(${seededInt(num * 37, 360)}, 58%, 46%)`,
    linkedPlatforms,
    lastLogin: {
      ip: lastLoginIp,
      at: `2026-11-1${num % 9}T${10 + (num % 12)}:0${num % 6}:00Z`,
      device: seededInt(num, 2) ? 'PlayStation 5' : 'Windows PC (Origin)',
      location: country.city,
    },
    security: {
      twoFactorEnabled: twoFactor,
      loginVerificationEmail: true,
      securityQuestionSet: seededInt(num * 41, 10) > 2,
      lastPasswordChange: `2026-0${1 + (num % 8)}-1${num % 9}`,
    },
  };
}

const ACCOUNTS = {};
const ACCOUNT_IDS = [];
for (let i = 0; i < COUNT; i += 1) {
  const acct = buildAccount(i);
  ACCOUNTS[acct.accountId] = acct;
  ACCOUNT_IDS.push(acct.accountId);
}

function getAccount(accountId) {
  return ACCOUNTS[accountId] || null;
}

function listAccountIds() {
  return ACCOUNT_IDS.slice();
}

module.exports = { ACCOUNTS, ACCOUNT_IDS, getAccount, listAccountIds, BASE_ID };
