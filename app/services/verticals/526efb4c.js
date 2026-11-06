const crypto = require('crypto');

/**
 * American Express USA Corporate Program — Know Your Customer (KYC) portal.
 * Demo replica only: in-memory fixtures, no external calls, no alerting.
 * The questionnaire is defined per market in MARKETS and rendered by the page from GET /api/526efb4c/form.
 */

const COUNTRIES = [
  ['AD', 'Andorra'], ['AE', 'United Arab Emirates'], ['AF', 'Afghanistan'], ['AG', 'Antigua & Barbuda'],
  ['AI', 'Anguilla'], ['AL', 'Albania'], ['AM', 'Armenia'], ['AO', 'Angola'], ['AQ', 'Antarctica'],
  ['AR', 'Argentina'], ['AS', 'American Samoa'], ['AT', 'Austria'], ['AU', 'Australia'], ['AW', 'Aruba'],
  ['AX', 'Åland Islands'], ['AZ', 'Azerbaijan'], ['BA', 'Bosnia & Herzegovina'], ['BB', 'Barbados'],
  ['BD', 'Bangladesh'], ['BE', 'Belgium'], ['BF', 'Burkina Faso'], ['BG', 'Bulgaria'], ['BH', 'Bahrain'],
  ['BI', 'Burundi'], ['BJ', 'Benin'], ['BL', 'St. Barthélemy'], ['BM', 'Bermuda'], ['BN', 'Brunei'],
  ['BO', 'Bolivia'], ['BQ', 'Caribbean Netherlands'], ['BR', 'Brazil'], ['BS', 'Bahamas'], ['BT', 'Bhutan'],
  ['BV', 'Bouvet Island'], ['BW', 'Botswana'], ['BY', 'Belarus'], ['BZ', 'Belize'], ['CA', 'Canada'],
  ['CC', 'Cocos (Keeling) Islands'], ['CD', 'Congo - Kinshasa'], ['CF', 'Central African Republic'],
  ['CG', 'Congo - Brazzaville'], ['CH', 'Switzerland'], ['CI', 'Côte d\'Ivoire'], ['CK', 'Cook Islands'],
  ['CL', 'Chile'], ['CM', 'Cameroon'], ['CN', 'China'], ['CO', 'Colombia'], ['CR', 'Costa Rica'], ['CU', 'Cuba'],
  ['CV', 'Cape Verde'], ['CW', 'Curaçao'], ['CX', 'Christmas Island'], ['CY', 'Cyprus'], ['CZ', 'Czechia'],
  ['DE', 'Germany'], ['DJ', 'Djibouti'], ['DK', 'Denmark'], ['DM', 'Dominica'], ['DO', 'Dominican Republic'],
  ['DZ', 'Algeria'], ['EC', 'Ecuador'], ['EE', 'Estonia'], ['EG', 'Egypt'], ['EH', 'Western Sahara'],
  ['ER', 'Eritrea'], ['ES', 'Spain'], ['ET', 'Ethiopia'], ['FI', 'Finland'], ['FJ', 'Fiji'],
  ['FK', 'Falkland Islands'], ['FM', 'Micronesia'], ['FO', 'Faroe Islands'], ['FR', 'France'], ['GA', 'Gabon'],
  ['GB', 'United Kingdom'], ['GD', 'Grenada'], ['GE', 'Georgia'], ['GF', 'French Guiana'], ['GG', 'Guernsey'],
  ['GH', 'Ghana'], ['GI', 'Gibraltar'], ['GL', 'Greenland'], ['GM', 'Gambia'], ['GN', 'Guinea'],
  ['GP', 'Guadeloupe'], ['GQ', 'Equatorial Guinea'], ['GR', 'Greece'],
  ['GS', 'South Georgia & South Sandwich Islands'], ['GT', 'Guatemala'], ['GU', 'Guam'], ['GW', 'Guinea-Bissau'],
  ['GY', 'Guyana'], ['HK', 'Hong Kong SAR China'], ['HM', 'Heard & McDonald Islands'], ['HN', 'Honduras'],
  ['HR', 'Croatia'], ['HT', 'Haiti'], ['HU', 'Hungary'], ['ID', 'Indonesia'], ['IE', 'Ireland'], ['IL', 'Israel'],
  ['IM', 'Isle of Man'], ['IN', 'India'], ['IO', 'British Indian Ocean Territory'], ['IQ', 'Iraq'], ['IR', 'Iran'],
  ['IS', 'Iceland'], ['IT', 'Italy'], ['JE', 'Jersey'], ['JM', 'Jamaica'], ['JO', 'Jordan'], ['JP', 'Japan'],
  ['KE', 'Kenya'], ['KG', 'Kyrgyzstan'], ['KH', 'Cambodia'], ['KI', 'Kiribati'], ['KM', 'Comoros'],
  ['KN', 'St. Kitts & Nevis'], ['KP', 'North Korea'], ['KR', 'South Korea'], ['KW', 'Kuwait'],
  ['KY', 'Cayman Islands'], ['KZ', 'Kazakhstan'], ['LA', 'Laos'], ['LB', 'Lebanon'], ['LC', 'St. Lucia'],
  ['LI', 'Liechtenstein'], ['LK', 'Sri Lanka'], ['LR', 'Liberia'], ['LS', 'Lesotho'], ['LT', 'Lithuania'],
  ['LU', 'Luxembourg'], ['LV', 'Latvia'], ['LY', 'Libya'], ['MA', 'Morocco'], ['MC', 'Monaco'], ['MD', 'Moldova'],
  ['ME', 'Montenegro'], ['MF', 'St. Martin'], ['MG', 'Madagascar'], ['MH', 'Marshall Islands'],
  ['MK', 'North Macedonia'], ['ML', 'Mali'], ['MM', 'Myanmar (Burma)'], ['MN', 'Mongolia'],
  ['MO', 'Macao SAR China'], ['MP', 'Northern Mariana Islands'], ['MQ', 'Martinique'], ['MR', 'Mauritania'],
  ['MS', 'Montserrat'], ['MT', 'Malta'], ['MU', 'Mauritius'], ['MV', 'Maldives'], ['MW', 'Malawi'], ['MX', 'Mexico'],
  ['MY', 'Malaysia'], ['MZ', 'Mozambique'], ['NA', 'Namibia'], ['NC', 'New Caledonia'], ['NE', 'Niger'],
  ['NF', 'Norfolk Island'], ['NG', 'Nigeria'], ['NI', 'Nicaragua'], ['NL', 'Netherlands'], ['NO', 'Norway'],
  ['NP', 'Nepal'], ['NR', 'Nauru'], ['NU', 'Niue'], ['NZ', 'New Zealand'], ['OM', 'Oman'], ['PA', 'Panama'],
  ['PE', 'Peru'], ['PF', 'French Polynesia'], ['PG', 'Papua New Guinea'], ['PH', 'Philippines'], ['PK', 'Pakistan'],
  ['PL', 'Poland'], ['PM', 'St. Pierre & Miquelon'], ['PN', 'Pitcairn Islands'], ['PR', 'Puerto Rico'],
  ['PS', 'Palestinian Territories'], ['PT', 'Portugal'], ['PW', 'Palau'], ['PY', 'Paraguay'], ['QA', 'Qatar'],
  ['RE', 'Réunion'], ['RO', 'Romania'], ['RS', 'Serbia'], ['RU', 'Russia'], ['RW', 'Rwanda'], ['SA', 'Saudi Arabia'],
  ['SB', 'Solomon Islands'], ['SC', 'Seychelles'], ['SD', 'Sudan'], ['SE', 'Sweden'], ['SG', 'Singapore'],
  ['SH', 'St. Helena'], ['SI', 'Slovenia'], ['SJ', 'Svalbard & Jan Mayen'], ['SK', 'Slovakia'],
  ['SL', 'Sierra Leone'], ['SM', 'San Marino'], ['SN', 'Senegal'], ['SO', 'Somalia'], ['SR', 'Suriname'],
  ['SS', 'South Sudan'], ['ST', 'São Tomé & Príncipe'], ['SV', 'El Salvador'], ['SX', 'Sint Maarten'],
  ['SY', 'Syria'], ['SZ', 'Eswatini'], ['TC', 'Turks & Caicos Islands'], ['TD', 'Chad'],
  ['TF', 'French Southern Territories'], ['TG', 'Togo'], ['TH', 'Thailand'], ['TJ', 'Tajikistan'], ['TK', 'Tokelau'],
  ['TL', 'Timor-Leste'], ['TM', 'Turkmenistan'], ['TN', 'Tunisia'], ['TO', 'Tonga'], ['TR', 'Türkiye'],
  ['TT', 'Trinidad & Tobago'], ['TV', 'Tuvalu'], ['TW', 'Taiwan'], ['TZ', 'Tanzania'], ['UA', 'Ukraine'],
  ['UG', 'Uganda'], ['UM', 'U.S. Outlying Islands'], ['US', 'United States'], ['UY', 'Uruguay'],
  ['UZ', 'Uzbekistan'], ['VA', 'Vatican City'], ['VC', 'St. Vincent & Grenadines'], ['VE', 'Venezuela'],
  ['VG', 'British Virgin Islands'], ['VI', 'U.S. Virgin Islands'], ['VN', 'Vietnam'], ['VU', 'Vanuatu'],
  ['WF', 'Wallis & Futuna'], ['WS', 'Samoa'], ['YE', 'Yemen'], ['YT', 'Mayotte'], ['ZA', 'South Africa'],
  ['ZM', 'Zambia'], ['ZW', 'Zimbabwe'],
];

