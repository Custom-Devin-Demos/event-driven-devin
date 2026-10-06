/* global document, location, localStorage, window */
/* Per-browser "Send my demo alerts to: Slack / Teams" choice, shared by the
 * demo hub (/) and the On-Call hub (/oncall). Saved in localStorage and
 * mirrored into the alert_destination cookie so every demo page's API request
 * carries it to the server. It only affects this browser. */
(function () {
  var KEY = 'alertDestination';
  var listeners = [];

  var SLACK_ICON = '<svg viewBox="0 0 54 54" aria-hidden="true"><path fill="#36C5F0" d="M19.7.1a5.4 5.4 0 0 0 0 10.8h5.4V5.5A5.4 5.4 0 0 0 19.7.1m0 14.4H5.4a5.4 5.4 0 0 0 0 10.8h14.3a5.4 5.4 0 0 0 0-10.8"/><path fill="#2EB67D" d="M53.8 19.9a5.4 5.4 0 0 0-10.8 0v5.4h5.4a5.4 5.4 0 0 0 5.4-5.4m-14.4 0V5.5a5.4 5.4 0 0 0-10.8 0v14.4a5.4 5.4 0 0 0 10.8 0"/><path fill="#ECB22E" d="M34 54a5.4 5.4 0 0 0 0-10.8h-5.4v5.4A5.4 5.4 0 0 0 34 54m0-14.4h14.4a5.4 5.4 0 0 0 0-10.8H34a5.4 5.4 0 0 0 0 10.8"/><path fill="#E01E5A" d="M0 34.2a5.4 5.4 0 0 0 10.8 0v-5.4H5.4A5.4 5.4 0 0 0 0 34.2m14.3 0v14.4a5.4 5.4 0 0 0 10.8 0V34.2a5.4 5.4 0 0 0-10.8 0"/></svg>';
  var TEAMS_ICON = '<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="19" cy="6.2" r="2.4" fill="#5059C9"/><rect x="15" y="9.6" width="8" height="9" rx="3" fill="#5059C9"/><circle cx="12.5" cy="4.8" r="3" fill="#7B83EB"/><rect x="7" y="9" width="11" height="12.5" rx="3.2" fill="#7B83EB"/><rect x="1" y="6" width="12" height="12" rx="2" fill="#4B53BC"/><path fill="#fff" d="M4 9h6v1.7H7.9V15H6.1v-4.3H4z"/></svg>';

  var CSS = ''
    + '.adp{display:flex;align-items:center;flex-wrap:wrap;gap:6px 10px;font-family:inherit;letter-spacing:normal}'
    + '.adp-title{font-size:13px;color:rgba(25,25,25,.56)}'
    + '.adp-summary{font-size:12px;line-height:1.4;color:rgba(25,25,25,.56)}'
    + '.adp-summary:not(.warn){display:none}'
    + '.adp-summary.warn{color:#9a4a00}'
    + '.adp-seg{display:inline-grid;grid-template-columns:auto auto;border:1px solid rgba(0,0,0,.18);border-radius:2px;overflow:hidden}'
    + '.adp-opt{display:inline-flex;align-items:center;justify-content:center;height:26px;padding:0 10px;border:0;border-radius:0;background:transparent;color:rgba(25,25,25,.56);font:inherit;font-size:13px;line-height:1;cursor:pointer;white-space:nowrap;transition:background .15s,color .15s}'
    + '.adp-opt svg{display:none}'
    + '.adp-opt:hover:not(.on){color:#141414}'
    + '.adp-opt.on{background:#141414;color:#fff}'
    + '.adp-opt:focus-visible{outline:2px solid #2600ff;outline-offset:-2px}';

  function normalize(value) {
    return value === 'slack' || value === 'teams' ? value : null;
  }

  function writeCookie(value) {
    document.cookie = 'alert_destination=' + value + '; Path=/; Max-Age=31536000; SameSite=Lax'
      + (location.protocol === 'https:' ? '; Secure' : '');
  }

  function get() {
    return normalize(localStorage.getItem(KEY)) || 'slack';
  }

  function notify(value) {
    listeners.forEach(function (fn) { fn(value); });
  }

  function set(value) {
    value = normalize(value) || 'slack';
    var changed = localStorage.getItem(KEY) !== value;
    localStorage.setItem(KEY, value);
    writeCookie(value);
    if (changed) notify(value);
    return value;
  }

  function onChange(fn) {
    listeners.push(fn);
  }

  // Another tab (e.g. the other hub) changed it: follow along without a reload.
  window.addEventListener('storage', function (e) {
    if (e.key === KEY) notify(get());
  });

  function injectCss() {
    if (document.getElementById('adp-css')) return;
    var style = document.createElement('style');
    style.id = 'adp-css';
    style.textContent = CSS;
    document.head.appendChild(style);
  }

  function mount(el, opts) {
    opts = opts || {};
    var teamsAvailable = opts.teamsAvailable !== false;
    injectCss();
    el.innerHTML = ''
      + '<div class="adp">'
      + '<div class="adp-title" id="adp-title">Post alerts to</div>'
      + '<div class="adp-seg" role="radiogroup" aria-labelledby="adp-title">'
      + '<button type="button" class="adp-opt" role="radio" data-value="slack">' + SLACK_ICON + 'Slack</button>'
      + '<button type="button" class="adp-opt" role="radio" data-value="teams">' + TEAMS_ICON + 'Microsoft Teams</button>'
      + '</div>'
      + '<div class="adp-summary" aria-live="polite"></div>'
      + '</div>';
    var buttons = Array.prototype.slice.call(el.querySelectorAll('.adp-opt'));
    var summary = el.querySelector('.adp-summary');

    function render() {
      var value = get();
      buttons.forEach(function (b) {
        var on = b.getAttribute('data-value') === value;
        b.classList.toggle('on', on);
        b.setAttribute('aria-checked', on ? 'true' : 'false');
        b.tabIndex = on ? 0 : -1;
      });
      var warn = value === 'teams' && !teamsAvailable;
      summary.classList.toggle('warn', warn);
      if (warn) {
        summary.innerHTML = 'Teams isn\'t set up on this server yet, so alerts still go to <b>Slack</b>.';
      } else if (value === 'teams') {
        summary.innerHTML = TEAMS_ICON + '<span>Alerts post to <b>Microsoft Teams</b>. Nothing goes to Slack.</span>';
      } else {
        summary.innerHTML = SLACK_ICON + '<span>Alerts post to <b>Slack</b>. Nothing goes to Teams.</span>';
      }
    }

    buttons.forEach(function (b) {
      b.addEventListener('click', function () { set(b.getAttribute('data-value')); });
      b.addEventListener('keydown', function (e) {
        if (['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'].indexOf(e.key) === -1) return;
        e.preventDefault();
        var next = buttons[(buttons.indexOf(b) + 1) % buttons.length];
        set(next.getAttribute('data-value'));
        next.focus();
      });
    });
    onChange(render);
    render();
    return {
      setTeamsAvailable: function (available) { teamsAvailable = Boolean(available); render(); },
    };
  }

  set(get());
  window.AlertDestination = { get: get, set: set, onChange: onChange, mount: mount };
})();
