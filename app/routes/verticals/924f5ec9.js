const express = require('express');
const {
  lookupMember,
  LEDGERS,
  SCOPE_OPTIONS,
  MEMBERS,
} = require('../../services/verticals/924f5ec9');

const router = express.Router();

router.get('/api/924f5ec9/ledgers', (req, res) => {
  res.json({
    ledgers: Object.entries(LEDGERS).map(([key, ledger]) => ({
      key,
      label: ledger.label,
      system: ledger.system,
    })),
    scopeOptions: Object.entries(SCOPE_OPTIONS).map(([key, option]) => ({
      key,
      label: option.label,
      ledgerCount: option.ledgers.length,
    })),
    members: Object.values(MEMBERS).map((member) => ({
      memberNumber: member.memberNumber,
      name: member.name,
    })),
  });
});

router.post('/api/924f5ec9/member-lookup', async (req, res) => {
  const body = req.body || {};
  try {
    const result = await lookupMember({
      memberNumber: body.memberNumber,
      scope: body.scope,
      devinUserId: body.devinUserId,
      devinOrgId: body.devinOrgId,
      devinEmail: body.devinEmail,
    });

    res.json(result);
  } catch (error) {
    res.status(error.statusCode || 500).json({
      success: false,
      error: error.message,
      errorClass: error.name,
      code: error.code || 'MEMBER_LOOKUP_FAILED',
      requestId: error.requestId || req.requestId || null,
    });
  }
});

module.exports = router;
