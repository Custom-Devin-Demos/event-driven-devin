module.exports = {
  label: 'Customer CE9A',
  triggerMode: 'api',
  githubOrg: 'COG-GTM',
  // No per-customer Devin key: the alert session runs on the default service
  // key, so the SonarCloud scan workflow must use the same one.
  sonarWorkflowCustomer: 'default',
};
