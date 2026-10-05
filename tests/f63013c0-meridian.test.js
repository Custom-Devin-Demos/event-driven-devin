const meridian = require('../app/services/verticals/f63013c0-meridian');

const AUTH_2025_06 = {
  status: 'AUTHORISED',
  paymentId: 'psp_01HZXK3Q8E7W9R4T2Y',
  amount: 568.00,
  currency: 'USD',
  descriptor: 'RALPH LAUREN',
};

describe('Meridian Pay adapter', () => {
  afterEach(() => {
    jest.restoreAllMocks();
  });

  test('authorize parses the authorization id from the PSP response', async () => {
    jest.spyOn(global, 'fetch').mockResolvedValue({
      ok: true,
      status: 200,
      headers: new Headers({ 'Meridian-Version': '2025-06' }),
      json: async () => AUTH_2025_06,
    });

    const result = await meridian.authorize({
      amount: 568.00,
      currency: 'USD',
      cardToken: 'tok_claire_visa_4242',
      reference: 'ord_test1',
    });

    expect(result.status).toBe('AUTHORISED');
    expect(result.paymentId).toBe('psp_01HZXK3Q8E7W9R4T2Y');
    expect(result.apiVersion).toBe('2025-06');
  });
});
