/**
 * Layout rules for the invite screen (ce9afcfc).
 *
 * The composer offers several invite themes. Each theme declares how the top
 * of the RSVP screen is laid out, and the renderer composes the hero block
 * from that declaration plus whatever the host attached to the event.
 */

const THEME_LAYOUTS = {
  photo: {
    heroKind: 'photo',
    heroHeight: 400,
    overlayOpacity: 0.28,
    titlePlacement: 'above',
  },
  marquee: {
    heroKind: 'photo',
    heroHeight: 360,
    overlayOpacity: 0.34,
    titlePlacement: 'above',
  },
  confetti: {
    heroKind: 'photo',
    heroHeight: 340,
    overlayOpacity: 0.3,
    titlePlacement: 'above',
  },
};

const DEFAULT_THEME = 'photo';

/** Layout declaration for an invite theme. */
function layoutForTheme(theme) {
  return THEME_LAYOUTS[theme] || THEME_LAYOUTS[DEFAULT_THEME];
}

/**
 * Build the hero block the invite screen is drawn around.
 */
function composeHeroBlock(event, layout) {
  const media = event.coverPhoto;

  return {
    kind: layout.heroKind,
    url: media.url,
    aspectRatio: Number((media.width / media.height).toFixed(3)),
    height: layout.heroHeight,
    overlayOpacity: layout.overlayOpacity,
    titlePlacement: layout.titlePlacement,
    accent: event.accent,
  };
}

module.exports = {
  THEME_LAYOUTS,
  DEFAULT_THEME,
  layoutForTheme,
  composeHeroBlock,
};
