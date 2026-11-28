/* global describe, expect, test */
const fs = require('fs');
const path = require('path');
const { login, getAccount, logout } = require('../app/services/verticals/66c8f8fc');

describe('My Verizon (66c8f8fc)', () => {
  test('login opens a session that can read the account', () => {
    const { sessionToken, name } = login({ userId: 'sidney.morgan', password: 'x', deviceId: 'd1' });
    expect(name).toBe('Sidney');
    expect(getAccount(sessionToken).bill.balanceCents).toBe(14237);
  });

  test('bill lines add up to the balance', () => {
    const { sessionToken } = login({ userId: 'sidney.morgan', password: 'x' });
    const { bill } = getAccount(sessionToken);
    expect(bill.lines.reduce((s, l) => s + l.amountCents, 0)).toBe(bill.balanceCents);
  });

  test('rejects unknown users and missing passwords', () => {
    expect(() => login({ userId: 'nobody', password: 'x' })).toThrow(/incorrect/);
    expect(() => login({ userId: 'sidney.morgan' })).toThrow(/password/);
  });

  test('account requires a session and logout closes it', () => {
    expect(() => getAccount('nope')).toThrow(/Sign in/);
    const { sessionToken } = login({ userId: 'sidney.morgan', password: 'x' });
    logout({ sessionToken });
    expect(() => getAccount(sessionToken)).toThrow(/Sign in/);
  });

  test('page is in English and shows no demo notice', () => {
    const html = fs.readFileSync(path.join(__dirname, '../app/public/verticals/66c8f8fc.html'), 'utf8');
    expect(html).toContain('<html lang="en">');
    for (const id of ['loginForm', 'rememberMe', 'tabbar']) expect(html).toContain(`id="${id}"`);
    expect(html).not.toMatch(/demo|synthetic|NOT ACTUALLY/i);
  });
});
