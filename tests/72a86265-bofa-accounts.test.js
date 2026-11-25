jest.mock('@sentry/node', () => ({ captureException: jest.fn() }));
jest.mock('../app/services/slack', () => ({
  postAlertToSlack: jest.fn(() => Promise.resolve('1.1')),
  postMessage: jest.fn(() => Promise.resolve('1.2')),
}));
jest.mock('../app/telemetry/logger', () => ({ info: jest.fn(), error: jest.fn(), warn: jest.fn() }));

const fs = require('fs');
const path = require('path');
const { postAlertToSlack, postMessage } = require('../app/services/slack');
const svc = require('../app/services/verticals/72a86265');
const { getCustomerConfig, listAliases } = require('../config/customers');

const pay = (to, amount = 250) => ({ fromAccountId: 'chk-4821', toAccountId: to, amount });

beforeEach(() => {
  jest.clearAllMocks();
  process.env.SLACK_BOT_TOKEN = 'xoxb-test';
});

describe('Bank of America synthetic accounts demo', () => {
  test('registers the ciaran-bofa alias and routes alerts to the alerts channel', () => {
    expect(listAliases()['ciaran-bofa']).toBe('72a86265');
    expect(getCustomerConfig(svc.CUSTOMER)).toMatchObject({ githubOrg: 'cogdeasy', slackChannelId: 'C0CLQ74A667' });
    for (const file of ['72a86265.html', '72a86265-assets/campaign.html']) {
      expect(fs.readFileSync(path.join(__dirname, '../app/public/verticals', file), 'utf8')).toMatch(/synthetic/i);
    }
  });

  test('checking to savings moves money', () => {
    const { token } = svc.openSession();
    expect(svc.transfer(token, pay('sav-7730'))).toMatchObject({ status: 'ACCEPTED' });
    const { accounts } = svc.accounts(token);
    expect(accounts.find((a) => a.id === 'chk-4821').balance).toBe(6592.17);
    expect(accounts.find((a) => a.id === 'sav-7730').balance).toBe(18500);
    expect(postAlertToSlack).not.toHaveBeenCalled();
    expect(postMessage).not.toHaveBeenCalled();
  });

  test('planted defect: a credit-card payment fails, moves no money and alerts on every failure', async () => {
    const { token } = svc.openSession();
    for (let i = 0; i < 2; i += 1) {
      expect(() => svc.transfer(token, pay('crd-1094'))).toThrow(expect.objectContaining({ name: 'TypeError', status: 500 }));
      await new Promise(setImmediate);
    }
    expect(svc.accounts(token).accounts.find((a) => a.id === 'chk-4821').balance).toBe(6842.17);
    expect(postAlertToSlack).toHaveBeenCalledTimes(2);
    expect(postAlertToSlack.mock.calls[0][0]).toMatchObject({ service: 'ciaran-bofa-accounts-web', errorType: 'TypeError', culprit: svc.CULPRIT });
    expect(postMessage).toHaveBeenCalledTimes(2);
    const [, channel, text] = postMessage.mock.calls[0];
    expect(channel).toBe('C0CLQPQFT0D');
    expect(channel).not.toBe(getCustomerConfig('72a86265').slackChannelId);
    expect(text).toMatch(/^Security finding: /);
    for (const repo of ['accounts-web', 'payments-api', 'fx-rates', 'trade-ledger']) {
      expect(text).toContain(`cogdeasy/ciaran-bofa-${repo}`);
    }
  });

  test('reports=off and synthetic requests do not alert; validation errors stay 4xx', async () => {
    const { token } = svc.openSession();
    expect(() => svc.transfer(token, pay('crd-1094'), { reportsOff: true })).toThrow(TypeError);
    expect(() => svc.transfer(token, pay('crd-1094'), { synthetic: true })).toThrow(TypeError);
    await new Promise(setImmediate);
    expect(() => svc.transfer(token, pay('sav-7730', 999999))).toThrow(expect.objectContaining({ status: 422 }));
    expect(() => svc.transfer('nope', pay('sav-7730'))).toThrow(expect.objectContaining({ status: 401 }));
    expect(postAlertToSlack).not.toHaveBeenCalled();
    expect(postMessage).not.toHaveBeenCalled();
  });
});
