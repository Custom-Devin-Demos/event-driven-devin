const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const https = require('https');
const { execFile } = require('child_process');
const { performance } = require('perf_hooks');
const logger = require('../../telemetry/logger');
const { recordMetric } = require('../../telemetry/datadog');

const SERVICE = 'industrials-edge-gateway';
const SITE_CERT_NAMES = ['f2-torrance', 'f3-mesa', 'f4-alabama'];
let MATERIAL_DIR = path.join(os.tmpdir(), 'event-driven-devin-mtls');
let CERT_DIR = path.join(MATERIAL_DIR, String(process.pid));
let CA_CERT = path.join(CERT_DIR, 'ca', 'ca.cert.pem');
let CLIENT_DIR = path.join(CERT_DIR, 'client');
let sweepOrphans = true;
let temporaryMaterialDirectory = false;

let gateway;
let gatewayReady;
let materialState;
let materialGenerationFailed = false;
const clientSocketSites = new Map();

function runOpenSSL(args, cwd) {
  return new Promise((resolve, reject) => {
    execFile('openssl', args, {
      cwd,
      stdio: ['ignore', 'pipe', 'pipe'],
    }, (error) => {
      if (error) {
        reject(error);
        return;
      }
      resolve();
    });
  });
}

function inspectCertificate(certPath) {
  const certificate = new crypto.X509Certificate(fs.readFileSync(certPath));
  const notAfter = new Date(certificate.validTo);
  const daysToExpiry = (notAfter.getTime() - Date.now()) / 86400000;
  const subjectCn = certificate.subject
    .split(/[\n,]/)
    .map((part) => part.trim())
    .map((part) => part.match(/^CN=(.*)$/)?.[1])
    .find(Boolean);
  return {
    certificate,
    notAfter,
    daysToExpiry,
    subjectCn,
  };
}

function cleanupOrphanedMaterialDirectories() {
  let entries;
  try {
    entries = fs.readdirSync(MATERIAL_DIR, { withFileTypes: true });
  } catch (error) {
    if (error.code !== 'ENOENT') {
      logger.warn('Industrial edge orphaned certificate sweep failed', {
        service: SERVICE,
        error: error.message,
      });
    }
    return;
  }

  for (const entry of entries) {
    if (!entry.isDirectory() || entry.name === String(process.pid) || !/^\d+$/.test(entry.name)) {
      continue;
    }
    const pid = Number(entry.name);
    try {
      process.kill(pid, 0);
      continue;
    } catch (error) {
      if (error.code !== 'ESRCH') continue;
    }
    try {
      fs.rmSync(path.join(MATERIAL_DIR, entry.name), { recursive: true, force: true });
    } catch (error) {
      logger.warn('Industrial edge orphaned certificate cleanup failed', {
        service: SERVICE,
        directory: entry.name,
        error: error.message,
      });
    }
  }
}

function prepareMaterialDirectory() {
  const expectedUid = typeof process.getuid === 'function' ? process.getuid() : null;
  try {
    let stats;
    try {
      stats = fs.lstatSync(MATERIAL_DIR);
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
      fs.mkdirSync(MATERIAL_DIR, { mode: 0o700 });
      stats = fs.lstatSync(MATERIAL_DIR);
    }
    if (
      !stats.isDirectory()
      || (expectedUid !== null && stats.uid !== expectedUid)
      || (stats.mode & 0o777) !== 0o700
    ) {
      throw new Error('shared certificate directory is not a private owner-only directory');
    }
    temporaryMaterialDirectory = false;
  } catch (error) {
    const fallbackDir = fs.mkdtempSync(path.join(os.tmpdir(), 'event-driven-devin-mtls-'));
    MATERIAL_DIR = fallbackDir;
    sweepOrphans = false;
    temporaryMaterialDirectory = true;
    logger.warn('Industrial edge certificate directory fallback enabled', {
      service: SERVICE,
      error: error.message,
    });
  }
  CERT_DIR = path.join(MATERIAL_DIR, String(process.pid));
  CA_CERT = path.join(CERT_DIR, 'ca', 'ca.cert.pem');
  CLIENT_DIR = path.join(CERT_DIR, 'client');
}

