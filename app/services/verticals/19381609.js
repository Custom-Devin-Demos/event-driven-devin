const { v4: uuidv4 } = require('uuid');
const logger = require('../../telemetry/logger');
const { incrementMetric, recordTiming } = require('../../telemetry/datadog');
const { Sentry } = require('../../telemetry/sentry');
const { createSessionAndAlert } = require('../devin-session');

const SLACK_MEMBER_ID = process.env.APPLIED_SLACK_MEMBER_ID || '';

const SERVICE = 'customer-19381609-attachment-search';
const ROUTE = '/api/19381609/search';
const CULPRIT = 'app/services/verticals/19381609.js — describeAttachedTo';

const AGENCY = {
  name: 'Applied Agency Insurance Services',
  code: 'INS',
  branches: {
    MAT: 'Main — Chicago, IL',
    MIL: 'Milwaukee, WI',
    IND: 'Indianapolis, IN',
  },
};

const EPIC_LINE_TYPES = {
  WCOM: { description: "Worker's Compensation", lineOfBusiness: 'Commercial' },
  BAUT: { description: 'Business Auto', lineOfBusiness: 'Commercial' },
  GLIA: { description: 'General Liability', lineOfBusiness: 'Commercial' },
  PROP: { description: 'Property', lineOfBusiness: 'Commercial' },
  CUMB: { description: 'Commercial Umbrella', lineOfBusiness: 'Commercial' },
  CPKG: { description: 'Commercial Package', lineOfBusiness: 'Commercial' },
  INMR: { description: 'Inland Marine', lineOfBusiness: 'Commercial' },
  CYBR: { description: 'Cyber Liability', lineOfBusiness: 'Commercial' },
};

// Carrier downloads (Ivans) arrive with ACORD line-of-business codes.
const ACORD_TO_EPIC_LINE = {
  WORK: 'WCOM',
  AUTOB: 'BAUT',
  CGL: 'GLIA',
  PROPC: 'PROP',
  UMBRC: 'CUMB',
  CPKGE: 'CPKG',
  INMRC: 'INMR',
  CYBER: 'CYBR',
};

function toEpicLineCode(code) {
  return ACORD_TO_EPIC_LINE[code] || code;
}

const ACCOUNTS = [
  {
    lookupCode: 'HARTLOG-01', name: 'Hartwell Logistics, Inc.', type: 'Commercial', branch: 'MAT',
    primaryContact: 'Dana Whitfield', email: 'dwhitfield@hartwelllogistics.com', phone: '(312) 555-0148',
    accountExec: 'Marisol Reyes', csr: 'Tom Becker',
  },
  {
    lookupCode: 'LAKESHO-01', name: 'Lakeshore Dental Group', type: 'Commercial', branch: 'MAT',
    primaryContact: 'Dr. Priya Raman', email: 'office@lakeshoredental.com', phone: '(312) 555-0193',
    accountExec: 'Marisol Reyes', csr: 'Angela Ortiz',
  },
  {
    lookupCode: 'BRIGHTW-01', name: 'Brightwater Property Management', type: 'Commercial', branch: 'MIL',
    primaryContact: 'Kevin Lindqvist', email: 'klindqvist@brightwaterpm.com', phone: '(414) 555-0172',
    accountExec: 'Derek Han', csr: 'Tom Becker',
  },
  {
    lookupCode: 'NORTHSI-01', name: 'Northside Electric Co.', type: 'Commercial', branch: 'MAT',
    primaryContact: 'Ray Kowalczyk', email: 'ray@northsideelectric.com', phone: '(773) 555-0126',
    accountExec: 'Derek Han', csr: 'Angela Ortiz',
  },
  {
    lookupCode: 'PRAIRIE-01', name: 'Prairie Ridge Farms LLC', type: 'Commercial', branch: 'IND',
    primaryContact: 'Hannah Voss', email: 'hannah@prairieridgefarms.com', phone: '(317) 555-0164',
    accountExec: 'Marisol Reyes', csr: 'Luis Navarro',
  },
  {
    lookupCode: 'CARDINA-01', name: 'Cardinal Freight Brokers', type: 'Commercial', branch: 'IND',
    primaryContact: 'Monique Ellis', email: 'mellis@cardinalfreight.com', phone: '(317) 555-0110',
    accountExec: 'Derek Han', csr: 'Luis Navarro',
  },
  {
    lookupCode: 'SUMMITC-01', name: 'Summit Craft Brewing Co.', type: 'Commercial', branch: 'MIL',
    primaryContact: 'Owen Gallagher', email: 'owen@summitcraftbrewing.com', phone: '(414) 555-0187',
    accountExec: 'Marisol Reyes', csr: 'Tom Becker',
  },
];

