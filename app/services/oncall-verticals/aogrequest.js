const crypto = require('crypto');
const logger = require('../../telemetry/logger');
const { incrementMetric, recordTiming } = require('../../telemetry/datadog');
const { Sentry } = require('../../telemetry/sentry');

const ROUTE = '/api/oncall/aogrequest/requests';
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const TAIL_NUMBER = /^[A-Z0-9]{1,3}-?[A-Z0-9]{1,5}$/;

/**
 * Regional Boeing AOG desks. Every request is queued to the desk that covers
 * the operator's country so a duty AOG manager responds within the target.
 */
const AOG_DESKS = {
  AMER: { name: 'Boeing AOG Desk \u2014 Americas (Seattle)', queue: 'aog-amer', firstResponseMinutes: 30 },
  EMEA: { name: 'Boeing AOG Desk \u2014 Europe, Middle East & Africa (London)', queue: 'aog-emea', firstResponseMinutes: 30 },
  APAC: { name: 'Boeing AOG Desk \u2014 Asia Pacific (Singapore)', queue: 'aog-apac', firstResponseMinutes: 30 },
};

/** Countries offered on the AOG request form. */
const COUNTRIES = [
  'Afghanistan', 'Albania', 'Algeria', 'American Samoa', 'Andorra', 'Angola', 'Anguilla', 'Antarctica',
  'Antigua and Barbuda', 'Argentina', 'Armenia', 'Aruba', 'Australia', 'Austria', 'Azerbaijan', 'Bahamas',
  'Bahrain', 'Bangladesh', 'Barbados', 'Belarus', 'Belgium', 'Belize', 'Benin', 'Bermuda', 'Bhutan',
  'Bolivia', 'Bosnia and Herzegovina', 'Botswana', 'Bouvet Island', 'Brazil',
  'British Indian Ocean Territory', 'Brunei Darussalam', 'Bulgaria', 'Burkina Faso', 'Burundi', 'Cambodia',
  'Cameroon', 'Canada', 'Canary Islands', 'Cape Verde', 'Cayman Islands', 'Central African Republic', 'Chad',
  'Chile', 'China', 'Christmas Island', 'Cocos (Keeling) Islands', 'Colombia', 'Comoros',
  'Congo, Republic of the', 'Congo, The Democratic Republic', 'Cook Islands', 'Costa Rica', "Côte d'Ivoire",
  'Croatia', 'Cuba', 'Curacao', 'Cyprus', 'Czech Republic', 'Denmark', 'Djibouti', 'Dominica',
  'Dominican Republic', 'East Timor', 'Ecuador', 'Egypt', 'El Salvador', 'Equatorial Guinea', 'Eritrea',
  'Estonia', 'Ethiopia', 'Falkland Islands (Malvinas)', 'Faroe Islands', 'Fiji', 'Finland', 'France',
  'French Guiana', 'French Polynesia', 'French Southern Territories', 'Gabon', 'Gambia', 'Georgia',
  'Germany', 'Ghana', 'Gibraltar', 'Greece', 'Greenland', 'Grenada', 'Guadeloupe', 'Guam', 'Guatemala',
  'Guernsey (UK)', 'Guinea', 'Guinea-Bissau', 'Guyana', 'Haiti', 'Heard and McDonald Islands',
  'Holy See (Vatican City State)', 'Honduras', 'Hong Kong', 'Hungary', 'Iceland', 'India', 'Indonesia',
  'Iran (Islamic Republic of)', 'Iraq', 'Ireland', 'Isle Of Man', 'Israel', 'Italy', 'Jamaica', 'Japan',
  'Jersey (UK)', 'Jordan', 'Kazakhstan', 'Kenya', 'Kiribati', 'Kosovo', 'Kuwait', 'Kyrgyzstan', 'Laos',
  'Latvia', 'Lebanon', 'Lesotho', 'Liberia', 'Liechtenstein', 'Lithuania', 'Luxembourg', 'Macau',
  'Macedonia, Republic of', 'Madagascar', 'Malawi', 'Malaysia', 'Maldives', 'Mali', 'Malta',
  'Marshall Islands', 'Martinique', 'Mauritania', 'Mauritius', 'Mayotte', 'Mexico',
  'Micronesia, Federated States of', 'Moldova, Republic of', 'Monaco', 'Mongolia', 'Montenegro',
  'Montserrat', 'Morocco', 'Mozambique', 'Myanmar', 'Namibia', 'Nauru', 'Nepal', 'Netherlands',
  'New Caledonia', 'New Zealand', 'Nicaragua', 'Niger', 'Nigeria', 'Niue', 'Norfolk Island', 'North Korea',
  'Northern Mariana Islands', 'Norway', 'Oman', 'Pakistan', 'Palau', 'Palestine', 'Panama',
  'Papua New Guinea', 'Paraguay', 'Peru', 'Philippines', 'Pitcairn', 'Poland', 'Portugal', 'Puerto Rico',
  'Qatar', 'Republic of China (Taiwan)', 'Republic of Korea', 'Republic of South Sudan', 'Reunion',
  'Romania', 'Russian Federation', 'Rwanda', 'Samoa', 'San Marino', 'Sao Tome and Principe', 'Saudi Arabia',
  'Senegal', 'Serbia', 'Seychelles', 'Sierra Leone', 'Singapore', 'Slovakia (Slovak Republic)', 'Slovenia',
  'Solomon Islands', 'Somalia', 'South Africa', 'Spain', 'Sri Lanka', 'St. Helena', 'St. Kitts and Nevis',
  'St. Lucia', 'St. Pierre and Miquelon', 'St. Vincent and the Grenadines', 'State of Libya', 'Sudan',
  'Suriname', 'Svalbard and Jan Mayen Islands', 'Eswatini', 'Sweden', 'Switzerland', 'Syrian Arab Republic',
  'Tajikistan', 'Tanzania, United Republic of', 'Thailand', 'Togo', 'Tokelau', 'Tonga',
  'Trinidad and Tobago', 'Tunisia', 'Turkey', 'Turkmenistan', 'Turks and Caicos Islands', 'Tuvalu', 'Uganda',
  'Ukraine', 'United Arab Emirates', 'United Kingdom', 'United States', 'Uruguay',
  'US Minor Outlying Islands', 'Uzbekistan', 'Vanuatu', 'Venezuela', 'Vietnam', 'Virgin Islands (British)',
  'Virgin Islands (U.S.)', 'Wallis and Futuna Islands', 'Western Sahara', 'Yemen', 'Zambia', 'Zimbabwe'
];

