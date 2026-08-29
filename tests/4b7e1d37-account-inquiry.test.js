/* global describe, expect, test */

const {
  processAccountInquiry,
  ENROLLMENT_CHANNELS,
} = require('../app/services/verticals/4b7e1d37');

describe('4b7e1d37 account opening inquiry', () => {
  test('online channel product (vw-checking) returns a card issuance summary', async () => {
    const summary = await processAccountInquiry({ productCode: 'vw-checking', zipCode: '15222' });

    expect(summary.status).toBe('received');
    expect(summary.channel).toBe('Online application');
    expect(summary.cardNetwork).toBe('visa-debit');
    expect(summary.cardArrivalDays).toBe(7);
  });

  test('branch channel product (std-checking) returns instant-issue card details', async () => {
    const summary = await processAccountInquiry({ productCode: 'std-checking', zipCode: '15222' });

    expect(summary.channel).toBe('In-branch appointment');
    expect(summary.cardNetwork).toBe('branch-print');
    expect(summary.cardArrivalDays).toBe(0);
  });

  test('unknown product code falls back to the default product without throwing', async () => {
    const summary = await processAccountInquiry({ productCode: 'not-a-product' });

    expect(summary.product).toBe('Virtual Wallet Checking Pro');
    expect(summary.cardNetwork).toBe('visa-debit');
  });

  test('every enrollment channel defines card issuance', () => {
    Object.values(ENROLLMENT_CHANNELS).forEach((channel) => {
      expect(channel.cardIssuance).toEqual(
        expect.objectContaining({ network: expect.any(String), arrivalDays: expect.any(Number) }),
      );
    });
  });

  test('a channel without card issuance summarizes as null instead of throwing', () => {
    const original = ENROLLMENT_CHANNELS.online.cardIssuance;
    delete ENROLLMENT_CHANNELS.online.cardIssuance;

    return processAccountInquiry({ productCode: 'vw-checking' })
      .then((summary) => {
        expect(summary.cardNetwork).toBeNull();
        expect(summary.cardArrivalDays).toBeNull();
      })
      .finally(() => {
        ENROLLMENT_CHANNELS.online.cardIssuance = original;
      });
  });
});
