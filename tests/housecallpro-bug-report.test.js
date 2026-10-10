jest.mock('axios', () => ({ post: jest.fn() }));

const express = require('express');
const http = require('http');
const axios = require('axios');
const { APP_SOURCE, BUG_REPORT_PATH, buildIntakeMessage, normalizeReport } = require('../app/services/verticals/housecallpro');
const router = require('../app/routes/verticals/housecallpro');

const REPORT = {
  source: APP_SOURCE,
  reporter: 'Alex Rivera (Technician)',
  summary: "Can't collect payment on job #1042 — invoice total fails",
  description: 'Collect payment shows an error for this job.',
  screen: 'Collect payment',
  jobId: '1042',
  customer: 'Maria Gonzalez',
  serviceZip: '78681',
  errorCode: 'HCP-PAY-4041',
  errorMessage: 'Tax jurisdiction not found for ZIP 78681',
  stepsToReproduce: ['Open job #1042', 'Tap Collect payment'],
};

function request(server, body) {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify(body);
    const req = http.request(
      { host: '127.0.0.1', port: server.address().port, path: BUG_REPORT_PATH, method: 'POST', headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) } },
      (res) => {
        let raw = '';
        res.on('data', (c) => { raw += c; });
        res.on('end', () => resolve({ status: res.statusCode, body: JSON.parse(raw) }));
      },
    );
    req.on('error', reject);
    req.end(data);
  });
}

describe('Housecall Pro bug report intake', () => {
  let server;
  const savedEnv = { ...process.env };

  beforeAll((done) => {
    const app = express();
    app.use(express.json());
    app.use(router);
    server = app.listen(0, () => done());
  });
  afterAll((done) => { server.close(() => done()); });
  beforeEach(() => {
    router._resetReportCap();
    axios.post.mockReset();
    process.env = { ...savedEnv, SLACK_ONCALL_BOT_TOKEN: 'xoxb-test' };
    delete process.env.HCP_SLACK_INTAKE_CHANNEL;
    delete process.env.HCP_SLACK_BOT_TOKEN;
  });
  afterEach(() => { process.env = savedEnv; });

  test('posts the report to #hcp-bug-intake and returns a reference', async () => {
    axios.post.mockResolvedValue({ data: { ok: true, ts: '1.2', channel: 'C123' } });
    const res = await request(server, REPORT);
    expect(res.status).toBe(202);
    expect(res.body).toMatchObject({ received: true, status: 'posted', channel: '#hcp-bug-intake' });
    expect(res.body.reference).toMatch(/^HCP-BUG-[0-9A-F]{4}$/);
    const [url, payload, opts] = axios.post.mock.calls[0];
    expect(url).toBe('https://slack.com/api/chat.postMessage');
    expect(payload.channel).toBe('#hcp-bug-intake');
    expect(payload.text).toContain('HCP-PAY-4041');
    expect(payload.text).toContain('#1042 — Maria Gonzalez');
    expect(opts.headers.Authorization).toBe('Bearer xoxb-test');
  });

  test('honors HCP_SLACK_INTAKE_CHANNEL', async () => {
    process.env.HCP_SLACK_INTAKE_CHANNEL = 'C0TEST';
    axios.post.mockResolvedValue({ data: { ok: true, ts: '1.2', channel: 'C0TEST' } });
    await request(server, REPORT);
    expect(axios.post.mock.calls[0][1].channel).toBe('C0TEST');
  });

  test('rejects payloads from other sources', async () => {
    const res = await request(server, { ...REPORT, source: 'web' });
    expect(res.status).toBe(400);
    expect(axios.post).not.toHaveBeenCalled();
  });

  test('fails instead of acknowledging when Slack is not configured', async () => {
    delete process.env.SLACK_ONCALL_BOT_TOKEN;
    delete process.env.SLACK_BOT_TOKEN;
    const res = await request(server, REPORT);
    expect(res.status).toBe(502);
    expect(res.body.received).toBe(false);
    expect(axios.post).not.toHaveBeenCalled();
  });

  test('failed deliveries do not consume the report cap', async () => {
    axios.post.mockResolvedValue({ data: { ok: false, error: 'channel_not_found' } });
    for (let i = 0; i < 12; i += 1) {
      // eslint-disable-next-line no-await-in-loop
      expect((await request(server, REPORT)).status).toBe(502);
    }
    axios.post.mockResolvedValue({ data: { ok: true, ts: '1.2', channel: 'C123' } });
    expect((await request(server, REPORT)).status).toBe(202);
  });

  test('returns 502 when Slack rejects the post', async () => {
    axios.post.mockResolvedValue({ data: { ok: false, error: 'channel_not_found' } });
    const res = await request(server, REPORT);
    expect(res.status).toBe(502);
  });

  test('strips Slack control characters from user text', () => {
    const msg = buildIntakeMessage(normalizeReport({ ...REPORT, summary: '<!channel> boom @here @Everyone' }), 'HCP-BUG-0001');
    expect(msg).not.toContain('<!channel>');
    expect(msg).not.toMatch(/@(channel|here|everyone)/i);
    expect(normalizeReport({ ...REPORT, reporter: 'tech@here.com' }).reporter).toBe('tech@here.com');
  });
});
