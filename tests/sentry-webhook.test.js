const { applyCustomerIdentity } = require('../app/routes/sentry-webhook');

describe('Sentry customer identity mapping', () => {
  test('maps Zelle service tags to the Bank of America customer identity', () => {
    const alertData = applyCustomerIdentity({
      issueTitle: 'LimitExceededError: Amount exceeds daily limit',
      service: 'customer-6f43e66c-zelle-send',
      project: 'event-driven-devin',
      release: 'acme-checkout@1.0.2',
      tags: [
        ['service', 'customer-6f43e66c-zelle-send'],
        ['route', '/api/6f43e66c/send'],
      ],
    });

    expect(alertData).toMatchObject({
      customer: '6f43e66c',
      verticalLabel: 'Consumer Zelle Send',
      service: 'customer-6f43e66c-zelle-send',
      project: 'event-driven-devin',
      release: 'customer-6f43e66c-zelle-send@1.0.0',
    });
    expect(alertData.tags).toEqual(expect.arrayContaining([
      { key: 'customer', value: '6f43e66c' },
      { key: 'service', value: 'customer-6f43e66c-zelle-send' },
      { key: 'route', value: '/api/6f43e66c/send' },
      { key: 'scenario', value: 'zelle-send' },
    ]));
  });
});
