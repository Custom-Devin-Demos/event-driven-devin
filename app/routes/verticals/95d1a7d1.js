const crypto = require('crypto');
const express = require('express');
const path = require('path');
const {
  inquireClaim,
  browsePositions,
  browseHistory,
  listClaims,
  readClaimMaster,
  ValidationError,
} = require('../../services/verticals/95d1a7d1');
const {
  CLAIM_STATUS,
  POSITION_STATUS,
} = require('../../services/verticals/95d1a7d1-codes');

const router = express.Router();

// Hosted `vite build --base=/95d1a7d1/app/` output of the claims inquiry
// front end (COG-GTM/healthinsurance-cobol-demo, web/).
const APP_WEB_PATH = '/95d1a7d1/app';
const APP_WEB_DIR = path.join(__dirname, '..', '..', 'public', 'verticals', '95d1a7d1-app');
const API_V1 = '/api/95d1a7d1/v1';

router.use(APP_WEB_PATH, express.static(APP_WEB_DIR, { index: 'index.html' }));
router.get(`${APP_WEB_PATH}/{*splat}`, (_req, res) => {
  res.sendFile(path.join(APP_WEB_DIR, 'index.html'));
});
router.get('/95d1a7d1', (_req, res) => res.redirect(`${APP_WEB_PATH}/`));

// ---------------------------------------------------------------------------
// Sign-on (replaces CICS sign-on; contract: api/openapi.yaml /auth/*).
// SECURITY_AUTH rows for resource CLMINQ; AUTH_LEVEL >= '01' is required (SECMGR parity).
// ---------------------------------------------------------------------------
const TOKEN_TTL_SECONDS = 3600;
const JWT_SECRET = process.env.HCPS_JWT_SECRET || 'hcps-inquiry-dev-secret';
const DEV_PASSWORD = process.env.HCPS_DEV_PASSWORD || 'inquiry';
const SECURITY_AUTH = {
  INQUSER1: '03',
  INQUSER2: '01',
  INQUSR01: '03',
  AUDITOR1: '02',
  NOAUTH01: null,
};

function base64url(input) {
  return Buffer.from(input).toString('base64url');
}

function signToken(userId) {
  const header = base64url(JSON.stringify({ alg: 'HS256', typ: 'JWT' }));
  const now = Math.floor(Date.now() / 1000);
  const payload = base64url(JSON.stringify({ sub: userId, iat: now, exp: now + TOKEN_TTL_SECONDS }));
  const signature = crypto.createHmac('sha256', JWT_SECRET).update(`${header}.${payload}`).digest('base64url');
  return `${header}.${payload}.${signature}`;
}

function verifyToken(token) {
  const parts = String(token || '').split('.');
  if (parts.length !== 3) return null;
  const expected = crypto.createHmac('sha256', JWT_SECRET).update(`${parts[0]}.${parts[1]}`).digest();
  const actual = Buffer.from(parts[2], 'base64url');
  if (expected.length !== actual.length || !crypto.timingSafeEqual(expected, actual)) return null;
  try {
    const payload = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8'));
    if (!payload.sub || payload.exp <= Math.floor(Date.now() / 1000)) return null;
    return payload;
  } catch {
    return null;
  }
}

class ContractError extends Error {
  constructor(status, code, message, returnCode) {
    super(message);
    this.name = 'ContractError';
    this.status = status;
    this.code = code;
    this.returnCode = returnCode;
  }
}

function unauthenticated() {
  return new ContractError(401, 'UNAUTHENTICATED', 'Sign-on required', 8);
}

function authenticate(req) {
  const [scheme, token] = String(req.get('authorization') || '').split(' ');
  const payload = scheme === 'Bearer' ? verifyToken(token) : null;
  if (!payload) throw unauthenticated();
  const userId = payload.sub;
  const authLevel = SECURITY_AUTH[userId];
  if (!authLevel || authLevel < '01') {
    throw new ContractError(403, 'FORBIDDEN', 'No authorization record found', 8);
  }
  return { userId, authLevel };
}

function money(value) {
  return Number(value).toFixed(2);
}

function titleCase(value) {
  return value ? value.charAt(0) + value.slice(1).toLowerCase() : value;
}

