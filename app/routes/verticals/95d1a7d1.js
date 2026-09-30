const express = require('express');
const path = require('path');
const {
  inquireClaim,
  browsePositions,
  browseHistory,
  listClaims,
  ValidationError,
} = require('../../services/verticals/95d1a7d1');

const router = express.Router();

// Hosted `vite build --base=/95d1a7d1/app/` output of the claims inquiry
// front end (COG-GTM/healthinsurance-cobol-demo, frontend/).
const APP_WEB_PATH = '/95d1a7d1/app';
const APP_WEB_DIR = path.join(__dirname, '..', '..', 'public', 'verticals', '95d1a7d1-app');
const API_V1 = '/api/95d1a7d1/v1';

router.use(APP_WEB_PATH, express.static(APP_WEB_DIR, { index: 'index.html' }));
router.get(`${APP_WEB_PATH}/{*splat}`, (_req, res) => {
  res.sendFile(path.join(APP_WEB_DIR, 'index.html'));
});
router.get('/95d1a7d1', (_req, res) => res.redirect(`${APP_WEB_PATH}/`));

const RETURN_CODES = { 404: 4 };

function money(value) {
  return Number(value).toFixed(2);
}

function requireUser(req) {
  const userId = String(req.get('x-user-id') || '').trim();
  if (!userId) {
    const error = new ValidationError('USER NOT AUTHORIZED - SIGN ON REQUIRED', 'USER_NOT_SIGNED_ON');
    error.status = 401;
    throw error;
  }
  return userId;
}

function sendContractError(req, res, error) {
  const status = error.status || 500;
  res.status(status).json({
    error: {
      code: status,
      returnCode: RETURN_CODES[status] || 8,
      type: error.name || 'Error',
      message: error.message,
      requestId: req.requestId,
    },
  });
}

function toClaimView(result) {
  const { claim, financial } = result;
  return {
    claimId: claim.claimId,
    memberId: claim.memberId,
    memberName: claim.memberName,
    memberType: claim.memberType,
    provider: { id: claim.providerId, name: claim.providerName },
    status: claim.status,
    serviceDate: claim.serviceDate,
    diagnosisCode: claim.diagnosisCode,
    procedureCode: claim.procedureCode,
    serviceType: claim.serviceType,
    financial: {
      charged: money(financial.charged),
      allowed: money(financial.allowed),
      paid: money(financial.paid),
      memberResponsibility: money(financial.memberResponsibility),
    },
    message: result.message,
  };
}

router.get(`${API_V1}/claims/:claimId`, async (req, res) => {
  try {
    const userId = requireUser(req);
    const result = await inquireClaim({ claimId: req.params.claimId, userId });
    res.json(toClaimView(result));
  } catch (error) {
    sendContractError(req, res, error);
  }
});

router.get(`${API_V1}/claims/:claimId/positions`, (req, res) => {
  try {
    const userId = requireUser(req);
    const page = browsePositions({
      claimId: req.params.claimId,
      userId,
      page: req.query.page,
      pageSize: req.query.pageSize,
    });
    res.json({
      ...page,
      items: page.items.map((item) => ({
        serviceCode: item.serviceCode,
        serviceDate: item.date,
        charged: money(item.charged),
        allowed: money(item.allowed),
        paid: money(item.paid),
        status: item.status,
      })),
    });
  } catch (error) {
    sendContractError(req, res, error);
  }
});

router.get(`${API_V1}/claims/:claimId/history`, (req, res) => {
  try {
    const userId = requireUser(req);
    const page = browseHistory({
      claimId: req.params.claimId,
      userId,
      page: req.query.page,
      pageSize: req.query.pageSize,
    });
    res.json({
      items: page.items.map((item) => ({
        ...item,
        charged: money(item.charged),
        allowed: money(item.allowed),
        paid: money(item.paid),
      })),
      page: page.page,
      pageSize: page.pageSize,
      hasMore: page.hasMore,
    });
  } catch (error) {
    sendContractError(req, res, error);
  }
});

router.get('/api/95d1a7d1/claims', (_req, res) => {
  res.json({ claims: listClaims() });
});

router.post('/api/95d1a7d1/inquiry', async (req, res) => {
  const body = req.body || {};
  try {
    const result = await inquireClaim({
      claimId: body.claimId,
      userId: body.userId,
      devinUserId: body.devinUserId,
      devinOrgId: body.devinOrgId,
      devinEmail: body.devinEmail,
    });
    res.json(result);
  } catch (error) {
    res.status(error.status || 500).json({
      success: false,
      error: error.message,
      errorClass: error.name,
      code: error.code || 'CLAIM_INQUIRY_FAILED',
      requestId: req.requestId,
    });
  }
});

module.exports = router;
