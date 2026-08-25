'use strict';

const storage = require('./storage');

// IndirectData writes large automation payloads to the org's own cloud
// storage and keeps only a reference in Postgres.

const IndirectData = {
  async newBlob(session, orgId, subpath, payload) {
    const client = await storage.clientForOrg(session, orgId);
    const blobName = `${Date.now()}-${Math.random().toString(36).slice(2, 10)}.json`;
    const containerName = storage.containerName(orgId, subpath);
    const ref = await client.uploadBlob(containerName, blobName, JSON.stringify(payload));
    return { orgId, subpath, ref };
  },
};

module.exports = IndirectData;
