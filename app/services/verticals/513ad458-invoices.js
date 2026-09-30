const fs = require('fs');
const path = require('path');
const { computeJurisdictionTax, JURISDICTIONS } = require('./513ad458');

const SEED_BOOK = path.join(__dirname, '..', '..', '..', 'config', 'seeds', '513ad458-accounts.json');

function roundMoney(amount) {
  return Math.round((amount + Number.EPSILON) * 100) / 100;
}

function listInvoices() {
  const book = JSON.parse(fs.readFileSync(SEED_BOOK, 'utf8'));
  const invoices = book.accounts.flatMap((account) => account.invoices.map((invoice) => {
    const subtotal = roundMoney(invoice.lines.reduce(
      (sum, line) => roundMoney(sum + roundMoney(line.amount * line.quantity)),
      0,
    ));
    const jurisdiction = JURISDICTIONS[account.jurisdiction];
    const tax = computeJurisdictionTax(subtotal, jurisdiction, true);

    return {
      invoiceNumber: invoice.invoiceNumber,
      accountId: account.accountId,
      legalName: account.legalName,
      city: account.city,
      jurisdiction: {
        code: account.jurisdiction,
        name: jurisdiction.name,
      },
      taxType: jurisdiction.taxType,
      currency: jurisdiction.currency,
      issueDate: invoice.issueDate,
      subtotal,
      lineItems: tax.lineItems,
      taxAmount: tax.taxAmount,
      total: roundMoney(subtotal + tax.taxAmount),
    };
  }));

  return { bookPeriod: book.bookPeriod, invoices };
}

module.exports = { listInvoices };
