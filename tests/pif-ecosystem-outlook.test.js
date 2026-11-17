jest.mock('../app/services/devin-api', () => ({ createDevinSession: jest.fn().mockResolvedValue({ sessionId: 'devin-test', url: 'https://app.devin.ai/sessions/test' }) }));

const http = require('http');
const express = require('express');

const pif = require('../app/services/verticals/23d790a9');
const router = require('../app/routes/verticals/23d790a9');

let server;
let baseUrl;

function call(method, urlPath, { body, cookie } = {}) {
  return new Promise((resolve, reject) => {
    const data = body ? JSON.stringify(body) : null;
    const req = http.request(`${baseUrl}${urlPath}`, {
      method,
      headers: { 'Content-Type': 'application/json', ...(cookie ? { Cookie: cookie } : {}) },
    }, (res) => {
      let raw = '';
      res.on('data', (c) => { raw += c; });
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: raw ? JSON.parse(raw) : null }));
    });
    req.on('error', reject);
    if (data) req.write(data);
    req.end();
  });
}

const CODE = '5150';

async function unlock(code = CODE) {
  const r = await call('POST', '/api/23d790a9/access', { body: { code } });
  return { status: r.status, cookie: (r.headers['set-cookie'] || [''])[0].split(';')[0] };
}

beforeAll((done) => {
  const app = express();
  app.use(express.json());
  app.use(router);
  server = http.createServer(app);
  server.listen(0, () => { baseUrl = `http://127.0.0.1:${server.address().port}`; done(); });
});

afterAll((done) => { server.close(done); });

