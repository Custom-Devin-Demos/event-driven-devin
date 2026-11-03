/* global describe, expect, jest, test, beforeEach */

jest.mock('../app/services/devin-session', () => ({
  createSessionAndAlert: jest.fn().mockResolvedValue(undefined),
}));

const { createSessionAndAlert } = require('../app/services/devin-session');
const { submitPayroll, listProjects } = require('../app/services/verticals/844f1b1f');

describe('HITT SiteForce payroll (844f1b1f)', () => {
  beforeEach(() => createSessionAndAlert.mockClear());

  test('federal certified payroll crashes on the drywall finisher and alerts', async () => {
    await expect(submitPayroll({ projectId: 'HITT-24117' })).rejects.toThrow(TypeError);
    expect(createSessionAndAlert).toHaveBeenCalledWith(expect.objectContaining({ customer: '844f1b1f' }));
  });

  test('private data center payroll succeeds with overtime', async () => {
    const result = await submitPayroll({ projectId: 'HITT-25203' });
    expect(result.success).toBe(true);
    expect(result.workers).toBe(5);
    expect(result.lines[0].overtime).toBe(18);
    expect(createSessionAndAlert).not.toHaveBeenCalled();
  });

  test('project list includes weekly totals', () => {
    const dea = listProjects().find((p) => p.id === 'HITT-24117');
    expect(dea.federal).toBe(true);
    expect(dea.crew.find((w) => w.id === 'W-10734').totalHours).toBe(50);
  });
});
