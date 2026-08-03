const { v4: uuidv4 } = require('uuid');
const logger = require('../../telemetry/logger');
const { incrementMetric, recordTiming } = require('../../telemetry/datadog');
const { Sentry } = require('../../telemetry/sentry');
const { createSessionAndAlert } = require('../devin-session');

/**
 * Resource library catalog. Every asset carries the content type that drives its
 * card treatment plus the topic/role taxonomy terms used by the library facets.
 */
const RESOURCES = [
  { id: "RES-1001", type: "Articles", title: "How to build a wellness stipend on Brex", byline: "By Brex, May 2026", img: "https://brand.brex.com/asset/53534faa-c378-4982-9190-2f283d850e02/thumbnail/webimage-Wellness-Preview-Image", topics: ["Expense management"], roles: ["Finance leader"] },
  { id: "RES-1002", type: "Articles", title: "Brex MCP: Connect Brex to any AI tool that supports MCP", byline: "By Brex, May 2026", img: "https://brand.brex.com/transform/9e3b9e0c-2d68-4f25-a8be-262b32873693/MCP-static-blog-image", topics: ["AI"], roles: ["Finance leader"] },
  { id: "RES-1003", type: "Articles", title: "Brex and Fintua: Automated VAT reclaim for global enterprises", byline: "By Brex, April 2026", img: "https://brand.brex.com/transform/b1c11946-065e-4822-bd3c-7cf9dc86048a/Article-image-Fintua-886-67x498-75", topics: ["Global spend", "Enterprise"], roles: ["Finance leader"] },
  { id: "RES-1004", type: "Articles", title: "Brex and VAT IT: Eliminating tax leakage across global spend", byline: "By Brex, April 2026", img: "https://brand.brex.com/transform/cd2b608c-a390-433c-bdbd-65628d411863/Article-image-VATIT-886-67x498-75", topics: ["Global spend"], roles: ["Finance leader"] },
  { id: "RES-1005", type: "Articles", title: "Capital One Completes Acquisition of Brex", byline: "By Brex, April 2026", img: "https://brand.brex.com/transform/9bbc53e4-ee59-462d-9f46-59cdf7d2eced/brex-default-tile-articles", topics: ["Brex news"], roles: ["Finance leader"] },
  { id: "RES-1006", type: "Articles", title: "Brex in Claude: Your expenses, now where you work", byline: "By Brex, March 2026", img: "https://brand.brex.com/transform/0f089ff7-97ff-4625-93b6-c2971ef0b39f/Claude-launch-static-blog", topics: ["AI", "Expense management"], roles: ["Finance leader"] },
  { id: "RES-1007", type: "Articles", title: "Built on 20 years of trust: Brex and Stifel Bank unite for founders", byline: "By Jason Mok, March 2026", img: "https://brand.brex.com/transform/dcf9c898-5a2a-4110-a54b-831e035e029a/Brex-x-Stifel", topics: ["Brex news", "Business banking"], roles: ["Founder"] },
  { id: "RES-1008", type: "Articles", title: "Brex in ChatGPT: Your expenses, one question away", byline: "By Brex, March 2026", img: "https://brand.brex.com/transform/fa50744b-3b03-4d06-82e5-60f68c493b6c/chatgpt-launch-static-01", topics: ["AI", "Expense management"], roles: ["Finance leader"] },
  { id: "RES-1009", type: "Articles", title: "Close your books faster with AI-native accruals automation.", byline: "By Brex, March 2026", img: "https://brand.brex.com/transform/9bbc53e4-ee59-462d-9f46-59cdf7d2eced/brex-default-tile-articles", topics: ["AI", "Accounting"], roles: ["Controller/accountant", "Accountant"] },
  { id: "RES-1010", type: "Articles", title: "Cash flow forecasting without a finance degree", byline: "By Brex, February 2026", img: "https://brand.brex.com/transform/4074e056-5d70-4210-9a8e-de34cb3bb297/Cash-flow-management-automated-invoice-processing-benefits", topics: ["Startups"], roles: ["Founder"] },
  { id: "RES-1011", type: "Articles", title: "Working capital optimization for scaling startups", byline: "By Brex, February 2026", img: "https://brand.brex.com/transform/1a0bc56f-0541-44d3-a308-ba554d0e56e1/underwriting_higher-limits", topics: ["Startups", "Midmarket"], roles: ["Founder"] },
  { id: "RES-1012", type: "Articles", title: "Evaluating burn reduction vs. growth investment", byline: "By Brex, February 2026", img: "https://brand.brex.com/transform/be32d64d-7372-42a7-9300-bb36943e9a20/Underwriting-blog-1", topics: ["Startups"], roles: ["Founder"] },
  { id: "RES-1013", type: "E-books", title: "The future of procurement is automated and integrated", byline: "By Brex, August 2023", img: "https://brand.brex.com/transform/07e96561-a585-477b-b8cb-cf821f769013/WBR-preview", topics: ["Procurement"], roles: ["Procurement manager"] },
  { id: "RES-1014", type: "E-books", title: "The CFO Imperative", byline: "By Brex, April 2025", img: "https://brand.brex.com/transform/f967c808-b4ba-4fe1-bcd2-ad184dd22594/The-CFO-Imperative", topics: ["Spend management insights"], roles: ["Finance leader"] },
  { id: "RES-1015", type: "E-books", title: "AI in accounting: 7 proven plays for a 3x faster close", byline: "By Brex, April 2025", img: "https://brand.brex.com/transform/6a755b61-0afc-4f3c-ae95-b65f11b4e438/accounting-automation-e-book-preview", topics: ["AI", "Accounting"], roles: ["Controller/accountant", "Accountant"] },
  { id: "RES-1016", type: "E-books", title: "CFO's guide to AI strategy", byline: "By Brex, September 2024", img: "https://brand.brex.com/transform/1b49279f-50d2-40cf-8bb5-7a24c9d27dcc/CFO-s-guide-to-AI-strategy", topics: ["AI"], roles: ["Finance leader"] },
  { id: "RES-1017", type: "E-books", title: "The future of B2B payments", byline: "By Brex, September 2024", img: "https://brand.brex.com/transform/1af1fdc6-1708-40e4-843b-7c925c086cfb/b2b-e-book-preview", topics: ["Spend management insights"], roles: ["Finance leader"] },
  { id: "RES-1018", type: "E-books", title: "Building trust in the digital finance era", byline: "By Brex, March 2026", img: "https://brand.brex.com/transform/51da154d-8c9a-4023-9d54-fc1c6a90de20/GRC-white-paper-article-image", topics: ["Improving compliance"], roles: ["Finance leader"] },
  { id: "RES-1019", type: "E-books", title: "How to solve the T&E challenges holding your business back", byline: "By Brex, August 2023", img: "https://brand.brex.com/transform/a3cd2ff4-3d8f-49f1-9fdf-d6bb81fc41a8/T-E-ebook-preview", topics: ["Travel"], roles: ["Travel manager"] },
  { id: "RES-1020", type: "E-books", title: "The step-by-step guide to getting more from company spend", byline: "By Brex, June 2023", img: "https://brand.brex.com/transform/12f5109e-043a-47f1-a430-776adfb0db07/unified-spend-preview", topics: ["Spend management insights"], roles: ["Finance leader"] },
  { id: "RES-1021", type: "E-books", title: "CB Insights report: Brex is No. 1 for expense management", byline: "By Brex, May 2024", img: "https://brand.brex.com/transform/3b2f6ceb-2c70-416c-8add-eab9c87af779/CB-Insights-preview", topics: ["Expense management"], roles: ["CFO/finance leader"] },
  { id: "RES-1022", type: "Case Studies", title: "How Vibe.co turned subscription payments into free billboards", byline: "By Brex, June 2026", img: "https://brand.brex.com/transform/4c356bdf-382a-44f9-af0d-a68dd180f9f4/vibe_preview", topics: ["Spend management insights"], roles: ["Finance leader"] },
  { id: "RES-1023", type: "Case Studies", title: "Boston Celtics shortens month-end close by 7 days with Brex", byline: "By Brex, June 2026", img: "https://brand.brex.com/transform/870306ca-68a4-4114-9dc1-90aa4df5fa28/Boston-Celtics-cover-v2", topics: ["Accounting"], roles: ["Controller/accountant", "Accountant"] },
  { id: "RES-1024", type: "Case Studies", title: "Canva unifies T&E, procurement, and spend in 190 countries with Brex, Zip, and Navan.", byline: "By Brex, June 2026", img: "https://brand.brex.com/asset/e19b1720-bf30-4576-ba51-e62672ed6af4/thumbnail/webimage-Canva_create", topics: ["Travel", "Procurement"], roles: ["Travel manager", "Procurement manager"] },
  { id: "RES-1025", type: "Case Studies", title: "How WindBorne Systems scales a global weather balloon network on Brex", byline: "By Brex, April 2026", img: "https://brand.brex.com/transform/a76e89ad-8b2a-4872-ad5d-7eeeb42725f2/Windborne-article-preview", topics: ["Midmarket"], roles: ["Finance leader"] },
  { id: "RES-1026", type: "Case Studies", title: "How ONEflight International saves 4 hours a day on wire payments using Brex", byline: "By Brex, March 2026", img: "https://brand.brex.com/transform/ae56f504-feed-428b-a08b-2a50823b892d/Oneflight_preview", topics: ["Spend management insights"], roles: ["Finance leader"] },
  { id: "RES-1027", type: "Case Studies", title: "Attivo Partners automates 80% of expense categorization", byline: "By Brex, March 2026", img: "https://brand.brex.com/transform/aacd05c7-e15d-4203-a1ed-52d0ad3b7c89/attivo_preview", topics: ["Expense management"], roles: ["Finance leader"] },
  { id: "RES-1028", type: "Case Studies", title: "How Brex helped Landry/French Construction cut month-end close from 20 hours to 3", byline: "By Brex, March 2026", img: "https://brand.brex.com/transform/3655f92b-dabf-410b-9e0d-b7d72d646b92/Landry_preview", topics: ["Accounting"], roles: ["Controller/accountant", "Accountant"] },
  { id: "RES-1029", type: "Case Studies", title: "Backburner Labs switched from Mercury to Brex and cut reconciliation time by 90%", byline: "By Brex, February 2026", img: "https://brand.brex.com/transform/e5df7d7d-38e7-43a2-bb4f-3b372853873e/Backburner_preview", topics: ["Startups"], roles: ["Founder"] },
  { id: "RES-1030", type: "Case Studies", title: "Finfuego spends 60% less time doing expenses on Brex and Puzzle", byline: "By Brex, January 2026", img: "https://brand.brex.com/transform/98471857-8d75-4a6c-8f3e-dd370cb590cb/Finfuego-article-preview", topics: ["Expense management"], roles: ["Finance leader"] },
  { id: "RES-1031", type: "Case Studies", title: "How Numeral cut month-end close time by 80% switching from Ramp to Brex", byline: "By Brex, January 2026", img: "https://brand.brex.com/transform/93030f96-c3a8-4b4f-84b0-55ff1a19e6ac/Numeral-article-preview", topics: ["Accounting"], roles: ["Controller/accountant", "Accountant"] },
  { id: "RES-1032", type: "Case Studies", title: "Prestige Healthcare gets 2x the credit and payment terms built for healthcare with Brex", byline: "By Brex, December 2025", img: "https://brand.brex.com/transform/681284ec-4762-4049-b2fe-f1359b4a6a52/Prestige-article-preview", topics: ["Spend management insights"], roles: ["Finance leader"] },
  { id: "RES-1033", type: "Case Studies", title: "Fullsteam seamlessly manages travel, payments, and expenses for multiple entities on Brex.", byline: "By Brex, December 2025", img: "https://brand.brex.com/transform/46d5079b-bd29-489b-93c4-e20795dad64a/Fullsteam-article-preview", topics: ["Travel", "Expense management"], roles: ["Travel manager"] },
  { id: "RES-1034", type: "Brex Benchmark", title: "Brex Benchmark: The 25 books founders buy most", byline: "By Sumeet Marwaha, July 2026", img: "https://brand.brex.com/transform/6b4fcff0-f8ad-448b-8e3d-addb63cc7283/brexbenchmark-article-image-branded-1200x630-2x", topics: ["Accounting", "Spend management insights"], roles: ["Controller/accountant", "Accountant"] },
  { id: "RES-1035", type: "Brex Benchmark", title: "Brex Benchmark: Spring 2026\u2019s top 25 fastest-growing software vendors", byline: "By Sumeet Marwaha, May 2026", img: "https://brand.brex.com/transform/012e186f-e265-4998-8a9d-7819cfe06f20/Spring-2026-s-top-25-fastest-growing-software-vendors", topics: ["Spend management insights"], roles: ["CFO/finance leader"] },
  { id: "RES-1036", type: "Brex Benchmark", title: "March Madness: From the court to the corporate card", byline: "By Brex, March 2026", img: "https://brand.brex.com/transform/59b9cf05-01ee-4678-b6d2-029817996219/brexbenchmark-article-image-branded-1200x630-2x-4", topics: ["Corporate credit card"], roles: ["Finance leader"] },
  { id: "RES-1037", type: "Brex Benchmark", title: "The Super Bowl economy: what expense reports reveal about America's biggest game", byline: "By Brex, February 2026", img: "https://brand.brex.com/transform/d77fb665-9624-4d0f-a559-dde0779a0353/brexbenchmark-article-image-February-1200x630-2x", topics: ["Expense management"], roles: ["CFO/finance leader"] },
  { id: "RES-1038", type: "Brex Benchmark", title: "The 50 fastest-growing software vendors of 2025.", byline: "By Sumeet Marwaha, December 2025", img: "https://brand.brex.com/transform/2acbf06f-4e99-410b-a486-a47196a3142d/brexbenchmark-article-image-November-1200x630-2x", topics: ["Spend management insights"], roles: ["Finance leader"] },
  { id: "RES-1039", type: "Brex Benchmark", title: "The AI infrastructure shift: Why OpenAI spend is up 80% on Brex", byline: "By Sumeet Marwaha, November 2025", img: "https://brand.brex.com/transform/69c069a1-6ac6-408f-aa48-0199b827e278/Benchmark-October-2025", topics: ["AI"], roles: ["Finance leader"] },
  { id: "RES-1040", type: "Spend Trends", title: "Are Miles Or Cash Back Better For Business Credit Card Rewards?", byline: "By Yolanda La, June 2026", img: "https://brand.brex.com/transform/f7489c62-475f-4e94-86b6-485ba099000f/corporate-credit-card-best-business-credit-card", topics: ["Corporate credit card"], roles: ["Finance leader"] },
  { id: "RES-1041", type: "Spend Trends", title: "Best 5 no foreign transaction fee business credit cards of 2026", byline: "By Yolanda La, June 2026", img: "https://brand.brex.com/m/2ecf9ecdadadb39b/webimage-Corporate-credit-cards-best-business-rewards-credit-cards.jpg", topics: ["Corporate credit card"], roles: ["Finance leader"] },
  { id: "RES-1042", type: "Spend Trends", title: "6 Key Differences Between Business Charge Cards vs Credit Cards", byline: "By Yolanda La, April 2026", img: "https://brand.brex.com/transform/e9d911da-d5f4-4495-ab3e-2d15ea6126b0/Corporate-credit-cards-General-06", topics: ["Corporate credit card"], roles: ["Finance leader"] },
  { id: "RES-1043", type: "Spend Trends", title: "6 Types of Smart Cards With Examples and Business Uses", byline: "By Yolanda La, April 2026", img: "https://brand.brex.com/transform/e9d911da-d5f4-4495-ab3e-2d15ea6126b0/Corporate-credit-cards-General-06", topics: ["Corporate credit card"], roles: ["Finance leader"] },
  { id: "RES-1044", type: "Spend Trends", title: "3 quick ways to find your employer identification number (EIN)", byline: "By Yolanda La, April 2026", img: "https://brand.brex.com/transform/bd297784-1ee4-4985-b181-b3cb679bfbe5/How-to-do-a-startup-valuation-using-8-different-methods", topics: ["Spend management insights"], roles: ["Finance leader"] },
  { id: "RES-1045", type: "Spend Trends", title: "How Does Cash Back Work on a Credit Card?", byline: "By Yolanda La, April 2026", img: "https://brand.brex.com/transform/e9d911da-d5f4-4495-ab3e-2d15ea6126b0/Corporate-credit-cards-General-06", topics: ["Corporate credit card"], roles: ["Finance leader"] },
];

