/* global window, document */
(function () {
  'use strict';

  var CC = window.CardControls;
  var CARD = CC.CARD;
  var ACCOUNT_LAST4 = '1634';
  var REPLY_DELAY_MS = 450;

  var STARTER_CHIPS = [
    'Lock my debit card',
    "What's my routing number?",
    'View my rewards',
    "What's my spend path?"
  ];
  var HELP_TOPICS = ["What's my spend path?", 'Subscription and recurring charges'];

  function hubEmail() {
    try {
      return window.localStorage.getItem('devinEmail') || undefined;
    } catch {
      return undefined;
    }
  }

  var clock = CC.createSystemClock();
  var controls = CC.createCardControls({
    clock: clock,
    transport: CC.createFakeTransport({ clock: clock }),
    reportsEnabled: CC.reportsEnabledFromSearch(window.location.search),
    userAgent: window.navigator.userAgent,
    ownerEmail: hubEmail()
  });

  var body = document.body;
  var scroller = document.getElementById('erica-scroll');
  var list = document.getElementById('erica-entries');
  var announcer = document.getElementById('erica-announcer');
  var form = document.getElementById('erica-form');
  var draft = document.getElementById('erica-draft');
  var railStatus = document.getElementById('rail-card-status');

  var state = {
    hasGreeting: false,
    lastKind: null,
    lockPhase: 'ready',
    isCardLocked: false,
    lockButtons: [],
    cardTiles: []
  };

  function el(tag, className, text) {
    var node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined) node.textContent = text;
    return node;
  }

  function append(node, kind) {
    list.appendChild(node);
    state.lastKind = kind;
    window.requestAnimationFrame(function () {
      scroller.scrollTop = scroller.scrollHeight;
    });
  }

  function announce(text) {
    announcer.textContent = '';
    window.setTimeout(function () { announcer.textContent = text; }, 50);
  }

  function clearGreeting() {
    if (!state.hasGreeting) return;
    list.textContent = '';
    state.hasGreeting = false;
    state.lastKind = null;
    state.lockButtons = [];
    state.cardTiles = [];
  }

  function addGreeting() {
    var greeting = el('div', 'erica-greeting');
    greeting.setAttribute('role', 'heading');
    greeting.setAttribute('aria-level', '2');
    greeting.appendChild(el('div', 'erica-greeting__hello', 'Good Morning,'));
    greeting.appendChild(el('div', 'erica-greeting__name', 'Robin'));
    append(greeting, 'greeting');
    state.hasGreeting = true;
  }

  function addErica(text, opts) {
    opts = opts || {};
    var leads = state.lastKind !== 'erica';
    var row = el('div', 'erica-row erica-row--erica' + (leads ? ' is-lead' : ''));
    var bubbleClass = 'erica-bubble' + (leads ? ' erica-bubble--mark' : '');
    if (opts.className) bubbleClass += ' ' + opts.className;
    var bubble = el('div', bubbleClass, text);
    if (opts.variant === 'error') {
      bubble.setAttribute('role', 'alert');
      var icon = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
      icon.setAttribute('width', '18');
      icon.setAttribute('height', '18');
      icon.setAttribute('viewBox', '0 0 18 18');
      icon.setAttribute('aria-hidden', 'true');
      icon.setAttribute('focusable', 'false');
      var circle = document.createElementNS('http://www.w3.org/2000/svg', 'circle');
      circle.setAttribute('cx', '9');
      circle.setAttribute('cy', '9');
      circle.setAttribute('r', '9');
      circle.setAttribute('fill', '#e31837');
      var exclamation = document.createElementNS('http://www.w3.org/2000/svg', 'path');
      exclamation.setAttribute('d', 'M8 4h2v6H8zM8 12h2v2H8z');
      exclamation.setAttribute('fill', '#fff');
      icon.appendChild(circle);
      icon.appendChild(exclamation);
      bubble.insertBefore(icon, bubble.firstChild);
    }
    var label = el('span', 'sr-only', 'Erica: ');
    bubble.insertBefore(label, bubble.firstChild);
    row.appendChild(bubble);
    append(row, 'erica');
    if (opts.variant !== 'error') announce('Erica: ' + text);
  }

  function addUser(text) {
    var row = el('div', 'erica-row erica-row--user');
    var bubble = el('div', 'erica-user', text);
    bubble.insertBefore(el('span', 'sr-only', 'You said: '), bubble.firstChild);
    row.appendChild(bubble);
    append(row, 'user');
  }

  function chip(title, onClick, compact) {
    var button = el('button', 'erica-chip' + (compact ? ' erica-chip--compact' : ''), title);
    button.type = 'button';
    button.addEventListener('click', onClick);
    return button;
  }

  function addChips(chips) {
    var row = el('div', 'erica-chips');
    row.setAttribute('role', 'group');
    row.setAttribute('aria-label', 'Suggestions');
    chips.forEach(function (item) {
      var title = typeof item === 'string' ? item : item.title;
      var action = typeof item === 'string' ? function () { send(title); } : item.action;
      row.appendChild(chip(title, action, chips.length === 1));
    });
    append(row, 'chips');
  }

  function addWaysToHelp() {
    var section = el('div', 'erica-help');
    section.appendChild(el('h3', 'erica-help__title', 'WAYS I CAN HELP'));
    HELP_TOPICS.forEach(function (topic) {
      section.appendChild(chip(topic, function () { send(topic); }, true));
    });
    append(section, 'help');
  }

  function lockIcon() {
    return '<svg viewBox="0 0 12 12" aria-hidden="true"><rect x="2" y="5.2" width="8" height="6" rx="1" fill="currentColor"/><path d="M3.8 5.2V3.8a2.2 2.2 0 0 1 4.4 0v1.4" fill="none" stroke="currentColor" stroke-width="1.3"/></svg>';
  }

  function renderCardTile(tile) {
    var locked = state.isCardLocked;
    tile.sub.innerHTML = '';
    tile.sub.appendChild(el('span', null, 'Debit card'));
    if (locked) {
      var badge = el('span', 'erica-card__locked');
      badge.innerHTML = lockIcon();
      badge.appendChild(document.createTextNode('Locked'));
      tile.sub.appendChild(badge);
    }
    tile.root.setAttribute('aria-label', CARD.productName + ' debit card ending in ' + CARD.last4.split('').join(' ') + ', ' + (locked ? 'Locked' : 'Active'));
  }

  function addDebitCard() {
    var root = el('div', 'erica-card');
    root.setAttribute('role', 'group');
    var art = el('div', 'erica-card__art');
    art.setAttribute('aria-hidden', 'true');
    art.appendChild(el('span', 'erica-card__chip'));
    art.appendChild(el('span', 'erica-card__digits', '\u2022\u2022 ' + CARD.last4));
    var meta = el('div', 'erica-card__meta');
    meta.setAttribute('aria-hidden', 'true');
    meta.appendChild(el('div', 'erica-card__name', CARD.productName + ' - ' + CARD.last4));
    var sub = el('div', 'erica-card__sub');
    meta.appendChild(sub);
    root.appendChild(art);
    root.appendChild(meta);
    var tile = { root: root, sub: sub };
    state.cardTiles.push(tile);
    renderCardTile(tile);
    append(root, 'card');
  }

  function renderLockButton(button) {
    var locking = state.lockPhase === 'locking';
    button.parentNode.hidden = state.lockPhase === 'locked';
    button.innerHTML = '';
    if (locking) {
      button.appendChild(el('span', 'erica-spinner'));
      button.appendChild(el('span', null, 'Locking your card...'));
      button.setAttribute('aria-disabled', 'true');
      button.setAttribute('aria-busy', 'true');
      button.setAttribute('aria-label', 'Locking your card');
    } else {
      button.appendChild(el('span', null, 'Lock my card'));
      button.removeAttribute('aria-disabled');
      button.removeAttribute('aria-busy');
      button.setAttribute('aria-label', 'Lock my card ending in ' + CARD.last4.split('').join(' '));
    }
  }

  function addLockAction() {
    var row = el('div', 'erica-lock-row');
    var button = el('button', 'erica-lock');
    button.type = 'button';
    button.setAttribute('data-testid', 'erica-lock-card');
    row.appendChild(button);
    button.addEventListener('click', lockCard);
    state.lockButtons.push(button);
    append(row, 'lock');
    renderLockButton(button);
  }

  function refreshCardState() {
    state.lockButtons.forEach(renderLockButton);
    state.cardTiles.forEach(renderCardTile);
    if (railStatus) {
      railStatus.className = 'debit__status' + (state.isCardLocked ? ' is-locked' : '');
      railStatus.innerHTML = '<span class="dot ' + (state.isCardLocked ? 'dot--off' : 'dot--on') + '"></span>' + (state.isCardLocked ? 'Locked' : 'Active');
    }
  }

  function setPhase(phase) {
    state.lockPhase = phase;
    body.setAttribute('data-lock-phase', phase);
    refreshCardState();
  }

  function lockCard() {
    if (state.lockPhase !== 'ready' && state.lockPhase !== 'failed') return;
    setPhase('locking');
    controls.lock(CARD).then(function () {
      state.isCardLocked = true;
      setPhase('locked');
      addErica('Your debit card ending in ' + CARD.last4 + ' is locked.');
      addChips(['Unlock my card']);
    }, function (error) {
      setPhase('failed');
      var failure = CC.lockFailureMessage(error);
      addErica(failure.text, failure);
      addChips([{ title: 'Try again', action: lockCard }]);
    });
  }

  function unlockCard() {
    controls.unlock(CARD).then(function () {
      state.isCardLocked = false;
      setPhase('ready');
      addErica('Your debit card ending in ' + CARD.last4 + ' is unlocked.');
    }, function () {
      addErica("Sorry, I couldn't unlock your card right now. Please try again.");
    });
  }

  function intentFor(text) {
    var query = text.toLowerCase();
    if (query.indexOf('unlock') !== -1) return 'unlock';
    if (query.indexOf('lock') !== -1) return 'lock';
    if (query.indexOf('routing') !== -1) return 'routing';
    if (query.indexOf('preferred') !== -1 || query.indexOf('tier') !== -1) return 'tier';
    if (query.indexOf('reward') !== -1) return 'rewards';
    if (query.indexOf('spend') !== -1 || query.indexOf('subscription') !== -1) return 'spending';
    return 'unknown';
  }

  function respond(intent) {
    var last4 = CARD.last4;
    switch (intent) {
      case 'lock':
        if (state.lockPhase === 'locking') {
          addErica("I'm locking your debit card ending in " + last4 + ' now.');
        } else if (state.isCardLocked) {
          addErica('Your debit card ending in ' + last4 + ' is already locked.');
          addChips(['Unlock my card']);
        } else {
          state.lockPhase = 'ready';
          addErica("Here's your debit card. Once you lock it, new purchases, ATM withdrawals and transfers will be declined. Recurring payments will continue as usual.");
          addDebitCard();
          addLockAction();
        }
        break;
      case 'unlock':
        if (state.lockPhase === 'locking') {
          addErica("I'm still locking your debit card ending in " + last4 + ". You can unlock it once that's done.");
        } else if (state.isCardLocked) {
          unlockCard();
        } else {
          addErica('Your debit card ending in ' + last4 + " isn't locked.");
        }
        break;
      case 'routing':
        addErica('The routing number for ' + CARD.productName + ' - ' + ACCOUNT_LAST4 + ' is 026009593.');
        break;
      case 'rewards':
        addErica('You have 18,450 BofA Rewards points. As a Preferred Rewards Honors member, you earn a 75% rewards bonus on eligible credit cards.');
        addChips(['Preferred Plus tier', 'Spending by category']);
        break;
      case 'tier':
        addErica("You're in the Preferred Rewards Honors tier. You qualify with a 3-month combined average daily balance of $50,000 or more.");
        break;
      case 'spending':
        addErica("Here's your spending so far this month: Dining $412.18, Groceries $356.40, Shopping $289.73 and Bills & Utilities $264.12.");
        break;
      default:
        addErica('I can help with your cards, accounts and rewards. Try one of these:');
        addChips(STARTER_CHIPS);
    }
  }

  function send(rawText) {
    var text = String(rawText || '').trim();
    if (!text) return;
    var hadGreeting = state.hasGreeting;
    clearGreeting();
    addUser(text);
    if (hadGreeting) draft.focus();
    var intent = intentFor(text);
    window.setTimeout(function () { respond(intent); }, REPLY_DELAY_MS);
  }

  function setOpen(open) {
    body.classList.toggle('erica-open', open);
    document.querySelectorAll('[data-erica-toggle]').forEach(function (button) {
      button.setAttribute('aria-expanded', String(open));
    });
    if (open) draft.focus({ preventScroll: true });
  }

  document.querySelectorAll('[data-erica-toggle]').forEach(function (button) {
    button.addEventListener('click', function () {
      var open = !body.classList.contains('erica-open');
      setOpen(open);
      if (!open) button.focus();
    });
  });
  document.querySelector('[data-erica-close]').addEventListener('click', function () {
    setOpen(false);
    var opener = document.querySelector('.olb-ask-erica');
    if (opener) opener.focus();
  });
  document.addEventListener('keydown', function (event) {
    if (event.key === 'Escape' && body.classList.contains('erica-open')) {
      setOpen(false);
      document.querySelector('.olb-ask-erica').focus();
    }
  });
  form.addEventListener('submit', function (event) {
    event.preventDefault();
    send(draft.value);
    draft.value = '';
  });

  addGreeting();
  addErica('How can I help you?');
  addChips(STARTER_CHIPS);
  addWaysToHelp();
  announcer.textContent = '';
  body.setAttribute('data-lock-phase', 'ready');
})();
