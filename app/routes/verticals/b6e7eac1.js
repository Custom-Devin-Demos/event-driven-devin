const express = require('express');
const service = require('../../services/verticals/b6e7eac1');

const router = express.Router();

function problem(res, status, title, extra = {}) {
  res.status(status).type('application/problem+json').json({ type: 'about:blank', title, status, ...extra });
}

/** GET /api/b6e7eac1/state — everything the ops console renders. */
router.get('/api/b6e7eac1/state', async (_req, res) => {
  await service.ready;
  res.json(service.getState());
});

/** GET /api/b6e7eac1/deadletters — current dead-letter queue with reason and full message. */
router.get('/api/b6e7eac1/deadletters', async (_req, res) => {
  await service.ready;
  res.json(service.listDeadLetters());
});

/** GET /api/b6e7eac1/contracts/:dataAreaId — contract lines for one legal entity. */
router.get('/api/b6e7eac1/contracts/:dataAreaId', async (req, res) => {
  await service.ready;
  const dataAreaId = String(req.params.dataAreaId).toLowerCase();
  if (!service.getState().dealers.some((d) => d.dataAreaId === dataAreaId)) {
    return problem(res, 404, `Unknown legal entity '${req.params.dataAreaId}'.`);
  }
  return res.json(service.listContractLines(dataAreaId));
});

/** POST /api/b6e7eac1/returns — ingest a return event (200 applied, 202 dead-lettered, 400 invalid). */
router.post('/api/b6e7eac1/returns', async (req, res) => {
  await service.ready;
  let evt;
  try {
    evt = service.validateReturnEvent(req.body);
  } catch (error) {
    return problem(res, 400, error.message, { errors: error.errors || [] });
  }
  const result = await service.processReturnEvent(evt);
  return res.status(result.status === 'Applied' ? 200 : 202).json(result);
});

/** POST /api/b6e7eac1/deadletters/:eventId/replay — 200 applied, 409 still failing, 404 unknown. */
router.post('/api/b6e7eac1/deadletters/:eventId/replay', async (req, res) => {
  await service.ready;
  const result = await service.replayDeadLetter(String(req.params.eventId));
  if (!result) return problem(res, 404, `No dead letter with id '${req.params.eventId}'.`);
  return res.status(result.status === 'Applied' ? 200 : 409).json(result);
});

/** POST /api/b6e7eac1/alerts/fire — presenter action: Slack alert + Devin session via createSessionAndAlert. */
router.post('/api/b6e7eac1/alerts/fire', async (req, res) => {
  await service.ready;
  const body = req.body || {};
  const result = await service.fireAlert({
    pageUrl: typeof body.pageUrl === 'string' ? body.pageUrl.slice(0, 300) : '',
    devinUserId: body.devinUserId,
    devinOrgId: body.devinOrgId,
    devinEmail: body.devinEmail,
  });
  return res.status(result.sent ? 200 : 409).json(result);
});

/** POST /api/b6e7eac1/alerts/reset — reload seed data and re-park the two stuck events. */
router.post('/api/b6e7eac1/alerts/reset', async (_req, res) => {
  await service.ready;
  res.json(await service.resetDemo());
});

module.exports = router;