const ACCOUNTS_BY_CODE = Object.fromEntries(ACCOUNTS.map((account) => [account.lookupCode, account]));

const POLICIES = {
  'HARTLOG-01': [
    { line: 'WCOM', policyNumber: 'UB-7K412093', status: 'Renewal', effective: '2026-08-07', expiration: '2027-08-07', stage: 'A', company: 'TRAVE1', billing: 'Agency' },
    { line: 'BAUT', policyNumber: 'BA-4R228710', status: 'Renewal', effective: '2026-06-01', expiration: '2027-06-01', stage: 'A', company: 'TRAVE1', billing: 'Agency' },
    { line: 'GLIA', policyNumber: 'CPP 2848019', status: 'Renewal', effective: '2026-06-01', expiration: '2027-06-01', stage: 'A', company: 'CHUBB1', billing: 'Direct' },
    { line: 'PROP', policyNumber: 'CPP 2848019', status: 'Renewal', effective: '2026-06-01', expiration: '2027-06-01', stage: 'A', company: 'CHUBB1', billing: 'Direct' },
    { line: 'CUMB', policyNumber: 'UMB 4471902', status: 'New', effective: '2025-12-01', expiration: '2026-12-01', stage: 'A', company: 'LIBMU1', billing: 'Agency' },
    { line: 'INMR', policyNumber: 'QT-660K1187', status: 'Renewal', effective: '2025-11-15', expiration: '2026-11-15', stage: 'A', company: 'TRAVE1', billing: 'Agency' },
    { line: 'WCOM', policyNumber: 'UB-7K412093', status: 'Renewal', effective: '2025-08-07', expiration: '2026-08-07', stage: 'D', company: 'TRAVE1', billing: 'Agency' },
    { line: 'GLIA', policyNumber: 'CPP 2848019', status: 'Renewal', effective: '2025-06-01', expiration: '2026-06-01', stage: 'D', company: 'CHUBB1', billing: 'Direct' },
    { line: 'PROP', policyNumber: 'CPP 2848019', status: 'Renewal', effective: '2025-06-01', expiration: '2026-06-01', stage: 'D', company: 'CHUBB1', billing: 'Direct' },
  ],
  'LAKESHO-01': [
    { line: 'CPKG', policyNumber: 'BOP 9921406', status: 'Renewal', effective: '2026-03-01', expiration: '2027-03-01', stage: 'A', company: 'HARTF1', billing: 'Direct' },
    { line: 'WCOM', policyNumber: 'WC 55102384', status: 'Renewal', effective: '2026-03-01', expiration: '2027-03-01', stage: 'A', company: 'HARTF1', billing: 'Direct' },
    { line: 'CYBR', policyNumber: 'CYB-1004872', status: 'New', effective: '2026-01-10', expiration: '2027-01-10', stage: 'A', company: 'COALI1', billing: 'Agency' },
  ],
  'BRIGHTW-01': [
    { line: 'PROP', policyNumber: 'PRP 3310978', status: 'Renewal', effective: '2025-12-15', expiration: '2026-12-15', stage: 'A', company: 'CINCI1', billing: 'Agency' },
    { line: 'GLIA', policyNumber: 'GL 3310979', status: 'Renewal', effective: '2025-12-15', expiration: '2026-12-15', stage: 'A', company: 'CINCI1', billing: 'Agency' },
    { line: 'CUMB', policyNumber: 'UMB 3310980', status: 'Renewal', effective: '2025-12-15', expiration: '2026-12-15', stage: 'A', company: 'CINCI1', billing: 'Agency' },
  ],
  'NORTHSI-01': [
    { line: 'GLIA', policyNumber: 'GL-80021457', status: 'Renewal', effective: '2026-04-01', expiration: '2027-04-01', stage: 'A', company: 'LIBMU1', billing: 'Agency' },
    { line: 'BAUT', policyNumber: 'BA-80021458', status: 'Renewal', effective: '2026-04-01', expiration: '2027-04-01', stage: 'A', company: 'LIBMU1', billing: 'Agency' },
    { line: 'WCOM', policyNumber: 'WC-80021459', status: 'Renewal', effective: '2026-04-01', expiration: '2027-04-01', stage: 'A', company: 'LIBMU1', billing: 'Agency' },
  ],
  'PRAIRIE-01': [
    { line: 'CPKG', policyNumber: 'FRM 7740122', status: 'Renewal', effective: '2026-02-01', expiration: '2027-02-01', stage: 'A', company: 'NATIO1', billing: 'Direct' },
    { line: 'BAUT', policyNumber: 'BA 7740123', status: 'Renewal', effective: '2026-02-01', expiration: '2027-02-01', stage: 'A', company: 'NATIO1', billing: 'Direct' },
  ],
  'CARDINA-01': [
    { line: 'BAUT', policyNumber: 'MCA-2219034', status: 'Renewal', effective: '2025-11-20', expiration: '2026-11-20', stage: 'A', company: 'TRAVE1', billing: 'Agency' },
    { line: 'INMR', policyNumber: 'MTC-2219035', status: 'Renewal', effective: '2025-11-20', expiration: '2026-11-20', stage: 'A', company: 'TRAVE1', billing: 'Agency' },
    { line: 'GLIA', policyNumber: 'GL-2219036', status: 'Renewal', effective: '2025-11-20', expiration: '2026-11-20', stage: 'A', company: 'TRAVE1', billing: 'Agency' },
  ],
  'SUMMITC-01': [
    { line: 'CPKG', policyNumber: 'CPP 6612090', status: 'Renewal', effective: '2026-05-01', expiration: '2027-05-01', stage: 'A', company: 'CHUBB1', billing: 'Direct' },
    { line: 'WCOM', policyNumber: 'WC 6612091', status: 'Renewal', effective: '2026-05-01', expiration: '2027-05-01', stage: 'A', company: 'CHUBB1', billing: 'Direct' },
    { line: 'CUMB', policyNumber: 'UMB 6612092', status: 'Renewal', effective: '2026-05-01', expiration: '2027-05-01', stage: 'A', company: 'CHUBB1', billing: 'Direct' },
  ],
};

