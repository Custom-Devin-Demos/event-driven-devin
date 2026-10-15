/* global describe, expect, test, beforeAll, afterAll, fetch */

const express = require('express');
const { createScoreCardRouter } = require('../app/routes/verticals/1b17e823-loyalty');
const { createScoreCardStore } = require('../app/services/verticals/1b17e823-loyalty/scorecard');

let server;
let base;

beforeAll(() => new Promise((resolve) => {
  const app = express();
  app.use(express.json());
  app.use(createScoreCardRouter(createScoreCardStore()));
  server = app.listen(0, () => {
    base = `http://127.0.0.1:${server.address().port}/api/1b17e823/scorecard`;
    resolve();
  });
}));

afterAll(() => new Promise((resolve) => { server.close(resolve); }));

async function call(method, path, body) {
  const res = await fetch(base + path, {
    method,
    headers: { 'content-type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
  });
  return { status: res.status, body: await res.json() };
}

describe('mock ScoreCard API', () => {
  test('seeds 200 members including the demo heroes', async () => {
    const seed = require('../app/services/verticals/1b17e823-loyalty/scorecard/members.json');
    expect(seed).toHaveLength(200);
    const jordan = await call('GET', '/members/8841207733');
    expect(jordan.status).toBe(200);
    expect(jordan.body).toMatchObject({ first_name: 'Jordan', last_name: 'Reyes', tier: 'standard', points_balance: 240 });
  });

  test('member lookup matches stored values exactly', async () => {
    const hit = await call('GET', '/members?email=casey.morgan%40example.com');
    expect(hit.body.members.map((m) => m.sc_member_id)).toEqual([5520917046]);
    const miss = await call('GET', '/members?email=Casey.Morgan%40example.com');
    expect(miss.body.members).toEqual([]);
    expect((await call('GET', '/members')).status).toBe(400);
  });

  test('earn applies the tier multiplier and issues $10 certificates per 300 points', async () => {
    const res = await call('POST', '/members/5520917046/earn', { amount: 100, order_id: 'DSG-T1' });
    expect(res.status).toBe(201);
    expect(res.body.transaction.points).toBe(150);
    expect(res.body.certificates_issued).toHaveLength(1);
    expect(res.body.member.points_balance).toBe(130);
    const txns = await call('GET', '/members/5520917046/transactions');
    expect(txns.body.transactions).toHaveLength(1);
  });

  test('redeem is single-step and rejects overdrafts', async () => {
    const ok = await call('POST', '/members/8841207733/redeem', { points: 40, order_id: 'DSG-T2' });
    expect(ok.status).toBe(201);
    expect(ok.body.member.points_balance).toBe(200);
    const over = await call('POST', '/members/8841207733/redeem', { points: 201, order_id: 'DSG-T3' });
    expect(over.status).toBe(409);
    expect(over.body.error).toBe('insufficient_points');
  });

  test('unknown members are 404', async () => {
    expect((await call('GET', '/members/1')).status).toBe(404);
  });
});
