/**
 * Rate tables for the 957da0c9 quote engine.
 *
 * Tables are keyed by rating basis. Each table carries age bands with a
 * monthly base rate per $1,000 of coverage plus tobacco and gender loads.
 */

const RATE_TABLES = Object.freeze({
  termLife: {
    minCoverage: 100000,
    bands: [
      { maxAge: 29, rate: 0.071 }, { maxAge: 39, rate: 0.084 }, { maxAge: 49, rate: 0.152 },
      { maxAge: 59, rate: 0.318 }, { maxAge: 69, rate: 0.742 }, { maxAge: 120, rate: 1.610 },
    ],
    tobaccoLoad: 2.35,
  },
  incomeProtection: {
    minCoverage: 24000,
    bands: [
      { maxAge: 29, rate: 1.12 }, { maxAge: 39, rate: 1.46 }, { maxAge: 49, rate: 2.05 },
      { maxAge: 59, rate: 2.88 }, { maxAge: 120, rate: 3.90 },
    ],
    tobaccoLoad: 1.40,
  },
  dentalPpo: {
    minCoverage: 1500,
    bands: [{ maxAge: 17, rate: 18.4 }, { maxAge: 64, rate: 24.9 }, { maxAge: 120, rate: 31.2 }],
    tobaccoLoad: 1.0,
  },
  visionPlan: {
    minCoverage: 500,
    bands: [{ maxAge: 17, rate: 6.1 }, { maxAge: 64, rate: 8.4 }, { maxAge: 120, rate: 9.7 }],
    tobaccoLoad: 1.0,
  },
  accidentIndemnity: {
    minCoverage: 10000,
    bands: [{ maxAge: 39, rate: 0.52 }, { maxAge: 59, rate: 0.71 }, { maxAge: 120, rate: 1.04 }],
    tobaccoLoad: 1.15,
  },
  fixedAnnuity: {
    minCoverage: 25000,
    bands: [{ maxAge: 49, rate: 0.0421 }, { maxAge: 64, rate: 0.0468 }, { maxAge: 120, rate: 0.0515 }],
    tobaccoLoad: 1.0,
  },
});

function bandFor(table, age) {
  return table.bands.find((b) => age <= b.maxAge) || table.bands[table.bands.length - 1];
}

function monthlyPremium(table, { age, coverage, tobacco }) {
  const band = bandFor(table, age);
  const units = Math.max(coverage, table.minCoverage) / 1000;
  const load = tobacco ? table.tobaccoLoad : 1;
  return Math.round(band.rate * units * load * 100) / 100;
}

module.exports = { RATE_TABLES, bandFor, monthlyPremium };
