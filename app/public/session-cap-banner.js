/* global document, fetch */
/**
 * Session Cap Banner — subtle UI notification when the global Devin session
 * cap has been reached. Polls /api/admin/session-stats periodically and
 * shows/hides a small banner at the top of the page.
 *
 * Usage: include <script src="/session-cap-banner.js"></script> on any page.
 */
(function () {
  var POLL_INTERVAL_MS = 15000; // check every 15 seconds
  var bannerId = 'session-cap-banner';

  function createBanner() {
    if (document.getElementById(bannerId)) return;

    var banner = document.createElement('div');
    banner.id = bannerId;
    banner.setAttribute('role', 'status');
    banner.setAttribute('aria-live', 'polite');

    // Inline styles so it works on every page without extra CSS imports
    Object.assign(banner.style, {
      display: 'none',
      position: 'fixed',
      bottom: '0',
      left: '0',
      right: '0',
      zIndex: '9999',
      padding: '10px 20px',
      background: 'rgba(15, 19, 28, 0.92)',
      backdropFilter: 'blur(8px)',
      color: 'rgba(234, 240, 249, 0.85)',
      fontFamily: "'IBM Plex Sans', -apple-system, BlinkMacSystemFont, sans-serif",
      fontSize: '13px',
      fontWeight: '500',
      textAlign: 'center',
      letterSpacing: '0.01em',
      lineHeight: '1.5',
      borderTop: '1px solid rgba(124, 138, 255, 0.25)',
      transition: 'transform 0.3s ease, opacity 0.3s ease',
      transform: 'translateY(100%)',
      opacity: '0',
    });

    document.body.appendChild(banner);
    return banner;
  }

  function showBanner(stats) {
    var banner = document.getElementById(bannerId) || createBanner();
    if (!banner) return;

    var retryText = '';
    if (stats.oldestSessionAgeSeconds != null) {
      var remaining = Math.max(Math.ceil(stats.windowMinutes * 60 - stats.oldestSessionAgeSeconds), 1);
      var mins = Math.ceil(remaining / 60);
      retryText = mins <= 1
        ? ' \u00B7 capacity frees up in under a minute'
        : ' \u00B7 capacity frees up in ~' + mins + ' min';
    }

    banner.textContent = 'Session limit reached (' + stats.current + '/' + stats.max
      + ' in ' + stats.windowMinutes + ' min)' + retryText
      + ' \u2014 try again shortly';

    banner.style.display = 'block';
    // Force reflow before transition
    void banner.offsetHeight;
    banner.style.transform = 'translateY(0)';
    banner.style.opacity = '1';
  }

  function hideBanner() {
    var banner = document.getElementById(bannerId);
    if (!banner) return;

    banner.style.transform = 'translateY(100%)';
    banner.style.opacity = '0';
    setTimeout(function () {
      banner.style.display = 'none';
    }, 300);
  }

  function poll() {
    fetch('/api/admin/session-stats')
      .then(function (res) { return res.json(); })
      .then(function (stats) {
        if (stats.remaining === 0) {
          showBanner(stats);
        } else {
          hideBanner();
        }
      })
      .catch(function () {
        // Silently ignore — don't show banner on network errors
        hideBanner();
      });
  }

  // Initial check shortly after page load, then poll
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', function () {
      setTimeout(poll, 1000);
    });
  } else {
    setTimeout(poll, 1000);
  }
  setInterval(poll, POLL_INTERVAL_MS);
})();