/**
 * Content types surfaced as the library's sub-navigation tabs.
 */
const CONTENT_TYPES = ['Articles', 'E-books', 'Case Studies', 'Brex Benchmark', 'Spend Trends'];

/**
 * Registered facet definitions. Each facet code declares which catalog field it
 * narrows and how a selected term is matched against that field.
 */
const FACET_REGISTRY = [
  { code: 'FACET-CONTENT-TYPE', label: 'Content type', field: 'type', match: 'equals' },
  { code: 'FACET-TOPIC', label: 'Topic', field: 'topics', match: 'contains' },
  { code: 'FACET-ROLE', label: 'Role', field: 'roles', match: 'contains' },
];

/**
 * Taxonomy facet per selectable filter group, used to resolve the base facet
 * plan before any mandatory entitlement facets are layered on.
 */
const TAXONOMY_FACETS = {
  topic: { code: 'FACET-TOPIC', group: 'By Topic' },
  role: { code: 'FACET-ROLE', group: 'By Role' },
};

/**
 * Entitlement facets that are force-attached whenever a visitor narrows the
 * library by taxonomy. Gated assets (e-books, benchmark reports) must be
 * excluded from anonymous taxonomy results, but this entitlement facet has not
 * been registered in the FACET_REGISTRY catalog yet.
 */
