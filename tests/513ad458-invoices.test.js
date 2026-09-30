/* global describe, expect, test */

const seedBook = require('../config/seeds/513ad458-accounts.json');
const { listInvoices } = require('../app/services/verticals/513ad458-invoices');

describe('Vertex invoice register', () => {
  test('returns one invoice row per seeded invoice with consistent totals', () => {
    const { bookPeriod, invoices } = listInvoices();
    const expectedInvoiceCount = seedBook.accounts.reduce(
      (count, account) => count + account.invoices.length,
      0,
    );

    expect(bookPeriod).toBe(seedBook.bookPeriod);
    expect(invoices).toHaveLength(expectedInvoiceCount);
    invoices.forEach((invoice) => {
      expect(invoice.total).toBeCloseTo(invoice.subtotal + invoice.taxAmount, 2);
    });
  });

  test('an Ontario invoice has one 13% HST line', () => {
    const invoice = listInvoices().invoices.find(({ jurisdiction }) => jurisdiction.code === 'CA-ON');

    expect(invoice.lineItems).toEqual([
      { authority: 'HST (Ontario)', rate: 0.13, tax: invoice.subtotal * 0.13 },
    ]);
  });

  test('a Quebec invoice has GST and QST lines', () => {
    const invoice = listInvoices().invoices.find(({ jurisdiction }) => jurisdiction.code === 'CA-QC');

    expect(invoice.lineItems.map(({ authority }) => authority)).toEqual([
      'GST (CRA)',
      'QST (Revenu Québec)',
    ]);
  });
});
