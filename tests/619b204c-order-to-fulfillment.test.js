const { CATALOG, findOrder } = require('../app/services/verticals/619b204c-data');
const fulfillment = require('../app/services/verticals/619b204c-fulfillment');
const { sendOrder, buildRequest } = require('../app/services/verticals/619b204c-middleware');

describe('619b204c OrderToFulfillment middleware', () => {
  test.each(['SO-48207', 'SO-48209', 'SO-48213', 'SO-48218', 'SO-48220', 'SO-48223'])('%s fulfills with one entitlement', async (orderNumber) => {
    const order = findOrder(orderNumber);
    const result = await sendOrder(order, CATALOG);
    expect(result.outcome).toBe('FULFILLED');
    expect(result.entitlementId).toMatch(/^ENT-\d{5}-\d{2}$/);
    expect(result.lines).toBe(order.lines.length);
  });

  test('AI triage to Japan stays on the trade compliance hold', async () => {
    const post = jest.spyOn(fulfillment, 'post');
    const result = await sendOrder(findOrder('SO-48216'), CATALOG);
    expect(result).toMatchObject({ outcome: 'HOLD', holdCode: 'TRADE_COMPLIANCE', calls: 0 });
    expect(post).not.toHaveBeenCalled();
    post.mockRestore();
  });

  test('request payload carries every order line', () => {
    const order = findOrder('SO-48209');
    const request = buildRequest(order);
    expect(request).toMatchObject({ orderNumber: 'SO-48209', destinationCountry: 'DE' });
    expect(request.lines.map((l) => l.lineNumber)).toEqual([1, 2, 3, 4]);
  });
});

describe('619b204c downstream license API', () => {
  const lines = (n) => Array.from({ length: n }, (_, i) => ({ lineNumber: i + 1, sku: 'XH-DOSE-SUB', quantity: 1 }));

  test('accepts 30 lines', async () => {
    const res = await fulfillment.post({ orderNumber: 'SO-1', lines: lines(30) });
    expect(res.status).toBe(200);
  });

  test('rejects 31 lines with 413', async () => {
    const res = await fulfillment.post({ orderNumber: 'SO-1', lines: lines(31) });
    expect(res).toMatchObject({ status: 413, body: { message: 'max 30 lines per request' } });
  });
});
