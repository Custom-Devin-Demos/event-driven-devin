'use strict';

const os = require('os');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const http = require('http');
const express = require('express');
const { URLSearchParams } = require('url');

const ADMIN = 'U053N173C4E';
const MARK = 'U0BT6626DB3';
const AMAN = 'U0BARJZMV36';
const KATRIN = 'U0C4QNNFANS';
const REQUESTER = 'UREQUESTER1';
const STRANGER = 'USTRANGER01';

let tmpDir;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'fcto-'));
  process.env.FCTO_STORE_FILE = path.join(tmpDir, 'store.json');
  delete process.env.FCTO_ADMIN_SLACK_IDS;
  delete process.env.FCTO_SLACK_ID_NARRY_SINGH;
  jest.resetModules();
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

function load() {
  const { ReservationStore } = require('../app/services/fcto/store');
  const R = require('../app/services/fcto/reservations');
  return { store: new ReservationStore(), R };
}

const NOW = 1_800_000_000;
const base = (over = {}) => ({
  requesterId: REQUESTER,
  account: 'Acme Corp',
  purpose: 'Executive briefing',
  startTs: NOW + 3 * 86400,
  durationKey: '2h',
  who: 'MEMBER:MARK_PORTER',
  audience: 'VP',
  country: 'US',
  industry: 'TECH_NATIVE',
  ...over,
});

describe('roster config', () => {
  test('known members have Slack IDs, unknown ones come from env', () => {
    const { getRoster, getAdminIds } = require('../config/fcto-roster');
    const byKey = Object.fromEntries(getRoster().map((m) => [m.key, m]));
    expect(byKey.JEFF_WANG.slackId).toBe(ADMIN);
    expect(byKey.NARRY_SINGH.slackId).toBe('U0BUYNKE136');
    expect(byKey.AKIRA_SHIBATA.tz).toBe('Asia/Tokyo');
    expect(byKey.AKIRA_SHIBATA.slackId).toBe('U0AUFDRGGLC');
    expect(getRoster({ FCTO_SLACK_ID_NARRY_SINGH: 'u0narry123' }).find((m) => m.key === 'NARRY_SINGH').slackId).toBe('U0NARRY123');
    expect(getAdminIds()).toEqual([ADMIN]);
    expect(getAdminIds({ FCTO_ADMIN_SLACK_IDS: 'U1, u2,bad id,,U1' })).toEqual(['U1', 'U2']);
  });
});

describe('createRequest validation', () => {
  test('creates a pending specific request with the member pre-assigned', async () => {
    const { store, R } = load();
    const r = await R.createRequest(store, base(), { now: NOW });
    expect(r.id).toBe('FCR-1');
    expect(r.status).toBe('pending');
    expect(r.requestType).toBe('specific');
    expect(r.assigneeKey).toBe('MARK_PORTER');
    expect(r.endTs - r.startTs).toBe(2 * 3600);
    expect(JSON.parse(fs.readFileSync(process.env.FCTO_STORE_FILE, 'utf8')).reservations).toHaveLength(1);
  });

  test('"any" requests carry the regional preference and no assignee', async () => {
    const { store, R } = load();
    const r = await R.createRequest(store, base({ who: 'ANY:EU' }), { now: NOW });
    expect(r.requestType).toBe('any');
    expect(r.preference).toBe('EU');
    expect(r.assigneeKey).toBeNull();
    expect(R.describeWho(r)).toMatch(/EU hours/);
  });

  test.each([
    [{ account: '' }, 'account'],
    [{ purpose: '  ' }, 'purpose'],
    [{ startTs: NOW - 3600 }, 'start'],
    [{ durationKey: 'bogus' }, 'duration'],
    [{ durationKey: 'custom' }, 'end'],
    [{ durationKey: 'custom', endTs: NOW + 3 * 86400 - 60 }, 'end'],
    [{ durationKey: 'custom', endTs: NOW + 30 * 86400 }, 'end'],
    [{ who: 'MEMBER:NOBODY' }, 'who'],
    [{ who: '' }, 'who'],
    [{ meetingLink: 'zoom.us/j/1' }, 'meetingLink'],
  ])('rejects %j on field %s', async (over, field) => {
    const { store, R } = load();
    await expect(R.createRequest(store, base(over), { now: NOW })).rejects.toMatchObject({ field });
    expect(store.all()).toHaveLength(0);
  });

  test('custom end supports multi-day blocks', async () => {
    const { store, R } = load();
    const r = await R.createRequest(store, base({ durationKey: 'custom', endTs: NOW + 5 * 86400 }), { now: NOW });
    expect(R.durationLabel(r)).toBe('2 days');
  });
});

describe('approval permissions', () => {
  test('admin approves; stranger cannot', async () => {
    const { store, R } = load();
    const r = await R.createRequest(store, base(), { now: NOW });
    await expect(R.approve(store, r.id, { by: STRANGER })).rejects.toMatchObject({ code: 'forbidden' });
    const approved = await R.approve(store, r.id, { by: ADMIN });
    expect(approved.status).toBe('approved');
    expect(approved.decidedBy).toBe(ADMIN);
    await expect(R.approve(store, r.id, { by: ADMIN })).rejects.toMatchObject({ code: 'not_pending' });
  });

  test('the requested Field CTO can approve their own slot but not hand it to someone else', async () => {
    const { store, R } = load();
    const r = await R.createRequest(store, base(), { now: NOW });
    expect(R.canDecide(r, MARK)).toBe(true);
    expect(R.canDecide(r, AMAN)).toBe(false);
    await expect(R.approve(store, r.id, { by: MARK, assigneeKey: 'AMAN_THIND' })).rejects.toMatchObject({ code: 'forbidden' });
    const approved = await R.approve(store, r.id, { by: MARK });
    expect(approved.assigneeKey).toBe('MARK_PORTER');
  });

  test('approving an "any" request needs an assignee; admin can pick one', async () => {
    const { store, R } = load();
    const r = await R.createRequest(store, base({ who: 'ANY:ANY' }), { now: NOW });
    await expect(R.approve(store, r.id, { by: ADMIN })).rejects.toMatchObject({ code: 'assignee_required', needsAssignee: true });
    const approved = await R.approve(store, r.id, { by: ADMIN, assigneeKey: 'KATRIN_LEHMANN' });
    expect(approved.assigneeKey).toBe('KATRIN_LEHMANN');
  });

  test('Field CTOs can claim open requests; non-members and specific requests cannot be claimed', async () => {
    const { store, R } = load();
    const open = await R.createRequest(store, base({ who: 'ANY:EU' }), { now: NOW });
    const specific = await R.createRequest(store, base(), { now: NOW });
    expect(R.canClaim(open, STRANGER)).toBe(false);
    expect(R.canClaim(specific, AMAN)).toBe(false);
    await expect(R.claim(store, open.id, { by: STRANGER })).rejects.toMatchObject({ code: 'forbidden' });
    const claimed = await R.claim(store, open.id, { by: AMAN });
    expect(claimed.status).toBe('approved');
    expect(claimed.assigneeKey).toBe('AMAN_THIND');
    expect(claimed.history.map((h) => h.action)).toEqual(['requested', 'claimed']);
  });

  test('decline records reason and who; cancel is requester or admin only', async () => {
    const { store, R } = load();
    const r = await R.createRequest(store, base(), { now: NOW });
    await expect(R.cancel(store, r.id, { by: STRANGER })).rejects.toMatchObject({ code: 'forbidden' });
    const declined = await R.decline(store, r.id, { by: MARK, reason: 'Travelling' });
    expect(declined.status).toBe('declined');
    expect(declined.declineReason).toBe('Travelling');
    await expect(R.cancel(store, r.id, { by: REQUESTER })).rejects.toMatchObject({ code: 'not_open' });

    const r2 = await R.createRequest(store, base(), { now: NOW });
    const cancelled = await R.cancel(store, r2.id, { by: REQUESTER });
    expect(cancelled.status).toBe('cancelled');
  });

  test('only admins reassign; reassigning a pending request approves it', async () => {
    const { store, R } = load();
    const r = await R.createRequest(store, base(), { now: NOW });
    await expect(R.reassign(store, r.id, { by: MARK, assigneeKey: 'AMAN_THIND' })).rejects.toMatchObject({ code: 'forbidden' });
    const moved = await R.reassign(store, r.id, { by: ADMIN, assigneeKey: 'AMAN_THIND' });
    expect(moved.status).toBe('approved');
    expect(moved.assigneeKey).toBe('AMAN_THIND');
    expect(moved.history.at(-1).detail).toBe('MARK_PORTER -> AMAN_THIND');
  });
});

