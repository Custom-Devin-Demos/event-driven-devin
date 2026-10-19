/* global afterAll, beforeAll, beforeEach, describe, expect, jest, test, fetch */

jest.mock('../app/telemetry/sentry', () => ({
  Sentry: { captureException: jest.fn() },
  initSentry: jest.fn(),
}));

jest.mock('../app/telemetry/logger', () => ({
  info: jest.fn(),
  warn: jest.fn(),
  error: jest.fn(),
}));

jest.mock('../app/services/slack', () => ({
  ownerRotation: jest.requireActual('../app/services/slack').ownerRotation,
  postMessage: jest.fn().mockResolvedValue('1700000000.000100'),
  postThreadReply: jest.fn().mockResolvedValue('1700000000.000200'),
  lookupSlackUserByEmail: jest.fn().mockResolvedValue(null),
  findChannelByNameFragment: jest.fn().mockResolvedValue(null),
  joinChannel: jest.fn().mockResolvedValue(undefined),
  postPersonaMessage: jest.fn().mockResolvedValue(undefined),
  inviteToChannel: jest.fn().mockResolvedValue(undefined),
}));

jest.mock('../app/services/devin-api', () => ({
  createDevinSession: jest.fn(),
}));

const fs = require('fs');
const http = require('http');
const express = require('express');
const path = require('path');
const { Sentry } = require('../app/telemetry/sentry');
const logger = require('../app/telemetry/logger');
const { postMessage } = require('../app/services/slack');
const { createDevinSession } = require('../app/services/devin-api');
const {
  getAvailability,
  confirmBooking,
  EXAMS,
  TEST_CENTRES,
  SCHEDULING_STORES,
  BOOKING_DEADLINE_MS,
  STORE_WRITE_LATENCY_MS,
} = require('../app/services/oncall-verticals/examscheduling');
const { ALERT_SCENARIOS, postOncallAlert } = require('../app/services/oncall');
const { getOncallSkin } = require('../config/oncall-skins');
const { stopGateway } = require('../app/services/oncall-verticals/industrials-edge');

process.env.SLACK_ONCALL_BOT_TOKEN = 'xoxb-test';
process.env.SLACK_ONCALL_ALERTS_CHANNEL_ID = 'C0TEST';

jest.setTimeout(30000);

const SLUG = 'e85b5836';
const BOOKING_DETAILS = {
  action: 'confirm-booking',
  examCode: 'MO-200',
  testCentreId: 'VUE-LON-01',
  candidate: {
    firstName: 'Sam',
    lastName: 'Taylor',
    email: 'sam.taylor@example.co.uk',
    candidateId: 'PSV1234567',
  },
  residencyRegion: 'UK',
};

function validBooking(overrides = {}, now = new Date()) {
  const londonCentre = getAvailability({ examCode: 'MO-200' }, now).testCentres
    .find((centre) => centre.id === BOOKING_DETAILS.testCentreId);
  return { ...BOOKING_DETAILS, slotId: londonCentre.slots[0].id, ...overrides };
}

