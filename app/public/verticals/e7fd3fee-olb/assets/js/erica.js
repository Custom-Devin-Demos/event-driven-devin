/* Erica virtual financial assistant - web chat widget (vanilla JS, no framework).
 * Accessibility: transcript is a polite role="log"; each Erica turn is built off-DOM and appended once when complete,
 * so it is announced once. Focus stays in the input. Escape minimizes and returns focus to the launcher.
 * We never detect or log assistive-technology usage. */
(function () {
  'use strict';
  var root = document.getElementById('erica');
  if (!root || !window.fetch) { return; }

  var $ = function (id) { return document.getElementById(id); };
  var launcher = $('erica-launcher'), panel = $('erica-panel'), log = $('erica-log'), form = $('erica-form'),
      input = $('erica-input'), send = $('erica-send'), typing = $('erica-typing'), notice = $('erica-notice'),
      alertBox = $('erica-alert'), unread = $('erica-unread'), langBtn = $('erica-lang');
  var ENDPOINT = root.getAttribute('data-endpoint');
  var STORE = 'erica.v1.' + root.getAttribute('data-key');
  var state = load();
  var busy = false;

  // ---------- storage (per sign-in, per tab) ----------
  function load() {
    try { var s = JSON.parse(window.sessionStorage.getItem(STORE)); if (s && s.turns) { return s; } } catch (e) {}
    return { open: false, locale: 'en-US', turns: [], used: {} };
  }
  function save() {
    try {
      if (state.turns.length > 60) { state.turns = state.turns.slice(-60); }
      window.sessionStorage.setItem(STORE, JSON.stringify(state));
    } catch (e) {}
  }

  // ---------- DOM helpers ----------
  function el(tag, attrs, kids) {
    var n = document.createElement(tag);
    if (attrs) {
      for (var k in attrs) {
        if (!attrs.hasOwnProperty(k) || attrs[k] === null || attrs[k] === undefined || attrs[k] === false) { continue; }
        if (k === 'text') { n.textContent = attrs[k]; } else if (k === 'cls') { n.className = attrs[k]; } else { n.setAttribute(k, attrs[k] === true ? '' : attrs[k]); }
      }
    }
    (kids || []).forEach(function (c) { if (c !== null && c !== undefined && c !== false) { n.appendChild(typeof c === 'string' ? document.createTextNode(c) : c); } });
    return n;
  }
  /** Visual text hidden from AT + spoken equivalent for money, dates and masked numbers. */
  function spoken(visual, sr, cls) {
    if (!sr || sr === visual) { return el('span', { cls: cls, text: visual }); }
    return el('span', { cls: cls }, [el('span', { 'aria-hidden': 'true', text: visual }), el('span', { cls: 'sr-only', text: sr })]);
  }
  var uid = 0;
  function nextId(p) { uid += 1; return 'erica-' + p + '-' + Date.now().toString(36) + uid; }

  // ---------- rich cards ----------
  function cardShell(card, kind, extraCls) {
    var hid = nextId('card');
    var box = el('div', { cls: 'erica-card erica-card--' + kind + (extraCls ? ' ' + extraCls : ''), role: 'group', 'aria-labelledby': hid });
    box.appendChild(el('h3', { cls: 'erica-card-title', id: hid }, [kind === 'error' ? el('span', { cls: 'sr-only', text: 'Error: ' }) : null, card.title || '']));
    return box;
  }
  function dl(rows) {
    var d = el('dl', { cls: 'erica-dl' });
    (rows || []).forEach(function (r) {
      d.appendChild(el('div', { cls: 'erica-dl-row' + (r.ok ? ' is-ok' : '') }, [el('dt', null, [spoken(r.k, r.k_sr)]), el('dd', null, [spoken(r.v, r.v_sr)])]));
    });
    return d;
  }
  function footnote(t) { return t ? el('p', { cls: 'erica-footnote', text: t }) : null; }

  var renderers = {
    balances: function (c) {
      var box = cardShell(c, 'balances');
      var ul = el('ul', { cls: 'erica-rows' });
      c.rows.forEach(function (r) {
        ul.appendChild(el('li', { cls: 'erica-row' }, [
          el('div', { cls: 'erica-row-main' }, [spoken(r.name + ' - ' + r.last4, r.name + ' ' + r.last4_sr, 'erica-row-name'), el('span', { cls: 'erica-row-sub', text: r.sub })]),
          el('div', { cls: 'erica-row-amt' }, [el('span', { cls: 'erica-row-label', text: r.label }), spoken(r.amount, r.amount_sr, 'erica-amt')]),
        ]));
      });
      box.appendChild(ul); box.appendChild(footnote(c.footnote) || document.createTextNode(''));
      return box;
    },
    transactions: function (c) {
      var box = cardShell(c, 'transactions');
      var ul = el('ul', { cls: 'erica-rows' });
      c.rows.forEach(function (r) {
        ul.appendChild(el('li', { cls: 'erica-row' + (r.pending ? ' is-pending' : '') }, [
          el('div', { cls: 'erica-row-main' }, [
            el('span', { cls: 'erica-row-name', text: r.description }),
            el('span', { cls: 'erica-row-sub' }, [spoken(r.date, r.date_sr), ' · ', spoken(r.account, r.account_sr), r.pending ? el('span', { cls: 'erica-pill', text: 'Pending' }) : null]),
          ]),
          el('div', { cls: 'erica-row-amt' + (r.credit ? ' is-credit' : '') }, [spoken(r.amount, r.amount_sr, 'erica-amt')]),
        ]));
      });
      box.appendChild(ul);
      return box;
    },
    spending: function (c) {
      var box = cardShell(c, 'spending');
      box.appendChild(el('p', { cls: 'erica-card-summary', text: c.summary }));
      var ul = el('ul', { cls: 'erica-rows' });
      c.rows.forEach(function (r) {
        var pct = r.pct === null ? 0 : Math.min(r.pct, 100);
        ul.appendChild(el('li', { cls: 'erica-row erica-row--stack' + (r.over ? ' is-over' : '') }, [
          el('div', { cls: 'erica-row-line' }, [el('span', { cls: 'erica-row-name', text: r.category }), spoken(r.amount, r.amount_sr, 'erica-amt')]),
          r.pct === null ? null : el('div', { cls: 'erica-bar', 'aria-hidden': 'true' }, [el('span', { style: 'width:' + pct + '%' })]),
          el('span', { cls: 'erica-row-sub', text: r.status_text + ' · ' + r.count + (r.count === 1 ? ' purchase' : ' purchases') }),
        ]));
      });
      box.appendChild(ul); box.appendChild(footnote(c.footnote) || document.createTextNode(''));
      return box;
    },
    bills: function (c) {
      var box = cardShell(c, 'bills');
      var ul = el('ul', { cls: 'erica-rows' });
      c.rows.forEach(function (r) {
        ul.appendChild(el('li', { cls: 'erica-row' }, [
          el('div', { cls: 'erica-row-main' }, [el('span', { cls: 'erica-row-name', text: r.name }), el('span', { cls: 'erica-row-sub' }, [spoken(r.date, r.date_sr), ' · ', r.detail])]),
          el('div', { cls: 'erica-row-amt' }, [spoken(r.amount, r.amount_sr, 'erica-amt'), el('span', { cls: 'erica-pill' + (r.status === 'eBill due' ? ' is-warn' : ''), text: r.status })]),
        ]));
      });
      box.appendChild(ul);
      return box;
    },
    info: function (c) {
      var box = cardShell(c, 'info');
      box.appendChild(el('ol', { cls: 'erica-steps' }, c.items.map(function (t) { return el('li', { text: t }); })));
      box.appendChild(footnote(c.footnote) || document.createTextNode(''));
      return box;
    },
    handoff: function (c) {
      var box = cardShell(c, 'handoff');
      box.appendChild(el('p', { cls: 'erica-phone' }, [el('a', { href: c.phone_href, text: c.phone })]));
      box.appendChild(el('p', { cls: 'erica-row-sub', text: c.hours }));
      box.appendChild(el('ul', { cls: 'erica-bullets' }, c.items.map(function (t) { return el('li', { text: t }); })));
      box.appendChild(el('p', { cls: 'erica-ref' }, ['Reference: ', el('code', { text: c.reference })]));
      return box;
    },
    transaction: function (c) {
      var box = cardShell(c, 'transaction');
      box.appendChild(el('div', { cls: 'erica-txn-hero' }, [
        el('div', null, [el('span', { cls: 'erica-row-name', text: c.merchant }), el('span', { cls: 'erica-row-sub', text: c.description })]),
        spoken(c.amount, c.amount_sr, 'erica-amt erica-amt--lg'),
      ]));
      box.appendChild(dl([
        { k: 'Date', v: c.date, v_sr: c.date_sr }, { k: 'Card', v: c.card, v_sr: c.card_sr },
        c.location ? { k: 'Location', v: c.location } : null, { k: 'Status', v: c.status }, { k: 'Category', v: c.category },
      ].filter(Boolean)));
      return box;
    },
    card_lock_confirm: confirmCard,
    lock_dispute_confirm: confirmCard,
    card_status: function (c) {
      var box = cardShell(c, 'status', 'is-success');
      box.appendChild(el('p', { cls: 'erica-status-line' }, [spoken(c.card, c.card_sr, 'erica-row-name'), el('span', { cls: 'erica-pill ' + (c.status === 'Locked' ? 'is-locked' : 'is-ok'), text: c.status })]));
      box.appendChild(el('p', { cls: 'erica-row-sub', text: c.detail }));
      return box;
    },
    dispute_confirmation: function (c) {
      var box = cardShell(c, 'dispute', 'is-success');
      box.appendChild(el('p', { cls: 'erica-case' }, [el('span', { text: 'Case number' }), el('strong', { text: c.case_number })]));
      box.appendChild(dl(c.rows.filter(function (r) { return r.k !== 'Case number'; }).concat([{ k: 'Status', v: c.status.charAt(0).toUpperCase() + c.status.slice(1) }])));
      box.appendChild(el('h4', { cls: 'erica-subhd', text: 'What happens next' }));
      box.appendChild(el('ul', { cls: 'erica-bullets' }, c.next_steps.map(function (t) { return el('li', { text: t }); })));
      return box;
    },
    error: function (c) {
      var box = cardShell(c, 'error', 'is-error');
      if (c.rows && c.rows.length) {
        var ul = el('ul', { cls: 'erica-outcomes' });
        c.rows.forEach(function (r) {
          ul.appendChild(el('li', { cls: r.ok ? 'is-ok' : 'is-fail' }, [
            el('span', { cls: 'erica-outcome-icon', 'aria-hidden': 'true', text: r.ok ? '\u2713' : '\u2715' }),
            spoken(r.k, r.k_sr), ': ', el('strong', { text: r.v || r.status }),
          ]));
        });
        box.appendChild(ul);
      }
      if (c.help) { box.appendChild(el('p', { cls: 'erica-card-summary', text: c.help })); }
      box.appendChild(el('p', { cls: 'erica-ref' }, ['Reference: ', el('code', { text: c.reference })]));
      return box;
    },
  };

  function confirmCard(c, ctx) {
    var box = cardShell(c, 'confirm');
    box.appendChild(el('p', { cls: 'erica-card-summary', text: c.summary }));
    box.appendChild(dl(c.rows));
    if (c.disclosure) { box.appendChild(el('p', { cls: 'erica-disclosure', text: c.disclosure })); }
    var stageId = c.actions[0] && c.actions[0].action.payload.stage_id;
    var used = stageId && state.used[stageId];
    var status = el('p', { cls: 'erica-confirm-status', hidden: !used, text: used ? used : '' });
    var bar = el('div', { cls: 'erica-actions' });
    c.actions.forEach(function (a) {
      var b = el('button', { type: 'button', cls: 'erica-btn erica-btn--' + a.style, disabled: !!used || ctx.stale }, [a.label]);
      b.addEventListener('click', function () {
        if (busy || state.used[stageId]) { return; }
        var outcome = a.action.type === 'confirm_staged' ? 'You confirmed this request.' : 'You canceled this request.';
        state.used[stageId] = outcome;
        bar.querySelectorAll('button').forEach(function (x) { x.disabled = true; });
        status.textContent = outcome; status.hidden = false;
        post({ action: a.action }, a.label, function () {
          // The request never reached Erica (offline, signed out, CSRF refresh), so nothing ran: let the customer retry.
          delete state.used[stageId]; save();
          bar.querySelectorAll('button').forEach(function (x) { x.disabled = !!ctx.stale; });
          status.textContent = ''; status.hidden = true;
        });
      });
      bar.appendChild(b);
    });
    box.appendChild(bar); box.appendChild(status);
    return box;
  }

  // ---------- messages ----------
  function chipsNode(m, ctx) {
    if (!m.chips || !m.chips.length) { return null; }
    var list = m.chips_layout === 'list';
    var wrap = el('ul', { cls: 'erica-chips' + (list ? ' erica-chips--list' : ''), 'aria-label': list ? 'Recent card purchases' : 'Suggested replies' });
    m.chips.forEach(function (ch) {
      var a = ch.action || {};
      var body = [el('span', { cls: 'erica-chip-label', text: ch.label })];
      if (ch.detail) { body.push(spoken(ch.detail, ch.detail_sr, 'erica-chip-detail')); }
      if (ch.flag) { body.push(el('span', { cls: 'erica-pill is-warn', text: ch.flag })); }
      var node;
      if (a.type === 'link') {
        node = el('a', { cls: 'erica-chip erica-chip--link', href: a.payload.href }, body);
      } else {
        node = el('button', { type: 'button', cls: 'erica-chip', disabled: ctx.stale }, body);
        node.addEventListener('click', function () { if (!busy) { post({ action: a }, ch.label); } });
      }
      wrap.appendChild(el('li', null, [node]));
    });
    return wrap;
  }

  function ericaTurnNode(turn, stale) {
    var g = el('div', { cls: 'erica-turn erica-turn--erica' + (stale ? ' is-stale' : ''), 'data-cid': turn.correlation_id || '' });
    turn.messages.forEach(function (m, i) {
      var bubble = el('div', { cls: 'erica-msg erica-msg--erica' + (m.tone ? ' is-' + m.tone : ''), lang: m.lang || null }, [
        el('span', { cls: 'sr-only', text: i === 0 ? 'Erica says: ' : '' }),
        el('p', { cls: 'erica-text', text: m.text }),
        m.note ? el('p', { cls: 'erica-note', text: m.note }) : null,
      ]);
      g.appendChild(bubble);
      if (m.card && renderers[m.card.type]) { g.appendChild(renderers[m.card.type](m.card, { stale: stale })); }
      var chips = chipsNode(m, { stale: stale });
      if (chips) { g.appendChild(chips); }
    });
    return g;
  }
  function customerTurnNode(turn) {
    return el('div', { cls: 'erica-turn erica-turn--me' }, [el('div', { cls: 'erica-msg erica-msg--me' }, [el('span', { cls: 'sr-only', text: 'You said: ' }), el('p', { cls: 'erica-text', text: turn.text })])]);
  }
  function markStale() {
    log.querySelectorAll('.erica-turn--erica:not(.is-stale)').forEach(function (t) {
      t.classList.add('is-stale');
      t.querySelectorAll('button.erica-chip, .erica-actions button').forEach(function (b) { b.disabled = true; });
    });
  }
  function scrollEnd() { log.scrollTop = log.scrollHeight; }

  function renderAll() {
    log.textContent = '';
    state.turns.forEach(function (t, i) {
      var last = i === state.turns.length - 1;
      log.appendChild(t.who === 'me' ? customerTurnNode(t) : ericaTurnNode(t, !last));
    });
    scrollEnd();
  }

  // ---------- networking ----------
  function showAlert(msg, linkHref, linkText) {
    alertBox.textContent = '';
    alertBox.appendChild(el('span', { text: msg + ' ' }));
    if (linkHref) { alertBox.appendChild(el('a', { href: linkHref, text: linkText })); }
    alertBox.hidden = false;
  }
  function setBusy(on) {
    busy = on;
    typing.hidden = !on;
    log.setAttribute('aria-busy', on ? 'true' : 'false');
    send.disabled = on;
    if (on) { scrollEnd(); }
  }

  function post(body, echo, onNotSent) {
    if (busy) { return; }
    alertBox.hidden = true;
    if (echo) {
      var me = { who: 'me', text: echo };
      state.turns.push(me); markStale(); log.appendChild(customerTurnNode(me)); save();
    }
    body.locale = state.locale;
    ['devinUserId', 'devinOrgId', 'devinEmail'].forEach(function (k) { try { body[k] = window.localStorage.getItem(k) || ''; } catch (e) { body[k] = ''; } });
    setBusy(true);
    var started = Date.now();
    fetch(ENDPOINT, {
      method: 'POST', credentials: 'same-origin',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json', 'X-CSRF-Token': (window.OLB && window.OLB.csrf) || '' },
      body: JSON.stringify(body),
    }).then(function (res) {
      return res.json().catch(function () { return {}; }).then(function (j) { return { status: res.status, json: j }; });
    }).then(function (r) {
      // A short, natural pause so the typing indicator is perceivable; never longer than ~0.7s added.
      var wait = Math.max(0, 650 - (Date.now() - started));
      setTimeout(function () { finish(r, onNotSent); }, wait);
    }).catch(function () {
      setBusy(false);
      if (onNotSent) { onNotSent(); }
      showAlert("We couldn't reach Erica. Check your connection and try again.");
      keepFocus();
    });
  }

  function finish(r, onNotSent) {
    setBusy(false);
    if ((r.status === 401 || r.status === 403) && onNotSent) { onNotSent(); }
    if (r.status === 200 && r.json && r.json.messages) {
      var turn = { who: 'erica', correlation_id: r.json.correlation_id, messages: r.json.messages };
      state.turns.push(turn); markStale(); save();
      // Built off-DOM, appended once: the polite log announces the complete turn exactly once.
      log.appendChild(ericaTurnNode(turn, false));
      scrollEnd();
      if (panel.hidden) { unread.hidden = false; }
    } else if (r.status === 401) {
      var e = (r.json && r.json.error) || {};
      showAlert(e.message || 'Your session ended. Please sign in again.', e.redirect || '/e7fd3fee/olb/login', 'Sign in');
    } else if (r.status === 403) {
      showAlert('Your session expired. Refresh the page and try again.', window.location.pathname, 'Refresh page');
    } else {
      var err = (r.json && r.json.error) || {};
      if (r.json && r.json.messages) {
        var failed = { who: 'erica', correlation_id: err.correlation_id, messages: r.json.messages };
        state.turns.push(failed); markStale(); save();
        log.appendChild(ericaTurnNode(failed, false));
        scrollEnd();
      }
      showAlert((err.message || "Erica isn't available right now. Please try again in a few minutes.") + (err.correlation_id ? ' Reference ' + err.correlation_id + '.' : ''));
    }
    keepFocus();
  }
  function keepFocus() { if (!panel.hidden) { input.focus(); } }

  // ---------- open / minimize / close ----------
  function open() {
    panel.hidden = false; root.classList.add('is-open');
    launcher.setAttribute('aria-expanded', 'true'); unread.hidden = true;
    state.open = true; save();
    if (!state.turns.length) { post({ action: { type: 'welcome', payload: {} } }, null); }
    scrollEnd(); input.focus();
  }
  function minimize() {
    panel.hidden = true; root.classList.remove('is-open');
    launcher.setAttribute('aria-expanded', 'false');
    state.open = false; save(); launcher.focus();
  }
  function endChat() {
    state = { open: false, locale: state.locale, turns: [], used: {} };
    save(); log.textContent = ''; alertBox.hidden = true; notice.hidden = true;
    minimize();
  }
  function flash(msg, lang) {
    notice.textContent = ''; notice.appendChild(el('span', { lang: lang || null, text: msg })); notice.hidden = false;
    clearTimeout(flash.t); flash.t = setTimeout(function () { notice.hidden = true; }, 9000);
  }

  launcher.addEventListener('click', function () { if (panel.hidden) { open(); } else { minimize(); } });
  $('erica-minimize').addEventListener('click', minimize);
  $('erica-close').addEventListener('click', endChat);
  panel.addEventListener('keydown', function (e) { if (e.key === 'Escape' || e.key === 'Esc') { e.preventDefault(); minimize(); } });
  form.addEventListener('submit', function (e) {
    e.preventDefault();
    var t = input.value.replace(/\s+/g, ' ').trim();
    if (!t) { input.focus(); return; }
    if (busy) { return; }
    input.value = '';
    post({ text: t }, t);
    input.focus();
  });
  $('erica-mic').addEventListener('click', function () {
    flash("Voice input isn't available in Online Banking on the web yet. To talk to Erica, use the Bank of America mobile app.");
    input.focus();
  });
  langBtn.addEventListener('click', function () {
    var es = state.locale !== 'es-US';
    state.locale = es ? 'es-US' : 'en-US'; save();
    langBtn.setAttribute('aria-pressed', es ? 'true' : 'false');
    langBtn.textContent = es ? 'English' : 'Español';
    langBtn.setAttribute('lang', es ? 'en' : 'es');
    if (es) { flash('Erica en español llegará pronto a la Banca en Línea. Por ahora, puede hablar con Erica en español en la aplicación móvil de Bank of America.', 'es'); }
    else { flash('Erica will continue in English.'); }
    input.focus();
  });

  // Page-level "Ask Erica" hooks: <a data-erica-ask="I don't recognize a charge">
  document.addEventListener('click', function (e) {
    var t = e.target.closest ? e.target.closest('[data-erica-ask]') : null;
    if (!t) { return; }
    e.preventDefault();
    if (panel.hidden) { open(); }
    var q = t.getAttribute('data-erica-ask');
    if (q) { var go = function () { if (busy) { return setTimeout(go, 200); } post({ text: q }, q); }; go(); }
  });

  // ---------- boot ----------
  if (state.locale === 'es-US') { langBtn.setAttribute('aria-pressed', 'true'); langBtn.textContent = 'English'; langBtn.setAttribute('lang', 'en'); }
  renderAll();
  if (state.open) { panel.hidden = false; root.classList.add('is-open'); launcher.setAttribute('aria-expanded', 'true'); scrollEnd(); }
}());
