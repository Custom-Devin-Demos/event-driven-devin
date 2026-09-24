'use strict';

var _ = require('lodash');
var moment = require('moment');

var MOVEMENT_WEIGHTS = {
  GRN: 1,
  RTN: 1,
  PICK: -1,
  ADJ: 1,
  SHRINK: -1,
};

function applyMovement(position, movement) {
  var weight = MOVEMENT_WEIGHTS[movement.type] || 0;
  position.onHand += weight * movement.quantity;
  if (movement.type === 'ASN') {
    position.inTransit += movement.quantity;
  }
  if (movement.type === 'ALLOC') {
    position.allocated += movement.quantity;
  }
  position.lastMovementAt = moment(movement.occurredAt).toISOString();
  return position;
}

function toPositions(movements) {
  var grouped = _.groupBy(movements, function (movement) {
    return movement.siteId + '|' + movement.sku;
  });

  return _.map(_.keys(grouped), function (key) {
    var parts = key.split('|');
    var position = {
      siteId: parts[0],
      sku: parts[1],
      onHand: 0,
      allocated: 0,
      inTransit: 0,
      lastMovementAt: null,
    };

    _.each(grouped[key], function (movement) {
      applyMovement(position, movement);
    });

    var weeklyDemand = _.reduce(grouped[key], function (total, movement) {
      return movement.type === 'PICK' ? total + movement.quantity : total;
    }, 0);

    position.weeklyDemand = weeklyDemand;
    position.coverageDays = weeklyDemand > 0
      ? Math.round(((position.onHand - position.allocated) / weeklyDemand) * 7 * 10) / 10
      : 99;

    return position;
  });
}

module.exports = {
  toPositions: toPositions,
  applyMovement: applyMovement,
  MOVEMENT_WEIGHTS: MOVEMENT_WEIGHTS,
};
