jest.mock('../app/services/devin-session', () => ({
  createSessionAndAlert: jest.fn(() => Promise.resolve()),
}));

const express = require('express');
const { createSessionAndAlert } = require('../app/services/devin-session');
const router = require('../app/routes/verticals/0f066b5c');
const { processSwipe, findProfile, getAppState } = require('../app/services/verticals/0f066b5c');

let server;
let base;

beforeAll((done) => {
  const a = express();
  a.use(express.json());
  a.use(router);
  server = a.listen(0, () => {
    base = `http://127.0.0.1:${server.address().port}`;
    done();
  });
});

afterAll((done) => {
  server.close(done);
});

async function post(body) {
  const r = await fetch(`${base}/api/0f066b5c/swipes`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  return { status: r.status, body: await r.json() };
}

describe('Bumble people deck (0f066b5c)', () => {
  beforeEach(() => createSessionAndAlert.mockClear());

  test('app state hides likedYou and lists the deck', () => {
    const state = getAppState();
    expect(state.people[0].id).toBe('mem_maya_k');
    expect(state.people.every((p) => !('likedYou' in p))).toBe(true);
    expect(state.likedYouCount).toBe(3);
    expect(state.likedYouIds).toHaveLength(3);
    expect(state.likedYouIds).not.toContain(state.people.find((p) => p.name === 'Aisha').id);
  });

  test('liking an ID-verified profile throws the planted TypeError and alerts', async () => {
    await expect(processSwipe({ profile: findProfile('mem_maya_k'), direction: 'like' }))
      .rejects.toThrow(TypeError);
    expect(createSessionAndAlert).toHaveBeenCalledTimes(1);
    expect(createSessionAndAlert.mock.calls[0][0]).toMatchObject({ customer: '0f066b5c', service: 'bumble-match-service' });
  });

  test('POST /swipes returns 500 for the ID-verified profile', async () => {
    const res = await post({ profileId: 'mem_maya_k', direction: 'like' });
    expect(res.status).toBe(500);
    expect(res.body).toMatchObject({ success: false, errorClass: 'TypeError', code: 'MATCH_CREATE_FAILED' });
    expect(res.body.error).toMatch(/trustWeight/);
  });

  test('passing on the ID-verified profile works', async () => {
    const res = await post({ profileId: 'mem_maya_k', direction: 'pass' });
    expect(res.status).toBe(200);
    expect(res.body.outcome).toBe('passed');
  });

  test('photo-verified profiles that liked you match', async () => {
    const res = await post({ profileId: 'mem_priya_s', direction: 'like' });
    expect(res.status).toBe(200);
    expect(res.body.outcome).toBe('matched');
    expect(res.body.match.openingMove).toMatch(/weeknight/);
    expect(createSessionAndAlert).not.toHaveBeenCalled();
  });

  test('like without a mutual like is recorded, superswipe matches', async () => {
    const liked = await post({ profileId: 'mem_aisha_b', direction: 'like' });
    expect(liked.body.outcome).toBe('liked');
    const sup = await post({ profileId: 'mem_aisha_b', direction: 'superswipe' });
    expect(sup.body.outcome).toBe('matched');
  });

  test.each([
    [{ profileId: 'nope', direction: 'like' }],
    [{ profileId: 'mem_priya_s', direction: 'constructor' }],
    [{ profileId: 'mem_priya_s' }],
  ])('rejects invalid input %j with 400', async (body) => {
    const res = await post(body);
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('VALIDATION_ERROR');
  });
});