const ACTIVITIES = {
  'HARTLOG-01': [
    { subject: 'Renewal review — Commercial Umbrella', due: '2026-11-02', owner: 'Marisol Reyes' },
    { subject: 'Ivans download 7186042 — file carrier documents', due: '2026-10-30', owner: 'Tom Becker' },
    { subject: 'Request updated driver schedule', due: '2026-11-14', owner: 'Tom Becker' },
  ],
  'LAKESHO-01': [{ subject: 'Send cyber application to Coalition', due: '2026-11-05', owner: 'Angela Ortiz' }],
  'BRIGHTW-01': [
    { subject: 'Remarket property renewal — 12/15', due: '2026-11-10', owner: 'Derek Han' },
    { subject: 'Ivans download 7186051 — file umbrella quote', due: '2026-10-30', owner: 'Tom Becker' },
  ],
  'NORTHSI-01': [],
  'PRAIRIE-01': [{ subject: 'Confirm farm equipment schedule', due: '2026-11-20', owner: 'Luis Navarro' }],
  'CARDINA-01': [{ subject: 'Motor truck cargo renewal — 11/20', due: '2026-11-03', owner: 'Luis Navarro' }],
  'SUMMITC-01': [{ subject: 'Review experience mod worksheet', due: '2026-11-12', owner: 'Tom Becker' }],
};

