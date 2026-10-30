jest.mock('../app/telemetry/sentry', () => ({
  Sentry: { captureException: jest.fn() },
  initSentry: jest.fn(),
}));

const fs = require('fs');
const path = require('path');

const { ALERT_SCENARIOS } = require('../app/services/oncall');
const { getOncallSkin } = require('../config/oncall-skins');

const PAGE = fs.readFileSync(path.join(__dirname, '../app/public/verticals/0e86daae.html'), 'utf8');

describe('0e86daae Banco Central de Costa Rica tipo de cambio on-call skin', () => {
  test('is a native Spanish insurance-backed skin at /bccr-oncall that pages the presenter', () => {
    const skin = getOncallSkin('0e86daae');
    expect(skin).toMatchObject({
      company: 'Banco Central de Costa Rica',
      vertical: 'insurance',
      paths: ['/bccr-oncall'],
      oncallOnly: true,
      alertDestination: 'slack',
      locale: 'es',
      ribbonSide: 'left',
      page: { file: '0e86daae.html', title: 'Banco Central de Costa Rica' },
    });
    expect(skin.devinSession).toMatchObject({ auto: true, onCallIsTriggerer: true });
    expect(skin.alertCard.title).toMatch(/tipo de cambio de referencia \(504\)/);
    expect(skin.disclaimer).toMatch(/^ESTE NO ES UN SITIO REAL DEL BANCO CENTRAL DE COSTA RICA/);
    expect(JSON.stringify(skin)).not.toMatch(/Guardia/);
  });

  test('Consultar posts the legacy insurance claim the on-call shim reroutes', () => {
    expect(ALERT_SCENARIOS.insurance.apiPath).toBe('/api/insurance/claim');
    expect(PAGE).toContain("fetch('/api/insurance/claim'");
    expect(PAGE).toMatch(/id="submitBtn"[\s\S]*Consultar/);
    expect(PAGE).toContain('Tipo de cambio no disponible');
    expect(PAGE).not.toMatch(/All Demos|\/verticals\/assets\/bccr\//);
  });

  test('ships its own BCCR assets', () => {
    const dir = path.join(__dirname, '../app/public/verticals/assets/0e86daae');
    for (const f of ['bccr-logo-transp.png', 'logo-bccr.svg', 'hero-centro-atencion.png', 'banner-politica-monetaria.jpg']) {
      expect(fs.existsSync(path.join(dir, f))).toBe(true);
    }
  });
});
