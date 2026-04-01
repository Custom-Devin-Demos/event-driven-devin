const axios = require('axios');
const logger = require('../telemetry/logger');
const { getCustomerConfig } = require('../../config/customers');

const GITHUB_API = 'https://api.github.com';
const TARGET_FILE = 'src/extract.py';
/**
 * The vulnerable version of extract.py that triggers SonarCloud quality gate failure.
 *
 * Scenario: A data engineer adds vehicle valuation API enrichment to the
 * extraction pipeline. The code contains realistic security issues that
 * professionals commonly introduce:
 *
 *   1. Hardcoded API key with production-looking value (python:S2068)
 *   2. SSL verification disabled for internal CA compatibility (python:S4830)
 *   3. MD5 used for record checksums / deduplication (python:S4790)
 *   4. SQL injection via f-string interpolation in WHERE clause
 *
 * When pushed as a PR, SonarCloud Automatic Analysis detects these issues,
 * fails the quality gate, and the devin-scan.yml workflow triggers a Devin
 * remediation session to fix them automatically.
 */
const VULNERABLE_EXTRACT_PY = `import os
import hashlib

import requests
import psycopg2
import pandas as pd


# Warehouse connection
DB_HOST = os.getenv("ETL_DB_HOST", "data-warehouse.internal.acme.com")
DB_PORT = int(os.getenv("ETL_DB_PORT", "5432"))
DB_NAME = os.getenv("ETL_DB_NAME", "vehicle_analytics")
DB_USER = os.getenv("ETL_DB_USER", "etl_service")

# Vehicle valuation enrichment API
VALUATION_API_URL = os.getenv("VALUATION_API_URL", "https://api.vehicledata.io/v2")
VALUATION_API_KEY = os.getenv("VALUATION_API_KEY", "vk_live_9kXr4Qm7YbT2wN8sLpG5") # TODO: move to vault


def connect_to_warehouse():
    """Connect to the analytics data warehouse."""
    conn = psycopg2.connect(
        host=DB_HOST,
        port=DB_PORT,
        dbname=DB_NAME,
        user=DB_USER,
        password=os.getenv("ETL_DB_PASSWORD"),
    )
    return conn


def generate_record_checksum(record_data):
    """Generate a checksum for deduplication during incremental loads."""
    return hashlib.md5(str(record_data).encode()).hexdigest()


def fetch_vehicle_valuation(vin):
    """Fetch current market valuation from the enrichment API."""
    resp = requests.get(
        f"{VALUATION_API_URL}/valuation/{vin}",
        headers={"X-Api-Key": VALUATION_API_KEY},
        verify=False,   # internal CA not in runner trust store
        timeout=10,
    )
    resp.raise_for_status()
    return resp.json()


def extract_vehicle_sales_data(region_filter=None):
    """
    Extract vehicle sales data and enrich with market valuations.

    Joins vehicles, dealerships, sales_transactions and service_records,
    then calls the valuation API per VIN for current market pricing.
    """
    conn = connect_to_warehouse()
    cursor = conn.cursor()

    query = (
        "SELECT v.vin, v.model, v.year, d.name AS dealership_name, d.region, "
        "s.sale_date, s.sale_price, s.buyer_name, "
        "COALESCE(sr.service_date, NULL) AS service_date, "
        "COALESCE(sr.service_type, 'Unknown') AS service_type, "
        "COALESCE(sr.service_cost, 0) AS service_cost "
        "FROM vehicles v "
        "JOIN dealerships d ON v.dealership_id = d.id "
        "LEFT JOIN sales_transactions s ON v.vin = s.vin "
        "LEFT JOIN service_records sr ON v.vin = sr.vin"
    )

    if region_filter:
        query += f" WHERE d.region = '{region_filter}'"

    cursor.execute(query)
    columns = [desc[0] for desc in cursor.description]
    rows = cursor.fetchall()
    df = pd.DataFrame(rows, columns=columns)

    # Enrich with market valuations
    for idx, row in df.iterrows():
        try:
            valuation = fetch_vehicle_valuation(row["vin"])
            df.at[idx, "market_value"] = valuation.get("estimated_value")
            df.at[idx, "valuation_checksum"] = generate_record_checksum(valuation)
        except Exception:
            df.at[idx, "market_value"] = None
            df.at[idx, "valuation_checksum"] = None

    df["sale_date"] = pd.to_datetime(df["sale_date"], errors="coerce")
    df["service_date"] = pd.to_datetime(df["service_date"], errors="coerce")

    return df
`;