async function generateCertificateMaterial() {
  prepareMaterialDirectory();
  if (sweepOrphans) cleanupOrphanedMaterialDirectories();
  fs.rmSync(CERT_DIR, { recursive: true, force: true });
  fs.mkdirSync(MATERIAL_DIR, { recursive: true, mode: 0o700 });
  fs.chmodSync(MATERIAL_DIR, 0o700);
  fs.mkdirSync(CERT_DIR, { recursive: true, mode: 0o700 });
  fs.chmodSync(CERT_DIR, 0o700);
  fs.mkdirSync(path.join(CERT_DIR, 'ca', 'newcerts'), { recursive: true });
  fs.mkdirSync(path.join(CERT_DIR, 'server'), { recursive: true });
  fs.mkdirSync(CLIENT_DIR, { recursive: true });
  fs.chmodSync(path.join(CERT_DIR, 'ca'), 0o700);
  fs.chmodSync(path.join(CERT_DIR, 'ca', 'newcerts'), 0o700);
  fs.chmodSync(path.join(CERT_DIR, 'server'), 0o700);
  fs.chmodSync(CLIENT_DIR, 0o700);
  fs.writeFileSync(path.join(CERT_DIR, 'ca', 'index.txt'), '');
  fs.writeFileSync(path.join(CERT_DIR, 'ca', 'serial'), '1000\n');

  const caKey = path.join(CERT_DIR, 'ca', 'ca.key.pem');
  await runOpenSSL([
    'req', '-x509', '-newkey', 'rsa:2048', '-nodes',
    '-keyout', caKey,
    '-out', CA_CERT, '-days', '3650',
    '-subj', '/C=US/O=Titan Mfg Edge/CN=Titan Mfg Edge Root CA',
    '-addext', 'basicConstraints=critical,CA:TRUE,pathlen:1',
    '-addext', 'keyUsage=critical,keyCertSign,cRLSign',
  ], CERT_DIR);
  fs.chmodSync(caKey, 0o600);

  const serverKey = path.join(CERT_DIR, 'server', 'server.key.pem');
  const serverCsr = path.join(CERT_DIR, 'server', 'server.csr.pem');
  const serverCert = path.join(CERT_DIR, 'server', 'server.cert.pem');
  await runOpenSSL([
    'req', '-newkey', 'rsa:2048', '-nodes',
    '-keyout', serverKey, '-out', serverCsr,
    '-subj', '/C=US/O=Titan Mfg Edge/CN=localhost',
  ], CERT_DIR);
  fs.chmodSync(serverKey, 0o600);
  const serverExt = path.join(CERT_DIR, 'server', 'server.ext');
  fs.writeFileSync(serverExt, [
    'basicConstraints=critical,CA:FALSE',
    'keyUsage=critical,digitalSignature,keyEncipherment',
    'extendedKeyUsage=serverAuth',
    'subjectAltName=DNS:localhost,IP:127.0.0.1,DNS:f2-torrance,DNS:f3-mesa,DNS:f4-alabama',
  ].join('\n'));
    await runOpenSSL([
    'x509', '-req', '-in', serverCsr,
    '-CA', CA_CERT, '-CAkey', path.join(CERT_DIR, 'ca', 'ca.key.pem'),
    '-CAcreateserial', '-out', serverCert, '-days', '3650', '-sha256',
    '-extfile', serverExt,
  ], CERT_DIR);

  for (const site of SITE_CERT_NAMES) {
    const key = path.join(CLIENT_DIR, `${site}.key.pem`);
    const csr = path.join(CLIENT_DIR, `${site}.csr.pem`);
    const cert = path.join(CLIENT_DIR, `${site}.cert.pem`);
    await runOpenSSL([
      'req', '-newkey', 'rsa:2048', '-nodes',
      '-keyout', key, '-out', csr,
      '-subj', `/C=US/O=Titan Mfg Edge/CN=${site}`,
    ], CERT_DIR);
    fs.chmodSync(key, 0o600);
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
        'x509_extensions = client_cert',
        '[ policy_any ]',
        'commonName = supplied',
        '[ client_cert ]',
        'basicConstraints=critical,CA:FALSE',
        'keyUsage=critical,digitalSignature,keyEncipherment',
        'extendedKeyUsage=clientAuth',
      ].join('\n'));
      const start = new Date(Date.now() - 2 * 86400000);
      const end = new Date(Date.now() - 86400000);
      const formatDate = (date) => {
        const iso = date.toISOString();
        return `${iso.slice(2, 4)}${iso.slice(5, 7)}${iso.slice(8, 10)}`
          + `${iso.slice(11, 13)}${iso.slice(14, 16)}${iso.slice(17, 19)}Z`;
      };
      await runOpenSSL([
        'ca', '-batch', '-config', 'openssl-ca.cnf',
        '-startdate', formatDate(start),
        '-enddate', formatDate(end),
        '-in', path.relative(path.join(CERT_DIR, 'ca'), csr),
        '-out', path.relative(path.join(CERT_DIR, 'ca'), cert),
      ], path.join(CERT_DIR, 'ca'));
    } else {
      await runOpenSSL([
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
    recordMetric('edge.cert.days_to_expiry', inspected.daysToExpiry, { site });
    logger.info('Industrial edge client certificate loaded', {
      service: SERVICE,
      site,
      notAfter: inspected.notAfter.toISOString(),
      daysToExpiry: Number(inspected.daysToExpiry.toFixed(3)),
    });
    return [site, {
      cert: certPath,
      key: path.join(CLIENT_DIR, `${site}.key.pem`),
      certBuffer: fs.readFileSync(certPath),
      keyBuffer: fs.readFileSync(path.join(CLIENT_DIR, `${site}.key.pem`)),
      subjectCn: inspected.subjectCn || site,
      notAfter: inspected.notAfter,
      daysToExpiry: inspected.daysToExpiry,
    }];
  }));

  return {
    ca: CA_CERT,
    caBuffer: fs.readFileSync(CA_CERT),
    server: {
      cert: path.join(CERT_DIR, 'server', 'server.cert.pem'),
      key: path.join(CERT_DIR, 'server', 'server.key.pem'),
      certBuffer: fs.readFileSync(path.join(CERT_DIR, 'server', 'server.cert.pem')),
      keyBuffer: fs.readFileSync(path.join(CERT_DIR, 'server', 'server.key.pem')),
    },
    clients: certificates,
  };
}

