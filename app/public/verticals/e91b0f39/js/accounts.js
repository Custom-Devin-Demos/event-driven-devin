/* global document */
(function () {
  'use strict';

  var CURRENT_BALANCE = 13021.0;
  var TRANSACTIONS = [
    { date: 'Processing', desc: 'WHOLE FOODS MKT #10235 10/17 PURCHASE BOSTON MA', type: 'Debit', amount: -84.62 },
    { date: '10/16/2026', desc: 'NETFLIX.COM 10/16 PURCHASE LOS GATOS CA', type: 'Debit', amount: -22.99, details: true },
    { date: '10/15/2026', desc: 'ACME CORP DES:PAYROLL ID:XXXXX20918 INDN:ROBIN TAYLOR CO ID:XXXXX52001 PPD', type: 'Deposit', amount: 4250.0, details: true },
    { date: '10/14/2026', desc: 'Online Banking transfer to SAV 7781 Confirmation# 2731948801', type: 'Transfer', amount: -500.0, details: true },
    { date: '10/13/2026', desc: 'SPOTIFY USA 10/13 PURCHASE NEW YORK NY', type: 'Debit', amount: -11.99 },
    { date: '10/12/2026', desc: 'PLANET FITNESS 10/12 PURCHASE HANOVER MA', type: 'Debit', amount: -24.99 },
    { date: '10/10/2026', desc: 'Preferred Rewards-Stop Pymt Fee Waiver of $30', type: 'Preferred', amount: 0, details: true },
    { date: '10/09/2026', desc: 'EVERSOURCE ENERGY DES:BILL PAY ID:XXXXX77310 INDN:ROBIN TAYLOR', type: 'Debit', amount: -142.18, details: true },
    { date: '10/08/2026', desc: 'Zelle payment to JORDAN LEE Conf# t9k2v1qz8', type: 'Transfer', amount: -60.0, details: true },
    { date: '10/07/2026', desc: "TRADER JOE'S #509 10/07 PURCHASE CAMBRIDGE MA", type: 'Debit', amount: -63.41 }
  ];

  function money(value) {
    var sign = value < 0 ? '-' : '';
    return sign + '$' + Math.abs(value).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  }

  function cell(text, className) {
    var td = document.createElement('td');
    if (className) td.className = className;
    td.textContent = text;
    return td;
  }

  var tbody = document.getElementById('txn-rows');
  if (!tbody) return;
  var balance = CURRENT_BALANCE;
  TRANSACTIONS.forEach(function (txn) {
    var tr = document.createElement('tr');
    if (txn.date === 'Processing') tr.className = 'is-processing';
    var date = document.createElement('td');
    date.className = 'date';
    if (txn.date === 'Processing') {
      var a = document.createElement('a');
      a.href = '#';
      a.textContent = 'Processing';
      date.appendChild(a);
    } else {
      date.textContent = txn.date;
    }
    tr.appendChild(date);
    tr.appendChild(cell(txn.desc, 'desc'));
    tr.appendChild(cell(txn.type));
    tr.appendChild(cell(money(txn.amount), 'num' + (txn.amount < 0 ? ' neg' : '')));
    tr.appendChild(cell(money(balance), 'num'));
    var details = document.createElement('td');
    if (txn.details) {
      var link = document.createElement('a');
      link.href = '#';
      link.textContent = 'View details';
      details.appendChild(link);
    }
    tr.appendChild(details);
    tbody.appendChild(tr);
    balance -= txn.amount;
  });
})();