const COUNTRY_OPTIONS = COUNTRIES.map(([value, label]) => ({ value, label }));

const US_STATES = [
  ['AL', 'Alabama'], ['AK', 'Alaska'], ['AZ', 'Arizona'], ['AR', 'Arkansas'], ['CA', 'California'],
  ['CO', 'Colorado'], ['CT', 'Connecticut'], ['DE', 'Delaware'], ['DC', 'District of Columbia'], ['FL', 'Florida'],
  ['GA', 'Georgia'], ['HI', 'Hawaii'], ['ID', 'Idaho'], ['IL', 'Illinois'], ['IN', 'Indiana'], ['IA', 'Iowa'],
  ['KS', 'Kansas'], ['KY', 'Kentucky'], ['LA', 'Louisiana'], ['ME', 'Maine'], ['MD', 'Maryland'],
  ['MA', 'Massachusetts'], ['MI', 'Michigan'], ['MN', 'Minnesota'], ['MS', 'Mississippi'], ['MO', 'Missouri'],
  ['MT', 'Montana'], ['NE', 'Nebraska'], ['NV', 'Nevada'], ['NH', 'New Hampshire'], ['NJ', 'New Jersey'],
  ['NM', 'New Mexico'], ['NY', 'New York'], ['NC', 'North Carolina'], ['ND', 'North Dakota'], ['OH', 'Ohio'],
  ['OK', 'Oklahoma'], ['OR', 'Oregon'], ['PA', 'Pennsylvania'], ['RI', 'Rhode Island'], ['SC', 'South Carolina'],
  ['SD', 'South Dakota'], ['TN', 'Tennessee'], ['TX', 'Texas'], ['UT', 'Utah'], ['VT', 'Vermont'],
  ['VA', 'Virginia'], ['WA', 'Washington'], ['WV', 'West Virginia'], ['WI', 'Wisconsin'], ['WY', 'Wyoming'],
  ['AS', 'American Samoa'], ['GU', 'Guam'], ['MP', 'Northern Mariana Islands'], ['PR', 'Puerto Rico'],
  ['VI', 'U.S. Virgin Islands'], ['UM', 'U.S. Minor Outlying Islands'],
  ['AA', 'Armed Forces Americas (AA)'], ['AE', 'Armed Forces Europe (AE)'], ['AP', 'Armed Forces Pacific (AP)'],
].map(([value, label]) => ({ value, label }));

