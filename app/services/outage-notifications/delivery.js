/**
 * STUB transport for the notifications gateway.
 *
 * This stands in for the real gateway client (HTTP/Kafka) — it records every
 * enqueue onto an in-memory queue so rules, tests and the demo can observe what
 * would have been sent. Only the email channel "delivers" (state 'queued');
 * SMS and webhook are phase 2 (PRD D3) and are recorded as 'suppressed' with
 * reason 'phase-2'. A real transport would replace enqueue() only.
 */
class GatewayClient {
  constructor() {
    this.queue = [];
  }

  /**
   * @param {{ channel: string, recipient: string, contactId: string,
   *   incidentId: string, type: string, message: object }} entry
   * @returns {{ state: 'queued'|'suppressed', queuedAt: string, reason?: string }}
   */
  enqueue({ channel, recipient, contactId, incidentId, type, message }) {
    const queuedAt = new Date().toISOString();
    const record = {
      channel,
      recipient,
      contactId,
      incidentId,
      type,
      message,
      queuedAt,
    };
    if (channel === 'email') {
      record.state = 'queued';
    } else {
      // sms / webhook delivery is phase 2 — recorded, not delivered (D3).
      record.state = 'suppressed';
      record.reason = 'phase-2';
    }
    this.queue.push(record);
    return record.state === 'queued'
      ? { state: 'queued', queuedAt }
      : { state: 'suppressed', queuedAt, reason: record.reason };
  }
}

const gateway = new GatewayClient();

function resetQueue() {
  gateway.queue.length = 0;
}

module.exports = { GatewayClient, gateway, resetQueue };