// Attachments filed from Ivans download batches 7186042 and 7186051. Records
// created by the Ivans eDocs mailbox keep the carrier's ACORD line code.
const ATTACHMENTS = [
  {
    id: 'ATT-30418871', account: 'HARTLOG-01', description: 'Liberty Mutual Umbrella Renewal Declarations (7186042) - .pdf',
    originalFileName: 'LM_UMB4471902_RENEWAL_DECS_7186042.pdf', folderPath: 'Policies / Commercial Umbrella / Declarations',
    attachedDate: '2026-10-27', attachedBy: 'Ivans eDocs Mailbox', important: true, securityAccess: 'Public', active: true,
    source: 'ivans-edocs', attachedTo: { type: 'policy', lineCode: 'UMBRC', policyNumber: 'UMB 4471902', effective: '2025-12-01', expiration: '2026-12-01' },
  },
  {
    id: 'ATT-30418872', account: 'HARTLOG-01', description: 'Travelers Workers Comp Audit Notice (7186042) - .pdf',
    originalFileName: 'TRV_UB7K412093_AUDIT_NOTICE.pdf', folderPath: "Policies / Worker's Compensation / Audits",
    attachedDate: '2026-10-27', attachedBy: 'Ivans Download', important: false, securityAccess: 'Public', active: true,
    source: 'ivans-download', attachedTo: { type: 'policy', lineCode: 'WCOM', policyNumber: 'UB-7K412093', effective: '2026-08-07', expiration: '2027-08-07' },
  },
  {
    id: 'ATT-30418873', account: 'LAKESHO-01', description: 'Hartford BOP Endorsement 004 (7186042) - .pdf',
    originalFileName: 'HIG_BOP9921406_END004.pdf', folderPath: 'Policies / Commercial Package / Endorsements',
    attachedDate: '2026-10-27', attachedBy: 'Ivans Download', important: false, securityAccess: 'Public', active: true,
    source: 'ivans-download', attachedTo: { type: 'policy', lineCode: 'CPKG', policyNumber: 'BOP 9921406', effective: '2026-03-01', expiration: '2027-03-01' },
  },
  {
    id: 'ATT-30418874', account: 'BRIGHTW-01', description: 'Cincinnati Property Renewal Quote (7186042) - .pdf',
    originalFileName: 'CIN_PRP3310978_RENEWAL_QUOTE.pdf', folderPath: 'Policies / Property / Renewals',
    attachedDate: '2026-10-27', attachedBy: 'Ivans Download', important: true, securityAccess: 'Public', active: true,
    source: 'ivans-download', attachedTo: { type: 'policy', lineCode: 'PROP', policyNumber: 'PRP 3310978', effective: '2025-12-15', expiration: '2026-12-15' },
  },
  {
    id: 'ATT-30418875', account: 'NORTHSI-01', description: 'Liberty Mutual Auto ID Cards (7186042) - .pdf',
    originalFileName: 'LM_BA80021458_AUTO_ID_CARDS.pdf', folderPath: 'Policies / Business Auto / ID Cards',
    attachedDate: '2026-10-27', attachedBy: 'Ivans Download', important: false, securityAccess: 'Public', active: true,
    source: 'ivans-download', attachedTo: { type: 'policy', lineCode: 'BAUT', policyNumber: 'BA-80021458', effective: '2026-04-01', expiration: '2027-04-01' },
  },
  {
    id: 'ATT-30418876', account: 'PRAIRIE-01', description: 'Nationwide Farm Package Billing Statement (7186042) - .pdf',
    originalFileName: 'NW_FRM7740122_BILLING_STMT.pdf', folderPath: 'Accounting / Carrier Statements',
    attachedDate: '2026-10-27', attachedBy: 'Ivans Download', important: false, securityAccess: 'Accounting', active: true,
    source: 'ivans-download', attachedTo: { type: 'policy', lineCode: 'CPKG', policyNumber: 'FRM 7740122', effective: '2026-02-01', expiration: '2027-02-01' },
  },
  {
    id: 'ATT-30418877', account: 'CARDINA-01', description: 'Travelers Motor Truck Cargo Change Endorsement (7186042) - .pdf',
    originalFileName: 'TRV_MTC2219035_END002.pdf', folderPath: 'Policies / Inland Marine / Endorsements',
    attachedDate: '2026-10-27', attachedBy: 'Ivans Download', important: false, securityAccess: 'Public', active: true,
    source: 'ivans-download', attachedTo: { type: 'policy', lineCode: 'INMR', policyNumber: 'MTC-2219035', effective: '2025-11-20', expiration: '2026-11-20' },
  },
  {
    id: 'ATT-30418878', account: 'SUMMITC-01', description: 'Chubb Package Policy Jacket (7186042) - .pdf',
    originalFileName: 'CHUBB_CPP6612090_POLICY.pdf', folderPath: 'Policies / Commercial Package / Policy Documents',
    attachedDate: '2026-10-27', attachedBy: 'Ivans Download', important: false, securityAccess: 'Public', active: true,
    source: 'ivans-download', attachedTo: { type: 'policy', lineCode: 'CPKG', policyNumber: 'CPP 6612090', effective: '2026-05-01', expiration: '2027-05-01' },
  },
  {
    id: 'ATT-30402215', account: 'HARTLOG-01', description: 'Chubb GL Loss Runs 5yr (7186051) - .pdf',
    originalFileName: 'CHUBB_CPP2848019_LOSSRUNS.pdf', folderPath: 'Policies / General Liability / Loss Runs',
    attachedDate: '2026-10-20', attachedBy: 'Ivans Download', important: true, securityAccess: 'Public', active: true,
    source: 'ivans-download', attachedTo: { type: 'policy', lineCode: 'GLIA', policyNumber: 'CPP 2848019', effective: '2026-06-01', expiration: '2027-06-01' },
  },
  {
    id: 'ATT-30402216', account: 'BRIGHTW-01', description: 'Cincinnati Umbrella Renewal Quote (7186051) - .pdf',
    originalFileName: 'CIN_UMB3310980_RENEWAL_QUOTE.pdf', folderPath: 'Policies / Commercial Umbrella / Renewals',
    attachedDate: '2026-10-20', attachedBy: 'Ivans Download', important: false, securityAccess: 'Public', active: true,
    source: 'ivans-download', attachedTo: { type: 'policy', lineCode: 'CUMB', policyNumber: 'UMB 3310980', effective: '2025-12-15', expiration: '2026-12-15' },
  },
  {
    id: 'ATT-30402217', account: 'SUMMITC-01', description: 'Chubb Workers Comp Experience Mod Worksheet (7186051) - .pdf',
    originalFileName: 'CHUBB_WC6612091_EMOD.pdf', folderPath: "Policies / Worker's Compensation / Experience Mods",
    attachedDate: '2026-10-20', attachedBy: 'Ivans Download', important: false, securityAccess: 'Public', active: true,
    source: 'ivans-download', attachedTo: { type: 'policy', lineCode: 'WCOM', policyNumber: 'WC 6612091', effective: '2026-05-01', expiration: '2027-05-01' },
  },
  {
    id: 'ATT-29877410', account: 'HARTLOG-01', description: 'Signed ACORD 125 Commercial Application - .pdf',
    originalFileName: 'Hartwell_ACORD125_signed.pdf', folderPath: 'Client / Applications',
    attachedDate: '2022-05-04', attachedBy: 'Marisol Reyes', important: false, securityAccess: 'Public', active: false,
    source: 'user', attachedTo: { type: 'account' },
  },
];

