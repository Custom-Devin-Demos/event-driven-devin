/* global document, window, localStorage, location, fetch, AbortController, Option */
(() => {
  const $ = id => document.getElementById(id);
  const identity = key => { try { return localStorage.getItem(key) || undefined; } catch { return undefined; } };
  const DEFAULTS = { specialty: 'cardiovascular-medicine', carrier: 'Blue Cross and Blue Shield of Minnesota', campus: 'rochester' };
  const FLOW = ['screen-who', 'screen-patient', 'screen-concerns', 'screen-insurance', 'screen-preferences'];
  const STEP_ORDER = ['patient', 'concerns', 'insurance', 'preferences', 'follow-up'];
  let catalog = null; let current = 'screen-who'; let submitted = null; let busy = false;

  function show(id) {
    document.querySelectorAll('.screen').forEach(s => { s.hidden = s.id !== id; });
    current = id;
    const step = $(id).dataset.step;
    const part2 = ['screen-follow-up', 'screen-done'].includes(id);
    $('steps-part2').hidden = !part2; $('part2-note').hidden = part2;
    const index = id === 'screen-done' ? STEP_ORDER.length : STEP_ORDER.indexOf(step);
    document.querySelectorAll('[data-step-for]').forEach(li => {
      const i = STEP_ORDER.indexOf(li.dataset.stepFor);
      li.classList.toggle('done', index >= 0 && i < index);
      li.classList.toggle('current', i === index);
    });
    window.scrollTo({ top: 0 });
    $(id).querySelector('h1')?.focus?.();
  }
  function route() {
    const onRequest = location.hash === '#request';
    $('landing').hidden = onRequest; $('request').hidden = !onRequest;
    document.title = onRequest ? 'Request an appointment | Request an Appointment | Mayo Clinic' : 'Appointments at Mayo Clinic';
    if (onRequest && !['screen-follow-up', 'screen-done'].includes(current)) show(current);
  }
  function fieldError(input, message) {
    input.setAttribute('aria-invalid', 'true');
    let p = input.parentElement.querySelector('.field-error');
    if (!p) { p = document.createElement('p'); p.className = 'field-error'; input.parentElement.append(p); }
    p.textContent = message; input.focus(); return false;
  }
  function clearErrors(form) {
    form.querySelectorAll('[aria-invalid]').forEach(i => i.removeAttribute('aria-invalid'));
    form.querySelectorAll('.field-error').forEach(p => p.remove());
  }
  const checks = {
    'screen-who': () => radio('isPatient') === 'yes' || $('relationship').value.trim().length >= 2 || fieldError($('relationship'), 'Tell us your relationship to the patient.'),
    'screen-patient': () => ($('firstName').value.trim() || fieldError($('firstName'), 'Enter a first name.'))
      && ($('lastName').value.trim() || fieldError($('lastName'), 'Enter a last name.'))
      && ($('dob').value || fieldError($('dob'), 'Enter a date of birth.'))
      && ($('email').checkValidity() && $('email').value || fieldError($('email'), 'Enter a valid email address.'))
      && ($('phone').value.replace(/\D/g, '').length === 10 || fieldError($('phone'), 'Enter a 10-digit phone number.')),
    'screen-concerns': () => ($('specialty').value || fieldError($('specialty'), 'Choose a type of care.'))
      && ($('concern').value.trim().length >= 10 || fieldError($('concern'), 'Tell us a little more (at least 10 characters).')),
    'screen-insurance': () => radio('payment') === 'self-pay' || /^[A-Za-z0-9-]{3,30}$/.test($('memberId').value) || fieldError($('memberId'), 'Enter your member ID.'),
    'screen-preferences': () => true,
  };
  function radio(name) { return document.querySelector(`input[name="${name}"]:checked`)?.value; }
  function buildRequest() {
    const isPatient = radio('isPatient') === 'yes';
    return {
      isPatient, requesterRelationship: isPatient ? undefined : $('relationship').value,
      patient: { firstName: $('firstName').value, lastName: $('lastName').value, dateOfBirth: $('dob').value, email: $('email').value, phone: $('phone').value },
      specialty: $('specialty').value, concern: $('concern').value,
      insurance: radio('payment') === 'insurance' ? { type: 'insurance', carrier: $('carrier').value, memberId: $('memberId').value } : { type: 'self-pay' },
      campus: radio('campus'), contactPreference: $('contact').value,
    };
  }
  function showError(result) {
    const campus = catalog?.campuses.find(c => c.id === radio('campus'));
    if (campus) { $('error-phone').textContent = campus.phone; $('error-phone').href = `tel:${campus.phone.replace(/\D/g, '')}`; }
    $('error-reference').textContent = result.requestId ? `Reference: ${result.requestId}` : 'Reference unavailable';
    $('error-text').textContent = `${result.errorClass || 'Error'}: ${result.error || 'Please try again.'}`;
    show('screen-error');
  }
  async function post(url, body) {
    const controller = new AbortController(); const timer = setTimeout(() => controller.abort(), 20000);
    try {
      const response = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body), signal: controller.signal });
      const result = await response.json().catch(() => ({ success: false, error: `HTTP ${response.status}` }));
      return response.ok && result.success ? result : { ...result, success: false };
    } catch (error) {
      return { success: false, errorClass: 'NetworkError', error: error.name === 'AbortError' ? 'The request timed out.' : 'We could not reach Mayo Clinic.' };
    } finally { clearTimeout(timer); }
  }
  async function submitRequest() {
    if (busy) return; busy = true;
    const button = $('submit-request'); button.disabled = true; button.textContent = 'Submitting…';
    const result = await post('/api/8d8c2937/appointment-requests', {
      request: buildRequest(), devinUserId: identity('devinUserId'), devinOrgId: identity('devinOrgId'), devinEmail: identity('devinEmail'),
    });
    busy = false; button.disabled = false; button.textContent = 'Submit request';
    if (!result.success) { showError(result); return; }
    submitted = result;
    $('follow-up-sub').textContent = `Your ${result.specialty} request for Mayo Clinic in ${result.campus} was received (request ${result.requestId}). When should an appointment coordinator ${$('contact').value === 'phone' ? 'call' : 'email'} you?`;
    $('windows').replaceChildren(...result.followUpWindows.map((w, i) => card('window', w.id, w.label, '', i === 0)));
    show('screen-follow-up');
  }
  async function confirmFollowUp() {
    if (busy || !submitted) return; busy = true;
    const button = $('confirm-follow-up'); button.disabled = true; button.textContent = 'Confirming…';
    const result = await post(`/api/8d8c2937/appointment-requests/${encodeURIComponent(submitted.requestId)}/follow-up`, { windowId: radio('window') });
    busy = false; button.disabled = false; button.textContent = 'Confirm follow-up time';
    if (!result.success) { showError(result); return; }
    $('done-title').textContent = `Thanks, ${result.firstName}. Your request is in.`;
    $('done-message').textContent = 'An appointment coordinator will reach out at the time you selected to review your medical records and schedule your visit.';
    const rows = [['Request number', result.requestId], ['Type of care', submitted.specialty], ['Location', `Mayo Clinic in ${submitted.campus}`], ['Follow-up', result.followUp.label]];
    $('done-summary').replaceChildren(...rows.flatMap(([k, v]) => { const dt = document.createElement('dt'); dt.textContent = k; const dd = document.createElement('dd'); dd.textContent = v; return [dt, dd]; }));
    show('screen-done');
  }
  function card(name, value, title, detail, checked) {
    const label = document.createElement('label'); label.className = 'card';
    const input = document.createElement('input'); input.type = 'radio'; input.name = name; input.value = value; input.checked = checked;
    const span = document.createElement('span'); const strong = document.createElement('strong'); strong.textContent = title;
    span.append(strong); if (detail) span.append(detail);
    label.append(input, span); return label;
  }
  async function loadCatalog() {
    try {
      const response = await fetch('/api/8d8c2937/catalog'); if (!response.ok) throw new Error();
      catalog = await response.json();
    } catch { $('specialty').replaceChildren(new Option('Unable to load — refresh the page', '')); return; }
    $('specialty').replaceChildren(new Option('Select type of care', ''), ...catalog.specialties.map(s => new Option(s.label, s.id, false, s.id === DEFAULTS.specialty)));
    $('carrier').replaceChildren(...catalog.insurers.map(i => new Option(i, i, false, i === DEFAULTS.carrier)));
    $('campuses').replaceChildren(...catalog.campuses.map(c => card('campus', c.id, `Mayo Clinic in ${c.label}`, `Central Appointment Office ${c.phone}`, c.id === DEFAULTS.campus)));
    hint();
  }
  function hint() { $('specialty-hint').textContent = catalog?.specialties.find(s => s.id === $('specialty').value)?.hint || ''; }

  FLOW.forEach((id, i) => {
    $(id).addEventListener('submit', event => {
      event.preventDefault(); clearErrors($(id));
      if (!checks[id]()) return;
      if (id === 'screen-preferences') submitRequest(); else show(FLOW[i + 1]);
    });
    $(id).querySelector('[data-back]')?.addEventListener('click', () => show(FLOW[i - 1]));
  });
  $('screen-follow-up').addEventListener('submit', event => { event.preventDefault(); confirmFollowUp(); });
  $('error-back').onclick = () => show('screen-preferences');
  $('error-retry').onclick = () => { show('screen-preferences'); submitRequest(); };
  document.querySelectorAll('input[name="isPatient"]').forEach(r => r.addEventListener('change', () => { $('relationship-field').hidden = radio('isPatient') === 'yes'; }));
  document.querySelectorAll('input[name="payment"]').forEach(r => r.addEventListener('change', () => { $('insurance-fields').hidden = radio('payment') === 'self-pay'; }));
  $('specialty').addEventListener('change', hint);
  $('cookies').onclick = event => event.preventDefault();
  document.querySelectorAll('[data-start]').forEach(a => a.addEventListener('click', () => { current = 'screen-who'; }));
  window.addEventListener('hashchange', route);
  loadCatalog(); route();
})();
