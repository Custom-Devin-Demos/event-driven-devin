/* global URLSearchParams, window, document */

const reportsOff = new URLSearchParams(window.location.search).get('reports') === 'off';
if (reportsOff) {
  for (const link of document.querySelectorAll('a[href="/healthie/see-a-demo"]')) {
    link.href += '?reports=off';
  }
}