const MANDATORY_TAXONOMY_FACETS = [
  { code: 'FACET-GATED-ASSET-ENTITLEMENT-2026', reason: 'Gated-asset entitlement check for anonymous taxonomy browsing' },
];

/**
 * Returns the ordering treatment applied to a resolved content type.
 */
function getSortTreatment(contentType) {
  if (contentType === 'Case Studies') return { sort: 'customer-featured', label: 'Featured customers first' };
  if (contentType === 'Brex Benchmark' || contentType === 'Spend Trends') return { sort: 'recency', label: 'Most recent first' };
  return { sort: 'editorial', label: 'Editorial order' };
}

/**
 * Layers the mandatory entitlement facets onto the requested facet lines for
 * any taxonomy-narrowed query.
 */
function applyEntitlementFacets(facetLines, topics, roles) {
  const isTaxonomyNarrowed = topics.length > 0 || roles.length > 0;
  if (!isTaxonomyNarrowed) return facetLines;
  const entitlements = MANDATORY_TAXONOMY_FACETS.map((facet) => ({ code: facet.code, term: null, source: 'entitlement' }));
  return [...facetLines, ...entitlements];
}

/**
 * Resolves the requested library selection into its base facet plan, before
 * mandatory entitlement facets are applied.
 */
function resolveFacetPlan(contentType, topics, roles) {
  if (contentType && !CONTENT_TYPES.includes(contentType)) {
    throw Object.assign(new Error(`Unknown content type: ${contentType}`), { code: 'INVALID_CONTENT_TYPE' });
  }
  const facetLines = [];
  if (contentType) {
    facetLines.push({ code: 'FACET-CONTENT-TYPE', term: contentType, source: 'tab' });
  }
  topics.forEach((topic) => {
    facetLines.push({ code: TAXONOMY_FACETS.topic.code, term: topic, source: 'sidebar' });
  });
  roles.forEach((role) => {
    facetLines.push({ code: TAXONOMY_FACETS.role.code, term: role, source: 'sidebar' });
  });
  const treatment = getSortTreatment(contentType);
  return { facetLines, sort: treatment.sort, sortLabel: treatment.label };
}

