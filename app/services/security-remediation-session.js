const logger = require('../telemetry/logger');
const { createDevinSession } = require('./devin-api');
const { getCustomerConfig } = require('../../config/customers');

const SECURITY_SESSION_DELAY_MS = 60 * 1000;
const SECURITY_REPO = 'COG-GTM/demo-vulns-swarm';

// The confirmed high-severity finding the stage demo remediates. Same shape the
// "Security Scan: High/Critical Finding -> Remediation PR" webhook automation
// receives; kept here so the demo does not depend on SonarCloud or a GitHub
// Actions dispatch to start the second session.
const CARELINK_FINDING = Object.freeze({
  "event": "finding.confirmed",
  "source": "devin-code-scan",
  "finding_id": "sfind-040a791ef0fd4357b47d5cddd3e0aca4",
  "severity": "high",
  "title": "Log forging and PHI written to audit log via unsanitized concatenation",
  "repository": "COG-GTM/demo-vulns-swarm",
  "file": "src/main/java/com/carelink/memberportal/service/MemberService.java",
  "line": 27,
  "description": "MemberService.search writes the raw attacker-controlled lastName search term into the audit log by string concatenation, permitting log forging and writing member search terms to the audit trail in cleartext.",
  "recommendation": "Use parameterized logging, strip or encode CR/LF, and redact member identifiers or search terms per policy."
});

// Mirrors that automation's prompt so the directly created session behaves the same.
const REMEDIATION_PROMPT = "# Security Scan Finding \u2192 Remediation PR\n\nA security scan of the Carelink Member Portal API has confirmed a high or critical\nvulnerability. Your job is to remediate exactly this one finding and end with a\nreview-ready pull request. Work autonomously; do not wait for human input.\n\n## The finding\n\nThe webhook payload for this run contains the finding. Read it first and restate it\nin your own words before you touch any code:\n\n- `finding_id`, `severity`, `title`\n- `file` and `line` \u2014 the vulnerable code location\n- `description` \u2014 what the scan proved, including the exploit request it used\n- `chain` (optional) \u2014 the other findings this one is chained with, if the scan\n  confirmed a multi-step attack path\n- `scan_url` \u2014 the Devin code scan this finding came from\n\nRemediate **only** the finding in the payload. Other findings in the same scan are\nhandled by their own runs; do not fix them, and do not refactor unrelated code.\n\n## Repository\n\n- `COG-GTM/demo-vulns-swarm` \u2014 Carelink Member Portal API, Java 17, Spring Boot 2.7,\n  Maven, H2 in-memory database.\n- Branch from the default branch. Name the branch\n  `devin/$(date +%s)-<short-finding-slug>`.\n- Never push to `main`. Never modify anything under `.github/`, and never weaken a\n  test, a scanner configuration, or a security policy to make a check pass.\n\n## What to do\n\n1. **Confirm the vulnerability before fixing it.** Start the app with\n   `mvn -q -DskipTests spring-boot:run` (port 8080; seed data loads automatically)\n   and reproduce the exploit from the finding's description with `curl`. Capture the\n   exact request and response. If you cannot reproduce it, say so explicitly in the\n   PR rather than fixing blind.\n2. **Find the true root cause.** Read the surrounding code and follow the call path\n   from the HTTP entry point to the vulnerable sink. Fix the root cause at the sink,\n   not just the entry point, and check whether the same unsafe pattern appears\n   elsewhere in the repository \u2014 if it does, fix those occurrences too and say so.\n3. **Implement the minimal correct fix**, matching the conventions already used in\n   the file. Preserve the public API and the endpoint's legitimate behavior.\n4. **Write a regression test** that fails against the old code and passes against the\n   fix. Put it alongside the existing tests in `src/test/java`.\n5. **Verify.** Run `mvn -B clean verify` and require it green (12 tests is the\n   baseline; your new test adds to that). Then restart the app and re-run the exploit\n   `curl` to show it no longer works, plus a control request showing the endpoint's\n   legitimate behavior still works. Record both.\n6. **Update the security register.** If `security/VULNERABILITY-MANAGEMENT.md` or\n   `security/SOUP.md` covers this component, update the relevant row. If a dependency\n   version changed, regenerate the SBOM under `security/sbom/` the same way the repo\n   already does.\n7. **Open a pull request** into the default branch of `COG-GTM/demo-vulns-swarm`.\n   The PR is the end state \u2014 do not merge it. Include in the description:\n   - the finding ID, severity, title, and a link to `scan_url`\n   - the attack path in plain words, naming each file involved (if the finding is\n     part of a confirmed chain, say which link of the chain this PR breaks)\n   - the exploit request/response before the fix, and the same request after it\n   - the root cause in one or two sentences\n   - `mvn -B clean verify` output summary\n   - what a human reviewer still owns (merge, release, any config or secret rotation)\n\n   End the PR description with this line exactly, on its own line:\n\n   ```\n   Devin-Org: engineering\n   ```\n\n   Every commit message must contain the word `fix` or `bug`.\n8. **Post to Slack** in `#devin-security-alerts`: one new message with the finding\n   severity and title, the one-line root cause, which link of the attack chain it\n   breaks, the PR link, and this session's URL. Then reply in that message's thread\n   with the before/after exploit evidence and the test results.\n\n## Constraints\n\n- Never print, log, or commit a credential, token, or secret value.\n- Stay inside this repository; do not open PRs against any other repository.\n- If a step genuinely cannot be completed, finish the remaining steps and state the\n  gap plainly in the PR and the Slack message. Do not claim work you did not do.";

function buildSecurityPrompt(finding = CARELINK_FINDING) {
  return `${REMEDIATION_PROMPT}\n\n## Webhook payload\n\n\`\`\`json\n${JSON.stringify(finding, null, 2)}\n\`\`\``;
}

/**
 * Start the Carelink security-remediation session in the presenter's account
 * after `delayMs`, independently of the RatingsDirect incident session.
 * Returns the timer so callers/tests can cancel it.
 */
function scheduleSecuritySession({ customer, devinUserId, devinOrgId, delayMs = SECURITY_SESSION_DELAY_MS } = {}) {
  const config = getCustomerConfig(customer);
  const userId = devinUserId || config.devinUserId || '';
  const orgId = devinOrgId || config.devinOrgId || '';

  logger.info('Scheduling security remediation session', {
    customer: config.customer, repo: SECURITY_REPO, findingId: CARELINK_FINDING.finding_id, delayMs,
    devinUserId: userId || 'service-user', devinOrgId: orgId || 'default',
  });

  const timer = setTimeout(async () => {
    try {
      const session = await createDevinSession(buildSecurityPrompt(), {
        apiKey: config.apiKey,
        orgId,
        userId,
        title: `Security finding ${CARELINK_FINDING.severity.toUpperCase()}: ${CARELINK_FINDING.title}`,
        repos: [SECURITY_REPO],
      });
      if (session) {
        logger.info('Security remediation session created', { sessionId: session.sessionId, url: session.url, repo: SECURITY_REPO });
      } else {
        logger.warn('Security remediation session was not created — API call failed or not configured', { repo: SECURITY_REPO });
      }
    } catch (error) {
      logger.error('Failed to create security remediation session', { error: error.message, status: error.response?.status, data: error.response?.data });
    }
  }, delayMs);
  if (typeof timer.unref === 'function') timer.unref();
  return timer;
}

module.exports = {
  CARELINK_FINDING,
  SECURITY_REPO,
  SECURITY_SESSION_DELAY_MS,
  buildSecurityPrompt,
  scheduleSecuritySession,
};
