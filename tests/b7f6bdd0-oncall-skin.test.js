jest.mock('../app/telemetry/sentry', () => ({
  Sentry: { captureException: jest.fn() },
  initSentry: jest.fn(),
}));

const fs = require('fs');
const path = require('path');

const { ALERT_SCENARIOS } = require('../app/services/oncall');
const { getOncallSkin } = require('../config/oncall-skins');

const PAGE = fs.readFileSync(path.join(__dirname, '../app/public/verticals/b7f6bdd0.html'), 'utf8');

describe('b7f6bdd0 My Verizon Change plan on-call skin', () => {
  test('is a native telco skin that fails after the hang and starts a Devin session', () => {
    const skin = getOncallSkin('b7f6bdd0');
    expect(skin).toMatchObject({
      vertical: 'telco',
      oncallOnly: true,
      failAfterHang: true,
      alertDestination: 'slack',
      page: { file: 'b7f6bdd0.html', title: 'Change plan | My Verizon' },
    });
    expect(skin.devinSession).toMatchObject({ auto: true, onCallIsTriggerer: true });
    expect(skin.alertCard.title).toBe('My Verizon: Change plan is timing out');
    expect(skin.disclaimer).toMatch(/^NOT ACTUALLY A VERIZON SITE/);
  });

  test('Confirm change posts the legacy telco upgrade the on-call shim reroutes', () => {
    expect(ALERT_SCENARIOS.telco.apiPath).toBe('/api/telco/upgrade');
    expect(PAGE).toContain("fetch('/api/telco/upgrade'");
    expect(PAGE).toContain('<title>Change plan | My Verizon</title>');
    for (const id of ['upgradeForm', 'currentPlan', 'newPlan', 'submitBtn', 'result']) {
      expect(PAGE).toContain(`id="${id}"`);
    }
    expect(PAGE).toContain('We couldn’t change your plan right now');
    expect(PAGE).not.toMatch(/All Demos|HOLD_EXPIRED|504/);
  });

  test('only offers plan codes the telco catalog knows', () => {
    const codes = [...PAGE.matchAll(/value="([A-Z]+(?:-[A-Z]+)*-\d+)"/g)].map((m) => m[1]);
    expect(new Set(codes)).toEqual(new Set(['BASIC-12', 'PLUS-24', 'ULTRA-36', 'FAMILY-PLUS-12']));
  });
});