/**
 * Country coverage per AOG region, from the geo-ref@2026.11.04 country
 * reference sync.
 */
const REGION_COUNTRIES = {
  AMER: [
    'American Samoa', 'Anguilla', 'Antarctica', 'Antigua and Barbuda', 'Argentina', 'Aruba', 'Bahamas',
    'Barbados', 'Belize', 'Bermuda', 'Bolivia', 'Bouvet Island', 'Brazil', 'Canada', 'Cayman Islands',
    'Chile', 'Colombia', 'Costa Rica', 'Cuba', 'Curacao', 'Dominica', 'Dominican Republic', 'Ecuador',
    'El Salvador', 'Falkland Islands (Malvinas)', 'French Guiana', 'Greenland', 'Grenada', 'Guadeloupe',
    'Guam', 'Guatemala', 'Guyana', 'Haiti', 'Honduras', 'Jamaica', 'Martinique', 'Mexico', 'Montserrat',
    'Nicaragua', 'Northern Mariana Islands', 'Panama', 'Paraguay', 'Peru', 'Puerto Rico',
    'St. Kitts and Nevis', 'St. Lucia', 'St. Pierre and Miquelon', 'St. Vincent and the Grenadines',
    'Suriname', 'Trinidad and Tobago', 'Turks and Caicos Islands', 'United States', 'Uruguay',
    'US Minor Outlying Islands', 'Venezuela', 'Virgin Islands (British)', 'Virgin Islands (U.S.)'
  ],
  EMEA: [
    'Albania', 'Algeria', 'Andorra', 'Angola', 'Armenia', 'Austria', 'Azerbaijan', 'Bahrain', 'Belarus',
    'Belgium', 'Benin', 'Bosnia and Herzegovina', 'Botswana', 'Bulgaria', 'Burkina Faso', 'Burundi',
    'Cameroon', 'Canary Islands', 'Cape Verde', 'Central African Republic', 'Chad', 'Comoros',
    'Congo, Republic of the', 'Congo, The Democratic Republic', 'CÃ´te d`Ivoire', 'Croatia', 'Cyprus',
    'Czech Republic', 'Denmark', 'Djibouti', 'Egypt', 'Equatorial Guinea', 'Eritrea', 'Estonia', 'Ethiopia',
    'Faroe Islands', 'Finland', 'France', 'French Southern Territories', 'Gabon', 'Gambia', 'Georgia',
    'Germany', 'Ghana', 'Gibraltar', 'Greece', 'Guernsey (UK)', 'Guinea', 'Guinea-Bissau',
    'Holy See (Vatican City State)', 'Hungary', 'Iceland', 'Iran (Islamic Republic of)', 'Iraq', 'Ireland',
    'Isle Of Man', 'Israel', 'Italy', 'Jersey (UK)', 'Jordan', 'Kenya', 'Kosovo', 'Kuwait', 'Latvia',
    'Lebanon', 'Lesotho', 'Liberia', 'Liechtenstein', 'Lithuania', 'Luxembourg', 'Macedonia, Republic of',
    'Madagascar', 'Malawi', 'Mali', 'Malta', 'Mauritania', 'Mauritius', 'Mayotte', 'Moldova, Republic of',
    'Monaco', 'Montenegro', 'Morocco', 'Mozambique', 'Namibia', 'Netherlands', 'Niger', 'Nigeria', 'Norway',
    'Oman', 'Palestine', 'Poland', 'Portugal', 'Qatar', 'Republic of South Sudan', 'Reunion', 'Romania',
    'Russian Federation', 'Rwanda', 'San Marino', 'Sao Tome and Principe', 'Saudi Arabia', 'Senegal',
    'Serbia', 'Seychelles', 'Sierra Leone', 'Slovakia (Slovak Republic)', 'Slovenia', 'Somalia',
    'South Africa', 'Spain', 'St. Helena', 'State of Libya', 'Sudan', 'Svalbard and Jan Mayen Islands',
    'Eswatini', 'Sweden', 'Switzerland', 'Syrian Arab Republic', 'Tanzania, United Republic of', 'Togo',
    'Tunisia', 'Turkey', 'Uganda', 'Ukraine', 'United Arab Emirates', 'United Kingdom', 'Western Sahara',
    'Yemen', 'Zambia', 'Zimbabwe'
  ],
  APAC: [
    'Afghanistan', 'Australia', 'Bangladesh', 'Bhutan', 'British Indian Ocean Territory',
    'Brunei Darussalam', 'Cambodia', 'China', 'Christmas Island', 'Cocos (Keeling) Islands', 'Cook Islands',
    'East Timor', 'Fiji', 'French Polynesia', 'Heard and McDonald Islands', 'Hong Kong', 'India',
    'Indonesia', 'Japan', 'Kazakhstan', 'Kiribati', 'Kyrgyzstan', 'Laos', 'Macau', 'Malaysia', 'Maldives',
    'Marshall Islands', 'Micronesia, Federated States of', 'Mongolia', 'Myanmar', 'Nauru', 'Nepal',
    'New Caledonia', 'New Zealand', 'Niue', 'Norfolk Island', 'North Korea', 'Pakistan', 'Palau',
    'Papua New Guinea', 'Philippines', 'Pitcairn', 'Republic of China (Taiwan)', 'Republic of Korea',
    'Samoa', 'Singapore', 'Solomon Islands', 'Sri Lanka', 'Tajikistan', 'Thailand', 'Tokelau', 'Tonga',
    'Turkmenistan', 'Tuvalu', 'Uzbekistan', 'Vanuatu', 'Vietnam', 'Wallis and Futuna Islands'
  ],
};