/**
 * Create a GitHub API client with the configured token.
 */
function githubClient() {
  const token = process.env.GITHUB_PAT || process.env.github_mcp_pat;
  if (!token) {
    throw new Error('No GitHub token configured (GITHUB_PAT or github_mcp_pat)');
  }
  return axios.create({
    baseURL: GITHUB_API,
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: 'application/vnd.github+json',
    },
    timeout: 15000,
  });
}

/**
 * Create a PR in etl-pipeline-demo with intentional vulnerabilities.
 *
 * Steps:
 *   1. Get the SHA of the main branch HEAD
 *   2. Create a new branch from that SHA
 *   3. Get the current file content and its blob SHA
 *   4. Update the file with the vulnerable version
 *   5. Create a pull request
 *
 * The PR triggers SonarCloud Automatic Analysis, which fails the quality gate,
 * which triggers the sonarqube-scan.yml workflow, which creates a Devin
 * remediation session automatically.
 *
 * @param {Object} [options] - Optional overrides
 * @param {string} [options.branchPrefix] - Branch name prefix (default: 'demo/sonar-remediation')
 * @param {string} [options.customer] - Customer slug for per-customer target repo and workflow input
 * @returns {Object} - { prNumber, prUrl, branch, htmlUrl }
 */
async function createVulnerablePR(options = {}) {
  const gh = githubClient();
  const customerSlug = options.customer || 'default';
  const config = getCustomerConfig(customerSlug);
  const targetRepo = config.targetRepo;
  const prefix = options.branchPrefix || 'demo/sonar-remediation';
  const timestamp = Math.floor(Date.now() / 1000);
  const branchName = `${prefix}-${timestamp}`;

  logger.info('Creating vulnerable PR in target repo', { branch: branchName, targetRepo, customer: customerSlug });

  // 1. Get main branch HEAD SHA
  const mainRef = await gh.get(`/repos/${targetRepo}/git/ref/heads/main`);
  const mainSha = mainRef.data.object.sha;

  // 2. Create a new branch
  await gh.post(`/repos/${targetRepo}/git/refs`, {
    ref: `refs/heads/${branchName}`,
    sha: mainSha,
  });
  logger.info('Branch created', { branch: branchName, baseSha: mainSha.substring(0, 8) });

  // 3. Get current file to obtain its blob SHA (needed for update)
  const currentFile = await gh.get(`/repos/${targetRepo}/contents/${TARGET_FILE}`, {
    params: { ref: branchName },
  });
  const fileSha = currentFile.data.sha;

  // 4. Push the vulnerable file
  const content = Buffer.from(VULNERABLE_EXTRACT_PY).toString('base64');
  await gh.put(`/repos/${targetRepo}/contents/${TARGET_FILE}`, {
    message: 'feat: add vehicle valuation enrichment to extraction pipeline',
    content,
    sha: fileSha,
    branch: branchName,
  });
  logger.info('Vulnerable file pushed', { file: TARGET_FILE, branch: branchName });

  // 5. Create the PR
  const prResponse = await gh.post(`/repos/${targetRepo}/pulls`, {
    title: 'feat: add vehicle valuation enrichment to extraction pipeline',
    body: [
      '## Summary',
      '',
      'Enriches vehicle sales extraction with live market valuations from the',
      'vehicle data API. Each VIN is looked up at extraction time so downstream',
      'analytics can compare sale price to current market value.',
      '',
      '### Changes',
      '- Added `fetch_vehicle_valuation()` — calls enrichment API per VIN',
      '- Added `generate_record_checksum()` for incremental load dedup',
      '- Added optional `region_filter` to scope extraction by dealership region',
      '- Refactored DB connection to use warehouse defaults',
      '',
      '### Testing',
      '- Verified against staging warehouse with 500-row sample',
      '- Valuation API returns within SLA (p99 < 200ms)',
    ].join('\n'),
    head: branchName,
    base: 'main',
  });

  const result = {
    prNumber: prResponse.data.number,
    prUrl: prResponse.data.url,
    htmlUrl: prResponse.data.html_url,
    branch: branchName,
  };

  logger.info('Vulnerable PR created', { ...result, targetRepo, customer: customerSlug });

  // 6. Dispatch devin-scan.yml via workflow_dispatch.
  // PRs created via the API don't trigger pull_request events, and
  // push/repository_dispatch produce 0-job ghost runs on this repo.
  // GitHub's workflow registry caches trigger definitions from the first
  // commit a file appears under a given filename. Files created via PR
  // merges (especially renames) inherit stale registry entries that reject
  // workflow_dispatch. Only files created directly on main via the
  // Contents API get fresh, working registry entries.
  // devin-scan.yml was bootstrapped this way and must be dispatched
  // against ref:'main' (the branch where the registry entry lives).
  const WORKFLOW_FILE = 'devin-scan.yml';
  try {
    await gh.post(
      `/repos/${targetRepo}/actions/workflows/${WORKFLOW_FILE}/dispatches`,
      {
          ref: 'main',
          inputs: {
            pr_number: String(result.prNumber),
            pr_branch: branchName,
            customer: customerSlug,
            user_id: options.devinUserId || '',
            org_id: options.devinOrgId || '',
          },
      },
    );
    logger.info('Dispatched devin-scan workflow via workflow_dispatch', {
      prNumber: result.prNumber,
      branch: branchName,
      customer: customerSlug,
      devinUserId: options.devinUserId || 'none',
      devinOrgId: options.devinOrgId || 'none',
    });
  } catch (dispatchErr) {
    logger.error('Failed to dispatch devin-scan workflow', {
      error: dispatchErr.message,
      status: dispatchErr.response?.status,
    });
  }

  return result;
}