const SEARCH_TYPES = ['attachment', 'account', 'policy'];
const STATUS_FILTERS = ['any', 'active', 'inactive'];
const DATE_FILTERS = ['any', '30d', '12m'];
const SORTS = ['best', 'newest', 'account'];

const REMEDIATION_DIRECTIVE = [
  '*Repository to investigate and fix:* `COG-GTM/event-driven-devin`',
  '',
  'The failing code path is the Applied Epic global attachment search:',
  '- Service: `app/services/verticals/19381609.js`',
  '- Route: `app/routes/verticals/19381609.js`',
  '- Page: `app/public/verticals/19381609.html` (served at `/applied`)',
  '- Test: `tests/19381609-attachment-search.test.js`',
  '',
  'Searching attachments for Ivans download batch `7186042` (the default search on the page) returns HTTP 500 for every user.',
  'Find the root cause in the code and fix it there; do not edit or delete the seeded attachment records.',
  'Preserve the search response shape, result ordering and the other search types.',
  'Add a regression test, then run `npx jest tests/19381609-attachment-search.test.js --runInBand` and `npx eslint app/routes/verticals/19381609.js app/services/verticals/19381609.js`.',
  'Verify the default attachment search at `/applied` returns 8 results across 7 accounts.',
  'Open a pull request against `main` with the fix.',
].join('\n');

