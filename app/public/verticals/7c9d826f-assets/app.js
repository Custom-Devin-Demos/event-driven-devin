/* global document, localStorage, fetch */
(() => {
  const $ = id => document.getElementById(id);
  const identity = key => { try { return localStorage.getItem(key) || undefined; } catch { return undefined; } };
  const LABEL = { authorized: 'Authorized', pending: 'Pending', rejected: 'Rejected', sending: 'Sending' };
  const money = (n, c) => `${n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })} ${c}`;
  const time = () => new Date().toLocaleString('en-US', { month: 'short', day: 'numeric', year: 'numeric', hour: 'numeric', minute: '2-digit' });
  const el = (tag, text, cls) => { const n = document.createElement(tag); if (text !== undefined) n.textContent = text; if (cls) n.className = cls; return n; };
  let docs = [], selected = null;

  function renderRows() {
    $('rows').replaceChildren(...docs.map(d => {
      const tr = el('tr'); tr.dataset.id = d.id; if (d.id === selected) tr.className = 'selected';
      const idCell = el('td'); const link = el('a', d.id); link.href = '#'; idCell.append(link);
      const type = el('td'); type.append(el('span', d.documentType, 'type'));
      const status = el('td'); status.append(el('span', LABEL[d.status], `badge ${d.status}`));
      tr.append(idCell, el('td', d.buyer.name), type, el('td', d.issueDate), el('td', money(d.totals.gross, d.currency), 'num'), status, el('td', d.ksefNumber || '–', 'mono'));
      tr.addEventListener('click', e => { e.preventDefault(); select(d.id); });
      return tr;
    }));
  }

  function renderDetail() {
    const d = docs.find(x => x.id === selected);
    $('detail').hidden = !d; if (!d) return;
    $('detail-title').textContent = d.id;
    $('statusbar').className = `statusbar ${d.status}`;
    $('statusbar').textContent = { authorized: 'Authorized by tax authority', pending: 'Pending · not yet sent to tax authority', rejected: 'Rejected by tax authority', sending: 'Sending to tax authority…' }[d.status];
    $('sender').textContent = d.seller.name; $('sender-id').textContent = d.seller.nip;
    $('receiver').textContent = d.buyer.name; $('receiver-id').textContent = d.buyer.nip;
    const fields = [['Country', 'Poland'], ['Tax authority', 'KSeF'], ['Schema', d.schema], ['Issue date', d.issueDate], ['Net amount', money(d.totals.net, d.currency)], ['VAT', money(d.totals.vat, d.currency)], ['Total amount', money(d.totals.gross, d.currency)], ['KSeF number', d.ksefNumber || '–'], ['Receiver address', d.buyer.address]];
    $('fields').replaceChildren(...fields.map(([k, v]) => { const row = el('div'); row.append(el('dt', k), el('dd', v)); return row; }));
    $('history').replaceChildren(...(d.history || []).map(h => { const li = el('li', undefined, h.error ? 'err' : ''); li.append(el('span', h.text), el('span', h.at)); return li; }));
    const banner = $('banner'); banner.hidden = !d.rejection && !d.sendError;
    if (d.sendError) banner.replaceChildren(el('strong', 'Not sent'), document.createTextNode(d.sendError));
    if (d.rejection) {
      const list = el('ul'); d.rejection.errors.forEach(e => { const li = el('li'); li.append(el('code', e.path), document.createTextNode(` ${e.message}`)); list.append(li); });
      banner.replaceChildren(el('strong', 'Rejected by tax authority (KSeF)'), document.createTextNode(`The document does not conform to schema ${d.rejection.schema}. It was not issued, and the invoice cannot be sent to the buyer.`), list);
    }
    $('send').hidden = d.status === 'authorized';
    $('send').disabled = d.status === 'sending';
    $('send').textContent = d.status === 'rejected' ? 'Retry send to tax authority' : d.status === 'sending' ? 'Sending…' : 'Send to tax authority';
  }

  function select(id) { selected = id; renderRows(); renderDetail(); }

  function failed(d, message) {
    d.status = 'pending'; d.sendError = message || 'The document could not be sent. Try again.';
    d.history.push({ text: 'Send failed', at: time(), error: true });
  }

  async function send() {
    const d = docs.find(x => x.id === selected); if (!d || d.status === 'sending' || d.status === 'authorized') return;
    d.status = 'sending'; d.rejection = null; d.sendError = null; d.history.push({ text: 'Sent to tax authority', at: time() });
    renderRows(); renderDetail();
    try {
      const res = await fetch(`/api/7c9d826f/documents/${encodeURIComponent(d.id)}/submit`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ devinUserId: identity('devinUserId'), devinOrgId: identity('devinOrgId'), devinEmail: identity('devinEmail') }),
      });
      const body = await res.json();
      if (res.ok && body.success) {
        d.status = 'authorized'; d.ksefNumber = body.document.ksefNumber;
        d.history.push({ text: 'Authorized · KSeF number assigned', at: time() });
      } else if (body.rejection) {
        d.status = 'rejected'; d.rejection = body.rejection;
        d.history.push({ text: `Rejected · ${d.rejection.errors[0].path}`, at: time(), error: true });
      } else {
        failed(d, body.error);
      }
    } catch {
      failed(d);
    }
    renderRows(); renderDetail();
  }

  $('send').addEventListener('click', send);
  $('close').addEventListener('click', () => select(null));
  fetch('/api/7c9d826f/documents').then(r => r.json()).then(body => {
    docs = body.documents.map(d => ({ ...d, history: [{ text: 'Received from ERP (SAP S/4HANA)', at: `${d.issueDate} 08:00` }, { text: 'Mapped to FA(3)', at: `${d.issueDate} 08:00` }, ...(d.status === 'authorized' ? [{ text: 'Authorized · KSeF number assigned', at: `${d.issueDate} 08:01` }] : [])] }));
    renderRows();
  }).catch(() => { $('rows').replaceChildren(Object.assign(el('tr'), { innerHTML: '<td colspan="7">Documents could not be loaded.</td>' })); });
})();