describe('conflicts', () => {
  test('overlapping approved reservations block approval unless forced', async () => {
    const { store, R } = load();
    const first = await R.createRequest(store, base(), { now: NOW });
    await R.approve(store, first.id, { by: ADMIN });
    const second = await R.createRequest(store, base({ startTs: NOW + 3 * 86400 + 3600, account: 'Beta' }), { now: NOW });
    expect(R.findConflicts(store, 'MARK_PORTER', second.startTs, second.endTs, second.id).map((c) => c.id)).toEqual([first.id]);
    await expect(R.approve(store, second.id, { by: ADMIN })).rejects.toMatchObject({ code: 'conflict' });
    const forced = await R.approve(store, second.id, { by: ADMIN, force: true });
    expect(forced.status).toBe('approved');
  });

  test('adjacent and pending/declined reservations are not conflicts', async () => {
    const { store, R } = load();
    const first = await R.createRequest(store, base(), { now: NOW });
    await R.approve(store, first.id, { by: ADMIN });
    const adjacent = await R.createRequest(store, base({ startTs: first.endTs }), { now: NOW });
    expect(R.findConflicts(store, 'MARK_PORTER', adjacent.startTs, adjacent.endTs, adjacent.id)).toEqual([]);
    const pendingOverlap = await R.createRequest(store, base({ who: 'MEMBER:KATRIN_LEHMANN' }), { now: NOW });
    expect(R.findConflicts(store, 'KATRIN_LEHMANN', pendingOverlap.startTs, pendingOverlap.endTs, 'other')).toEqual([]);
  });

  test('suggestAssignees prefers the requested region and free people', async () => {
    const { store, R } = load();
    const busy = await R.createRequest(store, base({ who: 'MEMBER:AMAN_THIND' }), { now: NOW });
    await R.approve(store, busy.id, { by: ADMIN });
    const open = await R.createRequest(store, base({ who: 'ANY:EU' }), { now: NOW });
    const names = R.suggestAssignees(store, open).map((m) => `${m.name}${m.preferred ? '' : '*'}${m.conflicts.length ? '!' : ''}`);
    expect(names.slice(0, 3)).toEqual(['Katrin Lehmann', 'Narry Singh', 'Aman Thind!']);
    expect(names.slice(3).every((n) => n.endsWith('*'))).toBe(true);
  });
});

describe('schedule queries and formatting', () => {
  test('listReservations filters by window, member and requester', async () => {
    const { store, R } = load();
    const a = await R.createRequest(store, base(), { now: NOW });
    const b = await R.createRequest(store, base({ startTs: NOW + 10 * 86400, who: 'MEMBER:KATRIN_LEHMANN', requesterId: 'UOTHER' }), { now: NOW });
    const c = await R.createRequest(store, base({ startTs: NOW + 20 * 86400 }), { now: NOW });
    await R.decline(store, c.id, { by: ADMIN });
    expect(R.listReservations(store).map((r) => r.id)).toEqual([a.id, b.id]);
    expect(R.listReservations(store, { from: NOW + 5 * 86400 }).map((r) => r.id)).toEqual([b.id]);
    expect(R.listReservations(store, { memberKey: 'MARK_PORTER' }).map((r) => r.id)).toEqual([a.id]);
    expect(R.listReservations(store, { requesterId: 'UOTHER' }).map((r) => r.id)).toEqual([b.id]);
    expect(R.listReservations(store, { statuses: ['declined'] }).map((r) => r.id)).toEqual([c.id]);
  });

  test('renders the same instant in Tokyo, Berlin and Pacific time', () => {
    const { R } = load();
    const ts = Date.UTC(2026, 9, 22, 17, 0) / 1000; // 2026-10-22 17:00Z
    expect(R.formatRangeInTz(ts, ts + 7200, 'Asia/Tokyo')).toBe('Fri Oct 23, 2:00 AM – 4:00 AM GMT+9');
    expect(R.formatRangeInTz(ts, ts + 7200, 'Europe/Berlin')).toBe('Thu Oct 22, 7:00 PM – 9:00 PM GMT+2');
    expect(R.formatRangeInTz(ts, ts + 7200, 'America/Los_Angeles')).toBe('Thu Oct 22, 10:00 AM – 12:00 PM PDT');
    expect(R.slackRange(ts, ts + 7200)).toContain(`<!date^${ts}^{date_short_pretty} {time}|`);
  });
});

describe('store durability', () => {
  test('reloads from disk and quarantines a corrupt file', async () => {
    const { store, R } = load();
    await R.createRequest(store, base(), { now: NOW });
    const { ReservationStore } = require('../app/services/fcto/store');
    const reopened = new ReservationStore(process.env.FCTO_STORE_FILE);
    expect(reopened.all()).toHaveLength(1);
    expect(reopened.load().nextSeq).toBe(2);

    fs.writeFileSync(process.env.FCTO_STORE_FILE, '{not json');
    const fresh = new ReservationStore(process.env.FCTO_STORE_FILE);
    expect(fresh.all()).toEqual([]);
    expect(fs.readdirSync(tmpDir).some((f) => f.includes('.corrupt-'))).toBe(true);
  });
});

describe('ics', () => {
  test('builds a valid VEVENT with escaped text', async () => {
    const { store, R } = load();
    const { buildIcs, icsFilename } = require('../app/services/fcto/ics');
    const r = await R.createRequest(store, base({ purpose: 'EBC; roadmap, pricing', meetingLink: 'https://zoom.us/j/123' }), { now: NOW });
    const approved = await R.approve(store, r.id, { by: ADMIN });
    const ics = buildIcs(approved, { now: NOW });
    expect(ics).toMatch(/^BEGIN:VCALENDAR\r\n/);
    expect(ics).toContain('SUMMARY:Field CTO: Mark Porter — Acme Corp');
    expect(ics.replace(/\r\n /g, '')).toContain('EBC\\; roadmap\\, pricing');
    expect(ics).toContain('URL:https://zoom.us/j/123');
    expect(ics).toMatch(/DTSTART:\d{8}T\d{6}Z/);
    expect(ics.split('\r\n').every((line) => line.length <= 75)).toBe(true);
    expect(icsFilename(approved)).toMatch(/^fcr-1-mark-porter-\d{4}-\d{2}-\d{2}\.ics$/);
  });
});

describe('block kit', () => {
  test('request card shows actions appropriate to state and viewer-agnostic status', async () => {
    const { store, R } = load();
    const B = require('../app/services/fcto/blocks');
    const open = await R.createRequest(store, base({ who: 'ANY:JP' }), { now: NOW });
    const actionIds = (blocks) => (blocks.find((b) => b.type === 'actions') || { elements: [] }).elements.map((e) => e.action_id);
    expect(actionIds(B.requestCard(open))).toEqual([B.ACTION.CLAIM, B.ACTION.ASSIGN, B.ACTION.DECLINE, B.ACTION.CANCEL]);
    expect(JSON.stringify(B.requestCard(open))).toContain('Japan / APAC');

    const specific = await R.createRequest(store, base(), { now: NOW });
    expect(actionIds(B.requestCard(specific))).toEqual([B.ACTION.APPROVE, B.ACTION.DECLINE, B.ACTION.ASSIGN, B.ACTION.CANCEL]);
    const approved = await R.approve(store, specific.id, { by: ADMIN });
    expect(actionIds(B.requestCard(approved))).toEqual([B.ACTION.ASSIGN, B.ACTION.CANCEL]);
    expect(JSON.stringify(B.requestCard(approved))).toContain(`<@${MARK}> (Mark Porter) is reserved`);
    const declined = await R.decline(store, open.id, { by: ADMIN, reason: 'No coverage' });
    expect(actionIds(B.requestCard(declined))).toEqual([]);
    expect(B.cardText(declined)).toMatch(/^\[Declined\]/);
  });

  test('modal round-trips through readRequestModal and maps errors to blocks', () => {
    const B = require('../app/services/fcto/blocks');
    const { R } = load();
    const modal = B.requestModal({ channelId: 'C123' });
    expect(modal.callback_id).toBe(B.CALLBACK.REQUEST);
    expect(modal.blocks.filter((b) => b.type === 'input').map((b) => b.block_id)).toEqual(['account', 'purpose', 'audience', 'country', 'industry', 'who', 'start', 'duration', 'end', 'meetingLink', 'notes']);
    const view = {
      private_metadata: modal.private_metadata,
      state: { values: {
        account: { value: { value: 'Acme' } },
        purpose: { value: { value: 'EBC' } },
        audience: { value: { selected_option: { value: 'VP' } } },
        country: { value: { selected_option: { value: 'DE' } } },
        industry: { value: { selected_option: { value: 'FINANCE' } } },
        who: { value: { selected_option: { value: 'MEMBER:JEFF_WANG' } } },
        start: { value: { selected_date_time: NOW } },
        duration: { value: { selected_option: { value: 'half_day' } } },
        end: { value: {} },
        meetingLink: { value: { value: null } },
        notes: { value: { value: 'bring slides' } },
      } },
    };
    expect(B.readRequestModal(view)).toMatchObject({ account: 'Acme', audience: 'VP', country: 'DE', industry: 'FINANCE', who: 'MEMBER:JEFF_WANG', durationKey: 'half_day', channelId: 'C123', notes: 'bring slides' });
    expect(B.modalErrors(new R.ReservationError('x', 'Pick a start', { field: 'start' }))).toEqual({ response_action: 'errors', errors: { start: 'Pick a start' } });
  });

  test('home view lists roster, upcoming reservations and admin role', async () => {
    const { store, R } = load();
    const B = require('../app/services/fcto/blocks');
    const r = await R.createRequest(store, { ...base(), startTs: Math.floor(Date.now() / 1000) + 2 * 86400 });
    await R.approve(store, r.id, { by: ADMIN });
    const home = JSON.stringify(B.homeView(store, ADMIN));
    expect(home).toContain('You are an *admin*');
    expect(home).toContain('Akira Shibata');
    expect(home).toContain('<@U0BUYNKE136>');
    expect(home).toContain('Acme Corp (FCR-1)');
  });
});

