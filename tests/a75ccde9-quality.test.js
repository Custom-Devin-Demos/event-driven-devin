jest.mock('../app/services/devin-session', () => ({
  createSessionAndAlert: jest.fn(() => Promise.resolve({ triggered: false })),
}));

jest.mock('../app/services/devin-api', () => ({
  listOrgUsers: jest.fn(() => Promise.resolve([])),
  listEnterpriseAdmins: jest.fn(() => Promise.resolve([])),
}));

jest.mock('../app/telemetry/sentry', () => ({
  Sentry: {
    captureException: jest.fn(),
    withScope: jest.fn((callback) => {
      const scope = { setTransactionName: jest.fn() };
      callback(scope);
      return scope;
    }),
  },
  initSentry: jest.fn(),
}));

jest.mock('../app/telemetry/datadog', () => ({
  incrementMetric: jest.fn(),
}));

const fs = require('fs');
const http = require('http');
const express = require('express');
const { createSessionAndAlert } = require('../app/services/devin-session');
const { Sentry } = require('../app/telemetry/sentry');
const { incrementMetric } = require('../app/telemetry/datadog');
const {
  AUDIT_REMEDIATION_DIRECTIVE,
  AUDIT_SERVICE,
  MIN_CONTRAST,
  MIN_TARGET_PX,
  PAGE_FILE,
  auditPlanPage,
  contrastRatio,
  reportQualityFindings,
} = require('../app/services/verticals/a75ccde9-quality');
const { APP_REMEDIATION_DIRECTIVE } = require('../app/services/verticals/a75ccde9');
const router = require('../app/routes/verticals/a75ccde9');

function postJson(server, path, body) {
  const { port } = server.address();
  return new Promise((resolve, reject) => {
    const payload = JSON.stringify(body);
    const req = http.request(
      { host: '127.0.0.1', port, path, method: 'POST', headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) } },
      (res) => {
        let raw = '';
        res.on('data', (chunk) => { raw += chunk; });
        res.on('end', () => resolve({ status: res.statusCode, body: JSON.parse(raw) }));
      },
    );
    req.on('error', reject);
    req.end(payload);
  });
}

const CLEAN_PAGE = `<!doctype html>
<html lang="en">
<head><style>
  .promo-banner { background: #F7F4F0; }
  .promo-headline { color: #1A1A1A; }
  .promo-terms { color: #55524E; }
  .promo-dismiss { width: 44px; height: 44px; }
</style></head>
<body>
  <img class="promo-art" src="promo.avif" alt="" width="120" height="80" loading="eager" fetchpriority="high">
  <button type="button" class="promo-cta">See offer details</button>
  <button type="button" class="promo-dismiss" aria-label="Dismiss offer"><svg aria-hidden="true"></svg></button>
</body>
</html>`;

describe('contrastRatio', () => {
  it('matches the WCAG reference ratios', () => {
    expect(contrastRatio('#000000', '#FFFFFF')).toBeCloseTo(21, 5);
    expect(contrastRatio('#FFFFFF', '#FFFFFF')).toBeCloseTo(1, 5);
    expect(contrastRatio('#777777', '#FFFFFF')).toBeCloseTo(4.48, 2);
  });

  it('returns null for colors it cannot parse', () => {
    expect(contrastRatio('rgba(0,0,0,.5)', '#FFFFFF')).toBeNull();
  });
});

describe('auditPlanPage', () => {
  it('reports every planted promo banner defect on the shipped page', () => {
    const findings = auditPlanPage();
    const rules = findings.map((finding) => finding.ruleId);

    expect(rules).toEqual(expect.arrayContaining([
      'color-contrast',
      'button-name',
      'keyboard-operable',
      'interactive-role',
      'target-size',
      'image-size-attributes',
      'lcp-lazy-loaded',
    ]));
  });

  it('measures the contrast failure below the AA threshold and the target below 44px', () => {
    const findings = auditPlanPage();
    const contrast = findings.find((finding) => finding.ruleId === 'color-contrast');
    const target = findings.find((finding) => finding.ruleId === 'target-size');

    expect(Number(contrast.measured.split(':')[0])).toBeLessThan(MIN_CONTRAST);
    expect(contrast.selector).toBe('.promo-terms');
    expect(target.required).toBe(`${MIN_TARGET_PX}x${MIN_TARGET_PX}px`);
  });

  it('does not flag the plan-change flow the page still needs to run', () => {
    const page = fs.readFileSync(PAGE_FILE, 'utf8');
    const findings = auditPlanPage(page);

    expect(page).toContain('renderPlanPricing');
    expect(findings.every((finding) => finding.selector.startsWith('.promo-'))).toBe(true);
  });

  it('returns no findings once the banner is built correctly', () => {
    expect(auditPlanPage(CLEAN_PAGE)).toEqual([]);
  });
});

describe('reportQualityFindings', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('raises the metric, the Sentry issue and a Devin session with the audit directive', async () => {
    const findings = auditPlanPage();
    const { reference, sessionPromise } = reportQualityFindings(findings, {
      devinUserId: 'user-abc',
      devinOrgId: 'org-abc',
      devinEmail: 'yubin.jee@cognition.ai',
    });
    await sessionPromise;

    expect(reference).toMatch(/^[0-9a-f-]{36}$/);
    expect(incrementMetric).toHaveBeenCalledWith('web_quality.violations', expect.objectContaining({
      route: '/oncall/c/a75ccde9',
    }));
    expect(Sentry.captureException).toHaveBeenCalledTimes(1);

    const alert = createSessionAndAlert.mock.calls[0][0];
    expect(alert.service).toBe(AUDIT_SERVICE);
    expect(alert.customer).toBe('a75ccde9');
    expect(alert.devinUserId).toBe('user-abc');
    expect(alert.promptAppendix).toBe(AUDIT_REMEDIATION_DIRECTIVE);
    expect(alert.errorValue).toContain(`${findings.length} accessibility`);
  });

  it('tells both FOX sessions to record their browser work', () => {
    expect(APP_REMEDIATION_DIRECTIVE).toContain('recording_start');
    expect(APP_REMEDIATION_DIRECTIVE).toContain('annotate_recording');
    expect(AUDIT_REMEDIATION_DIRECTIVE).toContain('recording_start');
    expect(AUDIT_REMEDIATION_DIRECTIVE).toContain('scoreboard.html');
    expect(AUDIT_REMEDIATION_DIRECTIVE).toContain('Devin-Org: engineering');
    expect(AUDIT_REMEDIATION_DIRECTIVE).toContain('Do not merge');
  });
});

describe('POST /api/a75ccde9/quality-audit', () => {
  let server;

  beforeAll((done) => {
    const app = express();
    app.use(express.json());
    app.use(router);
    server = app.listen(0, () => done());
  });

  afterAll((done) => {
    server.close(done);
  });

  beforeEach(() => jest.clearAllMocks());

  it('returns the findings and opens a Devin session', async () => {
    const response = await postJson(server, '/api/a75ccde9/quality-audit', { devinUserId: 'user-abc' });

    expect(response.status).toBe(202);
    expect(response.body.violations).toBeGreaterThan(0);
    expect(response.body.sessionRequested).toBe(true);
    expect(response.body.findings[0]).toHaveProperty('ruleId');
    expect(createSessionAndAlert).toHaveBeenCalledTimes(1);
  });
});
