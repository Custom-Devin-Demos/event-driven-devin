const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const https = require('https');
const { execFileSync } = require('child_process');
const { performance } = require('perf_hooks');
const logger = require('../../telemetry/logger');
const { recordMetric } = require('../../telemetry/datadog');
const { Sentry } = require('../../telemetry/sentry');

const SERVICE = 'industrials-edge-gateway';
const SITE_CERT_NAMES = ['f2-torrance', 'f3-mesa', 'f4-alabama'];
const MATERIAL_DIR = path.join(os.tmpdir(), 'event-driven-devin-mtls');
const CERT_DIR = path.join(MATERIAL_DIR, String(process.pid));
const CA_CERT = path.join(CERT_DIR, 'ca', 'ca.cert.pem');
const CLIENT_DIR = path.join(CERT_DIR, 'client');

let gateway;
let gatewayReady;
let materialState;
const clientSocketSites = new Map();
const pendingClientSites = [];

function runOpenSSL(args, cwd) {
  execFileSync('/usr/bin/openssl', args, {
    cwd,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
}

function inspectCertificate(certPath) {
  const certificate = new crypto.X509Certificate(fs.readFileSync(certPath));
  const notAfter = new Date(certificate.validTo);
  const daysToExpiry = (notAfter.getTime() - Date.now()) / 86400000;
  return {
    certificate,
    notAfter,
    daysToExpiry,
  };
}

function generateCertificateMaterial() {
  fs.rmSync(CERT_DIR, { recursive: true, force: true });
  fs.mkdirSync(path.join(CERT_DIR, 'ca', 'newcerts'), { recursive: true });
  fs.mkdirSync(path.join(CERT_DIR, 'server'), { recursive: true });
  fs.mkdirSync(CLIENT_DIR, { recursive: true });
  fs.writeFileSync(path.join(CERT_DIR, 'ca', 'index.txt'), '');
  fs.writeFileSync(path.join(CERT_DIR, 'ca', 'serial'), '1000\n');

  runOpenSSL([
    'req', '-x509', '-newkey', 'rsa:2048', '-nodes',
    '-keyout', path.join(CERT_DIR, 'ca', 'ca.key.pem'),
    '-out', CA_CERT, '-days', '3650',
    '-subj', '/C=US/O=Titan Mfg Edge/CN=Titan Mfg Edge Root CA',
    '-addext', 'basicConstraints=critical,CA:TRUE,pathlen:1',
    '-addext', 'keyUsage=critical,keyCertSign,cRLSign',
  ], CERT_DIR);

  const serverKey = path.join(CERT_DIR, 'server', 'server.key.pem');
  const serverCsr = path.join(CERT_DIR, 'server', 'server.csr.pem');
  const serverCert = path.join(CERT_DIR, 'server', 'server.cert.pem');
  runOpenSSL([
    'req', '-newkey', 'rsa:2048', '-nodes',
    '-keyout', serverKey, '-out', serverCsr,
    '-subj', '/C=US/O=Titan Mfg Edge/CN=localhost',
  ], CERT_DIR);
  const serverExt = path.join(CERT_DIR, 'server', 'server.ext');
  fs.writeFileSync(serverExt, [
    'basicConstraints=critical,CA:FALSE',
    'keyUsage=critical,digitalSignature,keyEncipherment',
    'extendedKeyUsage=serverAuth',
    'subjectAltName=DNS:localhost,IP:127.0.0.1',
  ].join('\n'));
  runOpenSSL([
    'x509', '-req', '-in', serverCsr,
    '-CA', CA_CERT, '-CAkey', path.join(CERT_DIR, 'ca', 'ca.key.pem'),
    '-CAcreateserial', '-out', serverCert, '-days', '3650', '-sha256',
    '-extfile', serverExt,
  ], CERT_DIR);

  for (const site of SITE_CERT_NAMES) {
    const key = path.join(CLIENT_DIR, `${site}.key.pem`);
    const csr = path.join(CLIENT_DIR, `${site}.csr.pem`);
    const cert = path.join(CLIENT_DIR, `${site}.cert.pem`);
    runOpenSSL([
      'req', '-newkey', 'rsa:2048', '-nodes',
      '-keyout', key, '-out', csr,
      '-subj', `/C=US/O=Titan Mfg Edge/CN=${site}`,
    ], CERT_DIR);
    const ext = path.join(CLIENT_DIR, `${site}.ext`);
    fs.writeFileSync(ext, [
      'basicConstraints=critical,CA:FALSE',
      'keyUsage=critical,digitalSignature,keyEncipherment',
      'extendedKeyUsage=clientAuth',
    ].join('\n'));

    if (site === 'f3-mesa') {
      const caConfig = path.join(CERT_DIR, 'ca', 'openssl-ca.cnf');
      fs.writeFileSync(caConfig, [
        '[ ca ]',
        'default_ca = CA_default',
        '[ CA_default ]',
        'database = ./index.txt',
        'new_certs_dir = ./newcerts',
        'certificate = ./ca.cert.pem',
        'private_key = ./ca.key.pem',
        'serial = ./serial',
        'default_md = sha256',
        'default_days = 3650',
        'policy = policy_any',
        '[ policy_any ]',
        'commonName = supplied',
      ].join('\n'));
      const start = new Date(Date.now() - 2 * 86400000);
      const end = new Date(Date.now() - 86400000);
      const formatDate = (date) => {
        const iso = date.toISOString();
        return `${iso.slice(2, 4)}${iso.slice(5, 7)}${iso.slice(8, 10)}`
          + `${iso.slice(11, 13)}${iso.slice(14, 16)}${iso.slice(17, 19)}Z`;
      };
      runOpenSSL([
        'ca', '-batch', '-config', 'openssl-ca.cnf',
        '-startdate', formatDate(start),
        '-enddate', formatDate(end),
        '-in', path.relative(path.join(CERT_DIR, 'ca'), csr),
        '-out', path.relative(path.join(CERT_DIR, 'ca'), cert),
      ], path.join(CERT_DIR, 'ca'));
    } else {
      runOpenSSL([
        'x509', '-req', '-in', csr,
        '-CA', CA_CERT, '-CAkey', path.join(CERT_DIR, 'ca', 'ca.key.pem'),
        '-CAcreateserial', '-out', cert, '-days', '3650', '-sha256',
        '-extfile', ext,
      ], CERT_DIR);
    }
  }

  const certificates = Object.fromEntries(SITE_CERT_NAMES.map((site) => {
    const certPath = path.join(CLIENT_DIR, `${site}.cert.pem`);
    const inspected = inspectCertificate(certPath);
    recordMetric('gateway.client_cert.days_to_expiry', inspected.daysToExpiry, {
      service: SERVICE,
      site,
    });
    logger.info('Industrial edge client certificate loaded', {
      service: SERVICE,
      site,
      notAfter: inspected.notAfter.toISOString(),
      daysToExpiry: Number(inspected.daysToExpiry.toFixed(3)),
    });
    return [site, {
      cert: certPath,
      key: path.join(CLIENT_DIR, `${site}.key.pem`),
      subjectCn: inspected.certificate.subject.match(/CN=([^,]+)/)?.[1] || site,
      notAfter: inspected.notAfter,
    }];
  }));

  return {
    ca: CA_CERT,
    server: {
      cert: path.join(CERT_DIR, 'server', 'server.cert.pem'),
      key: path.join(CERT_DIR, 'server', 'server.key.pem'),
    },
    clients: certificates,
  };
}

function ensureCertificateMaterial() {
  if (materialState) return materialState;
  try {
    materialState = generateCertificateMaterial();
    return materialState;
  } catch (error) {
    logger.warn('Industrial edge mTLS certificate generation failed — edge gateway disabled', {
      service: SERVICE,
      error: error.message,
      warning: 'Cloud DFM fallback remains available; install openssl or inspect boot logs before using edge routing.',
    });
    materialState = null;
    return null;
  }
}

function clientCertificateFor(site) {
  const material = ensureCertificateMaterial();
  return material && material.clients[site];
}

function startGateway() {
  if (gatewayReady) return gatewayReady;
  gatewayReady = new Promise((resolve) => {
    const material = ensureCertificateMaterial();
    if (!material) {
      resolve(null);
      return;
    }

    const server = https.createServer({
      key: fs.readFileSync(material.server.key),
      cert: fs.readFileSync(material.server.cert),
      ca: fs.readFileSync(material.ca),
      requestCert: true,
      rejectUnauthorized: true,
    }, async (req, res) => {
      if (req.url !== '/dfm/analyze' || req.method !== 'POST') {
        res.statusCode = 404;
        res.end('Not found');
        return;
      }
      const chunks = [];
      for await (const chunk of req) chunks.push(chunk);
      const payload = JSON.parse(Buffer.concat(chunks).toString() || '{}');
      const stages = {};
      const runStage = async (name, waitMs) => {
        const started = performance.now();
        await new Promise((stageResolve) => setTimeout(stageResolve, waitMs));
        stages[name] = performance.now() - started;
        logger.info('Industrial edge DFM stage completed', {
          service: SERVICE,
          site: payload.site,
          stage: name,
          durationMs: Number(stages[name].toFixed(1)),
        });
      };
      await runStage('geometry', 92);
      await runStage('tolerance', 103);
      await runStage('material', 96);
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({ success: true, site: payload.site, stages }));
    });

    server.on('tlsClientError', (error, socket) => {
      const certificate = socket.getPeerCertificate(true) || {};
      const mappedSite = clientSocketSites.get(socket.remotePort)
        || pendingClientSites[pendingClientSites.length - 1]?.site;
      const mappedCertificate = mappedSite && materialState?.clients[mappedSite];
      const subjectCn = certificate.subject?.CN || mappedCertificate?.subjectCn || 'unknown';
      const site = SITE_CERT_NAMES.includes(subjectCn) ? subjectCn : 'unknown';
      logger.warn('Industrial edge mTLS client rejected', {
        service: SERVICE,
        site,
        authorizationError: socket.authorizationError || error.code,
        clientCertSubjectCn: subjectCn,
        clientCertNotAfter: certificate.valid_to || mappedCertificate?.notAfter?.toISOString() || 'unknown',
        error: error.message,
      });
      const pendingIndex = pendingClientSites.findLastIndex((entry) => entry.site === mappedSite);
      if (pendingIndex >= 0) pendingClientSites.splice(pendingIndex, 1);
      Sentry.captureException(error, {
        tags: { service: SERVICE, site, authorization_error: socket.authorizationError || error.code },
        extra: { clientCertSubjectCn: subjectCn, clientCertNotAfter: certificate.valid_to },
      });
    });

    server.listen(0, '127.0.0.1', () => {
      gateway = server;
      resolve(server);
    });
  });
  return gatewayReady;
}

function quoteAtEdge(site, quote, timeoutMs = 4000) {
  return startGateway().then((server) => new Promise((resolve, reject) => {
    if (!server) {
      const error = new Error('Industrial edge gateway unavailable');
      error.code = 'EDGE_GATEWAY_UNAVAILABLE';
      reject(error);
      return;
    }
    const client = clientCertificateFor(site);
    if (!client) {
      const error = new Error(`No edge client certificate configured for ${site}`);
      error.code = 'EDGE_CLIENT_CERT_MISSING';
      reject(error);
      return;
    }
    pendingClientSites.push({ site });
    const request = https.request({
      host: '127.0.0.1',
      port: server.address().port,
      path: '/dfm/analyze',
      method: 'POST',
      ca: fs.readFileSync(CA_CERT),
      key: fs.readFileSync(client.key),
      cert: fs.readFileSync(client.cert),
      servername: 'localhost',
      timeout: timeoutMs,
      headers: { 'content-type': 'application/json' },
    }, (response) => {
      const pendingIndex = pendingClientSites.findIndex((entry) => entry.site === site);
      if (pendingIndex >= 0) pendingClientSites.splice(pendingIndex, 1);
      const chunks = [];
      response.on('data', (chunk) => chunks.push(chunk));
      response.on('end', () => {
        if (response.statusCode !== 200) {
          const error = new Error(`Industrial edge gateway returned ${response.statusCode}`);
          error.code = 'EDGE_GATEWAY_HTTP_ERROR';
          reject(error);
          return;
        }
        resolve(JSON.parse(Buffer.concat(chunks).toString()));
      });
    });
    request.on('socket', (socket) => {
      socket.once('connect', () => clientSocketSites.set(socket.localPort, site));
      socket.once('close', () => clientSocketSites.delete(socket.localPort));
    });
    request.on('timeout', () => request.destroy(new Error(`edge gateway timeout after ${timeoutMs}ms`)));
    request.on('error', (error) => {
      const clientError = new Error(error.message);
      clientError.code = error.code;
      reject(clientError);
    });
    request.end(JSON.stringify(quote));
  }));
}

function stopGateway() {
  if (!gateway) return Promise.resolve();
  const server = gateway;
  gateway = null;
  gatewayReady = null;
  return new Promise((resolve) => server.close(resolve));
}

module.exports = {
  SERVICE,
  SITE_CERT_NAMES,
  ensureCertificateMaterial,
  clientCertificateFor,
  quoteAtEdge,
  startGateway,
  stopGateway,
};

// Generate fixtures and bind the loopback gateway during application boot so
// the first quote measures request work rather than certificate generation.
startGateway();
