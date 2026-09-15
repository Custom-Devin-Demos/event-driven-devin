const { v4: uuidv4 } = require('uuid');
const logger = require('../../telemetry/logger');
const { incrementMetric, recordTiming } = require('../../telemetry/datadog');
const { Sentry } = require('../../telemetry/sentry');
const { createSessionAndAlert } = require('../devin-session');

/**
 * Listings served to the rental page.
 */
const LISTINGS = [
  {
    id: '894213507',
    title: 'Apartamento para alugar',
    neighborhood: 'Vila Madalena',
    city: 'São Paulo',
    street: 'Rua Harmonia',
    rent: 4200,
    condoFee: 780,
    iptu: 195,
    area: 68,
    bedrooms: 2,
    parkingSpots: 1,
  },
  {
    id: '771560284',
    title: 'Apartamento para alugar',
    neighborhood: 'Pinheiros',
    city: 'São Paulo',
    street: 'Rua dos Pinheiros',
    rent: 3350,
    condoFee: 640,
    iptu: 142,
    area: 54,
    bedrooms: 1,
    parkingSpots: 1,
  },
  {
    id: '602934118',
    title: 'Casa para alugar',
    neighborhood: 'Perdizes',
    city: 'São Paulo',
    street: 'Rua Cardoso de Almeida',
    rent: 6100,
    condoFee: 0,
    iptu: 410,
    area: 132,
    bedrooms: 3,
    parkingSpots: 2,
  },
];

/**
 * Guarantee options a tenant can pick when closing a rental. Each option maps
 * to the plan code that prices the contract.
 */
const GUARANTEE_OPTIONS = {
  quintoandar: { label: 'Garantia QuintoAndar', planCode: 'qa_garantia_v2' },
  fiador: { label: 'Fiador', planCode: 'fiador' },
  'seguro-fianca': { label: 'Seguro-fiança', planCode: 'seguro_fianca' },
  deposito: { label: 'Depósito caução', planCode: 'deposito_caucao' },
};

/**
 * Guarantee plans keyed by plan code: the service rate charged on the rent and
 * what the tenant has to put up front.
 */
const GUARANTEE_PLANS = {
  fiador: {
    label: 'Fiador',
    serviceRate: 0.08,
    upfrontMonths: 0,
    requiresApproval: true,
    analysisDays: 3,
  },
  seguro_fianca: {
    label: 'Seguro-fiança',
    serviceRate: 0.115,
    upfrontMonths: 0,
    requiresApproval: true,
    analysisDays: 2,
  },
  deposito_caucao: {
    label: 'Depósito caução',
    serviceRate: 0.09,
    upfrontMonths: 3,
    requiresApproval: false,
    analysisDays: 1,
  },
};

/**
 * Contract terms the proposal can price.
 */
const CONTRACT_TERMS = {
  12: { label: '12 meses', discountRate: 0 },
  30: { label: '30 meses', discountRate: 0.03 },
};

const FIRE_INSURANCE_RATE = 0.0045;

/**
 * Scenario directive appended to the Devin investigation prompt.
 *
 * The alert pipeline passes only a prompt to the Devin API, so the repository
 * to remediate has to be named explicitly here.
 */
const REMEDIATION_DIRECTIVE = [
  '*Repository to investigate and fix:* `COG-GTM/event-driven-devin`',
  '',
  'The failing code path is the QuintoAndar rental proposal vertical:',
  '- Service: `app/services/verticals/5e3d523c.js`',
  '- Route: `app/routes/verticals/5e3d523c.js`',
  '- Page: `app/public/verticals/5e3d523c.html` (served at `/quintoandar`)',
  '',
  'Open a pull request against `main` with the fix.',
].join('\n');

function findListing(listingId) {
  return LISTINGS.find((listing) => listing.id === listingId) || null;
}

/**
 * Resolve the guarantee plan that prices a rental contract.
 */
function resolveGuaranteePlan(optionId) {
  const option = GUARANTEE_OPTIONS[optionId] || GUARANTEE_OPTIONS.quintoandar;
  return { option, plan: GUARANTEE_PLANS[option.planCode] };
}

/**
 * Service fee and up-front requirements for the chosen guarantee.
 */
function computeGuarantee(rent, optionId) {
  const { option, plan } = resolveGuaranteePlan(optionId);

  return {
    guarantee: option.label,
    planLabel: plan.label,
    serviceFee: Math.round(rent * plan.serviceRate * 100) / 100,
    upfrontAmount: Math.round(rent * plan.upfrontMonths * 100) / 100,
    requiresApproval: plan.requiresApproval,
    analysisDays: plan.analysisDays,
  };
}

/**
 * Apply the term discount to the monthly rent.
 */
function computeRent(listing, termMonths) {
  const term = CONTRACT_TERMS[termMonths] || CONTRACT_TERMS[12];
  const rent = listing.rent * (1 - term.discountRate);

  return {
    termLabel: term.label,
    monthlyRent: Math.round(rent * 100) / 100,
  };
}

/**
 * Build the monthly cost breakdown shown on the proposal screen.
 */
