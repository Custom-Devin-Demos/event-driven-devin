/**
 * Guided scan protocols and the echocardiographic views they walk
 * the user through. A protocol is an ordered list of views; a view may be
 * acquired in B-mode (default) or with a Doppler mode layered on top.
 */
const VIEWS = {
  PLAX: { code: 'PLAX', label: 'Parasternal long axis', window: 'parasternal' },
  'PSAX-AV': { code: 'PSAX-AV', label: 'Parasternal short axis · aortic valve', window: 'parasternal' },
  'PSAX-PM': { code: 'PSAX-PM', label: 'Parasternal short axis · papillary muscle', window: 'parasternal' },
  AP4: { code: 'AP4', label: 'Apical 4-chamber', window: 'apical' },
  AP5: { code: 'AP5', label: 'Apical 5-chamber', window: 'apical' },
  AP2: { code: 'AP2', label: 'Apical 2-chamber', window: 'apical' },
  AP3: { code: 'AP3', label: 'Apical 3-chamber', window: 'apical' },
  'SubC-4': { code: 'SubC-4', label: 'Subcostal 4-chamber', window: 'subcostal' },
  'SubC-IVC': { code: 'SubC-IVC', label: 'Subcostal IVC', window: 'subcostal' },
  SSN: { code: 'SSN', label: 'Suprasternal notch', window: 'suprasternal' },
};

const PROTOCOLS = {
  'cardiac-10': {
    id: 'cardiac-10',
    name: 'Guided scan · 10-view cardiac',
    shortName: '10-view cardiac',
    version: '4.2',
    views: [
      { code: 'PLAX', ef: true },
      { code: 'PSAX-AV' },
      { code: 'PSAX-PM' },
      { code: 'AP4', ef: true },
      { code: 'AP5' },
      { code: 'AP2', ef: true },
      { code: 'AP3' },
      { code: 'SubC-4' },
      { code: 'SubC-IVC' },
      { code: 'SSN' },
    ],
  },
  'cardiac-quick': {
    id: 'cardiac-quick',
    name: 'Guided scan · Quick 4-view',
    shortName: 'Quick 4-view',
    version: '4.2',
    views: [
      { code: 'PLAX', ef: true },
      { code: 'PSAX-PM' },
      { code: 'AP4', ef: true },
      { code: 'SubC-IVC' },
    ],
  },
  'rhd-screening': {
    id: 'rhd-screening',
    name: 'RHD screening · PLAX / PSAX / AP4 / AP5 colour Doppler',
    shortName: 'RHD screening',
    version: '1.0',
    rolloutNote: 'Enabled for the Global RHD Screening Program fleet on firmware 2.4.1',
    views: [
      { code: 'PLAX', ef: true },
      { code: 'PSAX-PM' },
      { code: 'AP4', doppler: 'color', ef: true },
      { code: 'AP5', doppler: 'color' },
    ],
  },
};

/** Weight each AutoEF view carries in the blended ejection-fraction estimate. */
const EF_VIEW_WEIGHTS = { PLAX: 0.25, AP4: 0.45, AP2: 0.30 };

function viewKey(view) {
  return view.doppler ? `${view.code}+${view.doppler.toUpperCase()}` : view.code;
}

function efViews(protocol) {
  return protocol.views.filter((view) => view.ef);
}

function describeView(view) {
  const base = VIEWS[view.code];
  return {
    key: viewKey(view),
    code: view.code,
    label: base ? base.label : view.code,
    window: base ? base.window : 'unknown',
    doppler: view.doppler || null,
    ef: Boolean(view.ef),
  };
}

module.exports = { VIEWS, PROTOCOLS, EF_VIEW_WEIGHTS, viewKey, efViews, describeView };
