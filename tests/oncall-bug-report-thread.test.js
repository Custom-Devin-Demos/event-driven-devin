jest.mock('../app/services/slack', () => ({
  OWNER_DISCLAIMER: 'fictional on-call persona',
  postMessage: jest.fn().mockResolvedValue('1700000000.000100'),
  postThreadReply: jest.fn().mockResolvedValue('1700000000.000200'),
  lookupSlackUserByEmail: jest.fn().mockResolvedValue(null),
  findChannelByNameFragment: jest.fn().mockResolvedValue(null),
  joinChannel: jest.fn().mockResolvedValue(undefined),
  postPersonaMessage: jest.fn().mockResolvedValue(undefined),
  inviteToChannel: jest.fn().mockResolvedValue(undefined),
}));

const { postMessage, postThreadReply } = require('../app/services/slack');

process.env.SLACK_ONCALL_BOT_TOKEN = 'xoxb-test';
process.env.SLACK_ONCALL_BUGS_CHANNEL_ID = 'C0BUGS';

const { postOncallBugReport } = require('../app/services/oncall');

describe('postOncallBugReport parent/sub-ticket threading', () => {
  beforeEach(() => jest.clearAllMocks());

  test('a ticket without threadTs posts to the channel and labels the header with its id', async () => {
    const result = await postOncallBugReport({
      text: 'Payroll will not release.',
      severity: 'High',
      productArea: 'Payroll',
      supportCenter: 'Gusto Support',
      ticketId: 'GUS-1041',
    });

    expect(result).toMatchObject({ ok: true, ts: '1700000000.000100', channel: 'C0BUGS' });
    expect(postThreadReply).not.toHaveBeenCalled();
    const [, channel, text, blocks] = postMessage.mock.calls[0];
    expect(channel).toBe('C0BUGS');
    expect(text).toMatch(/^:inbox_tray: New support ticket GUS-1041 — Gusto Support/);
    expect(blocks[0].text.text).toBe(':inbox_tray: New support ticket GUS-1041 — Gusto Support');
    expect(JSON.stringify(blocks)).not.toContain('Parent ticket');
  });

  test('a ticket with threadTs is filed as a sub-ticket reply naming its parent', async () => {
    const result = await postOncallBugReport({
      text: 'Employer contribution shows $0.00.',
      severity: 'High',
      productArea: 'Payroll',
      supportCenter: 'Gusto Support',
      ticketId: 'GUS-1041.2',
      parentTicketId: 'GUS-1041',
      threadTs: '1700000000.000100',
    });

    expect(result).toMatchObject({ ok: true, ts: '1700000000.000200' });
    expect(postMessage).not.toHaveBeenCalled();
    const [, channel, threadTs, text, blocks] = postThreadReply.mock.calls[0];
    expect(channel).toBe('C0BUGS');
    expect(threadTs).toBe('1700000000.000100');
    expect(text).toMatch(/^:page_facing_up: Sub-ticket GUS-1041\.2 — Gusto Support\nParent ticket: GUS-1041/);
    expect(blocks[0].text.text).toBe(':page_facing_up: Sub-ticket GUS-1041.2 — Gusto Support');
    expect(JSON.stringify(blocks)).toContain('*Parent ticket:*\\nGUS-1041');
  });
});