let materialGenerationPromise;

async function ensureCertificateMaterial() {
  if (materialState) return materialState;
  if (materialGenerationFailed) return null;
  if (!materialGenerationPromise) {
    materialGenerationPromise = generateCertificateMaterial()
      .then((material) => {
        materialState = material;
        return material;
      })
      .catch((error) => {
        logger.warn('Industrial edge mTLS certificate generation failed — edge gateway disabled', {
          service: SERVICE,
          error: error.message,
          warning: 'Cloud DFM fallback remains available; install openssl or inspect boot logs before using edge routing.',
        });
        materialGenerationFailed = true;
        materialState = null;
        return null;
      })
      .finally(() => {
        materialGenerationPromise = null;
      });
  }
  return materialGenerationPromise;
}

function clientCertificateFor(site) {
  return materialState?.clients[site];
}

function recordCertificateExpiryMetric(site) {
  const client = clientCertificateFor(site);
  if (client) {
    const daysToExpiry = (client.notAfter.getTime() - Date.now()) / 86400000;
    recordMetric('edge.cert.days_to_expiry', daysToExpiry, { site });
  }
}

function startGateway() {
  if (gatewayReady) return gatewayReady;
  const ready = Promise.resolve().then(async () => {
    let server;
    try {
      const material = await ensureCertificateMaterial();
      if (!material) {
        return null;
      }
      server = https.createServer({
        key: material.server.keyBuffer,
        cert: material.server.certBuffer,
        ca: material.caBuffer,
        requestCert: true,
        rejectUnauthorized: true,
      }, async (req, res) => {
        try {
          if (req.url !== '/dfm/analyze' || req.method !== 'POST') {
            res.statusCode = 404;
            res.end('Not found');
            return;
          }
          const chunks = [];
          for await (const chunk of req) chunks.push(chunk);
          let payload;
          try {
            payload = JSON.parse(Buffer.concat(chunks).toString() || '{}');
          } catch {
            res.statusCode = 400;
            res.setHeader('content-type', 'application/json');
            res.end(JSON.stringify({ error: 'Invalid JSON request body' }));
            return;
          }
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
        } catch (error) {
          logger.warn('Industrial edge gateway request failed', {
            service: SERVICE,
            error: error.message,
          });
          if (!res.writableEnded && !res.destroyed) {
            res.statusCode = 500;
            res.setHeader('content-type', 'application/json');
            res.end(JSON.stringify({ error: 'Industrial edge gateway request failed' }));
          }
        }
      });
      server.on('error', (error) => {
        logger.warn('Industrial edge gateway failed to start', {
          service: SERVICE,
          error: error.message,
        });
        if (gateway === server) gateway = null;
        if (gatewayReady === ready) gatewayReady = null;
        server.close(() => {});
      });
      server.on('close', () => {
        if (gateway === server) gateway = null;
        if (gatewayReady === ready) gatewayReady = null;
      });
      server.on('tlsClientError', (error, socket) => {
        const certificate = socket.getPeerCertificate(true) || {};
        const mappedSite = clientSocketSites.get(socket.remotePort)
          || (SITE_CERT_NAMES.includes(socket.servername) ? socket.servername : undefined);
        const mappedCertificate = mappedSite && materialState?.clients[mappedSite];
        const certificateSubject = certificate.subject;
        const subjectCn = (
          typeof certificateSubject === 'string'
            ? certificateSubject.split(/[\n,]/)
              .map((part) => part.trim())
              .map((part) => part.match(/^CN=(.*)$/)?.[1])
              .find(Boolean)
            : certificateSubject?.CN
        ) || mappedCertificate?.subjectCn || 'unknown';
        const site = SITE_CERT_NAMES.includes(subjectCn) ? subjectCn : 'unknown';
        logger.warn('Industrial edge mTLS client rejected', {
          service: SERVICE,
          site,
          authorizationError: socket.authorizationError || error.code,
          clientCertSubjectCn: subjectCn,
          clientCertNotAfter: certificate.valid_to || mappedCertificate?.notAfter?.toISOString() || 'unknown',
          error: error.message,
        });
        clientSocketSites.delete(socket.remotePort);
      });

      return await new Promise((resolve) => {
        let settled = false;
        const settle = (serverInstance) => {
          if (settled) return;
          settled = true;
          resolve(serverInstance);
        };
        server.on('error', () => settle(null));
        server.listen(0, '127.0.0.1', () => {
          gateway = server;
          settle(server);
        });
      });
    } catch (error) {
      logger.warn('Industrial edge gateway failed to start', {
        service: SERVICE,
        error: error.message,
      });
      if (server) server.close(() => {});
      return null;
    }
  });
  gatewayReady = ready;
  return ready;
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
    let localPort;
    const clearClientSocketSite = () => {
      if (localPort !== undefined) {
        clientSocketSites.delete(localPort);
        localPort = undefined;
      }
    };
    const address = server.address();
    if (!address || typeof address.port !== 'number') {
      const error = new Error('Industrial edge gateway unavailable');
      error.code = 'EDGE_GATEWAY_UNAVAILABLE';
      reject(error);
      return;
    }
    const request = https.request({
      host: '127.0.0.1',
      port: address.port,
      path: '/dfm/analyze',
      method: 'POST',
      ca: materialState.caBuffer,
      key: client.keyBuffer,
      cert: client.certBuffer,
      servername: site,
      agent: false,
      timeout: timeoutMs,
      headers: { 'content-type': 'application/json' },
    }, (response) => {
      const chunks = [];
      response.on('data', (chunk) => chunks.push(chunk));
      response.on('end', () => {
        clearClientSocketSite();
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
      socket.once('connect', () => {
        localPort = socket.localPort;
        clientSocketSites.set(localPort, site);
      });
      socket.once('close', () => {
        clearClientSocketSite();
      });
    });
    request.on('timeout', () => request.destroy(new Error(`edge gateway timeout after ${timeoutMs}ms`)));
    request.on('error', (error) => {
      clearClientSocketSite();
      const clientError = new Error(error.message);
      clientError.code = error.code;
      reject(clientError);
    });
    request.end(JSON.stringify(quote));
  }));
}

