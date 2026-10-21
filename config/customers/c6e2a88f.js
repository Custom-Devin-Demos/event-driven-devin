/**
 * Cigna Enterprise Architecture — Architecture Review Hub.
 *
 * ServiceNow-first: a failed primary action opens an incident for the EA
 * platform team (CI "Architecture Review Hub") and the ServiceNow dispatch
 * rule starts the Devin session from that incident. The session writes its
 * findings and the fix PR back to the incident; the assignment group keeps
 * release ownership and closes the incident.
 */
module.exports = {
  label: 'Cigna Enterprise Architecture — Architecture Review Hub (ServiceNow)',
  triggerMode: 'api',
  aliases: ['arb-hub', 'architecture-review-hub'],
  itsm: 'servicenow',
  itsmAssignmentGroup: 'Enterprise Architecture Platform Engineering',
};
