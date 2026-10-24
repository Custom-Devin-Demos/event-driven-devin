/**
 * Reference data for settlement-date projection: booking entities, settlement
 * locations (depositories) and the 2026 market holiday calendars.
 */

const HOLIDAYS = {
  CA: {
    '2026-01-01': "New Year's Day",
    '2026-02-16': 'Family Day',
    '2026-04-03': 'Good Friday',
    '2026-05-18': 'Victoria Day',
    '2026-07-01': 'Canada Day',
    '2026-08-03': 'Civic Holiday',
    '2026-09-07': 'Labour Day',
    '2026-10-12': 'Thanksgiving Day',
    '2026-12-25': 'Christmas Day',
    '2026-12-28': 'Boxing Day (observed)',
  },
  US: {
    '2026-01-01': "New Year's Day",
    '2026-01-19': 'Martin Luther King Jr. Day',
    '2026-02-16': "Washington's Birthday",
    '2026-04-03': 'Good Friday',
    '2026-05-25': 'Memorial Day',
    '2026-06-19': 'Juneteenth',
    '2026-07-03': 'Independence Day (observed)',
    '2026-09-07': 'Labor Day',
    '2026-11-26': 'Thanksgiving Day',
    '2026-12-25': 'Christmas Day',
  },
};

const BOOKING_ENTITIES = {
  TDSUSA: { code: 'TDSUSA', name: 'TD Securities (USA) LLC', country: 'US' },
  TDSI: { code: 'TDSI', name: 'TD Securities Inc.', country: 'CA' },
};

const SETTLEMENT_LOCATIONS = {
  CDS: { code: 'CDS', name: 'CDS Clearing and Depository Services', short: 'CDS', country: 'CA', cycleDays: 1, currency: 'CAD' },
  DTC: { code: 'DTC', name: 'The Depository Trust Company', short: 'DTC', country: 'US', cycleDays: 1, currency: 'USD' },
};

function toIso(date) {
  return date.toISOString().slice(0, 10);
}

function isBusinessDay(isoDate, country) {
  const dow = new Date(`${isoDate}T00:00:00Z`).getUTCDay();
  if (dow === 0 || dow === 6) return false;
  return !Object.hasOwn(HOLIDAYS[country] || {}, isoDate);
}

function addBusinessDays(isoDate, days, country) {
  const d = new Date(`${isoDate}T00:00:00Z`);
  let left = days;
  while (left > 0) {
    d.setUTCDate(d.getUTCDate() + 1);
    if (isBusinessDay(toIso(d), country)) left -= 1;
  }
  return toIso(d);
}

function calendarForEntity(entityCode) {
  const entity = BOOKING_ENTITIES[entityCode];
  if (!entity) {
    const err = new Error(`Unknown booking entity ${entityCode}.`);
    err.name = 'ValidationError';
    err.statusCode = 400;
    throw err;
  }
  return entity.country;
}

module.exports = {
  HOLIDAYS,
  BOOKING_ENTITIES,
  SETTLEMENT_LOCATIONS,
  isBusinessDay,
  addBusinessDays,
  calendarForEntity,
};