function validationError(message, code) {
  const error = new Error(message);
  error.name = 'ValidationError';
  error.code = code;
  error.statusCode = 400;
  return error;
}

function formatDate(iso) {
  if (!iso) return '';
  const [year, month, day] = iso.split('-');
  return `${month}/${day}/${year}`;
}

function listAccounts() {
  return ACCOUNTS.map((account) => ({
    ...account,
    branchName: AGENCY.branches[account.branch],
    policyCount: (POLICIES[account.lookupCode] || []).length,
  }));
}

function getAccountPolicies(lookupCode) {
  const account = ACCOUNTS_BY_CODE[String(lookupCode || '').toUpperCase()];
  if (!account) return null;
  const policies = (POLICIES[account.lookupCode] || []).map((policy) => {
    const lineCode = toEpicLineCode(policy.line);
    return {
      ...policy,
      line: lineCode,
      lineDescription: EPIC_LINE_TYPES[lineCode].description,
      agency: AGENCY.code,
      branch: account.branch,
    };
  });
  return {
    account: { ...account, branchName: AGENCY.branches[account.branch] },
    policies,
    activities: ACTIVITIES[account.lookupCode] || [],
  };
}

function describeAttachedTo(attachment) {
  const { attachedTo } = attachment;
  if (attachedTo.type === 'account') {
    return `Account — ${ACCOUNTS_BY_CODE[attachment.account].name}`;
  }
  const line = EPIC_LINE_TYPES[attachedTo.lineCode];
  return `Policy ${attachedTo.lineCode} — ${line.description} · ${attachedTo.policyNumber} · ${formatDate(attachedTo.effective)}–${formatDate(attachedTo.expiration)}`;
}

function toResult(attachment) {
  const account = ACCOUNTS_BY_CODE[attachment.account];
  return {
    id: attachment.id,
    description: attachment.description,
    important: attachment.important,
    client: `${account.name} (${account.lookupCode})`,
    attachedDate: formatDate(attachment.attachedDate),
    attachedBy: attachment.attachedBy,
    folderPath: attachment.folderPath,
    originalFileName: attachment.originalFileName,
    securityAccess: attachment.securityAccess,
    status: attachment.active ? 'Active' : 'Inactive',
    attachedTo: describeAttachedTo(attachment),
  };
}

function normalizeSearch(data) {
  const body = data && typeof data === 'object' ? data : {};
  const query = String(body.query || '').trim();
  const type = String(body.type || 'attachment').trim().toLowerCase();
  const status = String(body.status || 'any').trim().toLowerCase();
  const date = String(body.date || 'any').trim().toLowerCase();
  const sort = String(body.sort || 'best').trim().toLowerCase();

  if (query.length < 3) throw validationError('Enter at least 3 characters to search.', 'SEARCH_QUERY_TOO_SHORT');
  if (!SEARCH_TYPES.includes(type)) throw validationError('Select a valid search type.', 'SEARCH_TYPE_INVALID');
  if (!STATUS_FILTERS.includes(status)) throw validationError('Select a valid status filter.', 'SEARCH_STATUS_INVALID');
  if (!DATE_FILTERS.includes(date)) throw validationError('Select a valid date filter.', 'SEARCH_DATE_INVALID');
  if (!SORTS.includes(sort)) throw validationError('Select a valid sort order.', 'SEARCH_SORT_INVALID');

  return {
    query, type, status, date, sort,
  };
}

