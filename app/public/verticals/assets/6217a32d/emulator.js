/* global document, window, location, navigator, ResizeObserver, fetch, AbortController */
(function () {
  if (document.documentElement.dataset.view !== 'console') return;
  const root = document.getElementById('emulator');
  const paths = {
    play: '<path d="m9 5 10 7-10 7Z"/>',
    stop: '<rect x="6" y="6" width="12" height="12" rx="1"/>',
    screen: '<rect x="2" y="4" width="20" height="14" rx="2"/><path d="M8 22h8m-4-4v4"/>',
    log: '<path d="M6 3h12v18H6zM9 7h6M9 11h6m-6 4h4"/>',
    snapshot: '<rect x="3" y="6" width="18" height="15" rx="2"/><path d="M8 6V3h8v3"/><circle cx="12" cy="13" r="4"/>',
    copy: '<rect x="7" y="7" width="13" height="14" rx="2"/><path d="M16 7V3H3v14h4"/>',
    back: '<path d="m10 5-7 7 7 7M3 12h18"/>',
    home: '<path d="m3 11 9-8 9 8M5 9v12h5v-7h4v7h5V9"/>',
    power: '<path d="M12 2v10m-5-7a9 9 0 1 0 10 0"/>',
    up: '<path d="m6 15 6-6 6 6"/>', down: '<path d="m6 9 6 6 6-6"/>',
    left: '<path d="m15 6-6 6 6 6"/>', right: '<path d="m9 6 6 6-6 6"/>',
    plus: '<path d="M12 4v16M4 12h16"/>',
    info: '<circle cx="12" cy="12" r="9"/><path d="M12 10v7m0-11v1"/>',
    person: '<circle cx="12" cy="8" r="4"/><path d="M5 21v-4a7 7 0 0 1 14 0v4"/>',
  };
  const icon = (name) => `<svg viewBox="0 0 24 24" aria-hidden="true">${paths[name] || paths.info}</svg>`;
  const escape = (value) => String(value).replace(/[&<>"']/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[ch]);
  const profiles = { 'p-maya': 'Maya', 'p-jordan': 'Jordan', 'p-sam': 'Sam' };
  let nextId = 3;
  let current = null;
  let experience = 'overview';
  let frame = null;
  let screenObserver = null;
  let toastTimer;
  let dialogReturnFocus = null;
  let filters = { query: '', type: 'All', status: 'All' };

  function device(id, name, type) {
    return {
      id, name, type, running: false, started: 0, maxMinutes: 30, firmware: type === 'TV' ? '15.2.4-tv' : '15.2.4-player',
      esn: 'VIRTUAL-' + id.toUpperCase(), devMode: true, installed: true, profileId: 'p-maya', logs: [], degraded: false, alertSent: false,
      snapshots: [{ name: 'Roku ready', note: 'Prepared demo app and Maya profile', devMode: true, installed: true, profileId: 'p-maya' }],
    };
  }
  const devices = [device('tv-001', 'Roku QA TV', 'TV'), device('player-002', 'Playback validation', 'Player')];
  const customer = device('customer-tv', 'Customer TV', 'TV');

  root.innerHTML = `
    <header class="ce-header"><div class="ce-brand">Roku</div><div class="ce-product" id="ceProduct">Experiences</div><div class="ce-account">Workspace <span class="ce-account-mark">${icon('person')}</span></div></header>
    <nav class="ce-subnav" aria-label="Workspace navigation"><button data-action="overview" data-experience="overview">Overview</button><button data-action="customer" data-experience="customer">Customer experience</button><button data-action="devices" data-experience="developer">Cloud Emulator</button><a class="ce-environment" href="https://developer.roku.com/dev/docs/rce" target="_blank" rel="noopener noreferrer">RCE documentation ↗</a></nav>
    <main class="ce-main" id="ceMain"></main>
    <footer class="ce-footer"><span>Roku</span><span>TV experience · Cloud Emulator</span></footer>
    <dialog class="ce-dialog" id="ceDialog" aria-labelledby="ceDialogTitle"></dialog>
    <div class="ce-toast" id="ceToast" role="status" hidden></div>`;
  const main = document.getElementById('ceMain');
  const dialog = document.getElementById('ceDialog');

  function toast(message) {
    const node = document.getElementById('ceToast');
    node.textContent = message; node.hidden = false;
    clearTimeout(toastTimer); toastTimer = setTimeout(() => { node.hidden = true; }, 4500);
  }
  function elapsed(d) {
    const seconds = d.running ? Math.max(0, Math.floor((Date.now() - d.started) / 1000)) : 0;
    return [Math.floor(seconds / 3600), Math.floor(seconds / 60) % 60, seconds % 60].map((x) => String(x).padStart(2, '0')).join(':');
  }
  function status(d) { return `<span class="ce-status ${d.running ? 'running' : ''}">${d.running ? 'Running' : 'Stopped'}</span>`; }
  function action(d, name, symbol, label, disabled = false) {
    return `<button class="ce-icon-button" data-action="${name}" data-device="${d.id}" aria-label="${label} — ${escape(d.name)}" title="${label}" ${disabled ? 'disabled' : ''}>${icon(symbol)}</button>`;
  }
  function addLog(d, message, level = '') {
    d.logs.push({ time: new Date().toISOString().slice(11, 23), message, level });
    if (d.logs.length > 250) d.logs.shift();
    if (current === d) renderLogs();
  }
  function removeFrame() {
    if (frame) frame.remove();
    frame = null;
  }
  function disconnectScreen() {
    removeFrame();
    screenObserver?.disconnect(); screenObserver = null;
  }


  function goToExperience(next, push = true) {
    experience = ['customer', 'developer'].includes(next) ? next : 'overview';
    if (push) {
      const url = new URL(location.href);
      if (experience === 'overview') url.searchParams.delete('experience');
      else url.searchParams.set('experience', experience);
      window.history.pushState(null, '', url);
    }
    const label = experience === 'customer' ? 'Customer experience' : experience === 'developer' ? 'Cloud Emulator' : 'Experiences';
    document.title = label + ' | Roku';
    document.getElementById('ceProduct').textContent = label;
    main.classList.toggle('ce-customer', experience === 'customer');
    root.querySelectorAll('[data-experience]').forEach((button) => {
      if (button.dataset.experience === experience) button.setAttribute('aria-current', 'page');
      else button.removeAttribute('aria-current');
    });
    if (experience === 'customer') renderCustomer();
    else if (experience === 'developer') renderDevices();
    else renderOverview();
  }
  function renderOverview() {
    disconnectScreen(); current = null;
    main.innerHTML = `
      <section class="ce-intro"><div class="ce-eyebrow">STREAMING PLATFORM</div><h1>Two perspectives. One experience.</h1><p>Start with the viewer journey, or open the developer workspace.</p></section>
      <div class="ce-experience-grid">
        <section class="ce-experience-card"><div class="ce-experience-art ce-tv-art"><span>ROKU TV</span><strong>Your home for great TV.</strong></div><div class="ce-experience-copy"><div class="ce-eyebrow">CUSTOMER IMPACT → ON-CALL</div><h2>Customer experience</h2><p>Launch the TV app, observe Continue Watching, and follow the request evidence into the on-call response.</p><button class="ce-button ce-primary" data-action="customer">Open TV experience ${icon('screen')}</button></div></section>
        <section class="ce-experience-card"><div class="ce-experience-art ce-dev-art">${icon('screen')}<strong>Cloud Emulator</strong><span>Devices / Remote / Application log</span></div><div class="ce-experience-copy"><div class="ce-eyebrow">DEVELOPER WORKFLOW</div><h2>Build, reproduce, validate</h2><p>Run a device, launch the bundled app, use the remote, and inspect application requests in the developer console.</p><button class="ce-button" data-action="devices">Open Cloud Emulator ${icon('screen')}</button></div></section>
      </div><p class="ce-entry-note">Workspaces open idle. Launching the app and sending an on-call alert are separate actions.</p>`;
  }
  function incidentPanel() {
    return '<section class="ce-card ce-incident"><div><h3>On-Call response</h3><p id="ceIncidentStatus"></p></div><button class="ce-button" data-action="alert" id="ceAlert" disabled>Send on-call alert</button></section>';
  }
  function requestLog(hidden = true) {
    return `<section class="ce-log" id="ceLog" ${hidden ? 'hidden' : ''}><div class="ce-log-head"><h3>Application log</h3><span>Actual browser requests and local actions</span><button data-action="clear-logs">Clear</button></div><div class="ce-log-body" id="ceLogBody" role="log" aria-label="Application request log"></div></section>`;
  }
  function renderCustomer() {
    disconnectScreen(); current = customer; customer.running = true;
    main.innerHTML = `
      <div class="ce-customer-heading"><div><h1>Customer experience</h1><p>Choose a profile, then launch the TV app.</p></div><label class="ce-field">App profile<select id="ceProfile">${Object.entries(profiles).map(([id, name]) => `<option value="${id}" ${id === customer.profileId ? 'selected' : ''}>${name}</option>`).join('')}</select></label></div>
      <div class="ce-screen" id="ceScreen">${launcher(customer)}</div>
      <div class="ce-customer-tools"><button class="ce-button ce-primary" data-action="launch">Launch TV app</button><div class="ce-customer-remote" aria-label="TV remote"><button class="ce-icon-button" data-key="ArrowUp" aria-label="Up">${icon('up')}</button><button class="ce-icon-button" data-key="ArrowLeft" aria-label="Left">${icon('left')}</button><button class="ce-icon-button" data-key="Enter" aria-label="OK">OK</button><button class="ce-icon-button" data-key="ArrowRight" aria-label="Right">${icon('right')}</button><button class="ce-icon-button" data-key="ArrowDown" aria-label="Down">${icon('down')}</button><button class="ce-icon-button" data-key="Escape" aria-label="Back">${icon('back')}</button><button class="ce-icon-button" data-action="home" aria-label="Home">${icon('home')}</button></div><button class="ce-button" data-action="oncall">Open On-Call</button></div>
      <details class="ce-oncall-panel" id="ceOncall"><summary>On-Call workspace<span>Request evidence → alert → investigation → fix PR</span></summary><p>Inspect the request evidence below. Sending an alert is a manual handoff to the responder, not automatic monitor detection. Follow the investigation in #oncall-alerts; review its PR, tests, and before/after evidence before approving any deployment.</p>${incidentPanel()}${requestLog(false)}</details>`;
    screenObserver = new ResizeObserver(scaleScreen); screenObserver.observe(document.getElementById('ceScreen'));
    scaleScreen(); updateIncident(); renderLogs();
  }

  function renderDevices() {
    disconnectScreen(); current = null;
    main.innerHTML = `
      <div class="ce-title-row"><div><h1>Devices</h1><p>Create and manage virtual devices. You can add up to 25 devices of each type.</p></div><button class="ce-button ce-primary" data-action="add">${icon('plus')}Add Device</button></div>
      <section class="ce-card" aria-label="Virtual devices">
        <div class="ce-filter-row"><label class="ce-field">Device name<input id="ceSearch" placeholder="Search devices…" value="${escape(filters.query)}"></label><label class="ce-field">Device type<select id="ceType"><option>All</option><option>TV</option><option>Player</option></select></label><label class="ce-field">Status<select id="ceStatus"><option>All</option><option>Running</option><option>Stopped</option></select></label></div>
        <div class="ce-table-meta"><span>TV ${devices.filter((d) => d.type === 'TV').length}/25 · Player ${devices.filter((d) => d.type === 'Player').length}/25</span><span>Browser-local devices · Updated just now</span></div>
        <div class="ce-table-scroll"><table><thead><tr><th>Device name</th><th>Device type</th><th>Status</th><th>Run time</th><th>ESN</th><th>Firmware version</th><th>Actions</th></tr></thead><tbody id="ceDevices"></tbody></table></div>
      </section>
      <aside class="ce-notice">${icon('info')}<p><strong>Get started</strong>Start a device, choose View device, then launch Roku. Use View Log to inspect application requests.</p></aside>`;
    document.getElementById('ceType').value = filters.type;
    document.getElementById('ceStatus').value = filters.status;
    renderDeviceRows();
  }
  function renderDeviceRows() {
    const matches = devices.filter((d) => d.name.toLowerCase().includes(filters.query.toLowerCase()) && (filters.type === 'All' || filters.type === d.type) && (filters.status === 'All' || filters.status === (d.running ? 'Running' : 'Stopped')));
    document.getElementById('ceDevices').innerHTML = matches.length ? matches.map((d) => `<tr><td><div class="ce-device-name">${escape(d.name)}</div><div class="ce-device-description">${d.installed ? 'Roku app installed' : 'No sample app installed'}</div></td><td>${d.type}</td><td>${status(d)}</td><td data-runtime="${d.id}">${d.running ? elapsed(d) : '—'}</td><td>${d.esn}</td><td>${d.firmware}</td><td><div class="ce-actions">${action(d, d.running ? 'stop' : 'run', d.running ? 'stop' : 'play', d.running ? 'Stop device' : 'Run device')}${action(d, 'view', 'screen', 'View device', !d.running)}${action(d, 'logs', 'log', 'View logs')}${action(d, 'snapshot', 'snapshot', 'Save snapshot')}${action(d, 'copy', 'copy', 'Copy ESN')}</div></td></tr>`).join('') : '<tr><td colspan="7" class="ce-empty">No devices match these filters.</td></tr>';
  }
  function openDialog(title, fields, submitText, onSubmit) {
    dialogReturnFocus = document.activeElement;
    dialog.innerHTML = `<form><h2 id="ceDialogTitle">${escape(title)}</h2>${fields}<div class="ce-dialog-error" id="ceDialogError" role="alert"></div><div class="ce-dialog-actions"><button type="button" class="ce-button ce-quiet" data-close>Cancel</button><button class="ce-button ce-primary" type="submit">${escape(submitText)}</button></div></form>`;
    dialog.querySelector('[data-close]').onclick = () => dialog.close();
    dialog.querySelector('form').onsubmit = async (event) => {
      event.preventDefault();
      const submit = dialog.querySelector('[type="submit"]'); submit.disabled = true;
      try {
        const error = await onSubmit(new window.FormData(event.target));
        if (error) document.getElementById('ceDialogError').textContent = error;
        else dialog.close();
      } catch { document.getElementById('ceDialogError').textContent = 'That action could not be completed. Try again.'; }
      finally { submit.disabled = false; }
    };
    dialog.showModal();
  }
  dialog.addEventListener('close', () => { if (dialogReturnFocus?.isConnected) dialogReturnFocus.focus(); });

  function addDevice() {
    openDialog('Add device', '<p>Add a browser-local device. No cloud instance is provisioned.</p><label class="ce-field">Device name<input name="name" maxlength="60" required placeholder="e.g. QA living room"></label><label class="ce-field">Device type<select name="type"><option>TV</option><option>Player</option></select></label>', 'Add', (form) => {
      const name = String(form.get('name')).trim(); const type = form.get('type');
      if (!name) return 'Enter a device name.';
      if (devices.some((d) => d.name.toLowerCase() === name.toLowerCase())) return 'A device already uses this name.';
      if (devices.filter((d) => d.type === type).length >= 25) return 'The demo supports 25 devices of each type.';
      devices.push(device('device-' + nextId++, name, type));
      filters = { query: '', type: 'All', status: 'All' }; renderDevices(); toast('Device added. Choose Run device to start.');
    });
  }
  function runDevice(d) {
    openDialog('Run device', `<p>${escape(d.name)} · ${d.type}. </p><label class="ce-field">Firmware version<select name="firmware"><option value="15.2.4-${d.type.toLowerCase()}">15.2.4 — current release</option><option value="16.0.0-${d.type.toLowerCase()}">16.0.0 — next release</option></select></label><label class="ce-field">Max run time<select name="minutes"><option value="15">15 minutes</option><option value="30" selected>30 minutes</option><option value="60">1 hour</option></select></label><label class="ce-field">Use this snapshot<select name="snapshot">${d.snapshots.map((s, i) => `<option value="${i}">${escape(s.name)}</option>`).join('')}</select></label>`, 'Run device', (form) => {
      const snapshot = d.snapshots[Number(form.get('snapshot'))];
      Object.assign(d, { running: true, started: Date.now(), maxMinutes: Number(form.get('minutes')), firmware: String(form.get('firmware')), devMode: snapshot.devMode, installed: snapshot.installed, profileId: snapshot.profileId, degraded: false, alertSent: false, alertMessage: '' });
      addLog(d, `EMULATOR Device started · ${d.firmware} · snapshot ${snapshot.name}`);
      renderDevices(); toast('Device running. Choose View device to open the viewer.');
    });
  }
  function stopDevice(d) {
    d.running = false;
    addLog(d, 'EMULATOR Device stopped.');
    if (current === d || !current) renderDevices();
    toast('Device stopped.');
  }
  function saveSnapshot(d) {
    openDialog('Add snapshot', `<p>Saves app installation, developer-mode setting and selected profile for this browser session.</p><label class="ce-field">Snapshot name<input name="name" maxlength="60" required></label><label class="ce-field">Note<input name="note" maxlength="200"></label><div>${d.snapshots.map((s) => `<div class="ce-snapshot-item">${escape(s.name)}<small>${escape(s.note)}</small></div>`).join('')}</div>`, 'Save', (form) => {
      const name = String(form.get('name')).trim();
      if (!name || d.snapshots.some((s) => s.name.toLowerCase() === name.toLowerCase())) return 'Use a unique, nonempty snapshot name.';
      if (d.snapshots.length >= 20) return 'This demo supports up to 20 snapshots per device.';
      d.snapshots.push({ name, note: String(form.get('note')), devMode: d.devMode, installed: d.installed, profileId: d.profileId });
      addLog(d, 'EMULATOR Snapshot saved: ' + name); toast('Snapshot saved for this browser session.');
    });
  }

  function launcher(d) {
    return `<div class="ce-launcher" id="ceLauncher"><div class="ce-launcher-top"><strong>Roku TV</strong><span>Home</span><small>Virtual device</small></div><div class="ce-launcher-grid"><div class="ce-launcher-nav"><b>Home</b><div>Streaming apps</div><div>Settings</div></div><div><h3>Quick access</h3><button class="ce-app-tile" data-action="launch" aria-label="Launch Roku"><strong>Roku</strong><span>${d.installed ? 'Press OK to launch' : 'Install the bundled app'}</span></button><div class="ce-launcher-copy">${d.installed ? 'Your shows. Ready when you are.' : 'Enable Dev Mode, then choose Sideload.'}</div></div><div class="ce-promo"><small>FEATURED TITLE</small><strong>NORTHERN<br>LIGHTS</strong><span>A world of stories awaits.</span></div></div></div>`;
  }
  function renderViewer(d) {
    if (!d.running) return;
    disconnectScreen(); current = d;
    main.innerHTML = `
      <div class="ce-breadcrumb"><button data-action="devices">Devices</button><span>/</span><span>${escape(d.name)}</span></div>
      <div class="ce-viewer-heading"><h1>${escape(d.name)}</h1>${status(d)}<label class="ce-field">App profile<select id="ceProfile">${Object.entries(profiles).map(([id, name]) => `<option value="${id}" ${id === d.profileId ? 'selected' : ''}>${name}</option>`).join('')}</select></label><button class="ce-button ce-quiet" data-action="snapshot">${icon('snapshot')}Snapshot</button></div>
      <div class="ce-viewer-grid"><div class="ce-screen-area"><div class="ce-screen" id="ceScreen">${launcher(d)}</div><div class="ce-screen-meta"><span>Current run time: <b data-runtime="${d.id}">${elapsed(d)}</b></span><span>1440 × 810 · Browser preview</span><span>${escape(d.firmware)}</span></div></div>
      <aside class="ce-remote"><h3>Remote</h3><p>Use this remote to navigate and interact with the demo app.</p>
        <div class="ce-remote-top"><button class="ce-icon-button" data-key="Escape" aria-label="Back">${icon('back')}</button><button class="ce-icon-button" data-action="home" aria-label="Home">${icon('home')}</button><button class="ce-icon-button" data-action="stop" aria-label="Stop device">${icon('power')}</button></div>
        <div class="ce-dpad" aria-label="Directional controls"><button data-key="ArrowUp" aria-label="Up">${icon('up')}</button><button data-key="ArrowLeft" aria-label="Left">${icon('left')}</button><button data-key="Enter" aria-label="OK">OK</button><button data-key="ArrowRight" aria-label="Right">${icon('right')}</button><button data-key="ArrowDown" aria-label="Down">${icon('down')}</button></div>
        <div class="ce-media"><button class="ce-icon-button" data-key="Enter" aria-label="Select or close playback">${icon('play')}</button><button class="ce-icon-button" data-action="home" aria-label="Return to device home">${icon('screen')}</button></div>
        <div class="ce-remote-tools"><button class="ce-button" data-action="wake">Wake Device</button><button class="ce-button" data-action="dev-mode" id="ceDevMode">Dev Mode: ${d.devMode ? 'on' : 'off'}</button><button class="ce-button" data-action="logs">View Log</button><button class="ce-button" data-action="sideload" id="ceSideload" ${d.devMode ? '' : 'disabled'}>Sideload</button></div>
        <div class="ce-remote-help">Arrow keys · Enter / OK · Esc / Back<br>Home returns to the device launcher.</div>
      </aside></div>
      ${incidentPanel()}
      ${requestLog()}`;
    screenObserver = new ResizeObserver(scaleScreen); screenObserver.observe(document.getElementById('ceScreen'));
    scaleScreen(); updateIncident(); renderLogs();
  }
  function scaleScreen() {
    const screen = document.getElementById('ceScreen'); if (!screen) return;
    const target = frame || document.getElementById('ceLauncher');
    if (target) target.style.transform = `scale(${screen.clientWidth / 1440})`;
  }
  function home() {
    if (!current?.running) return;
    removeFrame();
    document.getElementById('ceScreen').innerHTML = launcher(current);
    scaleScreen();
    addLog(current, 'EMULATOR Returned to device Home.');
  }
  function launchApp() {
    const d = current;
    if (!d?.running) return;
    if (!d.installed) { toast('Enable Dev Mode and use Sideload to install the bundled app.'); return; }
    removeFrame();
    const screen = document.getElementById('ceScreen'); screen.innerHTML = '';
    frame = document.createElement('iframe'); frame.title = 'Roku app preview';
    const url = new URL(location.pathname, location.origin);
    url.searchParams.set('view', 'tv'); url.searchParams.set('embed', '1'); url.searchParams.set('profileId', d.profileId);
    frame.src = url.href; screen.appendChild(frame); scaleScreen();
    addLog(d, `EMULATOR Launching bundled Roku web app · profile ${profiles[d.profileId]}.`);
    frame.addEventListener('load', () => frame?.contentWindow.focus(), { once: true });
  }
  function sendKey(key) {
    if (!current?.running) return;
    if (!frame) { if (key === 'Enter') launchApp(); return; }
    frame.contentWindow.postMessage({ source: 'streamtv-emulator', type: 'key', key }, location.origin);
  }
  function updateIncident() {
    if (!current) return;
    const button = document.getElementById('ceAlert');
    button.disabled = !current.degraded || current.alertSent;
    button.textContent = current.alertSent ? 'Alert delivered' : 'Send on-call alert';
    document.getElementById('ceIncidentStatus').textContent = current.alertMessage || (current.degraded ? 'Slow or failed home API request observed. Review the log, then explicitly send an alert to page on-call.' : 'Launch Roku to observe the home API. Alerts stay off until you explicitly send one.');
  }
  function renderLogs() {
    const log = document.getElementById('ceLogBody'); if (!log || !current) return;
    log.replaceChildren();
    current.logs.forEach((entry) => {
      const row = document.createElement('div'); row.className = 'ce-log-' + entry.level;
      row.textContent = `${entry.time}  ${entry.message}`; log.appendChild(row);
    });
    if (!current.logs.length) log.textContent = 'No events yet. Launch the app to observe API requests.';
    log.scrollTop = log.scrollHeight;
  }
  function showLogs(d) {
    if (current === d) { const panel = document.getElementById('ceLog'); panel.hidden = !panel.hidden; renderLogs(); return; }
    openDialog('Application log', `<p>Browser requests and local emulator actions.</p><pre style="white-space:pre-wrap;font-size:11px;max-height:280px;overflow:auto">${escape(d.logs.map((l) => l.time + ' ' + l.message).join('\n') || 'No events yet.')}</pre>`, 'Done', () => {});
  }
  function sideload() {
    if (!current?.devMode) return;
    const d = current;
    openDialog('Development Application Installer', '<p>Install the bundled Roku app into this device.</p><div class="ce-notice"><p><strong>sample-channel · browser build</strong>This installs a web preview only. It does not upload or execute native app packages.</p></div>', 'Install sample app', () => {
      d.installed = true; addLog(d, 'EMULATOR Bundled web app installed.'); home(); toast('Roku installed. Press OK to launch.');
    });
  }
  function sendAlert() {
    const d = current; if (!d?.degraded || d.alertSent) return;
    openDialog('Send a real on-call alert?', '<p>This posts to <strong>#oncall-alerts</strong> through the existing demo backend and may start the real responder automation.</p><p>Continue only when you are ready to demonstrate the on-call response.</p>', 'Send on-call alert', async () => {
      const controller = new AbortController(); const timer = setTimeout(() => controller.abort(), 12000);
      try {
        const response = await fetch('/api/oncall/trigger/streamtv', { method: 'POST', headers: { 'Content-Type': 'application/json' }, signal: controller.signal, body: JSON.stringify({ unique: true, skin: '6217a32d', alertDestination: 'slack', devinUserId: window.localStorage.getItem('devinUserId') || '', devinOrgId: window.localStorage.getItem('devinOrgId') || '', devinEmail: window.localStorage.getItem('devinEmail') || '' }) });
        const result = await response.json();
        d.alertSent = Boolean(response.ok && result.ok && !result.skipped);
        d.alertMessage = d.alertSent ? 'Alert delivered to the on-call channel.' : 'No alert delivered. Check Slack configuration before retrying.';
        addLog(d, `ALERT HTTP ${response.status} · ${d.alertMessage}`, d.alertSent ? 'ok' : 'warn');
        updateIncident(); toast(d.alertMessage);
      } catch { d.alertMessage = 'Alert delivery could not be confirmed. Check the channel before retrying.'; updateIncident(); return d.alertMessage; }
      finally { clearTimeout(timer); }
    });
  }

  root.addEventListener('click', async (event) => {
    const button = event.target.closest('button'); if (!button || button.disabled) return;
    if (button.dataset.key) { sendKey(button.dataset.key); return; }
    const d = button.dataset.device ? devices.find((item) => item.id === button.dataset.device) : current;
    switch (button.dataset.action) {
      case 'overview': goToExperience('overview'); break;
      case 'customer': goToExperience('customer'); break;
      case 'devices': goToExperience('developer'); break;
      case 'oncall': { const panel = document.getElementById('ceOncall'); panel.open = true; panel.scrollIntoView({ behavior: 'smooth', block: 'start' }); break; }
      case 'add': addDevice(); break;
      case 'run': runDevice(d); break;
      case 'stop': stopDevice(d); break;
      case 'view': renderViewer(d); break;
      case 'snapshot': saveSnapshot(d); break;
      case 'logs': showLogs(d); break;
      case 'copy': try { await navigator.clipboard.writeText(d.esn); toast('ESN copied.'); } catch { toast('Clipboard unavailable. ESN: ' + d.esn); } break;
      case 'home': home(); break;
      case 'launch': launchApp(); break;
      case 'wake': toast('Device is awake and ready.'); break;
      case 'dev-mode': d.devMode = !d.devMode; button.textContent = 'Dev Mode: ' + (d.devMode ? 'on' : 'off'); document.getElementById('ceSideload').disabled = !d.devMode; addLog(d, 'EMULATOR Developer mode ' + (d.devMode ? 'enabled' : 'disabled') + '.'); break;
      case 'sideload': sideload(); break;
      case 'alert': sendAlert(); break;
      case 'clear-logs': current.logs = []; renderLogs(); break;
    }
  });
  root.addEventListener('input', (event) => {
    if (event.target.id === 'ceSearch') { filters.query = event.target.value; renderDeviceRows(); }
  });
  root.addEventListener('change', (event) => {
    if (event.target.id === 'ceType') { filters.type = event.target.value; renderDeviceRows(); }
    if (event.target.id === 'ceStatus') { filters.status = event.target.value; renderDeviceRows(); }
    if (event.target.id === 'ceProfile' && current) {
      current.profileId = event.target.value;
      if (frame) launchApp(); else toast('App profile selected: ' + profiles[current.profileId]);
    }
  });
  document.addEventListener('keydown', (event) => {
    if (!current || dialog.open || event.target.closest('input,select,textarea,a,summary')) return;
    if (event.key === 'Enter' && event.target.closest('button')) return;
    if (event.key === 'Home') { event.preventDefault(); home(); return; }
    if (['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'Enter', 'Escape'].includes(event.key)) {
      if (event.target.closest('.ce-remote-tools,.ce-incident,.ce-breadcrumb,.ce-viewer-heading,.ce-log-head,.ce-subnav,.ce-oncall-panel,.ce-customer-tools,.ce-customer-heading')) return;
      event.preventDefault(); sendKey(event.key);
    }
  });
  window.addEventListener('message', (event) => {
    if (event.origin !== location.origin || !frame || event.source !== frame.contentWindow || !current?.running) return;
    const data = event.data;
    if (!data || data.source !== 'streamtv-emulator') return;
    if (data.type === 'profile' && Object.hasOwn(profiles, data.profileId)) {
      current.profileId = data.profileId;
      document.getElementById('ceProfile').value = data.profileId;
      addLog(current, 'EMULATOR App profile selected: ' + profiles[data.profileId]);
      return;
    }
    if (data.type === 'home') { home(); return; }
    if (data.type === 'ready') { addLog(current, 'EMULATOR Web preview ready. Automatic on-call alerts are held in manual mode.'); return; }
    if (data.type === 'alert-held') { addLog(current, 'ALERT Automatic trigger held. Use Send on-call alert to explicitly page on-call.', 'warn'); return; }
    if (data.type !== 'request' || !['/api/home/rows', '/api/home/continue-watching', '/api/playback/start'].includes(data.path)) return;
    if (data.phase === 'start') { addLog(current, `REQUEST ${data.method} ${data.path} · started`); return; }
    if (data.phase !== 'end' || !Number.isFinite(data.durationMs)) return;
    const statusText = data.status ? `HTTP ${data.status}` : 'NETWORK ERROR';
    addLog(current, `REQUEST ${data.method} ${data.path} · ${statusText} · ${data.durationMs}ms${data.error ? ' · ' + data.error : ''}`, data.status >= 500 || !data.status ? 'error' : data.durationMs > 2000 ? 'warn' : 'ok');
    if (data.path === '/api/home/continue-watching' && (data.status >= 500 || data.durationMs > 2000)) { current.degraded = true; current.alertMessage = ''; updateIncident(); }
  });
  setInterval(() => {
    devices.forEach((d) => {
      if (d.running && Date.now() - d.started >= d.maxMinutes * 60000) { stopDevice(d); return; }
      document.querySelectorAll(`[data-runtime="${d.id}"]`).forEach((node) => { node.textContent = d.running ? elapsed(d) : '—'; });
    });
  }, 1000);
  window.addEventListener('popstate', () => goToExperience(new URL(location.href).searchParams.get('experience'), false));
  goToExperience(new URL(location.href).searchParams.get('experience'), false);
})();