const ACCEPTED_DOCUMENT_TYPES = ['pdf', 'jpg', 'jpeg', 'png'];

const MARKETS = {
  US: {
    code: 'US',
    title: 'American Express\u00ae USA Corporate Program: Know Your Customer (KYC)',
    intro: {
      regulatoryNotice: 'To help the United States Government fight terrorism and money laundering, Federal law (the USA PATRIOT Act) requires us to obtain, verify, and record information that identifies each person.',
      missingDetails: 'We\u2019re missing important details on your account.',
      loginPrompt: 'Please provide the requested information by logging in to the portal using one of the below options:',
    },
    steps: [
      {
        id: 'legal-name',
        title: 'Full Legal Name',
        subtitle: 'as it appears on your government identification, including middle name if applicable',
        fields: [
          { id: 'firstName', label: 'First Name', type: 'text', required: true, rule: 'personName' },
          { id: 'middleName', label: 'Middle Name (if applicable)', type: 'text', required: false, rule: 'personName' },
          { id: 'lastName', label: 'Last Name', type: 'text', required: true, rule: 'personName' },
          { id: 'dateOfBirth', label: 'Date of Birth', type: 'date', required: true, rule: 'adult', section: 'Date of birth' },
        ],
      },
      {
        id: 'residential-address',
        title: 'Full Residential Address',
        subtitle: 'Please note that you cannot use a P.O. Box, post office location, commercial mail receiving agency or a registered agent as your address',
        fields: [
          { id: 'addressLine1', label: 'Address Line 1', type: 'text', required: true, rule: 'noPoBox' },
          { id: 'addressLine2', label: 'Address Line 2 (If applicable)', type: 'text', required: false, rule: 'noPoBox' },
          { id: 'city', label: 'City', type: 'text', required: true },
          { id: 'country', label: 'Country', type: 'select', required: true, options: COUNTRY_OPTIONS, defaultValue: 'US' },
          {
            id: 'state', label: 'State', type: 'select', required: true, options: US_STATES,
            showWhen: { field: 'country', equals: 'US' },
          },
          {
            id: 'region', label: 'State', type: 'text', required: true,
            showWhen: { field: 'country', notEquals: 'US' },
          },
          { id: 'postCode', label: 'Post code / Zip code', type: 'text', required: true, rule: 'postalCode' },
        ],
      },
      {
        id: 'national-id',
        title: 'National ID',
        paragraphs: [
          'Please provide your Social Security number (SSN). If you do not have SSN, please provide your ITIN.',
          'In case you do not have SSN or ITIN, you must provide another valid government-issued identification document and include a copy of the document here',
        ],
        fields: [
          {
            id: 'idType', label: 'Type of ID', type: 'radio', required: true,
            options: [
              { value: 'ssn', label: 'Social Security number (SSN)' },
              { value: 'itin', label: 'Individual Taxpayer Identification number (ITIN)' },
              { value: 'none', label: 'I declare I haven\u2019t been issued a SSN or ITIN' },
            ],
          },
          {
            id: 'ssn', label: 'Social Security number', type: 'text', required: true, rule: 'ssn', sensitive: true,
            showWhen: { field: 'idType', equals: 'ssn' },
          },
          {
            id: 'itin', label: 'ITIN (if SSN is not available)', type: 'text', required: true, rule: 'itin', sensitive: true,
            showWhen: { field: 'idType', equals: 'itin' },
          },
          {
            id: 'govIdType', label: 'Government-issued Identification Type', type: 'select', required: true,
            options: [
              { value: 'foreign-drivers-license', label: 'Foreign-issued Driver\u2019s License' },
              { value: 'foreign-passport', label: 'Foreign-issued Passport' },
              { value: 'foreign-national-id', label: 'Foreign-National ID' },
            ],
            showWhen: { field: 'idType', equals: 'none' },
          },
          {
            id: 'govIdNumber', label: 'Identification Number', type: 'text', required: true, rule: 'documentNumber',
            showWhen: { field: 'idType', equals: 'none' },
          },
          {
            id: 'govIdIssueDate', label: 'Issuance Date', type: 'date', required: true, rule: 'pastDate',
            showWhen: { field: 'idType', equals: 'none' },
          },
          {
            id: 'govIdExpiryDate', label: 'Expiration Date', type: 'date', required: true,
            rule: { name: 'notExpired', after: 'govIdIssueDate' },
            showWhen: { field: 'idType', equals: 'none' },
          },
          {
            id: 'govIdCountry', label: 'Country Of Issuance', type: 'select', required: true, options: COUNTRY_OPTIONS,
            showWhen: { field: 'idType', equals: 'none' },
          },
          {
            id: 'govIdDocument', label: 'Upload document', type: 'file', required: true, rule: 'documentUpload',
            accept: ACCEPTED_DOCUMENT_TYPES,
            note: 'We may use the documents you provide to verify or update your personal information on file. Only the details requested in this form will be used. For information about how we protect your privacy, please read our Privacy Statement.',
            showWhen: { field: 'idType', equals: 'none' },
          },
        ],
      },
    ],
    signature: {
      title: 'Sign your KYC Form',
      instructions: 'Review your answers below, then click Sign Here to add your signature.',
      methods: ['draw', 'choose'],
    },
    thankYou: {
      heading: 'Thank you for helping to keep your account up to date and secure.',
      lines: [
        'Your KYC information has been submitted successfully.',
        'If we require any additional information, we\u2019ll reach out to you.',
      ],
    },
  },
};

