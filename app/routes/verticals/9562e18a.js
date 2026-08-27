const express = require('express');
const { reserveVehicle, VEHICLE_CLASSES } = require('../../services/verticals/9562e18a');

const router = express.Router();

router.get('/api/9562e18a/vehicles', (_req, res) => {
  res.json({ vehicles: VEHICLE_CLASSES });
});

router.post('/api/9562e18a/reserve', async (req, res) => {
  try {
    const result = await reserveVehicle({
      pickupLocation: req.body.pickupLocation,
      pickupLocationCode: req.body.pickupLocationCode,
      pickupAt: req.body.pickupAt,
      returnAt: req.body.returnAt,
      renterAge: req.body.renterAge,
      corporateAccountNumber: req.body.corporateAccountNumber,
      vehicleClass: req.body.vehicleClass || 'CFAR',
      protectionProducts: req.body.protectionProducts,
      equipment: req.body.equipment,
      renterName: req.body.renterName,
      devinUserId: req.body.devinUserId,
      devinOrgId: req.body.devinOrgId,
      devinEmail: req.body.devinEmail,
    });
    res.json(result);
  } catch (error) {
    res.status(error.statusCode || 500).json({
      success: false,
      error: error.message,
      errorClass: error.name,
      code: error.code || 'RESERVATION_FAILED',
      requestId: req.requestId,
    });
  }
});

module.exports = router;