describe('Pearson VUE exam scheduling on-call vertical', () => {
  let server;
  let baseUrl;

  beforeAll((done) => {
    const app = express();
    app.use(express.json());
    app.use(require('../app/routes/oncall-verticals'));
    server = http.createServer(app).listen(0, () => {
      baseUrl = `http://127.0.0.1:${server.address().port}`;
      done();
    });
  });

  afterAll((done) => {
    server.closeAllConnections();
    server.close(() => stopGateway().then(() => done()));
  });

  beforeEach(() => jest.clearAllMocks());

  test('confirmation hangs about 9s, times out, and logs each completed store write', async () => {
    const started = Date.now();
    await expect(confirmBooking(validBooking())).rejects.toMatchObject({ code: 'BOOKING_TIMEOUT' });
    const elapsed = Date.now() - started;
    expect(elapsed).toBeGreaterThanOrEqual(8500);
    expect(elapsed).toBeLessThan(BOOKING_DEADLINE_MS + 1000);
    expect(BOOKING_DEADLINE_MS).toBe(9000);
    expect(STORE_WRITE_LATENCY_MS).toEqual([1550, 1750]);
    expect(SCHEDULING_STORES).toHaveLength(6);
    const storeLogs = logger.info.mock.calls
      .filter(([message]) => message === 'Regional scheduling-store write')
      .map(([, fields]) => fields);
    expect(storeLogs).toHaveLength(6);
    expect(storeLogs.map((fields) => fields.region)).toEqual(SCHEDULING_STORES.map((store) => store.id));
    expect(storeLogs.every((fields) => typeof fields.durationMs === 'number')).toBe(true);
    expect(storeLogs[5].writeStatus).toBe('timed_out');
    expect(Sentry.captureException).toHaveBeenCalledTimes(1);
    expect(Sentry.captureException.mock.calls[0][1].tags).toEqual({
      route: '/api/oncall/examscheduling/appointments',
      service: 'vue-scheduling-api',
    });
  });

  test('availability is fast and returns seeded exam, test-centre and slot data', () => {
    const started = Date.now();
    const result = getAvailability({ examCode: 'MO-200', postcode: 'EC1A 1BB' });
    expect(Date.now() - started).toBeLessThan(500);
    expect(result.success).toBe(true);
    expect(result.exam).toMatchObject({ code: 'MO-200', provider: 'Certiport', priceGbp: 9900 });
    expect(EXAMS.map((exam) => exam.code)).toEqual(['MO-200', 'MO-100', 'IC3-GS6-L1', 'SY0-701']);
    expect(result.testCentres).toHaveLength(4);
    expect(result.testCentres.every((centre) => centre.slots.length > 0)).toBe(true);
    expect(result.testCentres.flatMap((centre) => centre.slots).every((slot) => slot.status === 'available')).toBe(true);
    expect(result.testCentres.map((centre) => centre.id)).toEqual(TEST_CENTRES.map((centre) => centre.id));
  });

  test('availability generates slots after the requested current date', () => {
    const now = new Date(Date.now() + 10 * 86400000);
    const result = getAvailability({ examCode: 'MO-200' }, now);
    const slots = result.testCentres.flatMap((centre) => centre.slots);
    expect(slots.length).toBeGreaterThan(0);
    expect(slots.every((slot) => new Date(slot.startsAt).getTime() > now.getTime())).toBe(true);
  });

  test('availability uses London wall time and absolute IDs in BST and GMT', () => {
    const bstNow = new Date('2026-10-19T12:00:00.000Z');
    const bstSlots = getAvailability({ examCode: 'MO-200' }, bstNow)
      .testCentres.find((centre) => centre.id === 'VUE-LON-01').slots;
    expect(bstSlots.find((slot) => slot.id.endsWith('-0900'))).toMatchObject({
      id: 'VUE-LON-01-20261020-0900',
      startsAt: '2026-10-20T08:00:00.000Z',
    });

    const gmtNow = new Date('2026-11-19T12:00:00.000Z');
    const gmtSlots = getAvailability({ examCode: 'MO-200' }, gmtNow)
      .testCentres.find((centre) => centre.id === 'VUE-LON-01').slots;
    expect(gmtSlots.find((slot) => slot.id.endsWith('-0900'))).toMatchObject({
      id: 'VUE-LON-01-20261120-0900',
      startsAt: '2026-11-20T09:00:00.000Z',
    });
  });

  test('availability resolves London slots on the 2026 daylight-saving transition date', () => {
    const now = new Date('2026-10-24T12:00:00.000Z');
    const slots = getAvailability({ examCode: 'MO-200' }, now)
      .testCentres.find((centre) => centre.id === 'VUE-LON-01').slots;
    expect(slots.find((slot) => slot.id === 'VUE-LON-01-20261025-0900').startsAt)
      .toBe('2026-10-25T09:00:00.000Z');
    expect(slots.find((slot) => slot.id === 'VUE-LON-01-20261025-1300').startsAt)
      .toBe('2026-10-25T13:00:00.000Z');
  });

  test('absolute slot IDs do not map a previous day to a new date after midnight', async () => {
    const beforeMidnight = new Date('2026-10-19T22:59:00.000Z');
    const afterMidnight = new Date('2026-10-20T00:01:00.000Z');
    const firstSlots = getAvailability({ examCode: 'MO-200' }, beforeMidnight)
      .testCentres.flatMap((centre) => centre.slots);
    const secondSlots = getAvailability({ examCode: 'MO-200' }, afterMidnight)
      .testCentres.flatMap((centre) => centre.slots);
    const secondById = new Map(secondSlots.map((slot) => [slot.id, slot]));
    firstSlots.forEach((slot) => {
      if (secondById.has(slot.id)) expect(secondById.get(slot.id).startsAt).toBe(slot.startsAt);
    });
    const expiredSlot = firstSlots.find((slot) => !secondById.has(slot.id));
    expect(expiredSlot).toBeDefined();
    await expect(confirmBooking(validBooking({ slotId: expiredSlot.id }, afterMidnight), afterMidnight))
      .rejects.toMatchObject({ code: 'INVALID_BOOKING' });
    expect(Sentry.captureException).not.toHaveBeenCalled();
    expect(postMessage).not.toHaveBeenCalled();
  });

  test('toString is not a valid residency region and is rejected before alerting', async () => {
    const started = Date.now();
    const response = await fetch(`${baseUrl}/api/oncall/examscheduling/appointments`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(validBooking({ residencyRegion: 'toString' })),
    });
    expect(Date.now() - started).toBeLessThan(500);
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ code: 'INVALID_BOOKING' });
    expect(Sentry.captureException).not.toHaveBeenCalled();
    expect(postMessage).not.toHaveBeenCalled();
    expect(createDevinSession).not.toHaveBeenCalled();
  });

  test.each([
    ['unknown exam', (booking) => ({ ...booking, examCode: 'UNKNOWN' })],
    ['unknown centre', (booking) => ({ ...booking, testCentreId: 'VUE-NOWHERE' })],
    ['slot from another centre', (booking) => ({ ...booking, testCentreId: 'VUE-MAN-01' })],
    ['bad email', (booking) => ({
      ...booking,
      candidate: { ...booking.candidate, email: 'not-an-email' },
    })],
  ])('rejects %s before recording or alerting', async (_caseName, invalidBooking) => {
    await expect(confirmBooking(invalidBooking(validBooking()))).rejects.toMatchObject({ code: 'INVALID_BOOKING' });
    expect(Sentry.captureException).not.toHaveBeenCalled();
    expect(postMessage).not.toHaveBeenCalled();
    expect(createDevinSession).not.toHaveBeenCalled();
  });

  test('empty appointment body is a 400 INVALID_BOOKING without Sentry or alert delivery', async () => {
    const response = await fetch(`${baseUrl}/api/oncall/examscheduling/appointments`, { method: 'POST' });
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ success: false, code: 'INVALID_BOOKING' });
    expect(Sentry.captureException).not.toHaveBeenCalled();
    expect(postMessage).not.toHaveBeenCalled();
    expect(createDevinSession).not.toHaveBeenCalled();
  });

  test('availability route is fast and the appointment route returns the friendly 504', async () => {
    const availabilityStarted = Date.now();
    const availabilityResponse = await fetch(`${baseUrl}/api/oncall/examscheduling/availability`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ examCode: 'MO-200', postcode: 'EC1A 1BB' }),
    });
    expect(Date.now() - availabilityStarted).toBeLessThan(500);
    expect(availabilityResponse.status).toBe(200);
    expect((await availabilityResponse.json()).testCentres).toHaveLength(4);

    const started = Date.now();
    const response = await fetch(`${baseUrl}/api/oncall/examscheduling/appointments`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(validBooking()),
    });
    expect(Date.now() - started).toBeGreaterThanOrEqual(8500);
    expect(response.status).toBe(504);
    expect(await response.json()).toMatchObject({
      success: false,
      error: 'We couldn\'t confirm your booking. The request timed out before your appointment was reserved. Please try again in a few minutes.',
      errorClass: 'GatewayTimeout',
      code: 'BOOKING_TIMEOUT',
    });
  });

  test('Pearson VUE alert posts a metric-shaped Slack card without creating a Devin session', async () => {
    const skin = getOncallSkin(SLUG);
    expect(skin.alertDestination).toBe('slack');
    expect(skin.devinSession).toBeUndefined();
    const result = await postOncallAlert('examscheduling', { skin, runRef: 'run-test' });
    expect(result).toMatchObject({ ok: true, channel: 'C0TEST' });
    expect(createDevinSession).not.toHaveBeenCalled();
    expect(postMessage).toHaveBeenCalledTimes(1);
    const [, channel, text, blocks] = postMessage.mock.calls[0];
    expect(channel).toBe('C0TEST');
    const card = `${text}\n${JSON.stringify(blocks)}`;
    expect(card).toContain('Pearson VUE scheduling: 504 timeouts');
    expect(card).toContain('p95:demo.examscheduling.booking.confirm.latency');
    expect(card).toContain('vue-scheduling-api');
    expect(card).not.toMatch(/stack trace|TypeError|\.js:|app\/services/i);
    for (const alert of [ALERT_SCENARIOS.examscheduling, skin.alertCard]) {
      expect(JSON.stringify(alert)).not.toMatch(/stack trace|TypeError|\.js:|app\/services/i);
      expect(alert.metricQuery).toContain('route:/api/oncall/examscheduling/appointments');
    }
  });

  test('native page uses the legacy-shim paths and the skin alert destination', () => {
    const skin = getOncallSkin(SLUG);
    const html = fs.readFileSync(path.join(__dirname, '..', 'app', 'public', 'verticals', skin.page.file), 'utf8');
    expect(html).toContain(`<title>${skin.page.title}</title>`);
    expect(html).toContain("postJson('/api/vue-scheduling/availability'");
    expect(html).toContain("postJson('/api/vue-scheduling/appointments'");
    expect(html).toContain("fetch('/api/config')");
    expect(html).toContain('node.textContent = text');
    expect(html).toContain("action: 'confirm-booking'");
    expect(html).not.toMatch(/\/api\/oncall\//);
  });
});
