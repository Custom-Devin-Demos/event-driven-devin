'use strict';

// Provider A: permissive object store. Containers are created on demand and
// names are accepted as-is.

const containers = new Map();

function createClient() {
  return {
    provider: 'provider-a',
    async uploadBlob(containerName, blobName, body) {
      if (!containers.has(containerName)) containers.set(containerName, new Map());
      containers.get(containerName).set(blobName, body);
      return `provider-a://${containerName}/${blobName}`;
    },
  };
}

module.exports = { createClient };
