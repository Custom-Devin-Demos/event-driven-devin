/* global beforeEach, describe, expect, jest, test */

jest.mock('../app/services/oncall', () => ({
  postOncallBugReport: jest.fn(),
}));

jest.mock('../app/telemetry/datadog', () => ({
  incrementMetric: jest.fn(),
  recordTiming: jest.fn(),
}));

const { postOncallBugReport } = require('../app/services/oncall');
const { submitSupportTicket, splitSymptoms } = require('../app/services/verticals/f8555891');

const REPORT = [
  'Our Sep 17 payroll will not release. Every attempt fails with an internal error.',
  'The employer contribution line for Minnesota shows $0.00 and total debit equals gross pay.',
  'One company having a problem should not hold the other four companies in the batch.',
].join('\n\n');

describe('Gusto support ticket (f8555891)', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    postOncallBugReport.mockResolvedValue({ ok: true, ts: '1700000000.000100' });
  });

  test('splitSymptoms breaks a report into one symptom per paragraph', () => {
    expect(splitSymptoms(REPORT)).toHaveLength(3);
  });

  test('splitSymptoms falls back to list items when there are no blank lines', () => {
    expect(splitSymptoms('- batch fails\n- preview shows $0.00\n3. other companies blocked')).toEqual([
      'batch fails',
      'preview shows $0.00',
      'other companies blocked',
    ]);
  });

  test('splitSymptoms returns the whole text when there is a single symptom', () => {
    expect(splitSymptoms('Just one problem here.')).toEqual(['Just one problem here.']);
  });

  test('files a single ticket as Gusto Support, submitted from the console', async () => {
    const result = await submitSupportTicket({
      subject: 'Payroll blocked',
      text: REPORT,
      reporter: { name: 'Jordan Whitaker', email: 'jordan@northstardental.example' },
      severity: 'Critical',
      productArea: 'Payroll · ACH release',
      split: false,
    });

    expect(result).toMatchObject({ ok: true, skipped: false, ticketCount: 1, supportCenter: 'Gusto Support' });
    expect(postOncallBugReport).toHaveBeenCalledTimes(1);
    const call = postOncallBugReport.mock.calls[0][0];
    expect(call.text).toBe(`Payroll blocked\n\n${REPORT}`);
    expect(call.supportCenter).toBe('Gusto Support');
    expect(call.submittedFrom).toMatch(/\/gusto$/);
    expect(call.reporter).toEqual({ name: 'Jordan Whitaker', email: 'jordan@northstardental.example' });
    expect(call.severity).toBe('Critical');
    expect(call.productArea).toBe('Payroll · ACH release');
  });

  test('split files one ticket per symptom, numbered and in report order', async () => {
    const result = await submitSupportTicket({ subject: 'Payroll blocked', text: REPORT, split: true });

    expect(result.ticketCount).toBe(3);
    expect(result.tickets.map((ticket) => ticket.ts)).toEqual(Array(3).fill('1700000000.000100'));
    expect(postOncallBugReport).toHaveBeenCalledTimes(3);
    expect(postOncallBugReport.mock.calls[0][0].text).toMatch(/^\[1\/3\] Payroll blocked\n\nOur Sep 17 payroll/);
    expect(postOncallBugReport.mock.calls[2][0].text).toMatch(/^\[3\/3\] Payroll blocked\n\nOne company/);
  });

  test('reports skipped when the bugs channel is not configured', async () => {
    postOncallBugReport.mockResolvedValue({ ok: false, skipped: true, error: 'not configured' });

    const result = await submitSupportTicket({ text: REPORT, split: true });

    expect(result.ok).toBe(false);
    expect(result.skipped).toBe(true);
    expect(result.ticketCount).toBe(3);
    expect(result.error).toMatch(/not configured/);
  });

  test('rejects an empty report', async () => {
    await expect(submitSupportTicket({ text: '   ' })).rejects.toMatchObject({ code: 'EMPTY_TICKET', statusCode: 400 });
    expect(postOncallBugReport).not.toHaveBeenCalled();
  });

  test('rejects a report that splits into too many tickets', async () => {
    const text = Array.from({ length: 7 }, (_, i) => `Symptom ${i + 1}`).join('\n\n');
    await expect(submitSupportTicket({ text, split: true })).rejects.toMatchObject({ code: 'TOO_MANY_SYMPTOMS' });
    expect(postOncallBugReport).not.toHaveBeenCalled();
  });

  test('neutralizes Slack mentions and links in customer-supplied text', async () => {
    await submitSupportTicket({
      subject: '<!channel> urgent',
      text: 'Click <https://evil.example|here> & tell <@U123>',
      reporter: { name: '<!here> Mallory', email: 'mallory@example.com' },
    });
    const call = postOncallBugReport.mock.calls[0][0];
    expect(call.text).not.toMatch(/<[!@]/);
    expect(call.text).toContain('&lt;!channel&gt; urgent');
    expect(call.text).toContain('&lt;https://evil.example|here&gt; &amp; tell &lt;@U123&gt;');
    expect(call.reporter.name).toBe('&lt;!here&gt; Mallory');
  });

  test('rejects a malformed reporter email', async () => {
    await expect(submitSupportTicket({ text: 'x', reporter: { email: '<@U123>' } }))
      .rejects.toMatchObject({ code: 'INVALID_REPORTER_EMAIL', statusCode: 400 });
  });

  test('rejects a ticket that would exceed the Slack section limit', async () => {
    await expect(submitSupportTicket({ text: 'a'.repeat(2600) }))
      .rejects.toMatchObject({ code: 'TICKET_TOO_LONG', statusCode: 400 });
    expect(postOncallBugReport).not.toHaveBeenCalled();
  });

  test('reports partial delivery when a later ticket post fails', async () => {
    postOncallBugReport
      .mockResolvedValueOnce({ ok: true, ts: '1.1' })
      .mockRejectedValueOnce(new Error('slack timeout'));

    await expect(submitSupportTicket({ text: REPORT, split: true })).rejects.toMatchObject({
      code: 'PARTIAL_DELIVERY',
      statusCode: 502,
      ticketCount: 3,
      tickets: [expect.objectContaining({ ts: '1.1' })],
    });
    expect(postOncallBugReport).toHaveBeenCalledTimes(2);
  });

  test('emits one outcome-tagged metric per ticket', async () => {
    const { incrementMetric } = require('../app/telemetry/datadog');
    await submitSupportTicket({ text: REPORT, split: true });
    const calls = incrementMetric.mock.calls.filter(([name]) => name === 'gusto_payroll.support_ticket');
    expect(calls).toHaveLength(3);
    expect(calls[0][1]).toEqual({ service: 'customer-f8555891-payroll', outcome: 'delivered', split: 'true' });
  });

  test('falls back to defaults for unknown severity and missing product area', async () => {
    await submitSupportTicket({ text: 'One problem', severity: 'SEV-9' });
    expect(postOncallBugReport.mock.calls[0][0]).toMatchObject({ severity: 'High', productArea: 'Payroll · ACH release' });
  });
});
