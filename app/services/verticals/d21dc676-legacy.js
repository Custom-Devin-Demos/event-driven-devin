const D = require('./d21dc676-decimal');
const { BUSINESS_DATE } = require('./d21dc676-mockdata');

/**
 * Legacy SYBAL020 output for the parallel run. In the engagement this is the
 * LBBAL file the mainframe job writes from the same mock FOCLOT input; for
 * the demo it is reproduced here with Enterprise COBOL arithmetic semantics
 * (truncate by default, ROUNDED rounds half away from zero).
 */
function runLegacySybal020(lots) {
  return lots.map((fl) => {
    const begQty = D.setScale(D.add(D.parse(fl['FL-PRIOR-CLOSE-QTY']), D.parse(fl['FL-ADJ-QTY'])), 0, 'DOWN');
    const extCost = D.setScale(D.multiply(begQty, D.parse(fl['FL-AVG-UNIT-COST'])), 2, 'HALF_UP');
    const catchWt = D.setScale(D.multiply(begQty, D.parse(fl['FL-AVG-CASE-WT'])), 3, 'HALF_UP');
    return {
      'LB-OPCO-NBR': fl['FL-OPCO-NBR'],
      'LB-ITEM-NBR': fl['FL-ITEM-NBR'],
      'LB-LOT-NBR': fl['FL-LOT-NBR'],
      'LB-BUS-DT': BUSINESS_DATE,
      'LB-BEG-QTY': D.format(begQty),
      'LB-BEG-EXT-COST-AMT': D.format(extCost),
      'LB-CATCH-WT-LBS': D.format(catchWt),
    };
  });
}

module.exports = { runLegacySybal020 };
