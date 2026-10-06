/* global document, location, localStorage, window */
/* Per-browser "Send alerts to: Slack / Teams / Both" choice shared by the
 * demo hubs. Saved in localStorage and mirrored into the alert_destination
 * cookie so the demo pages' API requests carry it to the server. */
(function () {
  var VALUES = ['slack', 'teams', 'both'];
  var KEY = 'alertDestination';

  function writeCookie(value) {
    document.cookie = 'alert_destination=' + value + '; Path=/; Max-Age=31536000; SameSite=Lax'
      + (location.protocol === 'https:' ? '; Secure' : '');
  }

  function get() {
    var value = localStorage.getItem(KEY);
    if (VALUES.indexOf(value) !== -1) return value;
    // Earlier On-Call hub builds stored an on/off "also post to Teams" toggle.
    return localStorage.getItem('oncallTeamsAlerts') === 'on' ? 'both' : 'slack';
  }

  function set(value) {
    if (VALUES.indexOf(value) === -1) value = 'slack';
    localStorage.setItem(KEY, value);
    localStorage.removeItem('oncallTeamsAlerts');
    writeCookie(value);
    return value;
  }

  set(get());
  window.AlertDestination = { get: get, set: set };
})();
