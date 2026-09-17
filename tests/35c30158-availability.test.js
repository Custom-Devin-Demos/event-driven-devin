jest.mock('../app/services/devin-session', () => ({
  createSessionAndAlert: jest.fn().mockResolvedValue(null),
}));
jest.mock('../app/telemetry/sentry', () => ({
  Sentry: { captureException: jest.fn() },
}));

const { checkAvailability, buildAvailability, RESORTS } = require('../app/services/verticals/35c30158');
const { normalizeInventory } = require('../app/services/verticals/35c30158-normalize');
const { createSessionAndAlert } = require('../app/services/devin-session');
const { Sentry } = require('../app/telemetry/sentry');
const { isInstantPathEvent } = require('../app/routes/sentry-webhook');

const MS_PER_DAY = 24 * 60 * 60 * 1000;

function isoDaysFromNow(days) {
  const date = new Date();
  date.setUTCHours(0, 0, 0, 0);
  return new Date(date.getTime() + days * MS_PER_DAY).toISOString().slice(0, 10);
}

function request(overrides = {}) {
  return {
    resort: 'park-city',
    activity: 'snow',
    fulfillment: 'pickup',
    pickupDate: isoDaysFromNow(10),
    returnDate: isoDaysFromNow(12),
    devinUserId: '',
    devinOrgId: '',
    devinEmail: '',
    ...overrides,
  };
}

async function expectValidationError(data, code) {
  await expect(checkAvailability(data)).rejects.toMatchObject({
    name: 'ValidationError',
    statusCode: 400,
    code,
  });
}

beforeEach(() => {
  jest.clearAllMocks();
});

describe('request validation', () => {
  test('rejects an unknown resort', async () => {
    await expectValidationError(request({ resort: 'aspen' }), 'RESORT_REQUIRED');
  });

  test('rejects unknown activity and fulfillment values instead of coercing them', async () => {
    await expectValidationError(request({ activity: 'snowshoe' }), 'ACTIVITY_INVALID');
    await expectValidationError(request({ fulfillment: 'shipping' }), 'FULFILLMENT_INVALID');
  });

  test('defaults omitted activity and fulfillment', async () => {
    const availability = await checkAvailability(request({ activity: undefined, fulfillment: undefined }));
    expect(availability.activity).toBe('snow');
    expect(availability.fulfillment).toBe('pickup');
  });

  test('rejects delivery where the resort does not offer it', async () => {
    const noDelivery = RESORTS.find((resort) => !resort.deliveryOffered);
    await expectValidationError(request({ resort: noDelivery.id, fulfillment: 'delivery' }), 'DELIVERY_UNAVAILABLE');
  });

  test('rejects malformed and impossible calendar dates', async () => {
    await expectValidationError(request({ pickupDate: '' }), 'DATES_REQUIRED');
    await expectValidationError(request({ pickupDate: '03/15/2027' }), 'DATES_REQUIRED');
    await expectValidationError(request({ pickupDate: '2027-02-30', returnDate: '2027-03-02' }), 'DATES_REQUIRED');
    await expectValidationError(request({ pickupDate: '2027-13-01', returnDate: '2027-13-02' }), 'DATES_REQUIRED');
  });

  test('rejects pickup dates in the past', async () => {
    await expectValidationError(
      request({ pickupDate: isoDaysFromNow(-1), returnDate: isoDaysFromNow(1) }),
      'PICKUP_DATE_IN_PAST',
    );
  });

  test('accepts a same-day pickup', async () => {
    const availability = await checkAvailability(request({ pickupDate: isoDaysFromNow(0), returnDate: isoDaysFromNow(0) }));
    expect(availability.rentalDays).toBe(1);
  });

  test('rejects a return date before pickup and rentals longer than 14 days', async () => {
    await expectValidationError(
      request({ pickupDate: isoDaysFromNow(5), returnDate: isoDaysFromNow(4) }),
      'DATE_RANGE_INVALID',
    );
    await expectValidationError(
      request({ pickupDate: isoDaysFromNow(5), returnDate: isoDaysFromNow(19) }),
      'DATE_RANGE_TOO_LONG',
    );
  });
});

