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

  test('maps Flutter portal service tags to the GE customer identity and Flutter directive', () => {
    const alertData = applyCustomerIdentity({
      issueTitle: 'Null check operator used on a null value',
      culprit: 'buildEngineCoverage',
      project: 'ge-customer-portal',
      release: 'ge-customer-portal@1.0.0',
      tags: [
        ['service', 'customer-5b992ae7-portal'],
        ['platform', 'linux'],
        ['screen', 'inquiry'],
      ],
    });

    expect(alertData).toMatchObject({
      customer: '5b992ae7',
      verticalLabel: 'GE Aerospace Customer Portal',
      service: 'customer-5b992ae7-portal',
      project: 'ge-customer-portal',
      release: 'ge-customer-portal@1.0.0',
    });
    expect(alertData.promptAppendix).toContain('github.com/Custom-Devin-Demos/ge-customer-portal');
    expect(alertData.promptAppendix).toContain('flutter test');
    expect(alertData.promptAppendix).toMatch(/Linux, Windows and macOS/);
    expect(alertData.tags).toEqual(expect.arrayContaining([
      { key: 'customer', value: 'customer-5b992ae7-portal' },
      { key: 'service', value: 'customer-5b992ae7-portal' },
      { key: 'scenario', value: 'technical-inquiry' },
      ['platform', 'linux'],
    ]));
  });

  test('maps Splash mobile service tags to the Splash customer identity and mobile-repo directive', () => {
    const alertData = applyCustomerIdentity({
      issueTitle: "TypeError: Cannot read properties of undefined (reading 'multiplier')",
      culprit: 'submitSlip',
      tags: [
        ['service', 'customer-3aa9fa04-mobile'],
        ['platform', 'android'],
        ['slate', 'MNF'],
      ],
    });

    expect(alertData).toMatchObject({
      customer: '3aa9fa04',
      verticalLabel: 'Splash Sports Mobile',
      service: 'customer-3aa9fa04-mobile',
      project: 'splash-sports-mobile',
      release: 'splash-sports-mobile@1.0.0',
    });
    expect(alertData.promptAppendix).toContain('github.com/COG-GTM/splash-sports-mobile');
    expect(alertData.tags).toEqual(expect.arrayContaining([
      { key: 'customer', value: 'customer-3aa9fa04-mobile' },
      { key: 'service', value: 'customer-3aa9fa04-mobile' },
      { key: 'scenario', value: 'nfl-primetime-entry' },
      ['slate', 'MNF'],
    ]));
  });

  test('leaves the server-side GE inquiry alert on the Node directive', () => {
    const alertData = applyCustomerIdentity({
      issueTitle: 'TypeError: Cannot read properties of undefined',
      service: 'customer-5b992ae7-inquiry',
      tags: [['service', 'customer-5b992ae7-inquiry']],
    });

    expect(alertData.promptAppendix).toBeUndefined();
    expect(alertData.verticalLabel).toBeUndefined();
  });
});