const CARDMEMBER = {
  firstName: 'Jordan',
  lastName: 'Ellis',
  company: 'Harbor & Pine Coffee Roasters, Inc.',
};

const CARDS = [
  { cardNumber: '378282246310005', cardId: '4321', product: 'Corporate Green Card' },
  { cardNumber: '371449635398431', cardId: '8765', product: 'Corporate Platinum Card' },
];

const ACCOUNTS = [
  { userId: 'jordan.ellis', password: 'Corporate2026!', cards: CARDS.map((c) => c.cardNumber) },
];

const SESSION_TTL_MS = 60 * 60 * 1000;
const MAX_SESSIONS = 500;
const sessions = new Map();
const submissions = new Map();

const PO_BOX = /\b(?:p\.?\s*o\.?\s*b(?:ox)?|post\s*office\s*box|pmb|private\s*mail(?:ing)?\s*box)\b/i;
const SSN = /^(?!000|666|9\d\d)\d{3}-?(?!00)\d{2}-?(?!0000)\d{4}$/;
const ITIN = /^9\d{2}-?(?:5\d|6[0-5]|7\d|8[0-8]|9[0-2]|9[4-9])-?\d{4}$/;
const US_ZIP = /^\d{5}$/;
const POST_CODE = /^[A-Za-z0-9][A-Za-z0-9 -]{1,9}$/;
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

