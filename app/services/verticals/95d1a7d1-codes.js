/**
 * Code tables carried over from the CLAIMREC / CLMPOS copybooks. Keys are the
 * one- and three-character codes stored on the VSAM records; values are what
 * the inquiry screens render.
 */
const CLAIM_STATUS = {
  A: 'ACTIVE',
  C: 'CLOSED',
  S: 'SUSPENDED',
  P: 'PENDING',
};

const MEMBER_TYPE = {
  I: 'INDIVIDUAL',
  F: 'FAMILY',
  G: 'GROUP',
};

const POSITION_STATUS = {
  O: 'OPEN',
  C: 'CLOSED',
  A: 'ADJUSTED',
};

const SERVICE_TYPE = {
  MED: 'MEDICAL',
  DEN: 'DENTAL',
  VIS: 'VISION',
  PHR: 'PHARMACY',
  BHV: 'BEHAVIORAL',
};

const BENEFIT_CATEGORY = {
  MED: 'medical',
  DEN: 'dental',
  VIS: 'vision',
  PHR: 'pharmacy',
};

module.exports = {
  CLAIM_STATUS,
  MEMBER_TYPE,
  POSITION_STATUS,
  SERVICE_TYPE,
  BENEFIT_CATEGORY,
};
