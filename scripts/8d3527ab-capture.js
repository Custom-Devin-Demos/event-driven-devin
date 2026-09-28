/* global fetch, URLSearchParams */
/**
 * Regenerates the static Cummins OneMarket storefront served at /cummins
 * (app/public/verticals/8d3527ab.html + app/public/verticals/8d3527ab/).
 *
 * Crawls a running copy of the CloudCraze recreation in COG-GTM/salesforce-base
 * (branch `cummins`, `cd runtime && PORT=3300 npm run up`) as a guest, as a
 * Canada-store guest, and as the dealer demo user, then rewrites links so the
 * pages browse each other without the Salesforce runtime behind them.
 *
 *   CMI_BASE=http://localhost:3300 node scripts/8d3527ab-capture.js
 */
const fs = require('fs');
const path = require('path');

const BASE = process.env.CMI_BASE || 'http://localhost:3300';
const SLUG = '8d3527ab';
const OUT = process.argv[2] || path.join(__dirname, '..', 'app', 'public', 'verticals', SLUG);
const PUB = `/verticals/${SLUG}`;
const ASSET_PREFIXES = ['/resource/', '/media/', '/vendor/', '/img/'];

class Client {
  constructor() { this.cookie = ''; }
  async req(url, opts = {}) {
    const headers = { ...(opts.headers || {}) };
    if (this.cookie) headers.cookie = this.cookie;
    let body;
    if (opts.form) {
      body = new URLSearchParams(opts.form).toString();
      headers['content-type'] = 'application/x-www-form-urlencoded';
    }
    const res = await fetch(BASE + url, { method: opts.form ? 'POST' : 'GET', headers, body, redirect: 'manual' });
    const sc = res.headers.get('set-cookie');
    if (sc) this.cookie = sc.split(';')[0];
    if (res.status >= 300 && res.status < 400) return this.req(res.headers.get('location'));
    if (res.status !== 200) throw new Error(`${url} -> ${res.status}`);
    return res.text();
  }
}

