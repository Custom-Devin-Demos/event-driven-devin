jest.mock('../app/services/devin-session', () => ({
  createSessionAndAlert: jest.fn(() => Promise.resolve({ session: null })),
  buildPrompt: jest.fn(() => 'prompt'),
}));

const { createSessionAndAlert } = require('../app/services/devin-session');
const {
  runNightlyBatch, resetDemo, getConsoleState, getRequestLog, sendTestRequest, INCIDENT_ID,
} = require('../app/services/verticals/619b204c');

describe('619b204c Digital Fulfillment Interface console', () => {
  beforeEach(() => {
    resetDemo();
    createSessionAndAlert.mockClear();
  });

  test('opens on last night\'s failed request with an open incident', () => {
    const state = getConsoleState();
    expect(state.tiles.lastBatch.status).toBe('Error');
    expect(state.tiles.notFulfilled).toBe(6);
    expect(state.tiles.openIncidents).toBe(1);
    expect(state.incident).toMatchObject({ id: INCIDENT_ID, priority: 'P2', order: 'SO-48211', pagedAt: null });
    expect(state.orders.find((o) => o.orderNumber === 'SO-48211')).toMatchObject({ lineCount: 48, holdCode: 'DFI_INTERFACE_ERROR' });
    expect(getRequestLog(state.requests[0].id).log.some((l) => l.kind === 'err')).toBe(true);
  });

  test('nothing is sent until the batch is run', () => {
    getConsoleState();
    expect(createSessionAndAlert).not.toHaveBeenCalled();
  });

  test('running the batch now fails on SO-48211 and pages once', async () => {
    await expect(runNightlyBatch({})).rejects.toMatchObject({ name: 'FulfillmentApiError', status: 413 });
    const state = getConsoleState();
    expect(state.requests[0]).toMatchObject({ status: 'Error', failedOrder: 'SO-48211', processed: 0, total: 6 });
    expect(state.incident.status).toBe('In progress');
    expect(createSessionAndAlert).toHaveBeenCalledTimes(1);
    expect(createSessionAndAlert).toHaveBeenCalledWith(expect.objectContaining({ service: '619b204c-api', slackMemberId: 'U0BDHHQUM24' }));
  });

  test('reset restores the opening state', async () => {
    await expect(runNightlyBatch({})).rejects.toBeTruthy();
    const reset = resetDemo();
    expect(reset.requests).toHaveLength(3);
    expect(reset.tiles.notFulfilled).toBe(6);
    expect(reset.incident.pagedAt).toBeNull();
  });

  test('boundary test requests', async () => {
    expect(await sendTestRequest({ lineCount: 30 })).toMatchObject({ ok: true, status: 200 });
    expect(await sendTestRequest({ lineCount: 31 })).toMatchObject({ ok: false, status: 413 });
  });
});