describe('PIF Ecosystem Outlook PoC', () => {
  beforeEach(() => {
    delete process.env.OPENAI_API_KEY;
    delete process.env.FIREWORKS_API_KEY;
    process.env.PIF_ACCESS_CODE = CODE;
  });

  test('APIs require the access code', async () => {
    expect((await call('GET', '/api/23d790a9/outlook')).status).toBe(401);
    expect((await unlock('0000')).status).toBe(401);
    const { cookie } = await unlock();
    const r = await call('GET', '/api/23d790a9/outlook', { cookie });
    expect(r.status).toBe(200);
    expect(r.body.ecosystems).toHaveLength(6);
  });

  test('without PIF_ACCESS_CODE only the hashed shared code unlocks', async () => {
    delete process.env.PIF_ACCESS_CODE;
    expect((await unlock('')).status).toBe(401);
    expect((await unlock(CODE)).status).toBe(401);
    expect(await pif.codeMatches('undefined')).toBe(false);
  });

  test('exactly one ecosystem is above its illustrative band', () => {
    const above = pif.outlook().ecosystems.filter((e) => e.status === 'above');
    expect(above.map((e) => e.id)).toEqual(['ami']);
  });

  test('consistency check flags outdated figures and accepts current ones', () => {
    const r = pif.checkCommunication('Today PIF manages more than $925 billion in assets, and since 2017 we have delivered an annualized total shareholder return of over 7%. Since 2021 we have invested more than $199 billion in new projects in the Kingdom. Under our new five-ecosystem model, we will continue to crowd in private capital.');
    const byMetric = Object.fromEntries(r.findings.map((f) => [f.metric, f.status]));
    expect(byMetric).toEqual({ aum: 'issue', tsr: 'issue', newProjects: 'consistent', ecosystems: 'issue' });
    const ok = pif.checkCommunication('PIF manages more than $900 billion in assets across six ecosystems, with revenue of $120 billion in 2025.');
    expect(ok.summary.issues).toBe(0);
  });

  test('consistency check lists figures with no public source', () => {
    const r = pif.checkCommunication('We expect 40% growth in tourism visitors.');
    expect(r.unverified.map((u) => u.figure)).toEqual(['40%']);
  });

  test('research answers cite library passages without a language model', async () => {
    const r = await pif.ask('How is HUMAIN being financed?');
    expect(r.mode).toBe('extractive');
    expect(r.sources.length).toBeGreaterThan(0);
    expect(r.answer).toMatch(/\[\d\]/);
    expect(r.ecosystem).toBe('Advanced Manufacturing & Innovation');
    expect(r.focus.ecosystem).toBe('ami');
    expect(r.focus.themes).toContain('capital');
    expect(r.focus.cells.find((c) => c.theme === 'capital').studies).toBeGreaterThan(0);
    expect(Object.keys(r.focus.cited).length).toBeGreaterThan(0);
    expect(r.focus.citedDocs.length).toBeGreaterThan(0);
    const citedRefs = new Set([...r.answer.matchAll(/\[(\d+)\]/g)].map((m) => Number(m[1])));
    const citedDocs = new Set(r.sources.filter((_s, i) => citedRefs.has(i + 1)).map((s) => s.doc.id));
    const cov = pif.coverage();
    for (const key of Object.keys(r.focus.cited)) {
      const [e, t] = key.split(':');
      expect(cov[e][t].some((id) => citedDocs.has(id))).toBe(true);
    }
  });

  test('named ecosystems win over generic topic keywords', () => {
    expect(pif.detectEcosystem('AI financing in NEOM').id).toBe('neom');
    expect(pif.detectEcosystem('ما الذي درسناه عن نيوم؟').id).toBe('neom');
    expect(pif.detectEcosystem('السياحة في نيوم').id).toBe('neom');
    expect(pif.detectEcosystem('ما هي توقعات السياحة؟').id).toBe('tte');
    expect(pif.detectEcosystem('compute capacity outlook').id).toBe('ami');
  });

  test('question focus changes with the question', async () => {
    expect(pif.detectThemes('What talent gaps exist in tourism?')).toEqual(['talent']);
    const r = await pif.ask('What have we studied on talent in NEOM?');
    expect(r.focus.ecosystem).toBe('neom');
    expect(r.focus.cells).toEqual([{ ecosystem: 'neom', theme: 'talent', studies: 0 }]);
  });

  test('trends rank by ecosystem and the brief is available in Arabic', () => {
    const ami = pif.rankTrends('ami');
    expect(ami.every((t) => t.ecosystems.includes('ami'))).toBe(true);
    const brief = pif.trendsBrief('ami', 'ar');
    expect(brief.dir).toBe('rtl');
    expect(brief.items[0].title).toMatch(/[\u0600-\u06FF]/);
  });

  test('trends carry a priority, an owner and a recommended action', () => {
    const all = pif.rankTrends(null, new Date('2026-11-17T00:00:00Z'));
    expect(all.every((t) => ['act', 'watch', 'note'].includes(t.priority) && t.owner && t.action)).toBe(true);
    const nebius = all.find((t) => t.id === 'nebius-oxagon');
    expect(nebius.priority).toBe('act');
    expect(all.find((t) => t.id === 'nbim-ai-productivity').priority).toBe('note');
    const stats = pif.trendsStats(null, 'en', new Date('2026-11-17T00:00:00Z'));
    expect(stats.topCompany).toBe('HUMAIN');
    expect(stats.gaps.map((g) => g.id)).toEqual(expect.arrayContaining(['tte', 'neom']));
    expect(stats.gaps.map((g) => g.id)).not.toContain('ami');
  });

  test('summary falls back to plain takeaways and the brief lists actions', async () => {
    const s = await pif.trendsSummary('neom', 'en', new Date('2026-11-17T00:00:00Z'));
    expect(s.takeaways.length).toBeGreaterThanOrEqual(2);
    expect(s.takeaways.join(' ')).toMatch(/NEOM/);
    const brief = pif.trendsBrief(null, 'en', new Date('2026-11-17T00:00:00Z'));
    expect(brief.items[0].priority).toBe('act');
    expect(brief.items[0].action).toBeTruthy();
  });

  test('live scan keeps trusted, AI-related, portfolio items and drops duplicates', async () => {
    const rss = (items) => `<rss><channel>${items.map(([title, src, url, date]) => `<item><title>${title} - ${src}</title><link>https://news.example/${encodeURIComponent(title)}</link><pubDate>${date}</pubDate><source url="${url}">${src}</source></item>`).join('')}</channel></rss>`;
    const xml = rss([
      ['Riyadh Air picks an AI copilot for crew scheduling', 'Arab News', 'https://www.arabnews.com', 'Mon, 16 Nov 2026 08:00:00 GMT'],
      ['Riyadh Air picks AI copilot for crew scheduling', 'Zawya', 'https://www.zawya.com', 'Mon, 16 Nov 2026 09:00:00 GMT'],
      ['Humain raises $667m for AI buildout in Saudi Arabia', 'Data Center Dynamics', 'https://www.datacenterdynamics.com', 'Sat, 14 Nov 2026 07:00:00 GMT'],
      ['Qiddiya launches AI ticketing', 'Some Blog', 'https://blog.example.com', 'Sun, 15 Nov 2026 07:00:00 GMT'],
      ['ROSHN opens a new community', 'Arab News', 'https://www.arabnews.com', 'Sun, 15 Nov 2026 07:00:00 GMT'],
    ]);
    expect(pif.parseRss(xml)[0]).toMatchObject({ title: 'Riyadh Air picks an AI copilot for crew scheduling', source: 'Arab News' });
    const scan = await pif.scanTrends({ force: true, fetcher: async () => pif.parseRss(xml) });
    expect(scan).toMatchObject({ ok: true, added: 1 });
    const live = pif.rankTrends('tte').filter((t) => t.live);
    expect(live).toHaveLength(1);
    expect(live[0]).toMatchObject({ companies: ['Riyadh Air'], priority: 'watch', ai: false });
    expect(live[0].action).toMatch(/Tourism/);
  });

  test('live scan keeps distinct same-year stories and never re-adds stories it has seen', async () => {
    const rss = (items) => `<rss><channel>${items.map(([title, date]) => `<item><title>${title} - Arab News</title><link>https://news.example/${encodeURIComponent(title)}</link><pubDate>${date}</pubDate><source url="https://www.arabnews.com">Arab News</source></item>`).join('')}</channel></rss>`;
    const d = 'Mon, 16 Nov 2026 08:00:00 GMT';
    const year = await pif.scanTrends({ force: true, fetcher: async () => pif.parseRss(rss([
      ['HUMAIN launches 2026 AI graduate training programme', d],
      ['HUMAIN secures chip export approval for 2026', d],
    ])) });
    expect(year.added).toBe(2);
    const cos = ['ACWA Power', 'Riyadh Air', 'Qiddiya', 'ROSHN', 'Red Sea Global', 'NEOM', 'Alat', 'Ceer', 'Lifera', 'Bahri'];
    const verbs = ['pilots', 'unveils', 'tests', 'rolls out', 'trials', 'debuts', 'adopts', 'licenses', 'acquires', 'builds'];
    const nouns = ['grid forecasting', 'cabin assistants', 'ride analytics', 'housing permits', 'reef monitoring', 'port robotics', 'factory vision', 'battery diagnostics', 'blood screening', 'tanker routing'];
    const feed = pif.parseRss(rss(cos.map((c, i) => [`${c} ${verbs[i]} ${nouns[i]} AI`, d])));
    const added = [];
    for (let i = 0; i < 5; i += 1) added.push((await pif.scanTrends({ force: true, fetcher: async () => feed })).added);
    expect(added.reduce((a, b) => a + b, 0)).toBeLessThanOrEqual(cos.length);
    expect(added[added.length - 1]).toBe(0);
    expect(added[added.length - 2]).toBe(0);
  });

  test('unknown ecosystem filters fall back to all ecosystems', async () => {
    expect(() => pif.trendsStats('unknown')).not.toThrow();
    await expect(pif.trendsSummary('unknown')).resolves.toHaveProperty('takeaways');
    const res = await call('GET', '/api/23d790a9/trends?ecosystem=unknown', { cookie: (await unlock()).cookie });
    expect(res.status).toBe(200);
  });
});

describe('PIF consistency check edge cases', () => {
  test('understated qualifiers are not approved', () => {
    const r = pif.checkCommunication('We invested less than $199 billion in new projects.');
    expect(r.findings[0]).toMatchObject({ metric: 'newProjects', status: 'issue', kind: 'Understates published figure' });
  });

  test('local share only matches investment claims', () => {
    expect(pif.checkCommunication('76% of revenue is local.').findings).toHaveLength(0);
    expect(pif.checkCommunication('76% of our investments are local.').findings[0]).toMatchObject({ metric: 'localShare', status: 'consistent' });
  });
});

describe('PIF understatement qualifiers', () => {
  test('lower bounds and other clauses are not treated as understatements', () => {
    expect(pif.checkCommunication('We invested no less than $199 billion in new projects.').findings[0].status).toBe('consistent');
    const r = pif.checkCommunication('Under $1bn went to grants; revenue of $120 billion.');
    expect(r.findings.find((f) => f.metric === 'revenue').status).toBe('consistent');
  });
});
