/* global describe, expect, jest, test, beforeEach */

jest.mock('../app/services/devin-session', () => ({
  createSessionAndAlert: jest.fn().mockResolvedValue(undefined),
}));

const { createSessionAndAlert } = require('../app/services/devin-session');
const { downloadEdition, listEditions, getEdition, readMinutes } = require('../app/services/verticals/43e4e1fb');

describe('The Economist app weekly edition download (43e4e1fb)', () => {
  beforeEach(() => createSessionAndAlert.mockClear());

  test('current edition with the Technology Quarterly crashes packaging and alerts', async () => {
    await expect(downloadEdition({ editionId: '2026-11-21' })).rejects.toThrow(TypeError);
    expect(createSessionAndAlert).toHaveBeenCalledWith(expect.objectContaining({ customer: '43e4e1fb' }));
  });

  test('reports off keeps the failure but skips the alert', async () => {
    await expect(downloadEdition({ editionId: '2026-11-21', alertsSuppressed: true })).rejects.toThrow(TypeError);
    expect(createSessionAndAlert).not.toHaveBeenCalled();
  });

  test('previous edition downloads with audio and a size estimate', async () => {
    const result = await downloadEdition({ editionId: '2026-11-14', demoId: 't1' });
    expect(result.success).toBe(true);
    expect(result.articles).toBe(getEdition('2026-11-14').articleCount);
    expect(result.audioTracks).toBeGreaterThan(0);
    expect(result.sizeMb).toBeGreaterThan(0);
    expect(createSessionAndAlert).not.toHaveBeenCalled();
    expect(listEditions('t1').editions.find((e) => e.id === '2026-11-14').download.status).toBe('downloaded');
    expect(listEditions('other').editions.find((e) => e.id === '2026-11-14').download).toBeNull();
  });

  test('articles expose word counts and read/listen times', () => {
    const art = getEdition('2026-11-21').sections[1].articles[0];
    expect(art.wordCount).toBeGreaterThan(0);
    expect(art.readMinutes).toBe(readMinutes(art.wordCount));
    expect(art.audioSeconds).toBeGreaterThan(0);
  });
});
