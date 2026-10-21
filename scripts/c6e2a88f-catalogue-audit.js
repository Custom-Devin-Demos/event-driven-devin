#!/usr/bin/env node
/**
 * Architecture Review Hub — standards catalogue pin audit.
 *
 * Resolves the pinned catalogue version for every submission through the
 * decision-record path and exits non-zero when any submission cannot be
 * resolved. Run with `npm run audit:c6e2a88f`.
 */
const { SUBMISSIONS } = require('../app/services/verticals/c6e2a88f-submissions');
const { pinStandards } = require('../app/services/verticals/c6e2a88f');

let failures = 0;
for (const submission of SUBMISSIONS) {
  try {
    const [pinned] = pinStandards(submission, ['INT-007']);
    if (!pinned.includes(`catalogue ${submission.catalogueVersion.label}`)) {
      throw new Error(`pinned to "${pinned}" but submission is on catalogue ${submission.catalogueVersion.label}`);
    }
    console.log(`ok    ${submission.reference}  catalogue ${submission.catalogueVersion.label}`);
  } catch (error) {
    failures += 1;
    console.log(`FAIL  ${submission.reference}  catalogue ${submission.catalogueVersion.label}  ${error.name}: ${error.message}`);
  }
}

console.log(failures ? `\n${failures} submission(s) cannot be resolved through the decision-record path.` : '\nAll submissions resolve.');
process.exit(failures ? 1 : 0);