/**
 * Schedule the vulnerable PR creation after a delay.
 * Called from the alert flow so it runs in the background.
 *
 * @param {number} [delayMs=60000] - Delay before creating the PR (default: 1 minute)
 * @param {string} [customer] - Customer slug for per-customer target repo
 * @param {string} [devinUserId] - Devin user ID for per-user session creation
 * @param {string} [devinOrgId] - Devin org ID for per-org session creation
 */
function scheduleVulnerablePR(delayMs = 60000, customer, devinUserId, devinOrgId) {
  const token = process.env.GITHUB_PAT || process.env.github_mcp_pat;
  if (!token) {
    logger.warn('No GitHub token configured — skipping SonarCloud PR trigger');
    return;
  }

  logger.info('Scheduling vulnerable PR creation', {
    delayMs,
    customer: customer || 'default',
    devinUserId: devinUserId || 'none',
    devinOrgId: devinOrgId || 'default',
  });

  setTimeout(async () => {
    try {
      const result = await createVulnerablePR({ customer, devinUserId, devinOrgId });
      logger.info('SonarCloud remediation demo PR created successfully', {
        prNumber: result.prNumber,
        htmlUrl: result.htmlUrl,
        customer: customer || 'default',
        devinUserId: devinUserId || 'none',
        devinOrgId: devinOrgId || 'default',
      });
    } catch (error) {
      logger.error('Failed to create vulnerable PR', {
        error: error.message,
        stack: error.stack,
        status: error.response?.status,
        data: error.response?.data,
        customer: customer || 'default',
        devinUserId: devinUserId || 'none',
        devinOrgId: devinOrgId || 'default',
      });
    }
  }, delayMs);
}

module.exports = {
  createVulnerablePR,
  scheduleVulnerablePR,
};
