/* global afterAll, afterEach, beforeAll, beforeEach, describe, expect, fetch, jest, test */

jest.mock('../app/telemetry/sentry', () => ({
  Sentry: { captureException: jest.fn() },
  initSentry: jest.fn(),
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
  createDevinSession: jest.fn().mockResolvedValue({ sessionId: 's', url: 'https://app.devin.ai/sessions/s' }),
}));

jest.mock('../app/services/sonar-pr-trigger', () => ({
  scheduleVulnerablePR: jest.fn(),
}));

process.env.SLACK_ONCALL_BOT_TOKEN = 'xoxb-test';
process.env.SLACK_ONCALL_ALERTS_CHANNEL_ID = 'C0TEST';
process.env.STREAMTV_UPSTREAM_LATENCY_SCALE = '0';

const express = require('express');
const fs = require('fs');
const http = require('http');
const path = require('path');

const { postMessage } = require('../app/services/slack');
const { createDevinSession } = require('../app/services/devin-api');
const oncallRoutes = require('../app/routes/oncall');
const oncallVerticalRoutes = require('../app/routes/oncall-verticals');
const { postOncallAlert } = require('../app/services/oncall');
const { getOncallSkin } = require('../config/oncall-skins');
const streamtv = require('../app/services/oncall-verticals/streamtv');
const { TITLES, PROFILES } = require('../app/services/oncall-verticals/streamtv-catalog');

let server;
let baseUrl;

beforeAll((done) => {
  const app = express();
  app.use(express.json());
  app.use(oncallRoutes);
  app.use(oncallVerticalRoutes);
  server = http.createServer(app);
  server.listen(0, () => {
    baseUrl = `http://127.0.0.1:${server.address().port}`;
    done();
  });
});

afterAll((done) => {
  server.close(done);
});

