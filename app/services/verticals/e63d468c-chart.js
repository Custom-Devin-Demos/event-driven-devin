const CHART = { name: 'telemetry-ingest', version: '0.4.2', appVersion: '2.7.0' };

const VALUES = {
  replicaCount: 2,
  image: { repository: 'telemetry-ingest', tag: '2.7.0', pullPolicy: 'IfNotPresent' },
  resources: {
    requests: { cpu: '50m', memory: '128Mi' },
    limits: { memory: '256Mi' },
  },
  service: { type: 'NodePort', port: 8080, nodePort: 30080 },
  probes: { path: '/healthz', port: 8080 },
};

function renderContainer(values) {
  return {
    name: CHART.name,
    image: `${values.image.repository}:${values.image.tag}`,
    imagePullPolicy: values.image.pullPolicy,
    ports: [{ name: 'http', containerPort: values.probes.port }],
    resources: JSON.parse(JSON.stringify(values.resources)),
    readinessProbe: { httpGet: { path: values.probes.path, port: 'http' } },
    livenessProbe: { httpGet: { path: values.probes.path, port: 'http' } },
  };
}

function renderDeployment(values = VALUES) {
  return {
    apiVersion: 'apps/v1',
    kind: 'Deployment',
    metadata: {
      name: CHART.name,
      namespace: 'fleet',
      labels: { 'app.kubernetes.io/name': CHART.name, 'helm.sh/chart': `${CHART.name}-${CHART.version}` },
    },
    spec: {
      replicas: values.replicaCount,
      selector: { matchLabels: { 'app.kubernetes.io/name': CHART.name } },
      template: {
        metadata: { labels: { 'app.kubernetes.io/name': CHART.name } },
        spec: { containers: [renderContainer(values)] },
      },
    },
  };
}

module.exports = { CHART, VALUES, renderDeployment };
