const MAX_LINES_PER_REQUEST = 30;
const ENDPOINT = 'POST /license-service/v2/entitlements';

async function post(request) {
  await new Promise((resolve) => setTimeout(resolve, 15 + Math.random() * 25));
  const lines = Array.isArray(request.lines) ? request.lines : [];
  if (lines.length > MAX_LINES_PER_REQUEST) {
    return {
      status: 413,
      body: { error: 'Payload Too Large', message: `max ${MAX_LINES_PER_REQUEST} lines per request`, received: lines.length },
    };
  }
  if (!lines.length) {
    return { status: 400, body: { error: 'Bad Request', message: 'request has no lines' } };
  }
  const first = lines[0].lineNumber;
  return {
    status: 200,
    body: {
      entitlementId: `ENT-${request.orderNumber.replace(/^SO-/, '')}-${String(first).padStart(2, '0')}`,
      orderNumber: request.orderNumber,
      lines: lines.length,
    },
  };
}

module.exports = { post, ENDPOINT, MAX_LINES_PER_REQUEST };