describe('6217a32d TV home screen On-Call skin', () => {
  beforeEach(() => { jest.clearAllMocks(); streamtv.resetForTests(); });
  afterEach(() => jest.restoreAllMocks());

  test('is a native streamtv skin pinned to Slack with a brand-free scenario card', () => {
    const skin = getOncallSkin('6217a32d');
    expect(skin).toMatchObject({
      vertical: 'streamtv',
      oncallOnly: true,
      alertDestination: 'slack',
      paths: ['/streamtv'],
      page: { file: '6217a32d.html', title: 'Cloud Emulator | Roku' },
    });
    expect(skin.devinSession.auto).toBeUndefined();
    expect(skin.bugPortal).toBeUndefined();
    expect(skin.incident).toBeUndefined();
    expect(skin.disclaimer).toBe('');
    expect(skin.hideRibbon).toBe(true);
  });

  test('skin URL, direct slug and alias serve the same shimmed home screen', async () => {
    const paths = ['/oncall/c/6217a32d', '/6217a32d', '/streamtv'];
    const pages = await Promise.all(paths.map(async (p) => {
      const res = await fetch(`${baseUrl}${p}`);
      expect(res.status).toBe(200);
      return res.text();
    }));
    const html = pages[0];
    pages.slice(1).forEach((page) => expect(page).toEqual(html));
    expect(html).toContain('<title>Cloud Emulator | Roku</title>');
    expect(html).toContain('id="emulator"');
    expect(html).toContain("if (document.documentElement.dataset.view !== 'tv') return;");
    expect(html).toContain('/verticals/assets/6217a32d/emulator.js');
    expect(html).toContain("fetch('/api/playback/start'");
    expect(html).toContain('const oncallApiPath = "/api/playback/start"');
    expect(html).toContain('const triggerWhen = {"row":"continue-watching"}');
    expect(html).not.toContain('Demo environment – mock data');
    expect(html).toContain('Something went wrong. Try again.');
    expect(html).toContain('/session-cap-banner.js');
    expect(html).toContain('<div class="wordmark" aria-label="Roku">Roku</div>');
    const page = fs.readFileSync(path.join(__dirname, '..', 'app', 'public', 'verticals', '6217a32d.html'), 'utf8');
    const consoleScript = fs.readFileSync(path.join(__dirname, '..', 'app', 'public', 'verticals', 'assets', '6217a32d', 'emulator.js'), 'utf8');
    expect(page + consoleScript).not.toMatch(/StreamTV|STREAMTV/);
    expect(consoleScript).toContain('<div class="ce-brand">Roku</div>');
    expect(consoleScript).toContain('/api/oncall/trigger/streamtv');
    expect(consoleScript).toContain('streamtv-emulator');
    expect(consoleScript).not.toContain('class="ce-mock"');
    expect(consoleScript).not.toContain('not a native runtime');
    expect(consoleScript).toContain('Send a real on-call alert?');
  });

  test('report, incident and the bare scenario page are not opted in', async () => {
    for (const p of ['/oncall/c/6217a32d/report', '/oncall/c/6217a32d/incident', '/oncall/streamtv']) {
      const res = await fetch(`${baseUrl}${p}`);
      expect(res.status).toBe(404);
    }
  });

  test('ships original local poster art with a matching image for each presentation key', () => {
    const html = fs.readFileSync(path.join(__dirname, '..', 'app', 'public', 'verticals', '6217a32d.html'), 'utf8');
    const posterMap = html.match(/var POSTERS = \{([\s\S]*?)\};/)[1];
    const names = new Set([...posterMap.matchAll(/: '([a-z-]+)'/g)].map((match) => match[1]));
    names.add('woodland');
    names.add('wallpaper');
    for (const name of names) {
      const art = fs.readFileSync(path.join(__dirname, '..', 'app', 'public', 'verticals', 'assets', '6217a32d', `${name}.webp`));
      expect(art.toString('ascii', 0, 4)).toBe('RIFF');
      expect(art.toString('ascii', 8, 12)).toBe('WEBP');
      expect(art.length).toBeLessThan(160000);
    }
    expect(html).toContain("var t = el('button', 'tile')");
    expect(html).toContain('prefers-reduced-motion');
    expect(html).toContain('id="spotlightTitle"');
    expect(html).toContain('id="playerBack"');
  });

  test('seeds 50 titles and 3 profiles', () => {
    expect(TITLES).toHaveLength(50);
    expect(new Set(TITLES.map((t) => t.id)).size).toBe(50);
    expect(PROFILES).toHaveLength(3);
  });

  test('GET /api/home/rows returns the home rows with Continue Watching deferred', async () => {
    const res = await fetch(`${baseUrl}/api/home/rows?profileId=p-jordan`);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.profile.name).toBe('Jordan');
    expect(body.profiles).toHaveLength(3);
    const titles = body.rows.map((r) => r.title);
    expect(titles).toEqual(expect.arrayContaining(['Continue Watching', 'Trending', 'Live TV']));
    expect(titles.some((t) => t.startsWith('Because You Watched '))).toBe(true);
    const cw = body.rows.find((r) => r.id === 'continue-watching');
    expect(cw).toMatchObject({ deferred: true, href: '/api/home/continue-watching?profileId=p-jordan' });
    body.rows.filter((r) => !r.deferred).forEach((r) => expect(r.items.length).toBeGreaterThan(0));
    const live = body.rows.find((r) => r.id === 'live-tv');
    expect(live.items[0].channelName).toBe('Roku News 24');
    expect(JSON.stringify(body.rows)).not.toContain('StreamTV');
  });

  test('GET /api/home/continue-watching returns in-progress titles for every profile', async () => {
    for (const profile of PROFILES) {
      const res = await fetch(`${baseUrl}/api/home/continue-watching?profileId=${profile.id}`);
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.row.title).toBe('Continue Watching');
      expect(body.row.items.length).toBeGreaterThan(0);
      expect(body.row.items.length).toBeLessThanOrEqual(12);
      body.row.items.forEach((item) => {
        expect(item).toMatchObject({ titleId: expect.stringMatching(/^t\d{3}$/), title: expect.any(String) });
        expect(item.progressPct).toBeGreaterThan(0);
        expect(item.progressPct).toBeLessThan(95);
        expect(item.remainingLabel).toMatch(/left$/);
      });
    }
    const missing = await fetch(`${baseUrl}/api/home/continue-watching`);
    expect(missing.status).toBe(400);
    const unknown = await fetch(`${baseUrl}/api/home/continue-watching?profileId=p-nobody`);
    expect(unknown.status).toBe(404);
  });

  test('POST /api/playback/start resumes a Continue Watching title and starts others from the beginning', async () => {
    const cw = await (await fetch(`${baseUrl}/api/home/continue-watching?profileId=p-maya`)).json();
    const item = cw.row.items[0];
    const resume = await fetch(`${baseUrl}/api/playback/start`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ profileId: 'p-maya', titleId: item.titleId, row: 'continue-watching' }),
    });
    expect(resume.status).toBe(200);
    const started = await resume.json();
    expect(started).toMatchObject({ titleId: item.titleId, playbackId: expect.stringMatching(/^pb_/) });
    expect(started.resumeFromSec).toBeGreaterThan(0);
    expect(started.resumeLabel).toMatch(/^Resuming at /);

    const fresh = await fetch(`${baseUrl}/api/playback/start`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ profileId: 'p-maya', titleId: 't003', row: 'trending' }),
    });
    expect(fresh.status).toBe(200);
    expect((await fresh.json()).resumeFromSec).toBe(0);

    const unknown = await fetch(`${baseUrl}/api/playback/start`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ profileId: 'p-maya', titleId: 't999', row: 'trending' }),
    });
    expect(unknown.status).toBe(404);
  });

  test('posts the P2 latency card to #oncall-alerts and starts no app session', async () => {
    jest.spyOn(Math, 'random').mockReturnValue(0);
    const skin = getOncallSkin('6217a32d');
    await postOncallAlert(skin.vertical, { skin, runRef: 'run-test' });
    const [, , text] = postMessage.mock.calls[postMessage.mock.calls.length - 1];

    expect(text).toContain('*[Triggered] [P2] streamtv-home-api: p95 latency on GET /api/home/continue-watching > 2s (8.1s) for 5m – error rate 12% (504)*');
    expect(text).toContain('*Endpoint:* GET /api/home/continue-watching');
    expect(text).toContain('*Metric value:* 8.1s p95 · 12% of requests 504 | *Threshold:* > 2s for 5m');
    expect(text).toContain('streamtv-home-oncall');
    expect(text).toContain('/oncall/c/6217a32d');
    expect(createDevinSession).not.toHaveBeenCalled();
  });
});
