jest.mock('../app/services/devin-session', () => ({
  createSessionAndAlert: jest.fn(() => Promise.resolve({ triggered: false })),
}));

const { createSessionAndAlert } = require('../app/services/devin-session');
const { redeemPoints } = require('../app/services/verticals/bonvoy');

describe('Marriott Bonvoy points redemption service (bonvoy)', () => {
  beforeEach(() => createSessionAndAlert.mockClear());

  test('rejects an incomplete request with a 400 ValidationError and no alert', async () => {
    await expect(redeemPoints({ hotel: '', nights: 0, points: 0 })).rejects.toMatchObject({
      name: 'ValidationError',
      statusCode: 400,
    });
    expect(createSessionAndAlert).not.toHaveBeenCalled();
  });

  test('a Gold Elite member redeems points and receives a confirmation', async () => {
    const result = await redeemPoints({
      memberNumber: '512 330 908',
      hotel: 'Aloft Austin Downtown',
      nights: 2,
      points: 50000,
      devinOrgId: 'org-test',
    });
    expect(result.status).toBe('confirmed');
    expect(result.confirmationNumber).toMatch(/^BV[0-9A-F]{8}$/);
    expect(result.member.tier).toBe('Gold Elite');
    expect(result.pointsDebited).toBe(50000);
    expect(result.newBalance).toBe(22400);
    expect(createSessionAndAlert).not.toHaveBeenCalled();
  });
});
