const express = require('express');
const http = require('http');

const oncallRoutes = require('../app/routes/oncall');
const { getOncallSkin } = require('../config/oncall-skins');

let server;
let baseUrl;

beforeAll((done) => {
  const app = express();
  app.use(oncallRoutes);
  server = http.createServer(app);
  server.listen(0, () => {
    baseUrl = `http://127.0.0.1:${server.address().port}`;
    done();
  });
});

afterAll((done) => {
  server.close(done);
});

describe('accounts dashboard on-call skin (8f167941)', () => {
  test('is a native banking skin with its own page', () => {
    const skin = getOncallSkin('8f167941');
    expect(skin).toBeTruthy();
    expect(skin.vertical).toBe('banking');
    expect(skin.oncallOnly).toBe(true);
    expect(skin.page.file).toBe('8f167941.html');
  });

  test('skin URL, direct slug and friendly path serve the same shimmed page', async () => {
    const responses = await Promise.all([
      fetch(`${baseUrl}/oncall/c/8f167941`),
      fetch(`${baseUrl}/8f167941`),
      fetch(`${baseUrl}/bofa-oncall`),
    ]);
    responses.forEach((r) => expect(r.status).toBe(200));
    const [skinned, direct, friendly] = await Promise.all(responses.map((r) => r.text()));
    expect(direct).toEqual(skinned);
    expect(friendly).toEqual(skinned);
    expect(skinned).toContain('<title>Accounts Overview | Bank of America</title>');
    expect(skinned).toContain('/api/oncall/banking/transfer');
    expect(skinned).toContain('NOT ACTUALLY A BANK OF AMERICA SITE');
  });

  test('the Make a payment form posts a non-premium transfer through the legacy path the shim reroutes', async () => {
    const html = await (await fetch(`${baseUrl}/oncall/c/8f167941`)).text();
    expect(html).toContain('id="openPayBtn"');
    expect(html).toContain("fetch('/api/banking/transfer'");
    expect(html).not.toContain('data-tier="premium"');
  });
});
