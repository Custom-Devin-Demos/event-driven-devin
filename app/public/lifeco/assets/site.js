/* global window, document, IntersectionObserver, performance, requestAnimationFrame */
/* Renders a brand home page from window.BRAND (see brands/*.html). */
(function () {
  const B = window.BRAND;
  if (!B) return;

  const root = document.documentElement;
  Object.entries(B.theme).forEach(([k, v]) => root.style.setProperty('--' + k, v));
  document.title = B.name + ' — ' + B.tagline;

  const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  const family = [
    ['Power Corporation', 'pcc'], ['Great-West Lifeco', 'lifeco'], ['Canada Life', 'canada-life'],
    ['Irish Life', 'irish-life'], ['Empower', 'empower'], ['IGM Financial', 'igm-financial'],
    ['IG Wealth Management', 'ig-wealth'], ['Mackenzie Investments', 'mackenzie'],
  ];

  const sparkPath = () => {
    const pts = B.spark || [20, 28, 24, 34, 30, 40, 36, 46, 44, 52];
    const w = 260, h = 46;
    const max = Math.max(...pts), min = Math.min(...pts);
    const coords = pts.map((p, i) => [i * (w / (pts.length - 1)), h - ((p - min) / (max - min || 1)) * (h - 6) - 3]);
    const line = coords.map((c, i) => (i ? 'L' : 'M') + c[0].toFixed(1) + ' ' + c[1].toFixed(1)).join(' ');
    return `<svg class="spark" viewBox="0 0 ${w} ${h}" preserveAspectRatio="none">
      <defs><linearGradient id="sparkfill" x1="0" x2="0" y1="0" y2="1"><stop offset="0" stop-color="var(--accent)"/><stop offset="1" stop-color="transparent"/></linearGradient></defs>
      <path class="fill" d="${line} L${w} ${h} L0 ${h} Z"/><path d="${line}"/></svg>`;
  };

  const heroCards = B.cards;
  const html = `
  <div class="bg"></div><div class="orb orb-a"></div><div class="orb orb-b"></div><div class="orb orb-c"></div>

  <header class="nav"><div class="wrap nav-inner">
    <a class="logo" href="#"><span class="mark">${esc(B.monogram)}</span><span class="logo-name">${esc(B.name)}</span></a>
    <nav class="nav-links">${B.nav.map((n) => `<a href="#">${esc(n)}</a>`).join('')}</nav>
    <div class="nav-cta"><a class="btn btn-ghost" href="#">${esc(B.signIn || 'Sign in')}</a><a class="btn btn-primary" href="#">${esc(B.cta)}</a></div>
  </div></header>

  <section class="hero"><div class="wrap hero-grid">
    <div>
      <span class="eyebrow"><i class="dot"></i>${esc(B.eyebrow)}</span>
      <h1>${esc(B.headline).replace(/&lt;br&gt;/g, '<br>').replace(/\*(.+?)\*/g, '<span class="grad">$1</span>')}</h1>
      <p class="lede">${esc(B.lede)}</p>
      <div class="hero-actions"><a class="btn btn-primary btn-lg" href="#">${esc(B.cta)}</a><a class="btn btn-ghost btn-lg" href="#">${esc(B.cta2)}</a></div>
      <div class="hero-proof">${B.proof.map((p) => `<div><b>${esc(p[0])}</b><span>${esc(p[1])}</span></div>`).join('')}</div>
    </div>
    <div class="hero-visual">
      <div class="card card-1" data-tilt><small>${esc(heroCards[0].label)}</small><div class="big">${esc(heroCards[0].value)}</div><div class="trend">${esc(heroCards[0].trend)}</div>${sparkPath()}</div>
      <div class="card card-2" data-tilt><small>${esc(heroCards[1].label)}</small><div style="display:flex;gap:16px;align-items:center;margin-top:10px"><div class="ring" style="--p:${heroCards[1].pct}"><b>${heroCards[1].pct}%</b></div><div><div class="big" style="font-size:22px">${esc(heroCards[1].value)}</div><div class="trend">${esc(heroCards[1].trend)}</div></div></div></div>
      <div class="card card-3" data-tilt><small>${esc(heroCards[2].label)}</small><div class="big">${esc(heroCards[2].value)}</div><div class="chips">${heroCards[2].chips.map((c) => `<span class="chip">${esc(c)}</span>`).join('')}</div></div>
    </div>
  </div></section>

  <div class="marquee"><div class="marquee-track">${[...B.ticker, ...B.ticker].map((t) => `<span><i></i>${esc(t)}</span>`).join('')}</div></div>

  <section class="block"><div class="wrap">
    <div class="section-head reveal"><div><div class="kicker">${esc(B.offer.kicker)}</div><h2>${esc(B.offer.title)}</h2></div><p>${esc(B.offer.blurb)}</p></div>
    <div class="grid-4">${B.offer.items.map((it, i) => `<a href="#" class="tile reveal" data-delay="${i % 4}"><div class="icon">${it.icon}</div><h3>${esc(it.title)}</h3><p>${esc(it.text)}</p><span class="more">${esc(it.more || 'Explore')}</span></a>`).join('')}</div>
  </div></section>

  <section class="block" style="padding-top:0"><div class="wrap stats">${B.stats.map((s, i) => `<div class="stat reveal" data-delay="${i}"><b data-count="${esc(s[0])}">${esc(s[0])}</b><span>${esc(s[1])}</span></div>`).join('')}</div></section>

  <section class="block"><div class="wrap split">
    <div class="copy reveal"><div class="kicker">${esc(B.feature.kicker)}</div><h2>${esc(B.feature.title)}</h2><p>${esc(B.feature.text)}</p>
      <ul class="checks">${B.feature.checks.map((c) => `<li>${esc(c)}</li>`).join('')}</ul>
      <div class="hero-actions"><a class="btn btn-primary" href="#">${esc(B.feature.cta)}</a></div></div>
    <div class="device reveal" data-delay="1">
      <div style="display:flex;justify-content:space-between;align-items:center"><small style="color:var(--muted);font-weight:600;letter-spacing:.06em;text-transform:uppercase;font-size:12px">${esc(B.feature.panel.title)}</small><span class="chip">${esc(B.feature.panel.badge)}</span></div>
      <div class="big" style="font-family:var(--font-display);font-size:38px;letter-spacing:-.02em;margin-top:10px">${esc(B.feature.panel.value)}</div>
      <div class="bars">${B.feature.panel.bars.map((h, i) => `<i style="height:${h}%;animation-delay:${i * 0.08}s"></i>`).join('')}</div>
      ${B.feature.panel.rows.map((r) => `<div class="row"><div class="l"><i>${r[0]}</i><div>${esc(r[1])}<small>${esc(r[2])}</small></div></div><b>${esc(r[3])}</b></div>`).join('')}
    </div>
  </div></section>

  <section class="block" style="padding-top:0"><div class="wrap">
    <div class="section-head reveal"><div><div class="kicker">Insights</div><h2>${esc(B.insightsTitle)}</h2></div><a class="btn btn-ghost" href="#">View all</a></div>
    <div class="grid-3">${B.insights.map((p, i) => `<a href="#" class="post reveal" data-delay="${i}"><div class="cover" style="--c1:${p.c[0]};--c2:${p.c[1]}"><span>${esc(p.tag)}</span></div><div class="body"><h3>${esc(p.title)}</h3><p>${esc(p.meta)}</p></div></a>`).join('')}</div>
  </div></section>

  <section class="block" style="padding-top:0"><div class="wrap"><div class="cta reveal">
    <div class="kicker" style="color:#fff;opacity:.8">${esc(B.closing.kicker)}</div><h2>${esc(B.closing.title)}</h2><p>${esc(B.closing.text)}</p>
    <div style="display:flex;gap:12px;justify-content:center;flex-wrap:wrap"><a class="btn btn-primary btn-lg" href="#">${esc(B.closing.cta)}</a><a class="btn btn-ghost btn-lg" href="#">${esc(B.closing.cta2)}</a></div>
  </div></div></section>

  <footer><div class="wrap">
    <div class="foot-grid">
      <div><a class="logo" href="#"><span class="mark">${esc(B.monogram)}</span>${esc(B.name)}</a><p style="margin-top:16px;max-width:320px;line-height:1.55">${esc(B.footerBlurb)}</p></div>
      ${B.footer.map((col) => `<div><h4>${esc(col[0])}</h4>${col.slice(1).map((l) => `<a href="#">${esc(l)}</a>`).join('')}</div>`).join('')}
    </div>
    <div class="foot-bottom"><span>© ${new Date().getFullYear()} ${esc(B.legal)}. Demo recreation — not affiliated with or endorsed by ${esc(B.name)}.</span>
      <div class="family">${family.map((f) => `<a href="/lifeco/${f[1]}">${esc(f[0])}</a>`).join('')}</div></div>
  </div></footer>`;

  document.getElementById('app').innerHTML = html;

  /* scroll reveal */
  const io = new IntersectionObserver((entries) => {
    entries.forEach((e) => { if (e.isIntersecting) { e.target.classList.add('in'); io.unobserve(e.target); } });
  }, { threshold: 0.15 });
  document.querySelectorAll('.reveal').forEach((el) => io.observe(el));

  /* count-up for stats like "$1.2T", "38M+", "98%" */
  const countIO = new IntersectionObserver((entries) => {
    entries.forEach((e) => {
      if (!e.isIntersecting) return;
      countIO.unobserve(e.target);
      const target = e.target.dataset.count;
      const m = target.match(/^([^\d]*)([\d.,]+)(.*)$/);
      if (!m) return;
      const num = parseFloat(m[2].replace(/,/g, ''));
      const decimals = (m[2].split('.')[1] || '').length;
      const start = performance.now(), dur = 1600;
      const step = (t) => {
        const k = Math.min(1, (t - start) / dur), ease = 1 - Math.pow(1 - k, 3);
        e.target.textContent = m[1] + (num * ease).toLocaleString(undefined, { useGrouping: m[2].includes(','), minimumFractionDigits: decimals, maximumFractionDigits: decimals }) + m[3];
        if (k < 1) requestAnimationFrame(step);
      };
      requestAnimationFrame(step);
    });
  }, { threshold: 0.4 });
  document.querySelectorAll('[data-count]').forEach((el) => countIO.observe(el));

  /* pointer glow on tiles + tilt on hero cards */
  document.addEventListener('pointermove', (ev) => {
    document.querySelectorAll('.tile').forEach((t) => {
      const r = t.getBoundingClientRect();
      t.style.setProperty('--mx', (ev.clientX - r.left) + 'px');
      t.style.setProperty('--my', (ev.clientY - r.top) + 'px');
    });
  });

  const hv = document.querySelector('.hero-visual');
  const tilts = document.querySelectorAll('[data-tilt]');
  const clamp = (v) => Math.max(-0.5, Math.min(0.5, v));
  if (hv) {
    hv.addEventListener('pointermove', (ev) => {
      const r = hv.getBoundingClientRect();
      const dx = clamp((ev.clientX - (r.left + r.width / 2)) / r.width);
      const dy = clamp((ev.clientY - (r.top + r.height / 2)) / r.height);
      tilts.forEach((c) => { c.style.transform = `rotateY(${dx * 10}deg) rotateX(${-dy * 10}deg)`; c.style.animation = 'none'; });
    });
    hv.addEventListener('pointerleave', () => {
      tilts.forEach((c) => { c.style.transform = ''; c.style.animation = ''; });
    });
  }
})();
