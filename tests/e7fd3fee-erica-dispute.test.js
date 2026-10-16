jest.mock('../app/services/devin-session', () => ({
  createSessionAndAlert: jest.fn(() => Promise.resolve({ triggered: false })),
}));

jest.mock('../app/telemetry/sentry', () => ({
  Sentry: { captureException: jest.fn() },
  initSentry: jest.fn(),
}));

jest.mock('../app/telemetry/datadog', () => ({
  incrementMetric: jest.fn(),
  recordTiming: jest.fn(),
}));

const logger = require('../app/telemetry/logger');
const { createSessionAndAlert } = require('../app/services/devin-session');
const { chat } = require('../app/services/verticals/e7fd3fee-erica');
const fixtures = require('../app/services/verticals/e7fd3fee-erica-fixtures.json');

const disputeChips = fixtures.text["I don't recognize a charge"].messages[0].chips
  .filter((c) => c.action.type === 'select_dispute_transaction');

function stageDispute(match) {
  const chip = disputeChips.find((c) => c.label.includes(match));
  const res = chat({ action: chip.action, sessionKey: 't' });
  const confirm = res.messages.find((m) => m.card && m.card.type === 'lock_dispute_confirm');
  return confirm.card.actions[0].action;
}

function raiEvents() {
  return logger.info.mock.calls.filter(([msg]) => msg === 'erica_rai_event').map(([, e]) => e);
}

describe('Bank of America Erica card dispute (e7fd3fee)', () => {
  beforeEach(() => {
    createSessionAndAlert.mockClear();
    jest.spyOn(logger, 'info').mockImplementation(() => {});
    jest.spyOn(logger, 'error').mockImplementation(() => {});
  });

  afterEach(() => jest.restoreAllMocks());

  test('dispute keywords route to the recent card purchases list', () => {
    const res = chat({ text: 'I want to dispute a charge', sessionKey: 't' });
    expect(res.messages[0].chips.some((c) => c.action.type === 'select_dispute_transaction')).toBe(true);
    expect(res.correlation_id).toBeTruthy();
  });

  test('Visa dispute is filed after explicit confirmation', () => {
    const res = chat({ action: stageDispute('STARBUCKS'), sessionKey: 't' });
    expect(res.messages[0].card.type).toBe('dispute_confirmation');
    expect(createSessionAndAlert).not.toHaveBeenCalled();
  });

  test('Mastercard dispute fails with a TypeError, shows an error card and raises an alert', () => {
    const action = stageDispute('VELOCITY GEAR MIAMI FL $487.23');
    logger.info.mockClear();
    let thrown;
    try { chat({ action, sessionKey: 't', devinEmail: 'demo@devindemos.com' }); } catch (e) { thrown = e; }
    expect(thrown).toBeInstanceOf(TypeError);
    expect(thrown.ericaMessages[0].card.type).toBe('error');
    expect(thrown.ericaMessages[0].card.reference).toBe(thrown.referenceId);
    expect(createSessionAndAlert).toHaveBeenCalledTimes(1);
    expect(createSessionAndAlert.mock.calls[0][0].customer).toBe('e7fd3fee');

    const events = raiEvents();
    expect(events.map((e) => e.decision.outcome)).toEqual(expect.arrayContaining(['submitted', 'failed']));
    expect(new Set(events.map((e) => e.correlation_id)).size).toBe(1);
    expect(JSON.stringify(events)).not.toContain('demo@devindemos.com');
  });
});