function getMarket(code) {
  const key = typeof code === 'string' ? code.trim().toUpperCase() : 'US';
  return Object.prototype.hasOwnProperty.call(MARKETS, key) ? MARKETS[key] : null;
}

function listMarkets() {
  return Object.keys(MARKETS);
}

function getForm(code) {
  const market = getMarket(code);
  if (!market) return null;
  return JSON.parse(JSON.stringify(market));
}

function maskCard(cardNumber) {
  return `xxxx-xxxxxx-${cardNumber.slice(-5)}`;
}

function publicCard(card) {
  return { key: card.cardNumber.slice(-5), product: card.product, masked: maskCard(card.cardNumber) };
}

function pruneSessions(now = Date.now()) {
  for (const [token, s] of sessions) {
    if (now - s.createdAt > SESSION_TTL_MS) sessions.delete(token);
  }
  while (sessions.size >= MAX_SESSIONS) sessions.delete(sessions.keys().next().value);
}

function newSession(data) {
  pruneSessions();
  const token = crypto.randomBytes(16).toString('hex');
  sessions.set(token, { ...data, createdAt: Date.now() });
  return token;
}

function getSession(token) {
  if (typeof token !== 'string') return null;
  const s = sessions.get(token);
  if (!s) return null;
  if (Date.now() - s.createdAt > SESSION_TTL_MS) {
    sessions.delete(token);
    return null;
  }
  return s;
}

