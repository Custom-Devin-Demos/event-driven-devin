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
    + '.adp{display:flex;align-items:center;justify-content:space-between;gap:12px 20px;flex-wrap:wrap;padding:14px 16px;border:1px solid rgba(15,19,28,.08);border-radius:12px;background:#fff;font-family:inherit;letter-spacing:normal}'
    + '.adp-text{display:flex;flex-direction:column;gap:3px;min-width:0;flex:1 1 260px}'
    + '.adp-title{display:flex;align-items:center;gap:8px;flex-wrap:wrap;font-size:14px;font-weight:600;color:#0f131c}'
    + '.adp-scope{font-size:10px;font-weight:600;letter-spacing:.06em;text-transform:uppercase;color:#6b7280;border:1px solid rgba(15,19,28,.12);border-radius:999px;padding:1px 8px;cursor:help}'
    + '.adp-summary{display:flex;align-items:center;gap:6px;font-size:13px;font-weight:500;line-height:1.45;color:#6b7280}'
    + '.adp-summary svg{width:14px;height:14px;flex:none}'
    + '.adp-summary b{color:#0f131c;font-weight:600}'
    + '.adp-summary.warn{color:#b45309}'
    + '.adp-seg{display:inline-flex;gap:4px;padding:4px;border-radius:11px;background:#eef0f3}'
    + '.adp-opt{display:inline-flex;align-items:center;gap:8px;padding:8px 18px;border:0;border-radius:8px;background:transparent;color:#4b5563;font:inherit;font-size:13px;font-weight:600;line-height:1;cursor:pointer;transition:background .15s,color .15s,box-shadow .15s}'
    + '.adp-opt svg{width:16px;height:16px;transition:filter .15s,opacity .15s}'
    + '.adp-opt:not(.on) svg{filter:grayscale(1);opacity:.55}'
    + '.adp-opt:hover:not(.on){color:#0f131c}'
    + '.adp-opt:hover:not(.on) svg{filter:none;opacity:.9}'
    + '.adp-opt.on{background:#fff;color:#0f131c;box-shadow:0 1px 2px rgba(15,19,28,.12),0 0 0 1px rgba(15,19,28,.06)}'
    + '.adp-opt.on[data-value=slack]{box-shadow:0 1px 2px rgba(15,19,28,.12),inset 0 -2px 0 #4A154B}'
    + '.adp-opt.on[data-value=teams]{box-shadow:0 1px 2px rgba(15,19,28,.12),inset 0 -2px 0 #5B5FC7}'
    + '.adp-opt:focus-visible{outline:2px solid #7c8aff;outline-offset:2px}'
    + '.adp-opt{white-space:nowrap}@media (max-width:560px){.adp-seg{width:100%}.adp-opt{flex:1;justify-content:center;padding:9px 10px}}';

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
      + '<div class="adp-text">'
      + '<div class="adp-title" id="adp-title">Send my demo alerts to'
      + '<span class="adp-scope" title="Saved in this browser and shared by the demo hub and the On-Call hub. It never changes anyone else\'s alerts.">This browser only</span></div>'
      + '<div class="adp-summary" aria-live="polite"></div>'
      + '</div>'
      + '<div class="adp-seg" role="radiogroup" aria-labelledby="adp-title">'
      + '<button type="button" class="adp-opt" role="radio" data-value="slack">' + SLACK_ICON + 'Slack</button>'
      + '<button type="button" class="adp-opt" role="radio" data-value="teams">' + TEAMS_ICON + 'Microsoft Teams</button>'
      + '</div></div>';
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