const COUNTRY_REGIONS = Object.fromEntries(
  Object.entries(REGION_COUNTRIES).flatMap(([region, countries]) => countries.map((country) => [country, region])),
);

const AIRCRAFT_MODELS = [
  '737-700', '737-800', '737-900ER', '737 MAX 8', '737 MAX 9', '747-400F', '747-8F', '757-200', '767-300ER',
  '767-300F', '777-200ER', '777-300ER', '777F', '787-8', '787-9', '787-10', 'MD-11F',
];

function requestError(message, field) {
  const err = new Error(message);
  err.code = 'INVALID_REQUEST';
  err.status = 400;
  err.field = field;
  return err;
}

function text(value, max = 200) {
  return String(value == null ? '' : value).replace(/\s+/g, ' ').trim().slice(0, max);
}

function normalizeRequest(body) {
  const request = {
    firstname: text(body.firstname, 80),
    lastname: text(body.lastname, 80),
    email: text(body.email, 120).toLowerCase(),
    company: text(body.company, 120),
    country: text(body.country, 80),
    aircraftModel: text(body.aircraftModel, 20),
    tailNumber: text(body.tailNumber, 12).toUpperCase(),
    station: text(body.station, 60),
    partNumber: text(body.partNumber, 40).toUpperCase(),
    ataChapter: text(body.ataChapter, 4),
    otherInfo: text(body.otherInfo, 2000),
    optin: body.optin === true || body.optin === 'yes',
  };
  const required = [
    ['firstname', 'First Name'], ['lastname', 'Last Name'], ['email', 'Email'], ['company', 'Company'],
    ['country', 'Country'], ['aircraftModel', 'Aircraft model'], ['tailNumber', 'Tail number'],
  ];
  for (const [field, label] of required) {
    if (!request[field]) throw requestError(`${label} is required.`, field);
  }
  if (!EMAIL.test(request.email)) throw requestError('Enter a valid email address.', 'email');
  if (!COUNTRIES.includes(request.country)) throw requestError('Select a country from the list.', 'country');
  if (!AIRCRAFT_MODELS.includes(request.aircraftModel)) throw requestError('Select an aircraft model from the list.', 'aircraftModel');
  if (!TAIL_NUMBER.test(request.tailNumber)) throw requestError('Enter the tail number as registered, e.g. N12345 or G-XLEA.', 'tailNumber');
  return request;
}

