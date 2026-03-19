const axios = require('axios');
const logger = require('../telemetry/logger');

const GITHUB_API = 'https://api.github.com';
const TARGET_REPO = 'COG-GTM/etl-pipeline-demo';
const TARGET_FILE = 'src/extract.py';
/**
 * The vulnerable version of extract.py that triggers SonarCloud quality gate failure.
 *
 * Intentional vulnerabilities:
 *   1. Hardcoded credential in os.getenv() fallback (python:S2068)
 *   2. SQL injection via string concatenation
 *
 * When pushed as a PR, SonarCloud Automatic Analysis detects the credential,
 * fails the quality gate, and the repo's sonarqube-scan.yml workflow
 * triggers a Devin remediation session to fix it automatically.
 */
const VULNERABLE_EXTRACT_PY = `import os

import psycopg2
import pandas as pd


# Database configuration — uses environment variables with development defaults
DB_HOST = os.getenv("ETL_DB_HOST", "localhost")
DB_PORT = int(os.getenv("ETL_DB_PORT", "5432"))
DB_USER = os.getenv("ETL_DB_USER", "etl_service")
DB_PASSWORD = os.getenv("ETL_DB_PASSWORD", "etl_s3cure#2024")


def connect_to_postgres(dbname, host=None, port=None, user=None, password=None):
    """Connects to a local or remote PostgreSQL database"""
    conn = psycopg2.connect(
        dbname=dbname,
        host=host or DB_HOST,
        port=port or DB_PORT,
        user=user or DB_USER,
        password=password or DB_PASSWORD
    )
    print("\\u2705 Connected to PostgreSQL")
    return conn


def extract_vehicle_sales_data(dbname, host, port, user, password, region_filter=None):
    """
    Extract and transform vehicle sales and service data.
    - Joins vehicles, dealerships, sales_transactions, and service_records
    - Optionally filters by dealership region
    - Replaces null service type/cost with defaults
    - Computes total sales revenue per transaction
    - Formats dates as datetime
    """
    conn = connect_to_postgres(dbname, host, port, user, password)
    cursor = conn.cursor()

    query = "SELECT v.vin, v.model, v.year, d.name AS dealership_name, d.region, " \\
            "s.sale_date, s.sale_price, s.buyer_name, " \\
            "COALESCE(sr.service_date, NULL) AS service_date, " \\
            "COALESCE(sr.service_type, 'Unknown') AS service_type, " \\
            "COALESCE(sr.service_cost, 0) AS service_cost " \\
            "FROM vehicles v " \\
            "JOIN dealerships d ON v.dealership_id = d.id " \\
            "LEFT JOIN sales_transactions s ON v.vin = s.vin " \\
            "LEFT JOIN service_records sr ON v.vin = sr.vin"

    if region_filter:
        query = query + " WHERE d.region = '" + region_filter + "'"

    cursor.execute(query)
    columns = [desc[0] for desc in cursor.description]
    rows = cursor.fetchall()
    df = pd.DataFrame(rows, columns=columns)

    # Convert dates to datetime objects
    df['sale_date'] = pd.to_datetime(df['sale_date'], errors='coerce')
    df['service_date'] = pd.to_datetime(df['service_date'], errors='coerce')

    print("\\U0001f50d Extracted rows:", df.shape[0])
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
 * @returns {Object} - { prNumber, prUrl, branch, htmlUrl }
 */
async function createVulnerablePR(options = {}) {
  const gh = githubClient();
  const prefix = options.branchPrefix || 'demo/sonar-remediation';
  const timestamp = Math.floor(Date.now() / 1000);
  const branchName = `${prefix}-${timestamp}`;

  logger.info('Creating vulnerable PR in etl-pipeline-demo', { branch: branchName });

  // 1. Get main branch HEAD SHA
  const mainRef = await gh.get(`/repos/${TARGET_REPO}/git/ref/heads/main`);
  const mainSha = mainRef.data.object.sha;

  // 2. Create a new branch
  await gh.post(`/repos/${TARGET_REPO}/git/refs`, {
    ref: `refs/heads/${branchName}`,
    sha: mainSha,
  });
  logger.info('Branch created', { branch: branchName, baseSha: mainSha.substring(0, 8) });

  // 3. Get current file to obtain its blob SHA (needed for update)
  const currentFile = await gh.get(`/repos/${TARGET_REPO}/contents/${TARGET_FILE}`, {
    params: { ref: branchName },
  });
  const fileSha = currentFile.data.sha;

  // 4. Push the vulnerable file
  const content = Buffer.from(VULNERABLE_EXTRACT_PY).toString('base64');
  await gh.put(`/repos/${TARGET_REPO}/contents/${TARGET_FILE}`, {
    message: 'feat: add region filter with development credential defaults',
    content,
    sha: fileSha,
    branch: branchName,
  });
  logger.info('Vulnerable file pushed', { file: TARGET_FILE, branch: branchName });

  // 5. Create the PR
  const prResponse = await gh.post(`/repos/${TARGET_REPO}/pulls`, {
    title: 'feat: add region filter to vehicle sales extraction',
    body: [
      '## Summary',
      '',
      'Adds an optional `region_filter` parameter to `extract_vehicle_sales_data()` ',
      'and configures database connection defaults via environment variables.',
      '',
      '### Changes',
      '- Added `os.getenv()` with development defaults for DB config',
      '- Added `region_filter` parameter with WHERE clause support',
      '- Refactored query execution to use `cursor.execute()` for flexibility',
      '',
      '_Auto-generated PR for SonarCloud/Devin remediation demo._',
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

  logger.info('Vulnerable PR created in etl-pipeline-demo', result);

  // The sonar-scan.yml workflow in etl-pipeline-demo triggers on push
  // events for demo/** branches.  The push in step 4 already fired that
  // trigger, so no explicit dispatch call is needed here.

  return result;
}

/**
 * Schedule the vulnerable PR creation after a delay.
 * Called from the alert flow so it runs in the background.
 *
 * @param {number} [delayMs=60000] - Delay before creating the PR (default: 1 minute)
 */
function scheduleVulnerablePR(delayMs = 60000) {
  const token = process.env.GITHUB_PAT || process.env.github_mcp_pat;
  if (!token) {
    logger.warn('No GitHub token configured — skipping SonarCloud PR trigger');
    return;
  }

  logger.info('Scheduling vulnerable PR creation', { delayMs });

  setTimeout(async () => {
    try {
      const result = await createVulnerablePR();
      logger.info('SonarCloud remediation demo PR created successfully', {
        prNumber: result.prNumber,
        htmlUrl: result.htmlUrl,
      });
    } catch (error) {
      logger.error('Failed to create vulnerable PR in etl-pipeline-demo', {
        error: error.message,
        status: error.response?.status,
        data: error.response?.data,
      });
    }
  }, delayMs);
}

module.exports = {
  createVulnerablePR,
  scheduleVulnerablePR,
};
