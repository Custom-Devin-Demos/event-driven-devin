jest.mock('../app/services/devin-session', () => ({
  createSessionAndAlert: jest.fn(() => ({ sessionPromise: Promise.resolve({ triggered: false }) })),
}));

jest.mock('../app/telemetry/sentry', () => ({
  Sentry: {
    captureException: jest.fn(),
    withScope: jest.fn(),
  },
  initSentry: jest.fn(),
}));

jest.mock('../app/telemetry/datadog', () => ({
  incrementMetric: jest.fn(),
  recordTiming: jest.fn(),
}));

const { createSessionAndAlert } = require('../app/services/devin-session');
const { Sentry } = require('../app/telemetry/sentry');
const {
  CARDS,
  DISPUTE_RULES,
  calculateDisputeOutcome,
  resolveDisputeRules,
  submitDispute,
} = require('../app/services/verticals/westpac');

const ALTITUDE_BLACK_DISPUTE = {
  cardAccountNumber: 'WBC-CC-4417-2280',
  disputeReason: 'unauthorised',
  merchantName: 'LUMA TRAVEL SERVICES PTY LTD',
  transactionDate: '2026-09-18',
  transactionAmount: 2480.75,
  cardPresent: false,
  contactedMerchant: true,
  cardLostOrStolen: false,
  contactNumber: '0438 662 105',
  description: 'I did not authorise this charge.',
  declaration: true,
  channel: 'web',
};

describe('Westpac dispute rules registry', () => {
  beforeEach(() => {
    createSessionAndAlert.mockClear();
    Sentry.captureException.mockClear();
  });

  test.each(Object.values(CARDS).map((card) => [card.productCode, card]))(
    '%s resolves to registered dispute rules',
    (productCode, card) => {
      const rules = resolveDisputeRules(card);
      expect(rules).toBeDefined();
      expect(rules).toBe(DISPUTE_RULES[productCode]);
      expect(Number.isFinite(rules.chargebackWindowDays)).toBe(true);
      expect(Number.isFinite(rules.maxDisputeAmount)).toBe(true);
      expect(Number.isFinite(rules.investigationDays)).toBe(true);
      expect(typeof rules.scheme).toBe('string');
      expect(typeof rules.disputeQueue).toBe('string');
    },
  );

  test('Altitude Black Mastercard is registered under the Mastercard scheme', () => {
    expect(DISPUTE_RULES.westpac_altitude_black_mastercard).toMatchObject({
      label: CARDS['WBC-CC-4417-2280'].productLabel,
      scheme: 'Mastercard',
      chargebackWindowDays: 120,
    });
  });

  test('calculateDisputeOutcome no longer throws for the Altitude Black card', () => {
    const outcome = calculateDisputeOutcome(CARDS['WBC-CC-4417-2280'], {
      transactionDate: ALTITUDE_BLACK_DISPUTE.transactionDate,
      transactionAmount: ALTITUDE_BLACK_DISPUTE.transactionAmount,
    });

    expect(outcome).toMatchObject({
      chargebackWindowDays: 120,
      scheme: 'Mastercard',
      disputeQueue: 'cards-mastercard-daily',
      provisionalCreditAmount: 2480.75,
      exceedsDisputeCap: false,
    });
  });

  test('provisional credit is capped for large Altitude Black disputes', () => {
    const outcome = calculateDisputeOutcome(CARDS['WBC-CC-4417-2280'], {
      transactionDate: '2026-09-18',
      transactionAmount: 30000,
    });

    expect(outcome.provisionalCreditAmount).toBe(5000);
    expect(outcome.exceedsDisputeCap).toBe(true);
  });

  test('the alert payload from NODE-EXPRESS-8H is now accepted without alerting', async () => {
    await expect(submitDispute(ALTITUDE_BLACK_DISPUTE)).resolves.toMatchObject({
      success: true,
      status: 'accepted',
      productLabel: 'Altitude Black Mastercard',
      scheme: 'Mastercard',
      chargebackWindowDays: 120,
      disputeQueue: 'cards-mastercard-daily',
    });
    expect(Sentry.captureException).not.toHaveBeenCalled();
    expect(createSessionAndAlert).not.toHaveBeenCalled();
  });

  test('an unknown card account is still rejected as a validation error', async () => {
    await expect(submitDispute({
      ...ALTITUDE_BLACK_DISPUTE,
      cardAccountNumber: 'WBC-CC-0000-0000',
    })).rejects.toMatchObject({ name: 'ValidationError', statusCode: 400 });
  });
});
