jest.mock('../app/telemetry/sentry', () => ({
  Sentry: { captureException: jest.fn() },
  initSentry: jest.fn(),
}));

const fs = require('fs');
const path = require('path');
const { rebookFlight, TRIP, SEAT_HOLD_MINUTES } = require('../app/services/oncall-verticals/rebooking');
const { ALERT_SCENARIOS } = require('../app/services/oncall');
const { getOncallSkin } = require('../config/oncall-skins');

jest.setTimeout(30000);

describe('Egencia trip-disruption on-call rebooking', () => {
  test('rebooking an alternative times out re-shopping the GDS', async () => {
    const started = Date.now();
    await expect(rebookFlight({ tripId: TRIP.tripId, alternativeId: 'BA0303', action: 'rebook' }))
      .rejects.toMatchObject({ code: 'RESHOP_TIMEOUT' });
    expect(Date.now() - started).toBeGreaterThanOrEqual(7900);
  });

  test('holding a seat on the same alternative is fast', async () => {
    const started = Date.now();
    const result = await rebookFlight({ tripId: TRIP.tripId, alternativeId: 'BA 0303', action: 'hold' });
    expect(result.success).toBe(true);
    expect(result.flight).toBe('BA 0303');
    expect(result.holdMinutes).toBe(SEAT_HOLD_MINUTES);
    expect(result.holdRef).toMatch(/^HLD-BA0303-/);
    expect(new Date(result.expiresAt).getTime()).toBeGreaterThan(Date.now());
    expect(Date.now() - started).toBeLessThan(500);
  });

  test('policy is evaluated per alternative', async () => {
    const economy = await rebookFlight({ alternativeId: 'AF1280', action: 'hold' });
    const business = await rebookFlight({ alternativeId: 'BA0309', action: 'hold' });
    expect(economy.policy.inPolicy).toBe(true);
    expect(business.policy.inPolicy).toBe(false);
  });

  test.each([
    [{ alternativeId: 'LH9999', action: 'hold' }],
    [{ alternativeId: undefined, action: 'rebook' }],
    [{ tripId: 'NEO-OTHER', alternativeId: 'AF1280', action: 'hold' }],
  ])('rejects %j as INVALID_REBOOK without calling the GDS', async (body) => {
    const started = Date.now();
    await expect(rebookFlight(body)).rejects.toMatchObject({ code: 'INVALID_REBOOK' });
    expect(Date.now() - started).toBeLessThan(500);
  });

  test('only Rebook pages on-call; holds are rerouted without an alert', () => {
    expect(ALERT_SCENARIOS.rebooking.triggerWhen).toEqual({ action: 'rebook' });
    expect(ALERT_SCENARIOS.rebooking.initialClick).toBeUndefined();
  });

  test('alert scenario is latency-shaped, unlisted and free of code locations', () => {
    const s = ALERT_SCENARIOS.rebooking;
    expect(s.apiPath).toBe('/api/egencia/rebook');
    expect(s.oncallApiPath).toBe('/api/oncall/rebooking/rebook');
    expect(s.monitor).toMatch(/^p95 latency/);
    expect(s.service).toBe('egencia-rebooking-api');
    expect(s.metricQuery).toContain('service:egencia-rebooking-api');
    // The StatsD client prefixes every metric with `demo.`, so the monitor must query the prefixed name.
    expect(s.metricQuery).toMatch(/^p95:demo\.rebooking\.rebook\.latency\{/);
    expect(s.unlisted).toBe(true);
    expect(JSON.stringify(s)).not.toMatch(/\.js|FARE_FAMILIES|RESHOP/);
  });

  test('the Egencia skin routes to Teams and its card matches the service it names', () => {
    const skin = getOncallSkin('e7a1c4d9');
    expect(skin.vertical).toBe('rebooking');
    expect(skin.oncallOnly).toBe(true);
    expect(skin.teamsAlerts).toBe(true);
    expect(skin.alertDestination).toBe('teams');
    expect(skin.teamsWebhookEnv).toBe('ONCALL_TEAMS_WEBHOOK_URL_COGNITION_AI');
    expect(skin.devinSession).toBeUndefined();
    expect(skin.paths).toEqual(['/oncall/c/egencia', '/egencia-oncall']);
    expect(skin.alertCard.service).toBe('egencia-rebooking-api');
    expect(skin.alertCard.metricQuery).toContain(`service:${skin.alertCard.service}`);
    expect(skin.alertCard.metricQuery).toContain('/api/oncall/rebooking/rebook');
    expect(skin.alertCard.metricQuery).toMatch(/^p95:demo\.rebooking\.rebook\.latency\{/);
    expect(skin.alertCard.title).toContain('POST /api/oncall/rebooking/rebook');
    const html = fs.readFileSync(path.join(__dirname, '..', 'app', 'public', 'verticals', skin.page.file), 'utf8');
    expect(html).toContain(`<title>${skin.page.title}</title>`);
    expect(html).toContain("fetch('/api/egencia/rebook'");
    expect(html).not.toMatch(/\/api\/oncall\//);
  });
});
