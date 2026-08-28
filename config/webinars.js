// Registry of customer webinar pages served at /webinars/<slug>.
// Each entry maps a unique public slug to immutable webinar metadata.
// Registrations are stored against webinarId, never against the slug alone.
module.exports = {
  'acme-test-webinar': {
    webinarId: 'web-2026-acme-test-001',
    webinarTitle: 'Scaling Engineering with the Cognition Platform',
    customerName: 'Acme Test',
  },
  'eli-lilly-webinar': {
    webinarId: 'web-2026-eli-lilly-001',
    webinarTitle: 'Scaling Engineering with the Cognition Platform',
    customerName: 'Eli Lilly',
  },
};
