/**
 * Reference data for the PIF Ecosystem Outlook proof of concept (/pif).
 *
 * PUBLIC: ecosystem names, portfolio companies, headline figures and trend
 * items — each carries its source and date.
 * ILLUSTRATIVE: allocation, approved bands and signals on ECOSYSTEMS — invented
 * for the PoC and labelled as such in the UI. Never present them as PIF data.
 */

const ECOSYSTEMS = [
  {
    id: 'tte', n: '01', name: 'Tourism, Travel & Entertainment', nameAr: 'السياحة والسفر والترفيه',
    tagline: 'Hosting the World in Saudi',
    companies: ['Red Sea Global', 'Riyadh Air', 'Qiddiya', 'King Salman International Airport'],
    allocation: 21.0, band: [18, 24], status: 'ok', signalType: 'Opportunity',
    signal: 'AI demand forecasting across airline and hospitality capacity ahead of Expo 2030.',
  },
  {
    id: 'urban', n: '02', name: 'Urban Development & Livability', nameAr: 'التطوير العمراني وجودة الحياة',
    tagline: 'Creating people-centric modern cities',
    companies: ['ROSHN', 'KAFD', 'New Murabba', 'Jeddah Central Development Company'],
    allocation: 23.4, band: [20, 26], status: 'ok', signalType: 'Signal',
    signal: 'Private co-investment pipeline rising, consistent with the shift to private-sector leadership.',
  },
  {
    id: 'ami', n: '03', name: 'Advanced Manufacturing & Innovation', nameAr: 'التصنيع المتقدم والابتكار',
    tagline: 'Building the new industrial frontier',
    companies: ['HUMAIN', 'Alat', 'Ceer', 'Lifera', 'Saudi Arabian Military Industries'],
    allocation: 18.1, band: [12, 16], status: 'above', signalType: 'Deviation',
    signal: 'AI compute commitments take the ecosystem 2.1 pp above its band.',
  },
  {
    id: 'ind', n: '04', name: 'Industrials & Logistics', nameAr: 'الصناعة والخدمات اللوجستية',
    tagline: 'Strengthening global trade flows',
    companies: ["Ma'aden", 'Bahri', 'Hadeed', 'Saudi Arabia Railways'],
    allocation: 17.6, band: [14, 18], status: 'watch-high', signalType: 'Risk',
    signal: 'Freight-rate volatility; monitor fleet utilisation against plan.',
  },
  {
    id: 'energy', n: '05', name: 'Clean Energy, Water & Renewable Infrastructure', nameAr: 'الطاقة النظيفة والمياه والبنية التحتية المتجددة',
    tagline: 'Powering the planet responsibly',
    companies: ['ACWA Power', 'Badeel', 'Saudi Investment Recycling Company'],
    allocation: 11.2, band: [10, 14], status: 'ok', signalType: 'Opportunity',
    signal: 'Data-centre power demand supports long-term renewable offtake.',
  },
  {
    id: 'neom', n: '06', name: 'NEOM', nameAr: 'نيوم',
    tagline: 'Ports, Oxagon and green hydrogen',
    companies: ['NEOM', 'Oxagon', 'NEOM Green Hydrogen Company'],
    allocation: 8.7, band: [8, 12], status: 'watch-low', signalType: 'Signal',
    signal: 'Phasing updates in public reporting; keep leadership messaging consistent.',
  },
];

const THEMES = [
  { id: 'ai', name: 'AI & digital' },
  { id: 'capital', name: 'Financing & capital' },
  { id: 'private', name: 'Private sector & localisation' },
  { id: 'performance', name: 'Performance & returns' },
  { id: 'sustainability', name: 'Sustainability' },
  { id: 'talent', name: 'Talent & education' },
];

const S = {
  ar2025: { label: 'PIF Annual Report 2025', date: '2026-08-17', url: 'https://www.pif.gov.sa/en/news-and-insights/press-releases/2026/pif-delivers-strong-revenue-and-profit-growth-in-2025/' },
  results: { label: '2025 results release', date: '2026-08-17', url: 'https://www.pif.gov.sa/en/news-and-insights/press-releases/2026/pif-delivers-strong-revenue-and-profit-growth-in-2025/' },
  strategy: { label: '2026–2030 strategy release', date: '2026-04-15', url: 'https://www.pif.gov.sa/en/news-and-insights/press-releases/2026/chaired-by-hrh-crown-prince-pif-board-of-directors-approves-pif-2026-2030-strategy/' },
};