/**
 * Evaluates one resolved facet line against a catalog entry.
 */
function facetMatches(facetDef, term, resource) {
  const value = resource[facetDef.field];
  if (facetDef.match === 'contains') return Array.isArray(value) && value.includes(term);
  return value === term;
}

/**
 * Builds the applied-facet summary for a library query — one entry per facet
 * line, resolving each facet code to its registered definition and match rule.
 * BUG: FACET-GATED-ASSET-ENTITLEMENT-2026 is not in FACET_REGISTRY, so reading
 * facetDef.field on the undefined lookup result throws a TypeError.
 */
function buildFacetSummary(facetLines) {
  return facetLines.map((line) => {
    const facetDef = FACET_REGISTRY.find((f) => f.code === line.code);
    const matched = RESOURCES.filter((resource) => facetMatches(facetDef, line.term, resource));
    return {
      code: line.code,
      label: facetDef.label,
      field: facetDef.field,
      match: facetDef.match,
      term: line.term,
      source: line.source,
      matchCount: matched.length,
    };
  });
}

/**
 * Filters the resource library for a visitor's tab + taxonomy selection and
 * returns the narrowed card list along with the applied-facet summary.
 */
async function filterResources(query) {
  const startTime = Date.now();
  const requestId = uuidv4();
  const contentType = query.contentType || '';
  const topics = Array.isArray(query.topics) ? query.topics : [];
  const roles = Array.isArray(query.roles) ? query.roles : [];

  logger.info('Filtering resource library', {
    requestId,
    contentType: contentType || 'all',
    topics,
    roles,
    catalogSize: RESOURCES.length,
    service: 'resource-library',
    route: '/api/b136ae6e/filter',
  });

  try {
    await new Promise((resolve) => setTimeout(resolve, 70 + Math.random() * 120));

    const plan = resolveFacetPlan(contentType, topics, roles);
    const facetLines = applyEntitlementFacets(plan.facetLines, topics, roles);
    const facetSummary = buildFacetSummary(facetLines);

    const results = RESOURCES.filter((resource) => facetSummary.every((facet) => {
      const facetDef = FACET_REGISTRY.find((f) => f.code === facet.code);
      return facetMatches(facetDef, facet.term, resource);
    }));

    const duration = Date.now() - startTime;

    incrementMetric('resources.filter.success', {
      route: '/api/b136ae6e/filter',
      source: 'resource-library',
    });
    recordTiming('resources.filter.latency', duration, {
      route: '/api/b136ae6e/filter',
    });

    return {
      success: true,
      requestId,
      contentType: contentType || 'All',
      topics,
      roles,
      sort: plan.sort,
      sortLabel: plan.sortLabel,
      count: results.length,
      appliedFacets: facetSummary,
      results,
      processedAt: new Date().toISOString(),
    };
  } catch (error) {
    const duration = Date.now() - startTime;

    incrementMetric('resources.filter.failure', {
      route: '/api/b136ae6e/filter',
      errorClass: error.name,
      source: 'resource-library',
    });
    recordTiming('resources.filter.latency', duration, {
      route: '/api/b136ae6e/filter',
      error: 'true',
    });

    logger.error('Resource library filter failed', {
      requestId,
      error: error.message,
      errorClass: error.name,
      durationMs: duration,
      contentType: contentType || 'all',
      topics,
      roles,
      service: 'resource-library',
    });

    Sentry.captureException(error, {
      tags: {
        route: '/api/b136ae6e/filter',
        service: 'resource-library',
        source: 'resource-library',
      },
      extra: { requestId, contentType, topics, roles },
    });

    createSessionAndAlert({
      issueTitle: `${error.name}: ${error.message}`,
      issueUrl: `https://${process.env.SENTRY_ORG_SLUG || 'sentry-org'}.sentry.io/issues/?project=${process.env.SENTRY_PROJECT_ID || ''}&query=is%3Aunresolved`,
      culprit: 'app/services/verticals/b136ae6e.js \u2014 buildFacetSummary',
      errorType: error.name || 'Error',
      errorValue: error.message,
      customer: 'b136ae6e',
      devinUserId: query.devinUserId,
      devinEmail: query.devinEmail,
      devinOrgId: query.devinOrgId,
      slackMemberId: 'U08S7AVJ478',
      service: 'resource-library',
      verticalLabel: 'Resource Library \u2014 Content Filter',
      tags: [
        { key: 'route', value: '/api/b136ae6e/filter' },
        { key: 'service', value: 'resource-library' },
        { key: 'category', value: 'content-discovery' },
        { key: 'data_class', value: 'marketing' },
      ],
      extra: { requestId, contentType, topics, roles },
      level: 'error',
      platform: 'node',
      firstSeen: '',
      lastSeen: new Date().toISOString(),
      count: '',
      shortId: '',
      project: 'event-driven-devin',
      release: process.env.SENTRY_RELEASE || 'resource-library@1.0.0',
      environment: process.env.DD_ENV || 'prod',
      triggeredRule: '',
    }).catch((err) => {
      logger.error('Failed to trigger Devin session from resource library filter error', { error: err.message });
    });

    throw error;
  }
}

module.exports = {
  filterResources,
  buildFacetSummary,
  applyEntitlementFacets,
  resolveFacetPlan,
  RESOURCES,
  CONTENT_TYPES,
  FACET_REGISTRY,
  TAXONOMY_FACETS,
};