function sendContractError(res, error) {
  if (error instanceof ContractError) {
    return res.status(error.status).json({ code: error.code, message: error.message, returnCode: error.returnCode });
  }
  if (error instanceof ValidationError) {
    return res.status(400).json({ code: 'VALIDATION', message: error.message, returnCode: 8 });
  }
  if (error.status === 404) {
    return res.status(404).json({ code: 'NOT_FOUND', message: 'Claim record not found', returnCode: 4 });
  }
  return res.status(500).json({
    code: 'BACKEND_ERROR',
    message: `${error.name || 'Error'}: ${error.message}`.slice(0, 79),
    returnCode: 8,
  });
}

function toClaimDetail(result) {
  const { claim, financial } = result;
  const record = readClaimMaster(claim.claimId);
  return {
    returnCode: 0,
    message: 'Claim record retrieved successfully',
    claimId: record.claimId,
    memberId: record.memberId,
    memberName: record.memberName,
    memberType: record.memberType,
    providerId: record.providerId,
    providerName: record.providerName,
    status: record.status,
    statusText: titleCase(CLAIM_STATUS[record.status] || record.status),
    serviceDate: record.serviceDate,
    createDate: record.createDate,
    lastMaintDate: record.lastMaint,
    serviceType: record.serviceType,
    diagnosisCode: record.diagnosisCode,
    procedureCode: record.procedureCode,
    financial: {
      charged: money(financial.charged),
      allowed: money(financial.allowed),
      paid: money(financial.paid),
      memberResponsibility: money(financial.memberResponsibility),
      deductible: money(financial.deductible),
      copay: money(financial.copay),
      coinsurance: money(financial.coinsurance),
      currency: financial.currency,
    },
  };
}

router.post(`${API_V1}/auth/login`, (req, res) => {
  const body = req.body || {};
  const userId = String(body.userId || '').trim().toUpperCase();
  if (!(userId in SECURITY_AUTH) || body.password !== DEV_PASSWORD) {
    return sendContractError(res, new ContractError(401, 'UNAUTHENTICATED', 'Invalid user ID or password', 8));
  }
  return res.json({ accessToken: signToken(userId), tokenType: 'Bearer', expiresIn: TOKEN_TTL_SECONDS, userId });
});

router.get(`${API_V1}/auth/me`, (req, res) => {
  try {
    res.json(authenticate(req));
  } catch (error) {
    sendContractError(res, error);
  }
});

router.get(`${API_V1}/claims/:claimId`, async (req, res) => {
  try {
    const { userId } = authenticate(req);
    const result = await inquireClaim({ claimId: req.params.claimId, userId });
    res.json(toClaimDetail(result));
  } catch (error) {
    sendContractError(res, error);
  }
});

router.get(`${API_V1}/claims/:claimId/positions`, (req, res) => {
  try {
    const { userId } = authenticate(req);
    const limit = Math.min(Number.parseInt(req.query.limit, 10) || 10, 20);
    const page = browsePositions({ claimId: req.params.claimId, userId, page: req.query.page, pageSize: limit });
    const items = page.items.map((item) => ({
      claimId: req.params.claimId.toUpperCase(),
      date: item.date,
      serviceCode: item.serviceCode,
      charged: money(item.charged),
      allowed: money(item.allowed),
      paid: money(item.paid),
      status: Object.keys(POSITION_STATUS).find((code) => POSITION_STATUS[code] === item.status) || item.status,
    }));
    res.json({
      returnCode: items.length ? 0 : 4,
      message: items.length ? 'Position records retrieved' : 'No position records found',
      claimId: req.params.claimId.toUpperCase(),
      page: page.page,
      limit,
      recordCount: items.length,
      hasMore: page.hasMore,
      items,
    });
  } catch (error) {
    sendContractError(res, error);
  }
});

router.get(`${API_V1}/claims/:claimId/history`, (req, res) => {
  try {
    const { userId } = authenticate(req);
    const page = browseHistory({ claimId: req.params.claimId, userId, page: req.query.page, pageSize: 15 });
    const items = page.items.map((item) => ({
      claimId: req.params.claimId.toUpperCase(),
      serviceDate: item.serviceDate,
      serviceTime: item.serviceTime,
      claimType: item.claimType,
      charged: money(item.charged),
      allowed: money(item.allowed),
      paid: money(item.paid),
    }));
    res.json({
      returnCode: items.length ? 0 : 4,
      message: items.length ? 'History records retrieved' : 'No history records found',
      claimId: req.params.claimId.toUpperCase(),
      page: page.page,
      pageSize: 15,
      recordCount: items.length,
      hasMore: page.hasMore,
      items,
    });
  } catch (error) {
    sendContractError(res, error);
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