/** Figures PIF has published, newest first within each metric. */
const PUBLIC_FIGURES = [
  { metric: 'aum', label: 'Gross assets under management (2025)', value: '$904.54 bn (SAR 3.396 tn)', number: 904.54, unit: 'bn', source: S.ar2025, suggest: 'more than $900 billion in assets under management' },
  { metric: 'tsr', label: 'Annualised total shareholder return since 2017', value: '5.8%', number: 5.8, unit: '%', source: S.results, superseded: { value: 'over 7%', source: S.strategy }, suggest: 'an annualised total shareholder return of 5.8% since 2017' },
  { metric: 'ecosystems', label: 'Ecosystems in the Vision Portfolio', value: 'six', number: 6, unit: 'count', source: S.strategy, suggest: 'our six ecosystems' },
  { metric: 'newProjects', label: 'Investment in new projects in Saudi Arabia, 2021–2025', value: 'more than $199 bn', number: 199, unit: 'bn', source: S.results, suggest: 'more than $199 billion in new projects since 2021' },
  { metric: 'revenue', label: 'Revenue (2025)', value: '$120 bn, up 9%', number: 120, unit: 'bn', source: S.results, suggest: 'revenue of $120 billion in 2025' },
  { metric: 'netProfit', label: 'Net profit (2025)', value: '$17 bn, more than doubled', number: 17, unit: 'bn', source: S.results, suggest: 'net profit of $17 billion in 2025' },
  { metric: 'localShare', label: 'Local investments, share of AUM', value: '76%', number: 76, unit: '%', source: S.ar2025, suggest: '76% of our assets invested locally' },
  { metric: 'nonOilGdp', label: 'Cumulative contribution to non-oil GDP, 2021–2025', value: 'more than $342 bn', number: 342, unit: 'bn', source: S.results, superseded: { value: 'more than $243 bn (2021–2024)', source: S.strategy }, suggest: 'more than $342 billion to non-oil GDP from 2021 to 2025' },
  { metric: 'nonOilShare', label: 'Share of Saudi non-oil GDP (2025)', value: '11%', number: 11, unit: '%', source: S.results, suggest: '11% of Saudi Arabia’s non-oil GDP in 2025' },
  { metric: 'ratings', label: 'Credit ratings', value: "Moody's Aa3 (stable), Fitch A+ (stable), S&P A-1 short-term", source: S.results },
  { metric: 'aiSolutions', label: 'AI-enabled solutions activated in 2025', value: '43 (plus 100 new digital applications)', number: 43, unit: 'count', source: S.results },
];

