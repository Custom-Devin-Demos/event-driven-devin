const express = require('express');
const {
  submitProposal,
  LISTINGS,
  GUARANTEE_OPTIONS,
  CONTRACT_TERMS,
} = require('../../services/verticals/5e3d523c');

const router = express.Router();

/**
 * GET /api/5e3d523c/imoveis — listings available for rent
 */
router.get('/api/5e3d523c/imoveis', (_req, res) => {
  res.json({
    listings: LISTINGS.map((listing) => ({
      id: listing.id,
      title: listing.title,
      neighborhood: listing.neighborhood,
      city: listing.city,
      street: listing.street,
      rent: listing.rent,
      condoFee: listing.condoFee,
      iptu: listing.iptu,
      area: listing.area,
      bedrooms: listing.bedrooms,
      parkingSpots: listing.parkingSpots,
    })),
  });
});

/**
 * GET /api/5e3d523c/garantias — guarantee options and contract terms
 */
router.get('/api/5e3d523c/garantias', (_req, res) => {
  res.json({
    guarantees: Object.entries(GUARANTEE_OPTIONS).map(([id, option]) => ({
      id,
      label: option.label,
    })),
    terms: Object.entries(CONTRACT_TERMS).map(([months, term]) => ({
      months: Number(months),
      label: term.label,
    })),
  });
});

/**
 * POST /api/5e3d523c/proposta — submit a rental proposal
 */
router.post('/api/5e3d523c/proposta', async (req, res) => {
  const body = req.body || {};

  try {
    const proposal = await submitProposal({
      listingId: body.listingId || '894213507',
      guarantee: body.guarantee || 'quintoandar',
      termMonths: Number(body.termMonths) || 30,
      moveInDate: body.moveInDate || '',
      channel: body.channel || 'web',
      devinUserId: body.devinUserId,
      devinOrgId: body.devinOrgId,
      devinEmail: body.devinEmail,
    });
    res.json(proposal);
  } catch (error) {
    res.status(error.statusCode || 500).json({
      success: false,
      error: error.message,
      errorClass: error.name,
      code: error.code || 'RENTAL_PROPOSAL_FAILED',
      requestId: req.requestId,
    });
  }
});

module.exports = router;