function buildProposalSummary(proposalId, listing, rent, guarantee, moveInDate) {
  const fireInsurance = Math.round(listing.rent * FIRE_INSURANCE_RATE * 100) / 100;
  const monthlyTotal =
    rent.monthlyRent + listing.condoFee + listing.iptu + fireInsurance + guarantee.serviceFee;

  return {
    success: true,
    proposalId,
    status: 'em_analise',
    listingId: listing.id,
    listingLabel: `${listing.title} · ${listing.neighborhood}, ${listing.city}`,
    termLabel: rent.termLabel,
    monthlyRent: rent.monthlyRent,
    condoFee: listing.condoFee,
    iptu: listing.iptu,
    fireInsurance,
    serviceFee: guarantee.serviceFee,
    monthlyTotal: Math.round(monthlyTotal * 100) / 100,
    upfrontAmount: guarantee.upfrontAmount,
    guarantee,
    moveInDate,
    submittedAt: new Date().toISOString(),
  };
}

/**
 * Submit a rental proposal for a listing.
 */
async function submitProposal(data) {
  const startTime = Date.now();
  const proposalId = uuidv4();
  const listing = findListing(data.listingId);

  logger.info('Submitting rental proposal', {
    proposalId,
    listingId: data.listingId,
    guarantee: data.guarantee,
    termMonths: data.termMonths,
    service: 'customer-5e3d523c-rental',
    route: '/api/5e3d523c/proposta',
  });

  try {
    await new Promise((resolve) => setTimeout(resolve, 90 + Math.random() * 140));

    if (!listing) {
      const unavailable = new Error('Este imóvel não está mais disponível para locação.');
      unavailable.name = 'ValidationError';
      unavailable.code = 'LISTING_UNAVAILABLE';
      unavailable.statusCode = 400;
      throw unavailable;
    }

    const rent = computeRent(listing, data.termMonths);
    const guarantee = computeGuarantee(listing.rent, data.guarantee);
    const summary = buildProposalSummary(
      proposalId,
      listing,
      rent,
      guarantee,
      data.moveInDate
    );

    const duration = Date.now() - startTime;

    incrementMetric('rental_proposal.success', {
      route: '/api/5e3d523c/proposta',
      guarantee: data.guarantee || 'quintoandar',
    });
    recordTiming('rental_proposal.latency', duration, {
      route: '/api/5e3d523c/proposta',
    });

    return summary;
  } catch (error) {
    const duration = Date.now() - startTime;

    incrementMetric('rental_proposal.failure', {
      route: '/api/5e3d523c/proposta',
      errorClass: error.name,
      guarantee: data.guarantee || 'quintoandar',
    });
    recordTiming('rental_proposal.latency', duration, {
      route: '/api/5e3d523c/proposta',
      error: 'true',
    });

    logger.error('Rental proposal failed', {
      proposalId,
      error: error.message,
      errorClass: error.name,
      durationMs: duration,
      listingId: data.listingId,
      guarantee: data.guarantee,
      termMonths: data.termMonths,
      service: 'customer-5e3d523c-rental',
    });

    if (error.statusCode === 400) {
      throw error;
    }

    Sentry.captureException(error, {
      tags: {
        route: '/api/5e3d523c/proposta',
        service: 'customer-5e3d523c-rental',
        guarantee: data.guarantee,
      },
      extra: {
        proposalId,
        listingId: data.listingId,
        guarantee: data.guarantee,
        termMonths: data.termMonths,
      },
    });

    createSessionAndAlert({
      issueTitle: `${error.name}: ${error.message}`,
      issueUrl: `https://${process.env.SENTRY_ORG_SLUG || 'sentry-org'}.sentry.io/issues/?project=${process.env.SENTRY_PROJECT_ID || ''}&query=is%3Aunresolved`,
      culprit: 'app/services/verticals/5e3d523c.js \u2014 computeGuarantee',
      errorType: error.name || 'Error',
      errorValue: error.message,
      devinUserId: data.devinUserId,
      devinEmail: data.devinEmail,
      devinOrgId: data.devinOrgId,
      service: 'customer-5e3d523c-rental',
      verticalLabel: 'Rental Proposal',
      promptAppendix: REMEDIATION_DIRECTIVE,
      customer: '5e3d523c',
      tags: [
        { key: 'route', value: '/api/5e3d523c/proposta' },
        { key: 'service', value: 'customer-5e3d523c-rental' },
        { key: 'guarantee', value: data.guarantee },
        { key: 'term', value: String(data.termMonths || '') },
      ],
      extra: {
        proposalId,
        listingId: data.listingId,
        guarantee: data.guarantee,
        termMonths: data.termMonths,
      },
      level: 'error',
      platform: 'node',
      firstSeen: '',
      lastSeen: new Date().toISOString(),
      count: '',
      shortId: '',
      project: 'event-driven-devin',
      release: process.env.SENTRY_RELEASE || 'customer-5e3d523c-rental@1.0.0',
      environment: process.env.DD_ENV || 'prod',
      triggeredRule: '',
    }).catch((err) => {
      logger.error('Failed to create Devin session for rental proposal error', {
        error: err.message,
        proposalId,
      });
    });

    throw error;
  }
}

module.exports = {
  submitProposal,
  REMEDIATION_DIRECTIVE,
  LISTINGS,
  GUARANTEE_OPTIONS,
  GUARANTEE_PLANS,
  CONTRACT_TERMS,
  findListing,
  resolveGuaranteePlan,
  computeGuarantee,
  computeRent,
};