function withinDate(isoDate, filter, now) {
  if (filter === 'any') return true;
  const days = filter === '30d' ? 30 : 365;
  return (now - new Date(`${isoDate}T00:00:00Z`).getTime()) <= days * 86400000;
}

function matchingAttachments({ query, status, date }, now) {
  const needle = query.toLowerCase();
  return ATTACHMENTS.filter((attachment) => {
    const account = ACCOUNTS_BY_CODE[attachment.account];
    const haystack = [
      attachment.id, attachment.description, attachment.originalFileName,
      attachment.attachedTo.policyNumber || '', account.name, account.lookupCode,
    ].join(' ').toLowerCase();
    if (!haystack.includes(needle)) return false;
    if (status === 'active' && !attachment.active) return false;
    if (status === 'inactive' && attachment.active) return false;
    return withinDate(attachment.attachedDate, date, now);
  });
}

function groupByAccount(attachments, sort) {
  const groups = new Map();
  attachments.forEach((attachment) => {
    if (!groups.has(attachment.account)) {
      const account = ACCOUNTS_BY_CODE[attachment.account];
      groups.set(attachment.account, {
        lookupCode: account.lookupCode,
        name: account.name,
        type: account.type,
        branch: account.branch,
        attachments: [],
      });
    }
    groups.get(attachment.account).attachments.push(toResult(attachment));
  });
  const accounts = [...groups.values()].map((group) => ({ ...group, count: group.attachments.length }));
  if (sort === 'account') accounts.sort((a, b) => a.name.localeCompare(b.name));
  else accounts.sort((a, b) => b.count - a.count);
  return accounts;
}

const AGENCY_DATE = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Chicago' });

function isPolicyActive(policy, now) {
  return policy.stage === 'A' && policy.expiration >= AGENCY_DATE.format(new Date(now));
}

function matchingPolicies(account, {
  query, status, date,
}, now) {
  const needle = query.toLowerCase();
  return (POLICIES[account.lookupCode] || []).filter((policy) => {
    if (!policy.policyNumber.toLowerCase().includes(needle)) return false;
    if (status === 'active' && !isPolicyActive(policy, now)) return false;
    if (status === 'inactive' && isPolicyActive(policy, now)) return false;
    return withinDate(policy.effective, date, now);
  });
}

function searchAccountsAndPolicies(params, now) {
  const needle = params.query.toLowerCase();
  return ACCOUNTS
    .map((account) => {
      const count = params.type === 'account'
        ? Number(`${account.name} ${account.lookupCode} ${account.primaryContact}`.toLowerCase().includes(needle))
        : matchingPolicies(account, params, now).length;
      return {
        lookupCode: account.lookupCode,
        name: account.name,
        type: account.type,
        branch: account.branch,
        count,
        attachments: [],
      };
    })
    .filter((account) => account.count > 0);
}

function failureAlertPayload(error, context) {
  return {
    issueTitle: `${error.name || 'Error'}: ${error.message}`,
    issueUrl: `https://${process.env.SENTRY_ORG_SLUG || 'sentry-org'}.sentry.io/issues/?project=${process.env.SENTRY_PROJECT_ID || ''}&query=is%3Aunresolved`,
    culprit: CULPRIT,
    errorType: error.name || 'Error',
    errorValue: error.message,
    stackTrace: error.stack,
    devinUserId: context.devinUserId,
    devinEmail: context.devinEmail,
    devinOrgId: context.devinOrgId,
    service: SERVICE,
    verticalLabel: 'Applied Epic Attachment Search',
    promptAppendix: REMEDIATION_DIRECTIVE,
    customer: '19381609',
    slackMemberId: context.devinEmail ? '' : SLACK_MEMBER_ID,
    slackMemberIdFallback: SLACK_MEMBER_ID,
    tags: [
      { key: 'route', value: ROUTE },
      { key: 'service', value: SERVICE },
      { key: 'search_type', value: context.type },
      { key: 'alert_path', value: 'instant' },
    ],
    extra: {
      requestId: context.requestId,
      query: context.query,
      matchedAttachments: context.matchedAttachments,
    },
    level: 'error',
    platform: 'node',
    firstSeen: '',
    lastSeen: new Date().toISOString(),
    count: '',
    shortId: '',
    project: 'event-driven-devin',
    release: process.env.SENTRY_RELEASE || `${SERVICE}@2026.10.2`,
    environment: process.env.DD_ENV || 'prod',
    triggeredRule: '',
  };
}

