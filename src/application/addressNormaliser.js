/**
 * Address normalisation for the CIBC credit-card application funnel (step 1).
 *
 * Canadian postal codes are stored in the "A1A 1A1" presentation form; street,
 * city and unit values are stored upcased and trimmed.
 */

const PROVINCES = [
  { code: 'AB', name: 'Alberta' },
  { code: 'BC', name: 'British Columbia' },
  { code: 'MB', name: 'Manitoba' },
  { code: 'NB', name: 'New Brunswick' },
  { code: 'NL', name: 'Newfoundland and Labrador' },
  { code: 'NS', name: 'Nova Scotia' },
  { code: 'NT', name: 'Northwest Territories' },
  { code: 'NU', name: 'Nunavut' },
  { code: 'ON', name: 'Ontario' },
  { code: 'PE', name: 'Prince Edward Island' },
  { code: 'QC', name: 'Quebec' },
  { code: 'SK', name: 'Saskatchewan' },
  { code: 'YT', name: 'Yukon' },
];

const PROVINCE_CODES = PROVINCES.map((province) => province.code);

const POSTAL_CODE_PATTERN = /^[ABCEGHJKLMNPRSTVXY]\d[ABCEGHJKLMNPRSTVWXYZ]\d[ABCEGHJKLMNPRSTVWXYZ]\d$/;

/**
 * Format a Canadian postal code as "A1A 1A1", stripping incidental spacing,
 * hyphens and casing differences from the raw input.
 */
function formatPostalCode(value) {
  const compact = String(value).replace(/[\s-]/g, '').toUpperCase();
  if (compact.length !== 6) return compact;
  return `${compact.slice(0, 3)} ${compact.slice(3)}`;
}

function isValidPostalCode(value) {
  return POSTAL_CODE_PATTERN.test(String(value).replace(/[\s-]/g, '').toUpperCase());
}

function upcase(value) {
  return value.trim().toUpperCase();
}

// Every address field runs through exactly one of these in a single pass.
const FIELD_NORMALISERS = {
  street: upcase,
  unit: upcase,
  city: upcase,
  province: upcase,
  postalCode: formatPostalCode,
};

/**
 * Normalise an applicant address.
 *
 * @param {{street: string, unit?: string, city: string, province: string, postalCode: string}} input
 * @returns {{street: string, unit: string, city: string, province: string, postalCode: string, country: string}}
 */
function normaliseAddress(input) {
  if (!input || typeof input !== 'object') {
    throw new TypeError('normaliseAddress requires an address object');
  }

  const address = { country: 'CA' };

  Object.entries(FIELD_NORMALISERS).forEach(([field, normalise]) => {
    address[field] = normalise(input[field]);
  });

  return address;
}

module.exports = {
  normaliseAddress,
  formatPostalCode,
  isValidPostalCode,
  PROVINCES,
  PROVINCE_CODES,
};