const decode = (s) => s.replace(/&amp;/g, '&').replace(/&#x3D;/g, '=');
function parse(u) {
  const url = new URL(decode(u), BASE);
  return { path: url.pathname.replace(/^\/(apex|CMIStore)\//, '/'), q: url.searchParams };
}

const pages = {}; // state -> key -> html
const assets = new Set();

function pageKey(u) {
  const { path: p, q } = parse(u);
  if (p === '/' || p === '/ccrz__HomePage') return 'home';
  if (p === '/ccrz__Products' || p === '/ccrz__ProductList') return q.get('categoryId') ? `category-${q.get('categoryId')}` : null;
  if (p === '/ccrz__ProductDetails') return q.get('sku') ? `product-${q.get('sku')}` : null;
  if (p === '/ccrz__Cart') return 'cart';
  if (p === '/ccrz__Checkout') return 'checkout';
  if (p === '/ccrz__OrderConfirmation') return 'order-confirmation';
  if (p === '/ccrz__OrderView') return 'order-confirmation';
  if (p === '/ccrz__MyAccount') return 'my-account';
  if (p === '/Cummins_Login' || p === '/ccrz__CCSiteLogin' || p === '/ccrz__CCSiteRegister') return 'login';
  if (p === '/Cummins_Logout') return 'logout';
  return null;
}

function pageLinks(html) {
  const out = new Set();
  for (const m of html.matchAll(/href="(\/[^"#]*)"/g)) {
    const k = pageKey(m[1]);
    if (k && /^(category|product)-/.test(k)) out.add(decode(m[1]));
  }
  return [...out];
}

async function crawl(client, state, seeds, extra = []) {
  pages[state] = pages[state] || {};
  const queue = [...seeds];
  const seen = new Set();
  while (queue.length) {
    const u = queue.shift();
    const k = pageKey(u);
    if (!k || seen.has(k)) continue;
    seen.add(k);
    const html = await client.req(u);
    pages[state][k] = html;
    if (k === 'home' || k.startsWith('category-')) queue.push(...pageLinks(html));
  }
  for (const [k, u, form] of extra) pages[state][k] = await client.req(u, form ? { form } : {});
}

function pageUrl(state, key) {
  if (state === 'guest' && key === 'home') return `/${SLUG}`;
  return `${PUB}/pages/${state}/${key}.html`;
}

function resolvePage(state, u, isForm) {
  let k = pageKey(u);
  const { q } = parse(u);
  if (k === 'logout') return pageUrl('guest', 'home');
  if (k === 'login') {
    if (isForm) return pageUrl('dealer', 'home');
    return pageUrl(state === 'ca' ? 'guest' : state, 'login') === pageUrl('dealer', 'login') ? pageUrl('guest', 'login') : pageUrl('guest', 'login');
  }
  let target = state;
  if (q.get('store') === 'CA') target = 'ca';
  if (q.get('store') === 'US') target = state === 'ca' ? 'guest' : state;
  if (k && ['cart', 'checkout', 'order-confirmation', 'my-account'].includes(k)) {
    if (target !== 'dealer') return pageUrl('guest', 'login');
    if (k === 'checkout' && isForm) k = 'order-confirmation';
  }
  if (!k || !pages[target][k]) {
    if (k && k.startsWith('product-') && pages[target]['product-DEOK-B-5']) k = 'product-DEOK-B-5';
    else if (k && !pages[target][k]) k = 'home';
  }
  return k ? pageUrl(target, k) : null;
}

function rewrite(state, key, html) {
  const assetUrl = (u) => {
    const clean = decode(u).split(/[?#]/)[0];
    assets.add(clean);
    return PUB + clean;
  };
  html = html.replace(/<link[^>]*\/vendor\/font-awesome[^>]*>\n?/g, '');
  html = html.replace(/\s*<div class="cc_demo_users">[\s\S]*?<\/ul>\s*<\/div>/, '');
  html = html.replace(/(<input[^>]*?) name="password"/g, '$1');
  html = html.replace(/(src|href|action)="(\/[^"]*)"/g, (m, attr, u) => {
    if (ASSET_PREFIXES.some((p) => u.startsWith(p))) return `${attr}="${assetUrl(u)}"`;
    const target = resolvePage(state, u, attr === 'action');
    return `${attr}="${target || '#'}"`;
  });
  html = html.replace(/url\((['"]?)(\/(?:resource|media|img|vendor)\/[^'")]+)\1\)/g, (m, qt, u) => `url(${qt}${assetUrl(u)}${qt})`);
  html = html.replace(/<form([^>]*?)method="post"/gi, '<form$1method="get"');
  html = html.replace(/"themeBaseURL":"\/resource\//, `"themeBaseURL":"${PUB}/resource/`);
  const alt = {
    US: resolvePage(state === 'ca' ? 'guest' : state, `/ccrz__HomePage?store=US`),
    CA: pages.ca[key] ? pageUrl('ca', key) : pageUrl('ca', 'home'),
  };
  if (state === 'ca') alt.US = pages.guest[key] ? pageUrl('guest', key) : pageUrl('guest', 'home');
  const shim = `<script>(function(p){window.getRemoteContact=function(){window.location.href=p.US;};window.getRemoteContactCA=function(){window.location.href=p.CA;};}(${JSON.stringify(alt)}));</script>`;
  html = html.replace(/(<script src="[^"]*cc_globalstore\.js"><\/script>)/, `$1\n${shim}`);
  return html;
}

(async () => {
  const guest = new Client();
  await crawl(guest, 'guest', ['/ccrz__HomePage?cclcl=en_US'], [['login', '/Cummins_Login?cclcl=en_US']]);

  const ca = new Client();
  await ca.req('/ccrz__HomePage?cclcl=en_US&store=CA');
  await crawl(ca, 'ca', ['/ccrz__HomePage?cclcl=en_US']);

  const dealer = new Client();
  await dealer.req('/Cummins_Login?cclcl=en_US');
  await dealer.req('/Cummins_Login', { form: { username: process.env.CMI_USER || 'dealer@demo.cummins', password: 'demo1234' } });
  await crawl(dealer, 'dealer', ['/ccrz__HomePage?cclcl=en_US']);
  const sku = process.env.CMI_CART_SKU || 'DEOK-B-5';
  await dealer.req('/ccrz__Cart', { form: { action: 'add', sku, quantity: '1' } });
  pages.dealer.cart = await dealer.req('/ccrz__Cart?cclcl=en_US');
  pages.dealer.checkout = await dealer.req('/ccrz__Checkout?cclcl=en_US');
  pages.dealer['order-confirmation'] = await dealer.req('/ccrz__Checkout', { form: {
    action: 'placeOrder', shipFirstName: 'Marco', shipLastName: 'Ibarra',
    shipCompany: 'Cummins Sales and Service - Indianapolis', shipStreet: '3621 W Morris St',
    shipCity: 'Indianapolis', shipState: 'IN', shipPostal: '46241', shipCountry: 'US',
    shipMethod: 'Ground', poNumber: 'PO-44817', paymentType: 'po',
  } });
  pages.dealer['my-account'] = await dealer.req('/ccrz__MyAccount?cclcl=en_US');

  fs.rmSync(path.join(OUT, 'pages'), { recursive: true, force: true });
  for (const [state, byKey] of Object.entries(pages)) {
    for (const [key, html] of Object.entries(byKey)) {
      const out = rewrite(state, key, html);
      if (state === 'guest' && key === 'home') {
        fs.writeFileSync(path.join(OUT, '..', `${SLUG}.html`), out);
        continue;
      }
      const file = path.join(OUT, 'pages', state, `${key}.html`);
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, out);
    }
  }
  const queue = [...assets];
  const done = new Set();
  while (queue.length) {
    const a = queue.shift();
    if (done.has(a)) continue;
    done.add(a);
    const res = await fetch(BASE + a);
    if (res.status === 404 && a.startsWith('/resource/CC_Theme_SWStore/css3/') && a.endsWith('.ttf')) {
      const src = a.replace('/css3/', '/fonts/');
      const r2 = await fetch(BASE + src);
      if (r2.status === 200) {
        const f = path.join(OUT, a);
        fs.mkdirSync(path.dirname(f), { recursive: true });
        fs.writeFileSync(f, Buffer.from(await r2.arrayBuffer()));
        continue;
      }
    }
    if (res.status !== 200) { console.warn('missing asset', a, res.status); continue; }
    const buf = Buffer.from(await res.arrayBuffer());
    let file = path.join(OUT, a);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    if (a.endsWith('.css')) {
      let css = buf.toString('utf8');
      css = css.replace(/@import\s+(['"])([^'"]+)\1/g, (m, qt, u) => {
        const abs = new URL(u, BASE + a).pathname;
        if (!assets.has(abs)) { assets.add(abs); queue.push(abs); }
        return m;
      });
      css = css.replace(/url\((['"]?)([^'")]+)\1\)/g, (m, qt, u) => {
        if (/^(data:|https?:|#)/.test(u)) return m;
        const abs = new URL(u, BASE + a).pathname;
        if (!assets.has(abs)) { assets.add(abs); queue.push(abs); }
        return u.startsWith('/') ? `url(${qt}${PUB}${abs}${u.slice(u.indexOf(abs) + abs.length)}${qt})` : m;
      });
      fs.writeFileSync(file, css);
    } else {
      fs.writeFileSync(file, buf);
    }
  }
  console.log(Object.fromEntries(Object.entries(pages).map(([s, b]) => [s, Object.keys(b)])));
  console.log('assets', assets.size);
})().catch((e) => { console.error(e); process.exit(1); });