function reportSearchFailure(error, context) {
  logger.error('Applied Epic attachment search failed', {
    error: error.message,
    errorClass: error.name,
    query: context.query,
    type: context.type,
    requestId: context.requestId,
    service: SERVICE,
    route: ROUTE,
  });
  incrementMetric('attachment_search.failure', { route: ROUTE, errorClass: error.name || 'Error' });
  Sentry.captureException(error, {
    tags: {
      route: ROUTE,
      service: SERVICE,
      search_type: context.type,
      alert_path: 'instant',
    },
    extra: {
      requestId: context.requestId,
      query: context.query,
      matchedAttachments: context.matchedAttachments,
    },
  });
  logger.warn('Applied Epic attachment search failure — triggering Devin session', {
    requestId: context.requestId,
    service: SERVICE,
    route: ROUTE,
  });
  createSessionAndAlert(failureAlertPayload(error, context)).catch((alertError) => {
    logger.error('Failed to create Devin session for Applied Epic attachment search error', {
      error: alertError.message,
      requestId: context.requestId,
    });
  });
}

async function search(data = {}, options = {}) {
  const startTime = Date.now();
  const requestId = options.requestId || `SRCH-${uuidv4().slice(0, 8).toUpperCase()}`;
  const params = normalizeSearch(data);
  const now = options.now ? new Date(options.now).getTime() : Date.now();

  logger.info('Running Applied Epic global search', {
    requestId, type: params.type, query: params.query, service: SERVICE, route: ROUTE,
  });

  let matched = [];
  try {
    await new Promise((resolve) => setTimeout(resolve, 120 + Math.random() * 120));
    let accounts;
    if (params.type === 'attachment') {
      matched = matchingAttachments(params, now);
      accounts = groupByAccount(matched, params.sort);
    } else {
      accounts = searchAccountsAndPolicies(params, now);
    }
    const durationMs = Date.now() - startTime;
    incrementMetric('attachment_search.success', { route: ROUTE, type: params.type });
    recordTiming('attachment_search.latency', durationMs, { route: ROUTE });
    return {
      success: true,
      requestId,
      ...params,
      totalResults: accounts.reduce((sum, account) => sum + account.count, 0),
      accountCount: accounts.length,
      accounts,
      durationMs,
    };
  } catch (error) {
    recordTiming('attachment_search.latency', Date.now() - startTime, { route: ROUTE, error: 'true' });
    reportSearchFailure(error, {
      ...params,
      requestId,
      matchedAttachments: matched.map((attachment) => attachment.id),
      devinUserId: data.devinUserId,
      devinOrgId: data.devinOrgId,
      devinEmail: data.devinEmail,
    });
    error.requestId = requestId;
    error.code = error.code || 'SEARCH_FAILED';
    throw error;
  }
}

module.exports = {
  search,
  listAccounts,
  getAccountPolicies,
  describeAttachedTo,
  toEpicLineCode,
  failureAlertPayload,
  AGENCY,
  ACCOUNTS,
  POLICIES,
  ATTACHMENTS,
  EPIC_LINE_TYPES,
  ACORD_TO_EPIC_LINE,
  REMEDIATION_DIRECTIVE,
  SERVICE,
  ROUTE,
};
