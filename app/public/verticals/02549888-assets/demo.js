/* global document, URLSearchParams, window, fetch, Option, FormData, localStorage */

const api = '/api/02549888';
const form = document.getElementById('demo-form');
const status = document.getElementById('form-status');
const submit = form.querySelector('button[type="submit"]');
const reportsOff = new URLSearchParams(window.location.search).get('reports') === 'off';
let budgetMs;

function showStatus(text, isError = false) {
  status.textContent = text;
  status.toggleAttribute('data-error', isError);
}

async function loadForm() {
  try {
    const response = await fetch(`${api}/config`);
    if (!response.ok) throw new Error();
    const config = await response.json();
    budgetMs = config.budgetMs;
    for (const [name, labels] of Object.entries(config.options)) {
      const select = form.elements.namedItem(name);
      for (const label of labels) select.add(new Option(label, label));
    }
    for (const [name, value] of Object.entries(config.prefill)) form.elements.namedItem(name).value = value;
    submit.disabled = false;
  } catch {
    showStatus('The form is unavailable. Refresh the page to try again.', true);
  }
}

form.addEventListener('submit', async (event) => {
  event.preventDefault();
  if (submit.disabled) return;
  const payload = {
    ...Object.fromEntries(new FormData(form)),
    devinUserId: localStorage.getItem('devinUserId') || '',
    devinOrgId: localStorage.getItem('devinOrgId') || '',
    devinEmail: localStorage.getItem('devinEmail') || '',
  };
  submit.disabled = true;
  submit.textContent = 'Submitting…';
  showStatus('Sending your request…');
  const slow = setTimeout(() => showStatus('This is taking longer than usual. Please keep this page open.'), budgetMs);
  try {
    const response = await fetch(`${api}/demo-requests${reportsOff ? '?reports=off' : ''}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    const result = await response.json();
    if (!response.ok) throw new Error(result.error || 'Please try again.');
    showStatus('Thanks for your interest in Healthie! Your demo request is complete.');
  } catch (error) {
    showStatus(`Could not submit your request. ${error.message}`, true);
  } finally {
    clearTimeout(slow);
    submit.disabled = false;
    submit.textContent = 'Get Started';
  }
});

const video = document.getElementById('product-video');
const playButton = document.getElementById('play-video');
playButton.addEventListener('click', () => {
  video.src = 'https://embed-ssl.wistia.com/deliveries/792add1505c2dd0fe2bf90ebfbd188a9571d0581.bin';
  video.controls = true;
  playButton.hidden = true;
  video.play().catch(() => {
    video.controls = false;
    playButton.hidden = false;
  });
});

loadForm();
