const meridian = require('../app/services/verticals/ad6a0c70-meridian');

const AUTH_2025_06 = {
  status: 'AUTHORISED',
  paymentId: 'psp_01HZXK3Q8E7W9R4T2Y',
  amount: 26.74,
  currency: 'EUR',
  descriptor: 'LA POSTE',
};

describe('La Poste Meridian Pay adapter', () => {
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
      amount: 26.74,
      currency: 'EUR',
      cardToken: 'tok_julien_fr_visa_4242',
      reference: 'cmd_test1',
    });

    expect(result.status).toBe('AUTHORISED');
    expect(result.paymentId).toBe('psp_01HZXK3Q8E7W9R4T2Y');
    expect(result.apiVersion).toBe('2025-06');
  });
});
