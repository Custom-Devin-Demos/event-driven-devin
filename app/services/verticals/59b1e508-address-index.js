const SERVICE_AREAS = [
  {
    zip: '70815',
    city: 'Baton Rouge',
    state: 'LA',
    divisionId: 'DIV-3742',
    division: 'Baton Rouge Hauling',
    trashDays: ['Monday', 'Thursday'],
    recyclingDay: 'Wednesday',
    yardWasteDay: 'Monday',
    nextHoliday: { name: 'Labor Day', date: '2026-09-07', shift: 'one day' },
  },
  {
    zip: '95247',
    city: 'Murphys',
    state: 'CA',
    divisionId: 'DIV-4810',
    division: 'Calaveras County Hauling',
    trashDays: ['Tuesday'],
    recyclingDay: 'Friday',
    yardWasteDay: 'Thursday',
    nextHoliday: { name: 'Thanksgiving Day', date: '2026-11-26', shift: 'one day' },
  },
  {
    zip: '60137',
    city: 'Glen Ellyn',
    state: 'IL',
    divisionId: 'DIV-2058',
    division: 'DuPage County Hauling',
    trashDays: ['Monday', 'Thursday'],
    recyclingDay: 'Thursday',
    yardWasteDay: 'Friday',
    nextHoliday: { name: 'Memorial Day', date: '2026-05-25', shift: 'one day' },
  },
  {
    zip: '48104',
    city: 'Ann Arbor',
    state: 'MI',
    divisionId: 'DIV-7193',
    division: 'Washtenaw County Hauling',
    trashDays: ['Tuesday', 'Friday'],
    recyclingDay: 'Wednesday',
    yardWasteDay: 'Wednesday',
    nextHoliday: { name: 'Independence Day', date: '2026-07-04', shift: 'one day' },
  },
  {
    zip: '48843',
    city: 'Howell',
    state: 'MI',
    divisionId: 'DIV-6384',
    division: 'Livingston County Hauling',
    trashDays: ['Wednesday'],
    recyclingDay: 'Monday',
    yardWasteDay: 'Friday',
    nextHoliday: { name: 'Labor Day', date: '2026-09-07', shift: 'one day' },
  },
];

// User-supplied keys are kept on null-prototype records so __proto__ and constructor cannot reach Object.prototype, preventing prototype pollution (CWE-1321; cf. CVE-2022-24999 in Express's qs parser).
function createRecord(fields) {
  return Object.assign(Object.create(null), fields);
}

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && Object.getPrototypeOf(value) === Object.prototype;
}

function buildZipIndex() {
  return SERVICE_AREAS.reduce((index, area) => {
    index[area.zip] = createRecord(area);
    return index;
  }, Object.create(null));
}

function sanitizeLookupInput(body) {
  const input = isPlainObject(body) ? body : {};
  const fields = {};
  ['address', 'sourcePage', 'devinUserId', 'devinOrgId', 'devinEmail'].forEach((key) => {
    if (typeof input[key] === 'string') fields[key] = input[key].trim();
  });
  if (typeof fields.address === 'string') fields.address = fields.address.slice(0, 120);
  return createRecord(fields);
}

function parseAddress(address) {
  if (typeof address !== 'string' || !address.trim()) {
    throw new Error('A valid service address is required');
  }

  const normalized = address.trim().replace(/\s+/g, ' ');
  const match = normalized.match(/^(.+?),\s*([^,]+?),\s*([A-Za-z]{2})(?:,|\s)\s*(\d{5})$/);
  if (match) {
    return createRecord({
      street: match[1].trim(),
      city: match[2].trim(),
      state: match[3].toUpperCase(),
      zip: match[4],
    });
  }

  const cityStateMatch = normalized.match(/,\s*([^,]+?),\s*([A-Za-z]{2})$/);
  if (cityStateMatch) {
    const city = cityStateMatch[1].trim().toLowerCase();
    const state = cityStateMatch[2].toUpperCase();
    const area = SERVICE_AREAS.find(
      (entry) => entry.city.toLowerCase() === city && entry.state === state,
    );
    if (area) {
      return createRecord({
        street: normalized.split(',')[0].trim(),
        city: area.city,
        state: area.state,
        zip: area.zip,
      });
    }
  }

  throw new Error('Enter a complete service address');
}

module.exports = {
  SERVICE_AREAS,
  createRecord,
  isPlainObject,
  buildZipIndex,
  sanitizeLookupInput,
  parseAddress,
};