function sessionView(token, s) {
  return {
    sessionToken: token,
    method: s.method,
    market: s.market,
    cardmember: CARDMEMBER,
    card: s.card ? publicCard(s.card) : null,
    cards: s.method === 'account' ? s.cards.map(publicCard) : undefined,
    needsCardSelection: !s.card,
  };
}

/**
 * Start a portal session by card details (default) or My Account credentials.
 * Returns { error } with an HTTP status on failure.
 */
function login(body = {}) {
  const market = getMarket(body.market || 'US');
  if (!market) return { status: 404, error: `KYC is not yet available for market ${String(body.market).toUpperCase()}`, code: 'MARKET_NOT_AVAILABLE' };

  if (body.method === 'account') {
    const userId = typeof body.userId === 'string' ? body.userId.trim() : '';
    const password = typeof body.password === 'string' ? body.password : '';
    if (!userId || !password) return { status: 400, error: 'Enter your User ID and Password', code: 'VALIDATION_ERROR' };
    const account = ACCOUNTS.find((a) => a.userId.toLowerCase() === userId.toLowerCase() && a.password === password);
    if (!account) return { status: 401, error: 'The User ID or Password you entered is incorrect.', code: 'INVALID_CREDENTIALS' };
    const cards = account.cards.map((n) => CARDS.find((c) => c.cardNumber === n));
    const token = newSession({ method: 'account', market: market.code, cards, card: null });
    return { status: 200, ...sessionView(token, sessions.get(token)) };
  }

  const cardNumber = typeof body.cardNumber === 'string' ? body.cardNumber.replace(/[\s-]/g, '') : '';
  const cardId = typeof body.cardId === 'string' ? body.cardId.trim() : '';
  const errors = {};
  if (!/^3[47]\d{13}$/.test(cardNumber)) errors.cardNumber = 'Enter your 15-digit Card Number';
  if (!/^\d{4}$/.test(cardId)) errors.cardId = 'Enter the 4-digit Card ID printed above your account number';
  if (Object.keys(errors).length) return { status: 400, error: 'Check your Card details', code: 'VALIDATION_ERROR', errors };
  const card = CARDS.find((c) => c.cardNumber === cardNumber && c.cardId === cardId);
  if (!card) return { status: 401, error: 'We couldn\u2019t verify your Card details. Please try again.', code: 'INVALID_CREDENTIALS' };
  const token = newSession({ method: 'card', market: market.code, cards: [card], card });
  return { status: 200, ...sessionView(token, sessions.get(token)) };
}

function selectCard(body = {}) {
  const s = getSession(body.sessionToken);
  if (!s) return { status: 401, error: 'Your session has expired. Please log in again.', code: 'SESSION_EXPIRED' };
  const card = s.cards.find((c) => c.cardNumber.slice(-5) === body.cardKey);
  if (!card) return { status: 400, error: 'Select a card', code: 'VALIDATION_ERROR' };
  s.card = card;
  return { status: 200, ...sessionView(body.sessionToken, s) };
}