// ─── HTTP layer ─────────────────────────────────────────────────────────────

function sign(secret, body, ts = Math.floor(Date.now() / 1000)) {
  const sig = `v0=${crypto.createHmac('sha256', secret).update(`v0:${ts}:${body}`).digest('hex')}`;
  return { 'X-Slack-Request-Timestamp': String(ts), 'X-Slack-Signature': sig };
}

function startApp(router) {
  const app = express();
  app.use(router);
  return new Promise((resolve) => {
    const server = app.listen(0, () => resolve({ server, port: server.address().port }));
  });
}

function post(port, urlPath, body, headers = {}, contentType = 'application/x-www-form-urlencoded') {
  return new Promise((resolve, reject) => {
    const req = http.request({ port, path: urlPath, method: 'POST', headers: { 'Content-Type': contentType, 'Content-Length': Buffer.byteLength(body), ...headers } }, (res) => {
      let data = '';
      res.on('data', (c) => { data += c; });
      res.on('end', () => resolve({ status: res.statusCode, body: data, json: () => JSON.parse(data) }));
    });
    req.on('error', reject);
    req.end(body);
  });
}

describe('HTTP routes', () => {
  let slackCalls;
  let server;
  let port;
  let internal;

  beforeEach(async () => {
    slackCalls = [];
    process.env.FCTO_SLACK_SIGNING_SECRET = 'shhh';
    process.env.FCTO_SLACK_BOT_TOKEN = 'xoxb-test';
    process.env.FCTO_CHANNEL_ID = 'CEXEC';
    jest.doMock('../app/services/fcto/slack-client', () => {
      const actual = jest.requireActual('../app/services/fcto/slack-client');
      const record = (method, ok = { ok: true }) => jest.fn(async (...args) => { slackCalls.push([method, ...args]); return typeof ok === 'function' ? ok(...args) : ok; });
      return {
        ...actual,
        postMessage: record('chat.postMessage', (channel) => ({ ok: true, channel, ts: '1700.1' })),
        updateMessage: record('chat.update'),
        postEphemeral: record('chat.postEphemeral'),
        openView: record('views.open'),
        updateView: record('views.update'),
        publishHome: record('views.publish'),
        openDm: record('conversations.open', { ok: true, channel: { id: 'DM1' } }),
        respond: record('response_url'),
        uploadFile: record('files.upload'),
        userInfo: jest.fn(async () => ({ ok: false, error: 'not_mocked' })),
      };
    });
    const router = require('../app/routes/fcto');
    internal = router._internal;
    ({ server, port } = await startApp(router));
  });

  afterEach(async () => {
    await new Promise((resolve) => server.close(resolve));
    delete process.env.FCTO_SLACK_SIGNING_SECRET;
    delete process.env.FCTO_SLACK_BOT_TOKEN;
    delete process.env.FCTO_CHANNEL_ID;
    delete process.env.FCTO_ALLOW_UNSIGNED;
  });

  const form = (obj) => new URLSearchParams(obj).toString();
  const flush = () => new Promise((r) => setTimeout(r, 20));

  test('rejects unsigned, stale and forged requests', async () => {
    const body = form({ command: '/fcto', text: 'help', user_id: REQUESTER });
    expect((await post(port, '/slack/fcto/commands', body)).status).toBe(401);
    expect((await post(port, '/slack/fcto/commands', body, sign('shhh', body, 1000))).status).toBe(401);
    expect((await post(port, '/slack/fcto/commands', body, sign('wrong', body))).status).toBe(401);
    expect((await post(port, '/slack/fcto/commands', body, sign('shhh', body))).status).toBe(200);
  });

  test('503 when no signing secret unless FCTO_ALLOW_UNSIGNED=1', async () => {
    delete process.env.FCTO_SLACK_SIGNING_SECRET;
    const body = form({ command: '/fcto', text: 'help', user_id: REQUESTER });
    expect((await post(port, '/slack/fcto/commands', body)).status).toBe(503);
    process.env.FCTO_ALLOW_UNSIGNED = '1';
    expect((await post(port, '/slack/fcto/commands', body)).status).toBe(200);
  });

  test('/fcto opens the request modal with the channel in private_metadata', async () => {
    const body = form({ command: '/fcto', text: 'request', user_id: REQUESTER, channel_id: 'CEXEC', trigger_id: 'trig1' });
    const res = await post(port, '/slack/fcto/commands', body, sign('shhh', body));
    expect(res.status).toBe(200);
    expect(res.body).toBe('');
    expect(slackCalls[0][0]).toBe('views.open');
    expect(slackCalls[0][1]).toBe('trig1');
    expect(JSON.parse(slackCalls[0][2].private_metadata)).toEqual({ channelId: 'CEXEC' });
  });

  test('/fcto schedule, roster, help and unknown person', async () => {
    const run = async (text) => {
      const body = form({ command: '/fcto', text, user_id: REQUESTER });
      return (await post(port, '/slack/fcto/commands', body, sign('shhh', body))).json();
    };
    expect((await run('schedule')).text).toBe('Field CTO schedule — this week');
    expect((await run('schedule next')).text).toBe('Field CTO schedule — next week');
    expect((await run('schedule katrin')).text).toBe("Katrin Lehmann's schedule");
    expect((await run(`schedule <@${MARK}>`)).text).toBe("Mark Porter's schedule");
    expect((await run('schedule bob')).text).toMatch(/don't know a Field CTO called "bob"/);
    expect((await run('schedule me')).text).toMatch(/no open requests/);
    expect(JSON.stringify((await run('roster')).blocks)).toContain('Aman Thind');
    expect((await run('help')).text).toContain('/fcto request');
    expect((await run('bogus')).text).toContain('/fcto request');
  });

  function submission(callbackId, values, meta, user = REQUESTER) {
    return form({ payload: JSON.stringify({ type: 'view_submission', user: { id: user }, view: { callback_id: callbackId, private_metadata: JSON.stringify(meta), state: { values } } }) });
  }

  function blockAction(actionId, value, user, extra = {}) {
    return form({ payload: JSON.stringify({ type: 'block_actions', user: { id: user }, trigger_id: 'trig2', channel: { id: 'CEXEC' }, response_url: 'https://hooks.example/r', actions: [{ action_id: actionId, value }], ...extra }) });
  }

  const requestValues = (over = {}) => ({
    account: { value: { value: 'Acme Corp' } },
    purpose: { value: { value: 'EBC' } },
    audience: { value: { selected_option: { value: 'C_LEVEL' } } },
    country: { value: { selected_option: { value: 'US' } } },
    industry: { value: { selected_option: { value: 'TECH_NATIVE' } } },
    who: { value: { selected_option: { value: 'MEMBER:MARK_PORTER' } } },
    start: { value: { selected_date_time: Math.floor(Date.now() / 1000) + 86400 } },
    duration: { value: { selected_option: { value: '1h' } } },
    end: { value: {} },
    meetingLink: { value: {} },
    notes: { value: {} },
    ...over,
  });

  test('modal submission validation errors are returned inline', async () => {
    const body = submission('fcto_request_submit', requestValues({ account: { value: { value: '' } } }), { channelId: 'CEXEC' });
    const res = await post(port, '/slack/fcto/interactions', body, sign('shhh', body));
    expect(res.json()).toEqual({ response_action: 'errors', errors: { account: expect.stringMatching(/account/i) } });
    expect(internal.store.all()).toHaveLength(0);
  });

  test('full lifecycle: submit → card posted → approve → card updated, thread note + ics', async () => {
    const body = submission('fcto_request_submit', requestValues(), { channelId: 'CEXEC' });
    const res = await post(port, '/slack/fcto/interactions', body, sign('shhh', body));
    expect(res.status).toBe(200);
    expect(res.body).toBe('');
    await flush();
    const stored = internal.store.get('FCR-1');
    expect(stored.messageTs).toBe('1700.1');
    expect(stored.channelId).toBe('CEXEC');
    const posted = slackCalls.find((c) => c[0] === 'chat.postMessage');
    expect(posted[1]).toBe('CEXEC');
    expect(posted[2]).toMatch(/^\[Pending\] Field CTO request FCR-1/);

    slackCalls.length = 0;
    const strangerClick = blockAction('fcto_approve', 'FCR-1', STRANGER);
    await post(port, '/slack/fcto/interactions', strangerClick, sign('shhh', strangerClick));
    await flush();
    expect(slackCalls.map((c) => c[0])).toEqual(['response_url']);
    expect(slackCalls[0][2].text).toMatch(/Only an admin or the requested Field CTO/);
    expect(internal.store.get('FCR-1').status).toBe('pending');

    slackCalls.length = 0;
    const markClick = blockAction('fcto_approve', 'FCR-1', MARK);
    await post(port, '/slack/fcto/interactions', markClick, sign('shhh', markClick));
    await flush();
    expect(internal.store.get('FCR-1').status).toBe('approved');
    const methods = slackCalls.map((c) => c[0]);
    expect(methods).toEqual(['chat.update', 'chat.postMessage', 'files.upload']);
    expect(slackCalls[0][2]).toBe('1700.1');
    expect(slackCalls[0][3]).toMatch(/^\[Approved\]/);
    expect(slackCalls[1][4]).toEqual({ thread_ts: '1700.1' });
    expect(slackCalls[1][2]).toContain(`<@${MARK}> (Mark Porter) is reserved`);
    expect(slackCalls[2][1].content).toContain('BEGIN:VCALENDAR');
    expect(slackCalls[2][1].filename).toMatch(/\.ics$/);
  });

  test('conflicting approve opens the assign modal; forced submit books anyway', async () => {
    const first = submission('fcto_request_submit', requestValues(), { channelId: 'CEXEC' });
    await post(port, '/slack/fcto/interactions', first, sign('shhh', first));
    await flush();
    const approve1 = blockAction('fcto_approve', 'FCR-1', ADMIN);
    await post(port, '/slack/fcto/interactions', approve1, sign('shhh', approve1));
    await flush();
    const second = submission('fcto_request_submit', requestValues({ account: { value: { value: 'Beta' } } }), { channelId: 'CEXEC' });
    await post(port, '/slack/fcto/interactions', second, sign('shhh', second));
    await flush();

    slackCalls.length = 0;
    const approve2 = blockAction('fcto_approve', 'FCR-2', ADMIN);
    await post(port, '/slack/fcto/interactions', approve2, sign('shhh', approve2));
    await flush();
    expect(slackCalls[0][0]).toBe('views.open');
    const modal = slackCalls[0][2];
    expect(modal.callback_id).toBe('fcto_assign_submit');
    expect(JSON.stringify(modal)).toContain('already reserved');
    expect(internal.store.get('FCR-2').status).toBe('pending');

    const unforced = submission('fcto_assign_submit', { assignee: { value: { selected_option: { value: 'MARK_PORTER' } } }, force: { value: { selected_options: [] } } }, { id: 'FCR-2', mode: 'approve' }, ADMIN);
    const r1 = await post(port, '/slack/fcto/interactions', unforced, sign('shhh', unforced));
    expect(r1.json()).toEqual({ response_action: 'errors', errors: { force: expect.stringMatching(/already reserved/) } });

    const forced = submission('fcto_assign_submit', { assignee: { value: { selected_option: { value: 'MARK_PORTER' } } }, force: { value: { selected_options: [{ value: 'force' }] } } }, { id: 'FCR-2', mode: 'approve' }, ADMIN);
    const r2 = await post(port, '/slack/fcto/interactions', forced, sign('shhh', forced));
    expect(r2.body).toBe('');
    await flush();
    expect(internal.store.get('FCR-2').status).toBe('approved');
  });

  test('"any" request: claim by Field CTO, assign by admin only, decline modal flow', async () => {
    const body = submission('fcto_request_submit', requestValues({ who: { value: { selected_option: { value: 'ANY:EU' } } } }), { channelId: 'CEXEC' });
    await post(port, '/slack/fcto/interactions', body, sign('shhh', body));
    await flush();

    slackCalls.length = 0;
    const assignByMark = blockAction('fcto_assign', 'FCR-1', MARK);
    await post(port, '/slack/fcto/interactions', assignByMark, sign('shhh', assignByMark));
    await flush();
    expect(slackCalls[0][2].text).toMatch(/Only an admin can assign/);

    slackCalls.length = 0;
    const declineClick = blockAction('fcto_decline', 'FCR-1', ADMIN);
    await post(port, '/slack/fcto/interactions', declineClick, sign('shhh', declineClick));
    await flush();
    expect(slackCalls[0][0]).toBe('views.open');
    expect(slackCalls[0][2].callback_id).toBe('fcto_decline_submit');

    slackCalls.length = 0;
    const claim = blockAction('fcto_claim', 'FCR-1', KATRIN);
    await post(port, '/slack/fcto/interactions', claim, sign('shhh', claim));
    await flush();
    const r = internal.store.get('FCR-1');
    expect(r.status).toBe('approved');
    expect(r.assigneeKey).toBe('KATRIN_LEHMANN');
    expect(slackCalls.map((c) => c[0])).toEqual(['chat.update', 'chat.postMessage', 'files.upload']);

    slackCalls.length = 0;
    const reassign = submission('fcto_assign_submit', { assignee: { value: { selected_option: { value: 'AMAN_THIND' } } }, force: { value: {} } }, { id: 'FCR-1', mode: 'reassign' }, ADMIN);
    await post(port, '/slack/fcto/interactions', reassign, sign('shhh', reassign));
    await flush();
    expect(internal.store.get('FCR-1').assigneeKey).toBe('AMAN_THIND');
    expect(slackCalls.map((c) => c[0])).toEqual(['chat.update', 'chat.postMessage', 'files.upload', 'views.publish']);
  });

  test('cancel by requester updates the card; events handle url_verification and app_home_opened', async () => {
    const body = submission('fcto_request_submit', requestValues(), { channelId: 'CEXEC' });
    await post(port, '/slack/fcto/interactions', body, sign('shhh', body));
    await flush();
    slackCalls.length = 0;
    const cancel = blockAction('fcto_cancel', 'FCR-1', REQUESTER);
    await post(port, '/slack/fcto/interactions', cancel, sign('shhh', cancel));
    await flush();
    expect(internal.store.get('FCR-1').status).toBe('cancelled');
    expect(slackCalls.map((c) => c[0])).toEqual(['chat.update', 'chat.postMessage']);

    const challenge = JSON.stringify({ type: 'url_verification', challenge: 'abc' });
    const v = await post(port, '/slack/fcto/events', challenge, sign('shhh', challenge), 'application/json');
    expect(v.json()).toEqual({ challenge: 'abc' });

    slackCalls.length = 0;
    const home = JSON.stringify({ type: 'event_callback', event: { type: 'app_home_opened', tab: 'home', user: ADMIN } });
    const h = await post(port, '/slack/fcto/events', home, sign('shhh', home), 'application/json');
    expect(h.status).toBe(200);
    await flush();
    expect(slackCalls[0][0]).toBe('views.publish');
    expect(slackCalls[0][1]).toBe(ADMIN);
    expect(slackCalls[0][2].type).toBe('home');
  });

  test('health endpoint reports configuration without secrets', async () => {
    const res = await new Promise((resolve) => http.get({ port, path: '/slack/fcto/health' }, (r) => { let d = ''; r.on('data', (c) => { d += c; }); r.on('end', () => resolve(JSON.parse(d))); }));
    expect(res).toMatchObject({ ok: true, signingSecretConfigured: true, botTokenConfigured: true, channelConfigured: true, admins: 1, reservations: 0 });
    expect(JSON.stringify(res)).not.toContain('xoxb');
    expect(res.roster.find((m) => m.name === 'Akira Shibata').slackIdConfigured).toBe(true);
    expect(res.roster.find((m) => m.name === 'Narry Singh').slackIdConfigured).toBe(true);
  });

  test('qualification picks re-render the request modal with a suggested Field CTO', async () => {
    const B = require('../app/services/fcto/blocks');
    const modal = B.requestModal({ channelId: 'CEXEC' });
    const values = requestValues({ country: { value: { selected_option: { value: 'JP' } } } });
    delete values.who;
    values.who = { value: {} };
    const view = { id: 'V1', hash: 'h1', callback_id: modal.callback_id, private_metadata: modal.private_metadata, state: { values } };
    const body = blockAction('value', undefined, REQUESTER, { view, actions: [{ action_id: 'value', block_id: 'country', type: 'static_select' }] });
    expect((await post(port, '/slack/fcto/interactions', body, sign('shhh', body))).status).toBe(200);
    await flush();
    const update = slackCalls.find((c) => c[0] === 'views.update');
    expect(update[1]).toBe('V1');
    expect(update[3]).toBe('h1');
    const who = update[2].blocks.find((b) => (b.block_id || '').startsWith('who_'));
    expect(who.block_id).toBe('who_MEMBER_AKIRA_SHIBATA');
    expect(who.element.initial_option.value).toBe('MEMBER:AKIRA_SHIBATA');
    expect(JSON.parse(update[2].private_metadata)).toEqual({ channelId: 'CEXEC' });
    expect(internal.store.all()).toHaveLength(0);
  });

  test('overlapping qualification picks are serialized and the latest suggestion wins', async () => {
    const B = require('../app/services/fcto/blocks');
    const slackClient = require('../app/services/fcto/slack-client');
    const modal = B.requestModal({ channelId: 'CEXEC' });
    const viewWith = (over) => {
      const values = requestValues(over);
      delete values.who;
      values.who = { value: {} };
      return { id: 'V2', hash: 'h0', callback_id: modal.callback_id, private_metadata: modal.private_metadata, state: { values } };
    };
    let release;
    const gate = new Promise((r) => { release = r; });
    slackClient.updateView
      .mockImplementationOnce(async (...args) => { slackCalls.push(['views.update', ...args]); await gate; return { ok: true, view: { hash: 'h1' } }; })
      .mockImplementationOnce(async (...args) => { slackCalls.push(['views.update', ...args]); return { ok: false, error: 'hash_conflict' }; });
    const send = (view, blockId, actionTs) => {
      const body = blockAction('value', undefined, REQUESTER, { view, actions: [{ action_id: 'value', block_id: blockId, type: 'static_select', action_ts: actionTs }] });
      return post(port, '/slack/fcto/interactions', body, sign('shhh', body));
    };
    await send(viewWith({ country: { value: { selected_option: { value: 'DE' } } } }), 'country', '100.1');
    await flush();
    await send(viewWith({ country: { value: { selected_option: { value: 'DE' } } }, industry: { value: { selected_option: { value: 'FINANCE' } } } }), 'industry', '100.3');
    await flush();
    // A delayed older snapshot (country only) arriving mid-update is dropped.
    await send(viewWith({ country: { value: { selected_option: { value: 'DE' } } } }), 'country', '100.2');
    await flush();
    expect(slackCalls.filter((c) => c[0] === 'views.update')).toHaveLength(1);
    release();
    await flush();
    const updates = slackCalls.filter((c) => c[0] === 'views.update');
    expect(updates).toHaveLength(3);
    const whoOf = (u) => u[2].blocks.find((b) => (b.block_id || '').startsWith('who')).block_id;
    expect(whoOf(updates[0])).toBe('who_MEMBER_KATRIN_LEHMANN');
    expect(updates[1][3]).toBe('h0');
    expect(whoOf(updates[1])).toBe('who_MEMBER_AMAN_THIND');
    expect(updates[2][3]).toBeUndefined();
    expect(whoOf(updates[2])).toBe('who_MEMBER_AMAN_THIND');

    // ...and one arriving after the update finished is dropped too.
    await send(viewWith({ country: { value: { selected_option: { value: 'DE' } } } }), 'country', '100.2');
    await flush();
    expect(slackCalls.filter((c) => c[0] === 'views.update')).toHaveLength(3);
  });

  test('picking a time shows whether the chosen Field CTO is free, using the new suggestion when it changes', async () => {
    const B = require('../app/services/fcto/blocks');
    const R = require('../app/services/fcto/reservations');
    const start = Math.floor(Date.now() / 1000) + 2 * 86400;
    const booked = await R.createRequest(internal.store, base({ startTs: start - 1800, durationKey: '1h' }));
    await R.approve(internal.store, booked.id, { by: ADMIN });
    const modal = B.requestModal({ channelId: 'CEXEC' });
    // The view as Slack shows it after the US suggestion (who_ANY_US block) and a manual pick.
    const viewWith = (id, over) => {
      const values = requestValues({ start: { value: { selected_date_time: start } }, ...over });
      values.who_ANY_US = values.who;
      delete values.who;
      return { id, hash: 'h1', callback_id: modal.callback_id, private_metadata: modal.private_metadata, state: { values } };
    };
    const send = async (view, blockId) => {
      const body = blockAction('value', undefined, REQUESTER, { view, actions: [{ action_id: 'value', block_id: blockId, type: 'datetimepicker' }] });
      expect((await post(port, '/slack/fcto/interactions', body, sign('shhh', body))).status).toBe(200);
      await flush();
      return JSON.stringify(slackCalls.filter((c) => c[0] === 'views.update').pop()[2].blocks);
    };

    const mark = await send(viewWith('V10'), 'start');
    expect(mark).toContain(':red_circle: *Mark Porter is already booked then:*');
    expect(mark).toContain(`(${booked.id})`);

    const any = await send(viewWith('V11', { who: { value: { selected_option: { value: 'ANY:US' } } } }), 'start');
    expect(any).toContain(':large_green_circle: *Free then:* Jeff Wang');
    expect(any).toContain(':red_circle: *Booked:* Mark Porter');

    // Country → Japan swaps the select to Akira, so the check is about him, not Mark.
    const akira = await send(viewWith('V12', { country: { value: { selected_option: { value: 'JP' } } } }), 'country');
    expect(akira).toContain(':large_green_circle: *Akira Shibata is free then*');
    expect(akira).not.toContain('Mark Porter is');

    const noWindow = await send(viewWith('V13', { duration: { value: { selected_option: { value: 'custom' } } } }), 'duration');
    expect(noWindow).not.toContain('free then');
  });

  test('"Below" audience is rejected inline; suggested who block is read on submit', async () => {
    const below = submission('fcto_request_submit', requestValues({ audience: { value: { selected_option: { value: 'BELOW' } } } }), { channelId: 'CEXEC' });
    const res = await post(port, '/slack/fcto/interactions', below, sign('shhh', below));
    expect(res.json()).toEqual({ response_action: 'errors', errors: { audience: expect.stringMatching(/Director-level and above/) } });
    expect(internal.store.all()).toHaveLength(0);

    const values = requestValues({ country: { value: { selected_option: { value: 'JP' } } } });
    delete values.who;
    values.who_MEMBER_AKIRA_SHIBATA = { value: { selected_option: { value: 'MEMBER:AKIRA_SHIBATA' } } };
    const ok = submission('fcto_request_submit', values, { channelId: 'CEXEC' });
    expect((await post(port, '/slack/fcto/interactions', ok, sign('shhh', ok))).body).toBe('');
    await flush();
    expect(internal.store.get('FCR-1')).toMatchObject({ requestedKey: 'AKIRA_SHIBATA', audience: 'C_LEVEL', country: 'JP', industry: 'TECH_NATIVE' });
    const posted = slackCalls.find((c) => c[0] === 'chat.postMessage');
    expect(JSON.stringify(posted)).toContain(':crown: C-level   :flag-jp: Japan   :rocket: Tech Native');
  });
});

describe('qualifications', () => {
  const Q = require('../config/fcto-qualifications');

  test('option lists match the requested choices', () => {
    expect(Q.AUDIENCES.map((a) => a.label)).toEqual(['C-level', 'VP', 'Director', 'Below Director']);
    expect(Q.INDUSTRIES.map((i) => i.label)).toEqual(['Finance', 'Tech Native', 'Industrial', 'Healthcare', 'Public Sector', 'Other']);
    expect(Q.COUNTRIES).toHaveLength(21);
    expect(Q.COUNTRIES[Q.COUNTRIES.length - 1].key).toBe('OTHER');
  });

  test.each([
    [{ country: 'JP', industry: 'FINANCE' }, 'MEMBER:AKIRA_SHIBATA'],
    [{ country: 'DE', industry: 'FINANCE' }, 'MEMBER:AMAN_THIND'],
    [{ country: 'GB', industry: 'HEALTHCARE' }, 'MEMBER:KATRIN_LEHMANN'],
    [{ country: 'FR' }, 'MEMBER:KATRIN_LEHMANN'],
    [{ country: 'US', industry: 'FINANCE' }, 'MEMBER:AMAN_THIND'],
    [{ industry: 'FINANCE' }, 'MEMBER:AMAN_THIND'],
    [{ country: 'KR', industry: 'INDUSTRIAL' }, 'MEMBER:AKIRA_SHIBATA'],
    [{ country: 'CA', industry: 'TECH_NATIVE' }, 'ANY:US'],
    [{ country: 'BR' }, 'ANY:US'],
    [{ country: 'SA' }, 'ANY:EU'],
  ])('suggestWho(%o) → %s', (input, who) => {
    expect(Q.suggestWho(input).who).toBe(who);
  });

  test('no suggestion without country/industry signal', () => {
    expect(Q.suggestWho({})).toBeNull();
    expect(Q.suggestWho({ country: 'OTHER', industry: 'OTHER' })).toBeNull();
  });

  test('createRequest requires qualifications and blocks "Below"', async () => {
    const { store, R } = load();
    await expect(R.createRequest(store, base({ audience: 'BELOW' }), { now: NOW })).rejects.toMatchObject({ field: 'audience', code: 'audience_ineligible' });
    await expect(R.createRequest(store, base({ audience: '' }), { now: NOW })).rejects.toMatchObject({ field: 'audience' });
    await expect(R.createRequest(store, base({ country: 'XX' }), { now: NOW })).rejects.toMatchObject({ field: 'country' });
    await expect(R.createRequest(store, base({ industry: undefined }), { now: NOW })).rejects.toMatchObject({ field: 'industry' });
    const r = await R.createRequest(store, base({ audience: 'director', country: 'de', industry: 'finance' }), { now: NOW });
    expect(r).toMatchObject({ audience: 'DIRECTOR', country: 'DE', industry: 'FINANCE' });
    expect(R.qualificationsLabel(r)).toBe('Director · Germany · Finance');
    expect(R.qualificationsLabel({})).toBe('');
  });

  test('assign suggestions put the rule-recommended Field CTO first and preselect them', async () => {
    const { store, R } = load();
    const B = require('../app/services/fcto/blocks');
    const r = await R.createRequest(store, base({ who: 'ANY:EU', country: 'DE', industry: 'FINANCE' }), { now: NOW });
    const list = R.suggestAssignees(store, r);
    expect(list[0]).toMatchObject({ key: 'AMAN_THIND', recommended: true });
    const modal = B.assignModal(store, r);
    const select = modal.blocks.find((b) => b.block_id === 'assignee').element;
    expect(select.initial_option.value).toBe('AMAN_THIND');
    expect(select.options[0].text.text).toContain('recommended');
  });

  test('request modal shows the "Below" warning; card, schedule and ics show qualifications', async () => {
    const { store, R } = load();
    const B = require('../app/services/fcto/blocks');
    const { buildIcs } = require('../app/services/fcto/ics');
    expect(JSON.stringify(B.requestModal({ audience: 'BELOW' }))).toContain('Director-level and above');
    expect(JSON.stringify(B.requestModal({ audience: 'VP' }))).not.toContain('Director-level and above');
    const r = await R.createRequest(store, base({ country: 'JP', industry: 'HEALTHCARE' }), { now: NOW });
    expect(JSON.stringify(B.requestCard(r))).toContain(':briefcase: VP   :flag-jp: Japan   :hospital: Healthcare');
    expect(JSON.stringify(B.scheduleBlocks(store, { from: NOW, to: NOW + 30 * 86400 }))).toContain('VP · Japan · Healthcare');
    expect(buildIcs({ ...r, id: r.id, assigneeKey: 'MARK_PORTER' }, { now: NOW })).toContain('VP · Japan · Healthcare');
  });
});

describe('review fixes', () => {
  test("reassigned reservations leave the original Field CTO's schedule", async () => {
    const { store, R } = load();
    const r = await R.createRequest(store, base(), { now: NOW });
    await R.reassign(store, r.id, { by: ADMIN, assigneeKey: 'AMAN_THIND' });
    expect(R.listReservations(store, { memberKey: 'MARK_PORTER' })).toHaveLength(0);
    expect(R.listReservations(store, { memberKey: 'AMAN_THIND' }).map((x) => x.id)).toEqual([r.id]);
    expect(R.findConflicts(store, 'MARK_PORTER', r.startTs, r.endTs)).toHaveLength(0);
    expect(R.describeWho(store.get(r.id))).toBe('Aman Thind (requested Mark Porter)');
    const any = await R.createRequest(store, base({ who: 'ANY:EU', startTs: NOW + 5 * 86400 }), { now: NOW });
    await R.claim(store, any.id, { by: KATRIN });
    expect(R.describeWho(store.get(any.id))).toBe(`Katrin Lehmann (${R.PREFERENCES.EU})`);
  });

  test('a failed write leaves memory and disk unchanged', async () => {
    const { store, R } = load();
    await R.createRequest(store, base(), { now: NOW });
    const spy = jest.spyOn(fs, 'renameSync').mockImplementationOnce(() => { throw new Error('ENOSPC'); });
    await expect(R.createRequest(store, base({ account: 'Phantom' }), { now: NOW })).rejects.toThrow('ENOSPC');
    spy.mockRestore();
    expect(store.all()).toHaveLength(1);
    expect(JSON.parse(fs.readFileSync(process.env.FCTO_STORE_FILE, 'utf8')).reservations).toHaveLength(1);
    const again = await R.createRequest(store, base({ account: 'Real' }), { now: NOW });
    expect(again.id).toBe('FCR-2');
  });

  test('user text is escaped in cards; meeting links render as bare URLs', async () => {
    const { store, R } = load();
    const B = require('../app/services/fcto/blocks');
    const r = await R.createRequest(store, base({ account: '<!channel> Acme & Co', purpose: 'ping <@U0BT6626DB3>', notes: '<https://evil.example|Join>', meetingLink: 'https://zoom.us/j/1' }), { now: NOW });
    const json = JSON.stringify(B.requestCard(r));
    expect(json).toContain('&lt;!channel&gt; Acme &amp; Co');
    expect(json).toContain('ping &lt;@U0BT6626DB3&gt;');
    expect(json).toContain('&lt;https://evil.example|Join&gt;');
    expect(json).not.toContain('<!channel>');
    expect(json).toContain('<https://zoom.us/j/1>');
    expect(B.threadNote({ ...r, status: 'declined', declineReason: '<!here> no' })).toContain('&lt;!here&gt; no');
    await expect(R.createRequest(store, base({ meetingLink: 'https://evil.example/x|Join Zoom' }), { now: NOW })).rejects.toMatchObject({ code: 'bad_link' });
  });

  test('cards go to the configured channel; unsigned mode is refused in production', () => {
    const saved = { ...process.env };
    process.env.FCTO_CHANNEL_ID = 'CEXEC';
    const { requestChannel, verifySlackSignature } = require('../app/routes/fcto')._internal;
    expect(requestChannel('CPERSONAL')).toBe('CEXEC');
    delete process.env.FCTO_CHANNEL_ID;
    delete process.env.SLACK_CHANNEL_ID;
    expect(requestChannel('CPERSONAL')).toBe('CPERSONAL');

    delete process.env.FCTO_SLACK_SIGNING_SECRET;
    process.env.FCTO_ALLOW_UNSIGNED = '1';
    process.env.NODE_ENV = 'production';
    const res = { status: jest.fn(() => res), send: jest.fn(() => res) };
    const next = jest.fn();
    const local = { headers: {}, socket: { remoteAddress: '127.0.0.1' } };
    verifySlackSignature(local, res, next);
    expect(next).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(503);
    process.env.NODE_ENV = 'test';
    verifySlackSignature({ headers: {}, socket: { remoteAddress: '203.0.113.9' } }, res, next);
    expect(next).not.toHaveBeenCalled();
    verifySlackSignature(local, res, next);
    expect(next).toHaveBeenCalledTimes(1);
    process.env = saved;
  });

  test('a slower earlier Slack update cannot restore a superseded card', async () => {
    const calls = [];
    jest.doMock('../app/services/fcto/slack-client', () => ({
      ...jest.requireActual('../app/services/fcto/slack-client'),
      updateMessage: jest.fn(async (...a) => { calls.push(['chat.update', ...a]); return { ok: true }; }),
      postMessage: jest.fn(async (...a) => { calls.push(['chat.postMessage', ...a]); return { ok: true, ts: '1' }; }),
      uploadFile: jest.fn(async (...a) => { calls.push(['files.upload', ...a]); return { ok: true }; }),
      userInfo: jest.fn(async () => ({ ok: false })),
    }));
    process.env.FCTO_CHANNEL_ID = 'CEXEC';
    const { store, applyChange } = require('../app/routes/fcto')._internal;
    const R = require('../app/services/fcto/reservations');
    const r = await R.createRequest(store, base(), { now: NOW });
    await R.setMessage(store, r.id, 'CEXEC', '1700.1');
    const approved = await R.approve(store, r.id, { by: ADMIN });
    const cancelled = await R.cancel(store, r.id, { by: REQUESTER });
    await Promise.all([applyChange(approved, 'pending'), applyChange(cancelled, 'approved')]);
    expect(calls.filter((c) => c[0] === 'files.upload')).toHaveLength(0);
    const updates = calls.filter((c) => c[0] === 'chat.update');
    expect(updates.length).toBeGreaterThan(0);
    updates.forEach((u) => expect(u[3]).toMatch(/cancelled/i));
    expect(calls.filter((c) => c[0] === 'chat.postMessage')).toHaveLength(1);
    delete process.env.FCTO_CHANNEL_ID;
  });
});

describe('availability', () => {
  const T = Date.UTC(2026, 9, 15, 12) / 1000; // Thu 15 Oct 2026
  const d = (y, m, dd) => Date.UTC(y, m, dd) / 1000;

  test('parseDateRange handles the common spellings', () => {
    const { R } = load();
    expect(R.parseDateRange('oct 22', T)).toEqual({ from: d(2026, 9, 22), to: d(2026, 9, 23) });
    expect(R.parseDateRange('Oct 22-24', T)).toEqual({ from: d(2026, 9, 22), to: d(2026, 9, 25) });
    expect(R.parseDateRange('oct 30 - nov 2', T)).toEqual({ from: d(2026, 9, 30), to: d(2026, 10, 3) });
    expect(R.parseDateRange('2026-11-03..2026-11-05', T)).toEqual({ from: d(2026, 10, 3), to: d(2026, 10, 6) });
    expect(R.parseDateRange('22 oct', T)).toEqual({ from: d(2026, 9, 22), to: d(2026, 9, 23) });
    expect(R.parseDateRange('11/3', T)).toEqual({ from: d(2026, 10, 3), to: d(2026, 10, 4) });
    expect(R.parseDateRange('jan 5', T)).toEqual({ from: d(2027, 0, 5), to: d(2027, 0, 6) });
    expect(R.parseDateRange('tomorrow', T)).toEqual({ from: d(2026, 9, 16), to: d(2026, 9, 17) });
    expect(R.parseDateRange('next week', T)).toEqual({ from: d(2026, 9, 19), to: d(2026, 9, 26) });
    expect(R.parseDateRange('feb 30', T)).toBeNull();
    expect(R.parseDateRange('whenever', T)).toBeNull();
  });

  test('marks free, partly booked and booked days from approved reservations only', async () => {
    const { store, R } = load();
    const oct22 = d(2026, 9, 22);
    await R.createRequest(store, base({ startTs: oct22 + 9 * 3600, durationKey: '2h' }), { now: T }); // Mark, pending
    const b = await R.createRequest(store, base({ startTs: oct22 + 8 * 3600, durationKey: 'full_day', who: 'MEMBER:KATRIN_LEHMANN' }), { now: T });
    await R.approve(store, b.id, { by: ADMIN });
    const c = await R.createRequest(store, base({ startTs: oct22 + 86400 + 10 * 3600, durationKey: '1h', who: 'MEMBER:AMAN_THIND' }), { now: T });
    await R.approve(store, c.id, { by: ADMIN });

    const av = R.availability(store, { from: oct22, to: oct22 + 2 * 86400 });
    const by = Object.fromEntries(av.members.map((m) => [m.member.key, m]));
    expect(av.days).toEqual([oct22, oct22 + 86400]);
    expect(by.MARK_PORTER.days.map((x) => x.status)).toEqual(['free', 'free']);
    expect(by.KATRIN_LEHMANN.days.map((x) => x.status)).toEqual(['booked', 'free']);
    expect(by.AMAN_THIND.days.map((x) => x.status)).toEqual(['free', 'partial']);
    expect(by.AMAN_THIND.days[1].busy[0].id).toBe(c.id);

    const B = require('../app/services/fcto/blocks');
    const blocks = B.availabilityBlocks(store, { from: oct22, to: oct22 + 2 * 86400 });
    const json = JSON.stringify(blocks);
    expect(blocks[0].text.text).toBe("Who's free — Thu, Oct 22 to Fri, Oct 23");
    expect(json).toContain('*Mark Porter* (US) — free all 2 days');
    expect(json).toContain('*Katrin Lehmann* (EU) — 1/2 days free');
    expect(json).toContain(`Fri, Oct 23 (`);
    expect(json).toContain(c.id);
    expect(blocks.findIndex((x) => JSON.stringify(x).includes('Mark Porter'))).toBeLessThan(blocks.findIndex((x) => JSON.stringify(x).includes('Katrin')));
    expect(JSON.stringify(B.homeView(store, REQUESTER))).toContain('Free for the next 7 days');
  });

  test('/fcto free answers with an availability card; unreadable dates get a hint', async () => {
    process.env.FCTO_CHANNEL_ID = 'CEXEC';
    const { handleCommand } = require('../app/routes/fcto')._internal;
    const ok = await handleCommand({ command: '/fcto', text: 'free oct 22-24', user_id: REQUESTER });
    expect(ok.response_type).toBe('ephemeral');
    expect(ok.text).toMatch(/^Who's free — /);
    expect(ok.blocks.length).toBe(8);
    const bad = await handleCommand({ command: '/fcto', text: 'free sometime', user_id: REQUESTER });
    expect(bad.text).toMatch(/couldn't read those dates/);
    expect((await handleCommand({ command: '/fcto', text: 'help', user_id: REQUESTER })).text).toContain('/fcto free');
    delete process.env.FCTO_CHANNEL_ID;
  });
});

describe('availability edge cases', () => {
  const T = Date.UTC(2026, 9, 15, 12) / 1000;
  const d = (y, m, dd) => Date.UTC(y, m, dd) / 1000;

  test('year-crossing and reversed ranges', () => {
    const { R } = load();
    const dec31 = d(2026, 11, 31) + 3600;
    expect(R.parseDateRange('dec 30 - jan 2', dec31)).toEqual({ from: d(2027, 11, 30), to: d(2028, 0, 3) });
    expect(R.parseDateRange('dec 31 - jan 2', dec31)).toEqual({ from: d(2026, 11, 31), to: d(2027, 0, 3) });
    expect(R.parseDateRange('2026-11-05..2026-11-03', T)).toBeNull();
    expect(R.parseDateRange('nov 5 - nov 3, 2026', T)).toBeNull();
  });

  test("days are each Field CTO's local day", async () => {
    const { store, R } = load();
    expect(R.localDayStart(d(2026, 9, 23), 'Asia/Tokyo')).toBe(d(2026, 9, 22) + 15 * 3600);
    expect(R.localDayStart(d(2026, 9, 23), 'America/Los_Angeles')).toBe(d(2026, 9, 23) + 7 * 3600);
    expect(R.localDayStart(d(2026, 10, 2), 'America/Los_Angeles')).toBe(d(2026, 10, 2) + 8 * 3600); // after DST ends
    // 23:00Z Oct 22 = 08:00 JST Oct 23
    const r = await R.createRequest(store, base({ startTs: d(2026, 9, 22) + 23 * 3600, durationKey: '1h', who: 'MEMBER:AKIRA_SHIBATA' }), { now: T });
    await R.approve(store, r.id, { by: ADMIN });
    const pick = (day) => R.availability(store, { from: day, to: day + 86400 }).members.find((m) => m.member.key === 'AKIRA_SHIBATA').days[0].status;
    expect(pick(d(2026, 9, 23))).toBe('partial');
    expect(pick(d(2026, 9, 22))).toBe('free');
    const B = require('../app/services/fcto/blocks');
    const json = JSON.stringify(B.availabilityBlocks(store, { from: d(2026, 9, 23), to: d(2026, 9, 24) }));
    expect(json).toContain(':large_yellow_circle: *Akira Shibata* (Japan / APAC) — partly booked');
    expect(json).toContain("each person's local day");
  });

  test('ranges longer than 31 days are refused with a clear message', async () => {
    process.env.FCTO_CHANNEL_ID = 'CEXEC';
    const { handleCommand } = require('../app/routes/fcto')._internal;
    const res = await handleCommand({ command: '/fcto', text: 'free 2026-10-01 - 2026-12-15', user_id: REQUESTER });
    expect(res.text).toMatch(/up to 31 days/);
    delete process.env.FCTO_CHANNEL_ID;
  });
});

describe('slack design', () => {
  const NOW_D = Math.floor(Date.UTC(2027, 0, 11, 16) / 1000);
  const fresh = () => {
    jest.resetModules();
    const { ReservationStore } = require('../app/services/fcto/store');
    const store = new ReservationStore(path.join(os.tmpdir(), `fcto-design-${Date.now()}-${Math.random()}.json`));
    return { store, R: require('../app/services/fcto/reservations'), B: require('../app/services/fcto/blocks'), avatars: require('../app/services/fcto/avatars') };
  };
  const req = (over = {}) => ({ requesterId: 'UREQUESTER1', account: 'Acme Corp', purpose: 'EBC', audience: 'VP', country: 'DE', industry: 'FINANCE', who: 'MEMBER:MARK_PORTER', startTs: NOW_D + 86400, durationKey: '2h', ...over });

  test('card message puts status in a colored attachment with a progress line', async () => {
    const { store, R, B } = fresh();
    const r = await R.createRequest(store, req(), { now: NOW_D });
    const pending = B.requestCardMessage(r);
    expect(pending.text).toMatch(/^\[Pending\]/);
    expect(pending.attachments[0].color).toBe('#ECB22E');
    expect(JSON.stringify(pending.blocks)).toContain(':briefcase: VP   :flag-de: Germany   :bank: Finance');
    expect(JSON.stringify(pending.attachments[0].blocks)).toContain(':hourglass_flowing_sand: Approval');
    const approved = B.requestCardMessage(await R.approve(store, r.id, { by: 'U053N173C4E' }));
    expect(approved.attachments[0].color).toBe('#2EB67D');
    const cal = approved.attachments[0].blocks.find((b) => b.block_id === `cal_${r.id}`);
    expect(cal.elements.map((e) => e.action_id)).toEqual([B.ACTION.CAL_GOOGLE, B.ACTION.CAL_OUTLOOK]);
    expect(cal.elements[0].url).toMatch(/^https:\/\/calendar\.google\.com\/calendar\/render\?action=TEMPLATE&text=Field%20CTO%3A%20Mark%20Porter/);
    expect(cal.elements[0].url).toContain('dates=20270112T160000Z%2F20270112T180000Z');
    expect(cal.elements[1].url).toContain('startdt=2027-01-12T16%3A00%3A00Z');
    expect(B.threadBlocks(await R.cancel(store, r.id, { by: 'UREQUESTER1' }))).toBeUndefined();
  });

  test('cached Slack photos show on the card and in the free list', async () => {
    const { store, R, B, avatars } = fresh();
    avatars._cache.set('U0BT6626DB3', { url: 'https://example.com/mark.png', at: Date.now() });
    const r = await R.createRequest(store, req(), { now: NOW_D });
    const card = B.requestCard(r);
    expect(card[1].accessory).toEqual({ type: 'image', image_url: 'https://example.com/mark.png', alt_text: 'Mark Porter' });
    const free = B.availabilityBlocks(store, { from: NOW_D, to: NOW_D + 86400 });
    expect(free.find((b) => JSON.stringify(b).includes('Mark Porter')).accessory.image_url).toBe('https://example.com/mark.png');
  });

  test('avatars.warm caches users.info photos and tolerates failures', async () => {
    jest.resetModules();
    const userInfo = jest.fn(async (id) => (id === 'UOK' ? { ok: true, user: { profile: { image_192: 'https://x/192.png' } } } : { ok: false }));
    jest.doMock('../app/services/fcto/slack-client', () => ({ userInfo }));
    const avatars = require('../app/services/fcto/avatars');
    await avatars.warm(['UOK', 'UBAD', 'UOK', '']);
    expect(avatars.get('UOK')).toBe('https://x/192.png');
    expect(avatars.get('UBAD')).toBeNull();
    await avatars.warm(['UOK', 'UBAD']);
    expect(userInfo).toHaveBeenCalledTimes(2);
    jest.dontMock('../app/services/fcto/slack-client');
  });

  test('request modal has section headers and a suggestion callout', () => {
    const { B } = fresh();
    const modal = B.requestModal({ channelId: 'CEXEC', suggestion: { who: 'MEMBER:AKIRA_SHIBATA', reason: 'Japan' } });
    expect(modal.blocks.filter((b) => b.type === 'header').map((b) => b.text.text)).toEqual([':office: The meeting', ":busts_in_silhouette: Who's in the room", ':calendar: When', ':paperclip: Extras']);
    expect(JSON.stringify(modal.blocks)).toContain(':sparkles: *Suggested: Akira Shibata* for Japan');
    expect(JSON.stringify(modal.blocks[0])).toContain('<#CEXEC>');
    const country = modal.blocks.find((b) => b.block_id === 'country').element.options;
    expect(country.find((o) => o.value === 'JP').text.text).toBe(':flag-jp: Japan');
  });

  test('home shows stats, an action queue for admins and a week heatmap', async () => {
    const { store, R, B } = fresh();
    const soon = Math.floor(Date.now() / 1000) + 2 * 86400;
    await R.createRequest(store, req({ startTs: soon }));
    await R.createRequest(store, req({ startTs: soon + 86400, who: 'ANY:EU' }));
    const home = B.homeView(store, 'U053N173C4E');
    const json = JSON.stringify(home);
    expect(json).toContain(':raising_hand: *Waiting on you*\\n2');
    const queue = home.blocks.filter((b) => b.accessory && b.accessory.type === 'button');
    expect(queue.map((b) => b.accessory.action_id)).toEqual([B.ACTION.APPROVE, B.ACTION.ASSIGN]);
    expect(json).toContain(':large_green_square:');
    const stranger = JSON.stringify(B.homeView(store, 'USTRANGER1'));
    expect(stranger).not.toContain('Needs your action');
  });
});

describe('slack design review fixes', () => {
  const NOW_F = Math.floor(Date.UTC(2027, 0, 11, 16) / 1000);
  const fresh = () => {
    jest.resetModules();
    const { ReservationStore } = require('../app/services/fcto/store');
    const store = new ReservationStore(path.join(os.tmpdir(), `fcto-fix-${Date.now()}-${Math.random()}.json`));
    return { store, R: require('../app/services/fcto/reservations'), B: require('../app/services/fcto/blocks'), ics: require('../app/services/fcto/ics') };
  };
  const req = (over = {}) => ({ requesterId: 'UREQUESTER1', account: 'Acme Corp', purpose: 'EBC', audience: 'VP', country: 'JP', industry: 'TECH_NATIVE', who: 'MEMBER:MARK_PORTER', startTs: NOW_F + 86400, durationKey: '2h', ...over });

  test('calendar button URLs stay under Slack\'s 3,000-character limit for max-length multibyte input', async () => {
    const { store, R, ics } = fresh();
    const r = await R.createRequest(store, req({ account: '株'.repeat(150), purpose: '日本語'.repeat(200), notes: '😀'.repeat(500), meetingLink: `https://zoom.us/j/${'9'.repeat(400)}` }), { now: NOW_F });
    const links = ics.calendarLinks(r);
    for (const url of [links.google, links.outlook]) {
      expect(url.length).toBeLessThanOrEqual(ics.MAX_BUTTON_URL);
      expect(() => decodeURIComponent(url)).not.toThrow();
      expect(url).toMatch(/20270112T160000Z|2027-01-12T16%3A00%3A00Z/);
    }
    const mixed = ics.calendarLinks(await R.createRequest(store, req({ purpose: 'a😀'.repeat(250), notes: 'b😀'.repeat(250), meetingLink: 'https://zoom.us/j/1' }), { now: NOW_F }));
    for (const url of [mixed.google, mixed.outlook]) {
      expect(url.length).toBeLessThanOrEqual(ics.MAX_BUTTON_URL);
      expect(url.length).toBeGreaterThan(ics.MAX_BUTTON_URL - 20);
      expect(decodeURIComponent(url)).toContain('location=https://zoom.us/j/1');
      expect(decodeURIComponent(url)).toContain('…');
    }
    const short = ics.calendarLinks(await R.createRequest(store, req({ meetingLink: 'https://zoom.us/j/1' }), { now: NOW_F }));
    expect(decodeURIComponent(short.google)).toContain('Purpose: EBC');
    expect(decodeURIComponent(short.google)).toContain('location=https://zoom.us/j/1');
  });

  test('home action queue skips past requests, prefers the soonest and counts them all', async () => {
    const { store, R, B } = fresh();
    const now = Math.floor(Date.now() / 1000);
    for (let i = 0; i < 3; i += 1) await R.createRequest(store, req({ startTs: now - (10 - i) * 86400 }), { now: now - 20 * 86400 });
    for (let i = 0; i < 7; i += 1) await R.createRequest(store, req({ startTs: now + (i + 1) * 86400 }), { now });
    const home = B.homeView(store, 'U053N173C4E');
    const json = JSON.stringify(home);
    expect(json).toContain(':raising_hand: *Waiting on you*\\n7');
    expect(json).toContain('+2 more waiting on you in the channel');
    const ids = home.blocks.filter((b) => b.accessory && b.accessory.type === 'button').map((b) => b.accessory.value);
    expect(ids).toEqual(['FCR-4', 'FCR-5', 'FCR-6', 'FCR-7', 'FCR-8']);
  });
});

describe('request form availability', () => {
  test('requestWindow follows the duration and rejects incomplete picks', () => {
    const { R } = load();
    expect(R.requestWindow({ startTs: NOW, durationKey: '90m' })).toEqual({ startTs: NOW, endTs: NOW + 5400 });
    expect(R.requestWindow({ startTs: NOW, durationKey: 'custom', endTs: NOW + 7200 })).toEqual({ startTs: NOW, endTs: NOW + 7200 });
    expect(R.requestWindow({ startTs: NOW, durationKey: 'custom' })).toBeNull();
    expect(R.requestWindow({ startTs: NOW, durationKey: 'custom', endTs: NOW - 1 })).toBeNull();
    expect(R.requestWindow({ durationKey: '1h' })).toBeNull();
    expect(R.requestWindow({ startTs: NOW })).toBeNull();
  });

  test('whoIsFree checks one member or a regional pool against approved bookings only', async () => {
    const { store, R } = load();
    const start = NOW + 3 * 86400;
    const pending = await R.createRequest(store, base({ startTs: start, who: 'MEMBER:KATRIN_LEHMANN' }), { now: NOW });
    const approved = await R.createRequest(store, base({ startTs: start }), { now: NOW });
    await R.approve(store, approved.id, { by: ADMIN });
    const window = { startTs: start + 3600, endTs: start + 5400 };
    const mark = R.whoIsFree(store, { who: 'MEMBER:MARK_PORTER', ...window });
    expect(mark.map((r) => [r.member.key, r.conflicts.map((c) => c.id)])).toEqual([['MARK_PORTER', [approved.id]]]);
    expect(R.whoIsFree(store, { who: 'MEMBER:KATRIN_LEHMANN', ...window })[0].conflicts).toEqual([]);
    expect(pending.status).toBe('pending');
    expect(R.whoIsFree(store, { who: 'ANY:US', ...window }).map((r) => r.member.key)).toEqual(['JEFF_WANG', 'MARK_PORTER']);
    expect(R.whoIsFree(store, { who: 'ANY:ANY', ...window })).toHaveLength(6);
    expect(R.whoIsFree(store, { who: 'MEMBER:AKIRA_SHIBATA', startTs: start + 7200, endTs: start + 9000 })[0].conflicts).toEqual([]);
    expect(R.whoIsFree(store, { who: '', ...window })).toBeNull();
    expect(R.whoIsFree(store, { who: 'ANY:MARS', ...window })).toBeNull();
  });

  test('request modal renders the free/booked callout and dispatches on who and time picks', async () => {
    const { store, R } = load();
    const B = require('../app/services/fcto/blocks');
    const start = NOW + 3 * 86400;
    const approved = await R.createRequest(store, base({ startTs: start }), { now: NOW });
    await R.approve(store, approved.id, { by: ADMIN });
    const check = (who) => ({ who, startTs: start, endTs: start + 3600, results: R.whoIsFree(store, { who, startTs: start, endTs: start + 3600 }) });
    const modal = B.requestModal({ channelId: 'CEXEC', availability: check('MEMBER:MARK_PORTER') });
    const json = JSON.stringify(modal.blocks);
    expect(json).toContain(':red_circle: *Mark Porter is already booked then:*');
    expect(json).toContain('not personal calendars');
    const ids = modal.blocks.map((b) => b.block_id);
    expect(ids.indexOf('end')).toBeLessThan(modal.blocks.findIndex((b) => JSON.stringify(b).includes('already booked')));
    ['who', 'start', 'duration', 'end', 'audience', 'country', 'industry'].forEach((id) => {
      expect(modal.blocks.find((b) => b.block_id === id).dispatch_action).toBe(true);
    });
    expect(JSON.stringify(B.requestModal({ availability: check('MEMBER:KATRIN_LEHMANN') }).blocks)).toContain(':large_green_circle: *Katrin Lehmann is free then*');
    const eu = JSON.stringify(B.requestModal({ availability: check('ANY:EU') }).blocks);
    expect(eu).toContain(':large_green_circle: *Free then:* Aman Thind, Katrin Lehmann, Narry Singh');
    const us = JSON.stringify(B.requestModal({ availability: check('ANY:US') }).blocks);
    expect(us).toContain(':red_circle: *Booked:* Mark Porter');
    expect(JSON.stringify(B.requestModal({}).blocks)).not.toContain('free then');
  });
});