function stopGateway() {
  const ready = gatewayReady;
  if (!ready) return Promise.resolve();
  gatewayReady = null;
  return ready.then((server) => {
    if (!server) {
      return;
    }
    if (gateway === server) gateway = null;
    return new Promise((resolve) => {
      server.close(() => {
        resolve();
      });
    });
  });
}

function getClientSocketSiteCount() {
  return clientSocketSites.size;
}

module.exports = {
  SERVICE,
  SITE_CERT_NAMES,
  cleanupCertificateMaterial,
  runOpenSSL,
  ensureCertificateMaterial,
  clientCertificateFor,
  recordCertificateExpiryMetric,
  getClientSocketSiteCount,
  quoteAtEdge,
  startGateway,
  stopGateway,
};

function cleanupCertificateMaterial() {
  try {
    fs.rmSync(temporaryMaterialDirectory ? MATERIAL_DIR : CERT_DIR, {
      recursive: true,
      force: true,
    });
  } catch (error) {
    logger.warn('Industrial edge mTLS certificate cleanup failed', {
      service: SERVICE,
      error: error.message,
    });
  }
}

// The app's graceful shutdown drains connections and then calls process.exit,
// so cleanup on 'exit' also covers SIGTERM/SIGINT without pulling cert material
// out from under in-flight quotes mid-drain.
process.once('exit', cleanupCertificateMaterial);

// Let the application bind its HTTP port before synchronous certificate
// generation, while keeping the edge gateway warm before the first quote.
globalThis.setImmediate(() => startGateway().catch((error) => {
  logger.warn('Industrial edge gateway warm-up failed', {
    service: SERVICE,
    error: error.message,
  });
}));