function isVisible(field, values) {
  if (!field.showWhen) return true;
  const actual = values[field.showWhen.field];
  if ('equals' in field.showWhen) return actual === field.showWhen.equals;
  if ('notEquals' in field.showWhen) return actual !== field.showWhen.notEquals;
  return true;
}

function parseDate(value) {
  if (typeof value !== 'string' || !ISO_DATE.test(value)) return null;
  const d = new Date(`${value}T00:00:00Z`);
  return Number.isNaN(d.getTime()) || d.toISOString().slice(0, 10) !== value ? null : d;
}

function todayUtc(now = new Date()) {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
}

function ageOn(birth, today) {
  let age = today.getUTCFullYear() - birth.getUTCFullYear();
  const m = today.getUTCMonth() - birth.getUTCMonth();
  if (m < 0 || (m === 0 && today.getUTCDate() < birth.getUTCDate())) age -= 1;
  return age;
}

const RULES = {
  personName: (v) => (/^[\p{L}][\p{L}' .-]{0,59}$/u.test(v) ? null : 'Use letters, spaces, hyphens and apostrophes only'),
  adult: (v, _values, today) => {
    const d = parseDate(v);
    if (!d) return 'Enter a valid date';
    if (d > today) return 'Date of birth cannot be in the future';
    const age = ageOn(d, today);
    if (age > 120) return 'Enter a valid date of birth';
    return age >= 18 ? null : 'You must be at least 18 years old';
  },
  noPoBox: (v) => (PO_BOX.test(v) ? 'P.O. Boxes and private mailboxes (PMB) cannot be used as a residential address' : null),
  postalCode: (v, values) => {
    if (values.country === 'US') return US_ZIP.test(v) ? null : 'Enter a 5-digit Zip code';
    return POST_CODE.test(v) ? null : 'Enter a valid post code';
  },
  ssn: (v) => (SSN.test(v) ? null : 'Enter a valid 9-digit Social Security number'),
  itin: (v) => (ITIN.test(v) ? null : 'Enter a valid 9-digit ITIN beginning with 9'),
  documentNumber: (v) => (/^[A-Za-z0-9][A-Za-z0-9 -]{3,24}$/.test(v) ? null : 'Enter a valid identification number'),
  pastDate: (v, _values, today) => {
    const d = parseDate(v);
    if (!d) return 'Enter a valid date';
    return d > today ? 'Issuance date cannot be in the future' : null;
  },
  notExpired: (v, values, today, rule) => {
    const d = parseDate(v);
    if (!d) return 'Enter a valid date';
    if (d < today) return 'This identification document has expired';
    const issued = rule.after ? parseDate(values[rule.after]) : null;
    if (issued && d <= issued) return 'Expiration date must be after the issuance date';
    return null;
  },
  documentUpload: (v) => {
    const ext = v.includes('.') ? v.split('.').pop().toLowerCase() : '';
    return ACCEPTED_DOCUMENT_TYPES.includes(ext) ? null : 'Upload a PDF, JPG or PNG file';
  },
};

function validateField(field, values, today) {
  const raw = values[field.id];
  const value = typeof raw === 'string' ? raw.trim() : '';
  if (!value) return field.required ? `${field.label} is required` : null;
  if (value.length > 200) return `${field.label} is too long`;
  if ((field.type === 'select' || field.type === 'radio') && !field.options.some((o) => o.value === value)) {
    return `Select a valid ${field.label}`;
  }
  if (field.type === 'date' && !parseDate(value)) return 'Enter a valid date';
  if (!field.rule) return null;
  const rule = typeof field.rule === 'string' ? { name: field.rule } : field.rule;
  return RULES[rule.name](value, values, today, rule);
}

function normaliseValues(values) {
  const out = {};
  if (!values || typeof values !== 'object' || Array.isArray(values)) return out;
  for (const [k, v] of Object.entries(values)) {
    if (typeof v === 'string') out[k] = v.trim();
  }
  return out;
}

/**
 * Validate one step. `values` holds every answer so far so cross-step rules
 * (country-dependent post code) and showWhen conditions resolve.
 */
function validateStep(marketCode, stepId, rawValues, now = new Date()) {
  const market = getMarket(marketCode);
  if (!market) return null;
  const step = market.steps.find((s) => s.id === stepId);
  if (!step) return null;
  const values = normaliseValues(rawValues);
  const today = todayUtc(now);
  const errors = {};
  for (const field of step.fields) {
    if (!isVisible(field, values)) continue;
    const error = validateField(field, values, today);
    if (error) errors[field.id] = error;
  }
  return { valid: Object.keys(errors).length === 0, errors };
}

function redact(value) {
  const digits = value.replace(/\D/g, '');
  return `***-**-${digits.slice(-4)}`;
}

function validateSignature(signature) {
  if (!signature || typeof signature !== 'object') return 'Sign your KYC form before submitting';
  if (signature.method === 'draw') {
    const ok = typeof signature.image === 'string'
      && /^data:image\/png;base64,[A-Za-z0-9+/=]+$/.test(signature.image)
      && signature.image.length < 400000;
    return ok ? null : 'Draw your signature before submitting';
  }
  if (signature.method === 'choose') {
    const ok = typeof signature.name === 'string' && /^[\p{L}][\p{L}' .-]{1,80}$/u.test(signature.name.trim())
      && Number.isInteger(signature.style) && signature.style >= 0 && signature.style < 4;
    return ok ? null : 'Choose your signature before submitting';
  }
  return 'Sign your KYC form before submitting';
}

function newReference() {
  return `KYC-${crypto.randomBytes(4).toString('hex').toUpperCase()}`;
}

/**
 * Re-validate every step server-side, require a signature, and record a redacted submission.
 */
function submit(body = {}, now = new Date()) {
  const s = getSession(body.sessionToken);
  if (!s) return { status: 401, error: 'Your session has expired. Please log in again.', code: 'SESSION_EXPIRED' };
  if (!s.card) return { status: 400, error: 'Select the card you would like to provide KYC for', code: 'CARD_NOT_SELECTED' };
  const market = getMarket(body.market || s.market);
  if (!market || market.code !== s.market) return { status: 400, error: 'Market does not match your session', code: 'MARKET_MISMATCH' };
  if (submissions.has(body.sessionToken)) {
    return { status: 409, error: 'Your KYC information has already been submitted.', code: 'ALREADY_SUBMITTED', reference: submissions.get(body.sessionToken).reference };
  }

  const values = normaliseValues(body.values);
  const errors = {};
  for (const step of market.steps) {
    const result = validateStep(market.code, step.id, values, now);
    if (!result.valid) errors[step.id] = result.errors;
  }
  if (Object.keys(errors).length) return { status: 400, error: 'Some of your answers need attention', code: 'VALIDATION_ERROR', errors };
  const signatureError = validateSignature(body.signature);
  if (signatureError) return { status: 400, error: signatureError, code: 'SIGNATURE_REQUIRED' };

  const answers = {};
  for (const step of market.steps) {
    for (const field of step.fields) {
      if (!isVisible(field, values) || !values[field.id]) continue;
      answers[field.id] = field.sensitive ? redact(values[field.id]) : values[field.id];
    }
  }
  const record = {
    reference: newReference(),
    market: market.code,
    card: publicCard(s.card),
    submittedAt: now.toISOString(),
    signatureMethod: body.signature.method,
    answers,
  };
  submissions.set(body.sessionToken, record);
  return { status: 201, success: true, ...record };
}

function resetForTests() {
  sessions.clear();
  submissions.clear();
}

module.exports = {
  MARKETS,
  CARDS,
  ACCOUNTS,
  CARDMEMBER,
  COUNTRIES,
  US_STATES,
  getForm,
  listMarkets,
  login,
  selectCard,
  validateStep,
  submit,
  isVisible,
  resetForTests,
};