function routeToDesk(country) {
  const region = COUNTRY_REGIONS[country];
  const desk = AOG_DESKS[region];
  return { region, name: desk.name, queue: desk.queue, firstResponseMinutes: desk.firstResponseMinutes };
}

function requestNumber(now) {
  const day = now.toISOString().slice(2, 10).replace(/-/g, '');
  return `AOG-${day}-${crypto.randomInt(1000, 10000)}`;
}

async function submitAogRequest(body = {}) {
  const started = Date.now();
  const request = normalizeRequest(body);
  const tags = [`route:${ROUTE}`, `aircraft_model:${request.aircraftModel}`];
  try {
    const desk = routeToDesk(request.country);
    const now = new Date();
    incrementMetric('aogrequest.submit.success', [...tags, `region:${desk.region}`]);
    logger.info('AOG request queued', { route: ROUTE, queue: desk.queue, tailNumber: request.tailNumber });
    return {
      success: true,
      requestNumber: requestNumber(now),
      receivedAt: now.toISOString(),
      desk,
      aircraft: { model: request.aircraftModel, tailNumber: request.tailNumber, station: request.station || null },
      partNumber: request.partNumber || null,
      ataChapter: request.ataChapter || null,
    };
  } catch (error) {
    incrementMetric('aogrequest.submit.error', tags);
    logger.error('AOG request submission failed', { route: ROUTE, country: request.country, tailNumber: request.tailNumber, error: error.message });
    Sentry.captureException(error, {
      tags: { vertical: 'aogrequest', route: ROUTE },
      extra: { country: request.country, aircraftModel: request.aircraftModel, tailNumber: request.tailNumber },
    });
    throw error;
  } finally {
    recordTiming('aogrequest.submit.duration', Date.now() - started, tags);
  }
}

module.exports = { submitAogRequest, COUNTRIES, AIRCRAFT_MODELS, AOG_DESKS, COUNTRY_REGIONS };
