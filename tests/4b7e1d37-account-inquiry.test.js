/* global describe, expect, test */

const {
  processAccountInquiry,
  PRODUCT_CATALOG,
  ENROLLMENT_CHANNELS,
} = require('../app/services/verticals/4b7e1d37');

describe('4b7e1d37 account opening inquiry', () => {
  test('online-channel product returns a debit card issuance summary', async () => {
    const summary = await processAccountInquiry({ productCode: 'vw-checking', zipCode: '15222' });

    expect(summary.status).toBe('received');
    expect(summary.channel).toBe('Online application');
    expect(summary.cardNetwork).toBe('visa');
    expect(typeof summary.cardArrivalDays).toBe('number');
  });

  test('branch-channel product keeps instant-issue card details', async () => {
    const summary = await processAccountInquiry({ productCode: 'std-checking' });

    expect(summary.cardNetwork).toBe('branch-print');
    expect(summary.cardArrivalDays).toBe(0);
  });

  test('every enrollment channel defines card issuance', () => {
    Object.values(ENROLLMENT_CHANNELS).forEach((channel) => {
      expect(channel.instantIssue).toBeDefined();
      expect(channel.instantIssue.network).toEqual(expect.any(String));
    });
  });

  test('every catalog product maps to a known enrollment channel', () => {
    PRODUCT_CATALOG.forEach((product) => {
      expect(ENROLLMENT_CHANNELS[product.enrollmentChannel]).toBeDefined();
    });
  });

  test('unknown product falls back to the default catalog product without throwing', async () => {
    const summary = await processAccountInquiry({ productCode: 'does-not-exist' });

    expect(summary.product).toBe(PRODUCT_CATALOG[0].name);
    expect(summary.cardNetwork).toBeTruthy();
  });
});