describe('pricing', () => {
  const trip = (pickupOffset, rentalDays, activity = 'snow') => ({
    resort: RESORTS[0],
    activity,
    fulfillment: 'pickup',
    pickupDate: new Date(isoDaysFromNow(pickupOffset)),
    returnDate: new Date(isoDaysFromNow(pickupOffset + rentalDays - 1)),
    rentalDays,
  });
  const offers = [
    { sku: 'A', name: 'Sport', category: 'ski', level: 'sport', available: 5, dailyRate: 50, currency: 'USD' },
    { sku: 'B', name: 'Demo', category: 'snowboard', level: 'demo', available: 0, dailyRate: 30, currency: 'USD' },
    { sku: 'C', name: 'Trail', category: 'bike', level: 'all', available: 0, dailyRate: 89, currency: 'USD' },
  ];

  test('applies the 20% advance-booking discount two or more days out', () => {
    const { packages } = buildAvailability(offers, trip(10, 3));
    const sport = packages.find((pkg) => pkg.sku === 'A');
    expect(sport).toMatchObject({ listPrice: 150, advanceDiscount: 30, total: 120, rentalDays: 3 });
  });

  test('charges list price for pickups within two days', () => {
    const { packages } = buildAvailability(offers, trip(1, 2));
    const sport = packages.find((pkg) => pkg.sku === 'A');
    expect(sport).toMatchObject({ listPrice: 100, advanceDiscount: 0, total: 100 });
  });

  test('only counts and prices in-stock packages for the activity', () => {
    const snow = buildAvailability(offers, trip(10, 1));
    expect(snow.packages.map((pkg) => pkg.sku)).toEqual(['B', 'A']);
    expect(snow.inStockCount).toBe(1);
    expect(snow.lowestTotal).toBe(40);

    const bike = buildAvailability(offers, trip(10, 1, 'bike'));
    expect(bike.packages.map((pkg) => pkg.sku)).toEqual(['C']);
    expect(bike.inStockCount).toBe(0);
    expect(bike.lowestTotal).toBeNull();
  });
});

describe('inventory contracts', () => {
  test('normalizes each source into the shared offer shape', () => {
    const summit = normalizeInventory(
      { system: 'summit-pos', contract: '9.4', locationCode: '1180' },
      { skus: [{ code: 'SKI-1', desc: 'Sport', cat: 'SKI', lvl: 'BEG', qty_on_hand: 3, rate_cents: 5900 }] },
    );
    expect(summit).toEqual([
      { sku: 'SKI-1', name: 'Sport', category: 'ski', level: 'sport', available: 3, dailyRate: 59, currency: 'USD' },
    ]);

    const gearHub = normalizeInventory(
      { system: 'gear-hub', contract: '3', locationCode: 'WB' },
      { inventory: { 'GH-1': { label: 'Sport', group: 'ski', level: 'beginner', count: 2, price: { amount: 79, currency: 'CAD' } } } },
    );
    expect(gearHub).toEqual([
      { sku: 'GH-1', name: 'Sport', category: 'ski', level: 'sport', available: 2, dailyRate: 79, currency: 'CAD' },
    ]);
  });

  test.each(['park-city', 'breckenridge', 'whistler-blackcomb'])('returns availability for %s', async (resort) => {
    const availability = await checkAvailability(request({ resort }));
    expect(availability.resort.id).toBe(resort);
    expect(availability.inStockCount).toBeGreaterThan(0);
    expect(availability.lowestTotal).toBeGreaterThan(0);
    expect(createSessionAndAlert).not.toHaveBeenCalled();
  });
});

describe('inventory failures', () => {
  test('report through the instant path exactly once and rethrow', async () => {
    await expect(checkAvailability(request({ resort: 'vail' }))).rejects.toBeInstanceOf(TypeError);

    expect(Sentry.captureException).toHaveBeenCalledTimes(1);
    expect(Sentry.captureException.mock.calls[0][1].tags).toMatchObject({
      alert_path: 'instant',
      resort: 'vail',
      inventorySystem: 'alpine-fleet',
    });

    expect(createSessionAndAlert).toHaveBeenCalledTimes(1);
    expect(createSessionAndAlert.mock.calls[0][0]).toMatchObject({
      customer: '35c30158',
      errorType: 'TypeError',
      culprit: expect.stringContaining('35c30158-normalize'),
    });
  });

  test('Sentry webhook skips events the instant path already alerted on, tagged or tagless', () => {
    expect(isInstantPathEvent({
      issueTitle: "TypeError: Cannot read properties of undefined (reading 'map')",
      culprit: 'readAlpineFleet(app/services/verticals/35c30158-normalize)',
      tags: [['service', '35c30158-api'], ['alert_path', 'instant']],
    })).toBe(true);
    expect(isInstantPathEvent({
      issueTitle: "TypeError: Cannot read properties of undefined (reading 'map')",
      culprit: 'POST /api/35c30158/availability',
      tags: [],
    })).toBe(true);
  });
});