const TRENDS = [
  {
    id: 'humain-infra-financing', date: '2026-11-09', source: 'Saudi Press Agency', url: 'https://www.spa.gov.sa/en/N2721893',
    title: 'HUMAIN and Infra sign up to SAR 2.5 bn ($667 m) in financing for AI infrastructure',
    titleAr: 'هيوماين وإنفرا توقّعان اتفاقيات تمويل تصل إلى 2.5 مليار ريال للبنية التحتية للذكاء الاصطناعي',
    ecosystems: ['ami', 'energy'], companies: ['HUMAIN'], direct: true,
    implication: 'Debt financing for data-centre build-out reduces the equity PIF must commit — directly relevant to bringing Advanced Manufacturing & Innovation back within band.',
    implicationAr: 'يقلّل التمويل بالدين لتوسعة مراكز البيانات من حجم رأس المال الذي يلتزم به الصندوق، وهو ما يدعم إعادة منظومة التصنيع المتقدم والابتكار إلى نطاقها المعتمد.',
  },
  {
    id: 'aramco-humain', date: '2026-11-01', source: 'PIF press release', url: 'https://www.pif.gov.sa/en/news-and-insights/press-releases/2026/pif-and-aramco-close-humain-transaction-to-accelerate-humain-global-growth/',
    title: 'PIF and Aramco close the HUMAIN transaction: PIF 51%, Aramco 49%',
    titleAr: 'الصندوق وأرامكو يُتمّان صفقة هيوماين: 51٪ للصندوق و49٪ لأرامكو',
    ecosystems: ['ami'], companies: ['HUMAIN'], direct: true,
    implication: 'A co-shareholder now funds part of HUMAIN’s expansion; update exposure models and the ecosystem’s allocation path.',
    implicationAr: 'أصبح لهيوماين شريك مساهم يموّل جزءاً من توسعها، ما يستدعي تحديث نماذج الانكشاف ومسار التخصيص للمنظومة.',
  },
  {
    id: 'humain-nvidia-84mw', date: '2026-10-22', source: 'The National', url: 'https://www.thenationalnews.com/future/technology/2026/10/22/saudi-arabias-humain-expands-nvidia-deal-with-84mw-ai-computing-plan/',
    title: 'HUMAIN expands Nvidia partnership to 84 MW (~27,000 GPUs), incl. 50 MW for a US customer',
    titleAr: 'هيوماين توسّع شراكتها مع إنفيديا إلى 84 ميغاواط (نحو 27 ألف معالج رسومي)',
    ecosystems: ['ami', 'energy'], companies: ['HUMAIN'], direct: true,
    implication: 'Export-contracted capacity signals external demand for Saudi compute; chip export approvals remain the key dependency.',
    implicationAr: 'تعاقد سعة حوسبية لعميل أمريكي يؤكد وجود طلب خارجي على الحوسبة السعودية، مع بقاء موافقات تصدير الرقائق عاملاً حاسماً.',
  },
  {
    id: 'nebius-oxagon', date: '2026-10-21', source: 'NEOM newsroom', url: 'https://www.neom.com/en-us/newsroom/International-Agreement-Strengthens-Data-Center-Capabilities',
    title: 'Nebius to offtake capacity from first 100 MW of HUMAIN–DataVolt AI campus in Oxagon',
    titleAr: 'نيبيوس تستأجر سعة من أول 100 ميغاواط في مجمّع هيوماين وداتافولت للذكاء الاصطناعي في أوكساجون',
    ecosystems: ['neom', 'ami', 'energy'], companies: ['NEOM', 'Oxagon', 'HUMAIN'], direct: true,
    implication: 'First anchor customer for Oxagon’s AI campus links NEOM phasing to AI demand — a positive signal for the NEOM watch item.',
    implicationAr: 'أول عميل رئيسي لمجمّع أوكساجون يربط مراحل نيوم بالطلب على الذكاء الاصطناعي، وهي إشارة إيجابية لبند المتابعة الخاص بنيوم.',
  },
  {
    id: 'acwa-ai-power', date: '2026-10-16', source: 'Asharq Al-Awsat', url: 'https://english.aawsat.com/business/5330187-acwa-asharq-al-awsat-energy-storage-key-saudi-renewable-expansion',
    title: 'ACWA: AI and data-centre growth is reshaping power demand; storage is key',
    titleAr: 'أكوا: نمو الذكاء الاصطناعي ومراكز البيانات يعيد تشكيل الطلب على الكهرباء والتخزين عنصر أساسي',
    ecosystems: ['energy', 'ami'], companies: ['ACWA Power'], direct: true,
    implication: 'Pair compute commitments with renewable + storage offtake inside the portfolio to capture value across both ecosystems.',
    implicationAr: 'ربط التزامات الحوسبة بعقود شراء الطاقة المتجددة والتخزين داخل المحفظة لتحقيق القيمة عبر المنظومتين.',
  },
  {
    id: 'veolia-maaden-acwa', date: '2026-09-18', source: 'Arab News', url: 'https://www.arabnews.com/saudi-arabia/veolia-signs-3-agreements-on-water-waste-and-decarbonization-in-saudi-arabia-3002272',
    title: "Veolia signs agreements with Ma'aden and ACWA on digital water, waste and decarbonisation",
    titleAr: 'فيوليا توقّع اتفاقيات مع معادن وأكوا في المياه والنفايات وإزالة الكربون رقمياً',
    ecosystems: ['ind', 'energy'], companies: ["Ma'aden", 'ACWA Power'], direct: true,
    implication: 'Digital operations partnerships are an early route to AI-driven efficiency in heavy industry.',
    implicationAr: 'شراكات التشغيل الرقمي مدخل مبكر لرفع الكفاءة بالذكاء الاصطناعي في الصناعات الثقيلة.',
  },
  {
    id: 'rsg-ntt', date: '2026-09-09', source: 'Consultancy-me', url: 'https://www.consultancy-me.com/news/14360/red-sea-global-partners-with-ntt-data-for-smart-digital-solutions-in-its-destinations',
    title: 'Red Sea Global partners with NTT Data on AI, digital twins and smart-destination platforms',
    titleAr: 'البحر الأحمر الدولية تتعاون مع NTT Data في الذكاء الاصطناعي والتوائم الرقمية',
    ecosystems: ['tte'], companies: ['Red Sea Global'], direct: true,
    implication: 'Guest-experience AI could be shared across PIF tourism assets rather than built per destination.',
    implicationAr: 'يمكن مشاركة حلول الذكاء الاصطناعي لتجربة الضيوف عبر أصول الصندوق السياحية بدلاً من بنائها لكل وجهة.',
  },
  {
    id: 'pif-internal-ai', date: '2026-08-17', source: 'PIF press release', url: S.results.url,
    title: 'PIF activated 43 AI-enabled solutions and 100 new digital applications in 2025',
    titleAr: 'الصندوق فعّل 43 حلاً قائماً على الذكاء الاصطناعي و100 تطبيق رقمي جديد في 2025',
    ecosystems: ['tte', 'urban', 'ami', 'ind', 'energy', 'neom'], companies: [], direct: false,
    implication: 'Sets an internal benchmark; portfolio companies can be measured against the same adoption bar.',
    implicationAr: 'يضع معياراً داخلياً يمكن قياس تبنّي الشركات التابعة للذكاء الاصطناعي على أساسه.',
  },
  {
    id: 'qiddiya-google', date: '2026-05-20', source: 'Gulfdays', url: 'https://gulfdays.net/qiddiya-google-cloud-partner-to-build-ai-powered-smart-entertainment-city/',
    title: 'Qiddiya and Google Cloud build agentic “Q-Brain” for an AI-powered entertainment city',
    titleAr: 'القدية وغوغل كلاود تطوّران منصة "Q-Brain" الوكيلة لمدينة ترفيه مدعومة بالذكاء الاصطناعي',
    ecosystems: ['tte', 'urban'], companies: ['Qiddiya'], direct: true,
    implication: 'Agentic operations platforms are moving from pilots to city-scale; a model for ROSHN and New Murabba.',
    implicationAr: 'منصات التشغيل الوكيلة تنتقل من التجارب إلى نطاق المدن، ونموذج يمكن أن تستفيد منه روشن والمربع الجديد.',
  },
  {
    id: 'riyadh-air-ai-native', date: '2026-05-07', source: 'IBM case study', url: 'https://www.ibm.com/case-studies/riyadh-air',
    title: 'Riyadh Air positions itself as an AI-native airline from launch',
    titleAr: 'طيران الرياض تقدّم نفسها كأول ناقل جوي قائم على الذكاء الاصطناعي منذ الانطلاق',
    ecosystems: ['tte'], companies: ['Riyadh Air'], direct: true,
    implication: 'Digital-first operations make Riyadh Air a candidate reference case for AI adoption across the portfolio.',
    implicationAr: 'التشغيل الرقمي أولاً يجعل طيران الرياض حالة مرجعية لتبنّي الذكاء الاصطناعي عبر المحفظة.',
  },
  {
    id: 'nbim-ai-productivity', date: '2026-03-01', source: 'SuperAI 2026 (NBIM talk)', url: 'https://www.youtube.com/watch?v=JDzJR72mevk',
    title: 'Norway’s sovereign fund targets 20% productivity gain from AI across investment teams',
    titleAr: 'الصندوق السيادي النرويجي يستهدف رفع الإنتاجية 20٪ عبر الذكاء الاصطناعي',
    ecosystems: ['tte', 'urban', 'ami', 'ind', 'energy', 'neom'], companies: [], direct: false,
    implication: 'Peer benchmark: sovereign investors are setting explicit AI productivity targets for their own teams.',
    implicationAr: 'معيار مقارنة: المستثمرون السياديون يضعون أهدافاً صريحة لإنتاجية الذكاء الاصطناعي لفرقهم.',
  },
];

module.exports = { ECOSYSTEMS, THEMES, PUBLIC_FIGURES, TRENDS, SOURCES: S };
