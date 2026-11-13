/* global document, window, localStorage, fetch, location, history, crypto, URLSearchParams */
(() => {
  const API = '/api/128703d6';
  const $ = (s, r = document) => r.querySelector(s);
  const $$ = (s, r = document) => [...r.querySelectorAll(s)];
  const STYLES = [
    { id: 'dancing-script', family: "'Dancing Script'" },
    { id: 'homemade-apple', family: "'Homemade Apple'" },
    { id: 'mrs-saint-delafield', family: "'Mrs Saint Delafield'" },
    { id: 'caveat', family: "'Caveat'" },
  ];
  const ORDER = ['initial-1', 'sign-1', 'title-1'];
  const params = new URLSearchParams(location.search);
  const signerParam = params.get('signer') || params.get('name') || '';
  const SIGN_ICON = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 3l1.4 1.4-1.4 1.4L10.6 4.4zM4 21h16v-2H4zM11 7h2v6.2l2.3-2.3 1.4 1.4L12 17l-4.7-4.7 1.4-1.4 2.3 2.3z"/></svg>';

  let demoId = localStorage.getItem('ds-demo-id');
  if (!demoId || !/^[A-Za-z0-9-]{8,64}$/.test(demoId)) {
    demoId = (crypto.randomUUID ? crypto.randomUUID() : `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`);
    localStorage.setItem('ds-demo-id', demoId);
  }

  const state = { envelope: null, agreed: false, values: {}, signature: null, adoptFor: null, mode: 'style', style: 'dancing-script', zoom: 1, drawn: { sig: false, ini: false } };

  async function api(path, opts = {}) {
    const res = await fetch(`${API}${path}`, {
      method: opts.method || 'GET',
      headers: { 'content-type': 'application/json', 'x-demo-id': demoId },
      body: opts.body ? JSON.stringify(opts.body) : undefined,
    });
    const data = await res.json().catch(() => ({ success: false, error: `Request failed (${res.status})` }));
    if (!res.ok || !data.success) throw Object.assign(new Error(data.error || 'Something went wrong.'), { data, status: res.status });
    return data.envelope;
  }

  function toast(title, message, ok = false) {
    $('#toast-title').textContent = title; $('#toast-message').textContent = message;
    $('#toast').classList.toggle('ok', ok); $('#toast').hidden = false;
    clearTimeout(toast.t); toast.t = setTimeout(() => { $('#toast').hidden = true; }, 6000);
  }
  $('#toast-close').onclick = () => { $('#toast').hidden = true; };

  const initialsOf = name => name.split(/[\s-]+/).filter(Boolean).map(p => p[0].toUpperCase()).slice(0, 3).join('');
  const fmtDate = iso => new Date(iso).toLocaleDateString('en-US', { month: '2-digit', day: '2-digit', year: 'numeric' });
  const fmtTime = iso => new Date(iso).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', second: '2-digit' }).toLowerCase();
  const styleFamily = id => (STYLES.find(s => s.id === id) || STYLES[0]).family;

  function paintEnvelope() {
    const env = state.envelope; if (!env) return;
    $$('[data-envelope-id]').forEach(el => { el.textContent = env.envelopeId; });
    $$('[data-signer-name]').forEach(el => { el.textContent = env.signer.name; });
    $$('[data-signer-email]').forEach(el => { el.textContent = env.signer.email; });
    $('#avatar').textContent = initialsOf(env.signer.name);
    $('#sender-date').textContent = new Date(env.sentAt).toLocaleDateString('en-US');
    const done = env.status === 'completed';
    const status = $('#primary-status');
    status.className = `status ${done ? 'done' : 'need'}`;
    status.innerHTML = done
      ? '<svg viewBox="0 0 24 24"><path d="M12 2a10 10 0 1 1 0 20 10 10 0 0 1 0-20zm4.3 6.3L10.5 14l-2.8-2.7-1.4 1.4 4.2 4.2 7.2-7.2z"/></svg>Completed'
      : '<svg viewBox="0 0 24 24"><path d="M12 2a10 10 0 1 1 0 20 10 10 0 0 1 0-20zm-1 5v7h2V7zm0 8v2h2v-2z"/></svg>Need to Sign';
    $('#primary-row').classList.toggle('unread', !done);
    const changed = env.completedAt || env.sentAt;
    $('#primary-date').textContent = fmtDate(changed); $('#primary-time').textContent = fmtTime(changed);
    $('#primary-subject').setAttribute('href', done ? '#/completed' : '#/sign');
    $('#primary-action').textContent = done ? 'View' : 'Sign';
    $('#primary-action').className = done ? 'ghost-btn' : 'primary-btn';
    $('#inbox-count').textContent = done ? '0' : '1'; $('#inbox-count').hidden = done;
  }

  // ---------- tabs ----------
  function renderTabs() {
    const v = state.values; const sig = state.signature; const env = state.envelope;
    const anchor = id => $(`.tab-anchor[data-tab="${id}"]`);
    const signedMarkup = (kind) => {
      const isIni = kind === 'ini';
      const body = sig.mode === 'draw' && (isIni ? sig.iniImage : sig.image)
        ? `<img src="${isIni ? sig.iniImage : sig.image}" alt="${isIni ? sig.initials : sig.fullName}">`
        : `<span style="font-family:${styleFamily(sig.style)}">${escapeHtml(isIni ? sig.initials : sig.fullName)}</span>`;
      return `<button class="signed-tab" data-tab-btn="${isIni ? 'initial-1' : 'sign-1'}" aria-label="${isIni ? 'Initialed' : 'Signed'} — click to change"><span class="signed-stamp"><span class="ds-by">${isIni ? 'DS' : 'Docusigned by:'}</span><span class="ds-sig ${isIni ? 'signed-ini' : ''}">${body}</span>${isIni ? '' : `<span class="ds-hash">${sig.hash}…</span>`}</span></button>`;
    };
    anchor('initial-1').innerHTML = v['initial-1'] && sig ? signedMarkup('ini')
      : `<button class="tab initial required" data-tab-btn="initial-1">Initial${SIGN_ICON}</button>`;
    anchor('sign-1').innerHTML = v['sign-1'] && sig ? signedMarkup('sig')
      : `<button class="tab sign required" data-tab-btn="sign-1">Sign${SIGN_ICON}</button>`;
    const nameText = sig ? sig.fullName : (env ? env.signer.name : '');
    anchor('fullname-1').innerHTML = `<span class="tab-auto ${sig ? 'filled' : ''}">${escapeHtml(sig ? nameText : 'Full Name')}</span>`;
    anchor('date-1').innerHTML = `<span class="tab-auto ${v['sign-1'] ? 'filled' : ''}">${v['sign-1'] ? new Date().toLocaleDateString('en-US') : 'Date Signed'}</span>`;
    if (!anchor('title-1').querySelector('input')) {
      anchor('title-1').innerHTML = '<input class="tab-text required" id="title-input" data-tab-btn="title-1" maxlength="60" placeholder="Title" aria-label="Title (required)">';
      $('#title-input').addEventListener('input', e => { state.values['title-1'] = e.target.value; updateProgress(); });
    }
    const t = $('#title-input'); t.value = v['title-1'] || ''; t.disabled = !state.agreed || state.completedView;
    t.classList.toggle('filled', !!(v['title-1'] || '').trim()); t.classList.toggle('required', !(v['title-1'] || '').trim());
    $$('[data-tab-btn]').forEach(el => { if (el.tagName === 'BUTTON') el.onclick = () => onTab(el.dataset.tabBtn); });
    updateProgress();
  }
  const escapeHtml = s => String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const isDone = id => (id === 'title-1' ? !!(state.values['title-1'] || '').trim() : !!state.values[id]);
  const remaining = () => ORDER.filter(id => !isDone(id));

  function updateProgress() {
    const left = remaining();
    const t = $('#title-input');
    if (t) { const ok = isDone('title-1'); t.classList.toggle('filled', ok); t.classList.toggle('required', !ok); }
    $('#req-count').textContent = left.length ? `${left.length} required field${left.length > 1 ? 's' : ''} remaining` : 'All required fields complete';
    $('#req-count').classList.toggle('done', !left.length);
    const ready = !left.length;
    const finish = $('#finish');
    if (ready && finish.disabled) { finish.classList.remove('pulse'); void finish.offsetWidth; finish.classList.add('pulse'); }
    finish.disabled = !ready;
    $('#action-bar').classList.toggle('ready', ready);
    $('#action-message').textContent = ready ? 'Select Finish when you have completed your review.' : 'Please review and act on these documents.';
    positionNavTag();
  }

  function navLabel(id) { return { 'initial-1': 'Initial', 'sign-1': 'Sign', 'title-1': 'Fill In' }[id]; }
  function positionNavTag() {
    const tag = $('#nav-tag');
    if (!state.agreed || state.completedView) { tag.hidden = true; return; }
    tag.hidden = false;
    const left = remaining();
    const started = Object.keys(state.values).length > 0 || state.started;
    if (!left.length) { $('#nav-tag-label').textContent = 'Finish'; tag.style.top = `${anchorTop('sign-1')}px`; return; }
    $('#nav-tag-label').textContent = started ? navLabel(left[0]) : 'Start';
    tag.style.top = `${started ? anchorTop(left[0]) : 40}px`;
  }
  function anchorTop(id) {
    const a = $(`.tab-anchor[data-tab="${id}"]`); const scroller = $('#doc-scroll');
    const r = a.getBoundingClientRect(); const s = scroller.getBoundingClientRect();
    return r.top - s.top + scroller.scrollTop + r.height / 2 - 17;
  }
  function goTo(id) {
    const a = $(`.tab-anchor[data-tab="${id}"]`);
    a.scrollIntoView({ behavior: 'smooth', block: 'center' });
    const el = a.querySelector('[data-tab-btn]');
    if (el) { el.classList.add('focus-ring'); setTimeout(() => el.classList.remove('focus-ring'), 1200); if (id === 'title-1') setTimeout(() => el.focus(), 350); }
  }
  $('#nav-tag').onclick = () => {
    state.started = true;
    const left = remaining();
    if (!left.length) { $('#finish').scrollIntoView({ block: 'nearest' }); $('#finish').focus(); return; }
    goTo(left[0]); positionNavTag();
  };

  function onTab(id) {
    if (state.completedView) return;
    if (!state.agreed) {
      const ersd = $('#ersd'); ersd.classList.remove('attn'); void ersd.offsetWidth; ersd.classList.add('attn');
      window.scrollTo({ top: 0, behavior: 'smooth' });
      toast('Review the disclosure first', 'Check "I agree to use electronic records and signatures" and select Continue to start signing.');
      return;
    }
    state.started = true;
    if (id === 'title-1') return;
    if (state.signature && !state.values[id]) { state.values[id] = true; renderTabs(); afterFill(id); return; }
    openAdopt(id);
  }
  function afterFill(_id) {
    const left = remaining();
    if (left.length) setTimeout(() => goTo(left[0]), 250);
  }

  // ---------- adopt dialog ----------
  const adopt = $('#adopt-dialog');
  function openAdopt(forTab) {
    state.adoptFor = forTab;
    const name = state.signature ? state.signature.fullName : state.envelope.signer.name;
    $('#adopt-name').value = name; $('#adopt-initials').value = state.signature ? state.signature.initials : initialsOf(name);
    setMode('style'); renderPreview(); $('#style-list').hidden = true;
    adopt.showModal();
  }
  function setMode(mode) {
    state.mode = mode;
    $$('.adopt-tabs button').forEach(b => { const on = b.dataset.mode === mode; b.classList.toggle('active', on); b.setAttribute('aria-selected', on); });
    $('#panel-style').hidden = mode !== 'style'; $('#panel-draw').hidden = mode !== 'draw';
    if (mode === 'draw') { setupCanvas($('#draw-sig'), 'sig'); setupCanvas($('#draw-ini'), 'ini'); }
  }
  $$('.adopt-tabs button').forEach(b => { b.onclick = () => { if (!b.disabled) setMode(b.dataset.mode); }; });
  function renderPreview() {
    const name = $('#adopt-name').value.trim() || ' '; const ini = $('#adopt-initials').value.trim().toUpperCase() || ' ';
    $('#pv-sig').textContent = name; $('#pv-ini').textContent = ini;
    $('#pv-sig').style.fontFamily = styleFamily(state.style); $('#pv-ini').style.fontFamily = styleFamily(state.style);
    $('#style-list').innerHTML = STYLES.map(s => `<label class="style-opt"><input type="radio" name="sig-style" value="${s.id}" ${s.id === state.style ? 'checked' : ''}><span class="s" style="font-family:${s.family}">${escapeHtml(name)}</span><span class="i" style="font-family:${s.family}">${escapeHtml(ini)}</span></label>`).join('');
    $$('#style-list input').forEach(r => { r.onchange = () => { state.style = r.value; renderPreview(); $('#style-list').hidden = true; }; });
  }
  $('#adopt-name').addEventListener('input', e => { $('#adopt-initials').value = initialsOf(e.target.value); renderPreview(); });
  $('#adopt-initials').addEventListener('input', renderPreview);
  $('#change-style').onclick = () => { $('#style-list').hidden = !$('#style-list').hidden; };
  $$('[data-close]').forEach(b => { b.addEventListener('click', () => b.closest('dialog').close()); });

  function setupCanvas(canvas, key) {
    if (canvas.dataset.ready) return; canvas.dataset.ready = '1';
    const ctx = canvas.getContext('2d'); ctx.lineWidth = 3; ctx.lineCap = 'round'; ctx.lineJoin = 'round'; ctx.strokeStyle = '#14213d';
    let drawing = false;
    const pt = e => { const r = canvas.getBoundingClientRect(); return [(e.clientX - r.left) * canvas.width / r.width, (e.clientY - r.top) * canvas.height / r.height]; };
    canvas.addEventListener('pointerdown', e => { drawing = true; canvas.setPointerCapture(e.pointerId); ctx.beginPath(); ctx.moveTo(...pt(e)); });
    canvas.addEventListener('pointermove', e => { if (!drawing) return; ctx.lineTo(...pt(e)); ctx.stroke(); state.drawn[key] = true; });
    canvas.addEventListener('pointerup', () => { drawing = false; });
  }
  $$('[data-clear]').forEach(b => { b.onclick = () => { const c = $(`#draw-${b.dataset.clear}`); c.getContext('2d').clearRect(0, 0, c.width, c.height); state.drawn[b.dataset.clear] = false; }; });

  $('#adopt-form').addEventListener('submit', e => {
    e.preventDefault();
    const fullName = $('#adopt-name').value.trim().replace(/\s+/g, ' ');
    const initials = $('#adopt-initials').value.trim().toUpperCase();
    if (!fullName || !initials) { toast('Required', 'Enter your full name and initials.'); return; }
    if (state.mode === 'draw' && (!state.drawn.sig || !state.drawn.ini)) { toast('Draw your signature', 'Draw both your signature and initials, or choose Select Style.'); return; }
    const hash = Array.from(crypto.getRandomValues(new Uint8Array(8))).map(b => b.toString(16).padStart(2, '0')).join('').toUpperCase().slice(0, 15);
    state.signature = { fullName, initials, mode: state.mode, style: state.style, hash,
      image: state.mode === 'draw' ? $('#draw-sig').toDataURL('image/png') : null,
      iniImage: state.mode === 'draw' ? $('#draw-ini').toDataURL('image/png') : null };
    state.values[state.adoptFor] = true;
    adopt.close(); renderTabs(); afterFill(state.adoptFor);
  });

  // ---------- views ----------
  function show(view) {
    document.body.dataset.view = view;
    $('#view-agreements').hidden = view !== 'agreements';
    $('#view-signing').hidden = view !== 'signing';
    $('#view-done').hidden = view !== 'done';
    window.scrollTo(0, 0);
  }
  function resetCeremony() {
    Object.assign(state, { agreed: false, values: {}, signature: null, started: false, drawn: { sig: false, ini: false } });
    $('#ersd').hidden = false; $('#action-bar').hidden = true; $('#ersd-agree').checked = false; $('#ersd-continue').disabled = true;
    document.body.classList.remove('signing-active', 'agreed');
    const t = $('.tab-anchor[data-tab="title-1"]'); t.innerHTML = '';
    $$('canvas').forEach(c => { c.getContext('2d').clearRect(0, 0, c.width, c.height); });
    renderTabs();
  }
  async function route() {
    const hash = location.hash || '#/agreements';
    if (!state.envelope) await load();
    if (!hash.startsWith('#/completed')) leaveCompletedView();
    if (hash.startsWith('#/completed')) {
      if (state.envelope.status !== 'completed') { location.hash = '#/agreements'; return; }
      show('signing'); enterCompletedView();
    } else if (hash.startsWith('#/sign')) {
      if (state.envelope.status === 'completed') { location.hash = '#/done'; return; }
      show('signing'); if (!state.agreed) resetCeremony(); setTimeout(positionNavTag, 50);
    } else if (hash.startsWith('#/done')) {
      if (state.envelope.status !== 'completed') { location.hash = '#/agreements'; return; }
      renderDone(); show('done');
    } else { paintEnvelope(); show('agreements'); }
  }
  async function load() {
    try { state.envelope = await api(`/envelope${signerParam ? `?signer=${encodeURIComponent(signerParam)}` : ''}`); }
    catch (err) { toast('Unable to load envelope', err.message); state.envelope = null; throw err; }
    paintEnvelope(); renderTabs();
  }

  $('#primary-action').onclick = () => { location.hash = state.envelope && state.envelope.status === 'completed' ? '#/completed' : '#/sign'; };
  $('#ersd-agree').onchange = e => { $('#ersd-continue').disabled = !e.target.checked; };
  $('#ersd-continue').onclick = async () => {
    try { state.envelope = await api('/envelope/view', { method: 'POST', body: signerParam ? { signerName: signerParam } : {} }); } catch (err) { toast('Unable to continue', err.message); return; }
    state.agreed = true; $('#ersd').hidden = true; $('#action-bar').hidden = false; document.body.classList.add('signing-active', 'agreed');
    renderTabs(); positionNavTag();
  };
  $('#ersd-disclosure').onclick = () => info('Electronic Record and Signature Disclosure', '<p>From time to time, Northwind Systems, Inc. (we, us or Company) may be required by law to provide to you certain written notices or disclosures. Described below are the terms and conditions for providing to you such notices and disclosures electronically through the Docusign system.</p><p>You may request paper copies at any time, withdraw your consent to receive notices electronically, and must have a supported browser and an email account to access these records.</p>');

  $('#finish').onclick = async () => {
    const left = remaining();
    if (left.length) { goTo(left[0]); return; }
    const btn = $('#finish'); btn.disabled = true; btn.textContent = 'Finishing…';
    const overlay = $('#finishing'); const steps = $$('#finishing-steps li');
    steps.forEach(li => { li.className = ''; }); overlay.hidden = false;
    const pause = ms => new Promise(r => setTimeout(r, ms));
    try {
      const sig = state.signature;
      const request = api('/envelope/complete', { method: 'POST', body: {
        values: { 'initial-1': true, 'sign-1': true, 'title-1': state.values['title-1'].trim() },
        signature: { fullName: sig.fullName, initials: sig.initials, mode: sig.mode, style: sig.style, image: sig.image, initialsImage: sig.mode === 'draw' ? sig.iniImage : null },
      } });
      for (const li of steps) { li.className = 'active'; await pause(650); li.className = 'done'; }
      state.envelope = await request;
      await pause(250);
      location.hash = '#/done';
    } catch (err) {
      toast('Unable to complete signing', err.message);
    } finally { overlay.hidden = true; btn.textContent = 'Finish'; updateProgress(); }
  };

  function enterCompletedView() {
    const env = state.envelope; const saved = env.signature || {};
    if (!state.signature) state.signature = { fullName: saved.fullName, initials: saved.initials, mode: saved.mode, style: saved.style, image: saved.image, iniImage: saved.initialsImage || null };
    state.signature.hash = (saved.shortId || state.signature.hash || '').toUpperCase();
    state.values = { 'initial-1': true, 'sign-1': true, 'title-1': (env.values && env.values['title-1']) || state.values['title-1'] || '' };
    state.completedView = true; state.agreed = true;
    document.body.classList.add('completed-mode', 'signing-active', 'agreed');
    $('#ersd').hidden = true; $('#action-bar').hidden = true; $('#completed-bar').hidden = false;
    renderTabs(); $('#req-count').textContent = 'Completed'; $('#req-count').classList.add('done');
  }
  function leaveCompletedView() {
    if (!state.completedView) return;
    state.completedView = false;
    document.body.classList.remove('completed-mode');
    $('#completed-bar').hidden = true;
    if (state.envelope && state.envelope.status !== 'completed') resetCeremony();
  }

  function renderDone() {
    const env = state.envelope; paintEnvelope();
    $('#cert-status').textContent = 'Completed';
    $('#mail-time').textContent = `${fmtDate(env.completedAt)} ${fmtTime(env.completedAt)}`;
    $('#cert-subject').textContent = env.subject;
    $('#cert-adoption').textContent = env.certificate ? env.certificate.signatureAdoption : '';
    $('#cert-sigid').textContent = env.signature ? env.signature.signatureId : '';
    $('#cert-hash').textContent = env.certificate ? env.certificate.documentHash : '';
    $('#cert-ip').textContent = env.certificate ? env.certificate.ipAddress : '';
    $('#cert-history').innerHTML = env.history.map(h => `<li><time>${fmtDate(h.at)} | ${fmtTime(h.at)}</time><strong>${escapeHtml(h.action)}</strong> by ${escapeHtml(h.by)} — ${escapeHtml(h.detail)}</li>`).join('');
  }

  // ---------- menus / tools ----------
  const menu = $('#other-menu');
  const toggleMenu = (open) => { menu.hidden = !open; $('#other-actions').setAttribute('aria-expanded', open); };
  $('#other-actions').onclick = e => { e.stopPropagation(); toggleMenu(menu.hidden); };
  $('[data-open-other]').onclick = e => { e.stopPropagation(); toggleMenu(menu.hidden); };
  document.addEventListener('click', e => { if (!menu.contains(e.target)) toggleMenu(false); });
  function info(title, html) { $('#info-title').textContent = title; $('#info-body').innerHTML = html; $('#info-dialog').showModal(); }
  menu.addEventListener('click', e => {
    const b = e.target.closest('[data-menu]'); if (!b) return; toggleMenu(false);
    const env = state.envelope;
    switch (b.dataset.menu) {
      case 'later': location.hash = '#/agreements'; toast('Finish later', 'This envelope stays in your Inbox under Need to Sign. Reopen it any time to sign.', true); break;
      case 'print': window.print(); break;
      case 'assign': info('Assign to Someone Else', '<p>Reassigning is disabled in this demonstration environment.</p>'); break;
      case 'decline': info('Decline to Sign', '<p>Declining is disabled in this demonstration environment so the envelope stays ready for the next run.</p>'); break;
      case 'history': info('Envelope History', `<ol class="history">${env.history.map(h => `<li><time>${fmtDate(h.at)} ${fmtTime(h.at)}</time><strong>${escapeHtml(h.action)}</strong> — ${escapeHtml(h.by)}</li>`).join('')}</ol>`); break;
      case 'certificate': info('Certificate of Completion', '<p>The certificate is available once all recipients have signed.</p>'); break;
      case 'session': info('Session Information', `<dl><dt>Envelope ID</dt><dd>${env.envelopeId}</dd><dt>Recipient</dt><dd>${escapeHtml(env.signer.name)} (${escapeHtml(env.signer.email)})</dd><dt>Sender</dt><dd>${escapeHtml(env.sender.name)}</dd><dt>Status</dt><dd>${env.status}</dd></dl>`); break;
      default: break;
    }
  });
  $('#info').onclick = () => info('Document Information', `<dl><dt>Document</dt><dd>${state.envelope.document.name}</dd><dt>Pages</dt><dd>${state.envelope.document.pages}</dd><dt>Envelope ID</dt><dd>${state.envelope.envelopeId}</dd><dt>Sent</dt><dd>${fmtDate(state.envelope.sentAt)} ${fmtTime(state.envelope.sentAt)}</dd></dl>`);
  $('#print').onclick = () => window.print();
  $('#download').onclick = () => window.print();
  const printCompleted = () => { if (location.hash !== '#/completed') location.hash = '#/completed'; setTimeout(() => window.print(), 400); };
  $('#done-download').onclick = printCompleted; $('#done-print').onclick = printCompleted;
  $('#cb-download').onclick = () => window.print(); $('#cb-print').onclick = () => window.print();
  $('#done-view').onclick = () => { location.hash = '#/completed'; };
  $('#mail-view').onclick = () => { location.hash = '#/completed'; };
  const applyZoom = () => { $('#pages').style.transform = `scale(${state.zoom})`; $('#pages').style.marginBottom = `${(state.zoom - 1) * 2200}px`; setTimeout(positionNavTag, 50); };
  $('#zoom-in').onclick = () => { state.zoom = Math.min(1.5, +(state.zoom + 0.1).toFixed(1)); applyZoom(); };
  $('#zoom-out').onclick = () => { state.zoom = Math.max(0.6, +(state.zoom - 0.1).toFixed(1)); applyZoom(); };
  $$('[data-goto]').forEach(b => { b.onclick = () => { $(`#page-${b.dataset.goto}`).scrollIntoView({ behavior: 'smooth' }); }; });
  $('#doc-scroll').addEventListener('scroll', () => {
    const top = $('#doc-scroll').scrollTop; const p2 = $('#page-2').offsetTop;
    $$('.thumb').forEach(t => t.classList.toggle('active', (t.dataset.goto === '2') === (top + 200 >= p2 * state.zoom)));
  });
  window.addEventListener('resize', positionNavTag);

  async function resetDemo() {
    try {
      state.envelope = await api('/envelope/reset', { method: 'POST', body: signerParam ? { signerName: signerParam } : {} });
      state.completedView = false; document.body.classList.remove('completed-mode'); $('#completed-bar').hidden = true;
      resetCeremony(); paintEnvelope();
      if (location.hash === '#/agreements') route(); else location.hash = '#/agreements';
      toast('Demo reset', 'The envelope is ready to sign again.', true);
    } catch (err) { toast('Reset failed', err.message); }
  }
  $$('[data-reset]').forEach(b => { b.addEventListener('click', e => { e.preventDefault(); toggleMenu(false); resetDemo(); }); });
  document.addEventListener('keydown', e => { if (e.altKey && (e.key === 'r' || e.key === 'R' || e.code === 'KeyR')) { e.preventDefault(); resetDemo(); } });

  window.addEventListener('hashchange', route);
  window.__esign = { state, resetDemo };
  (async () => {
    if (params.has('reset')) {
      await resetDemo().catch(() => {});
      params.delete('reset'); history.replaceState(null, '', `${location.pathname}${params.toString() ? `?${params}` : ''}${location.hash}`);
    }
    route().catch(() => {});
  })();
})();
