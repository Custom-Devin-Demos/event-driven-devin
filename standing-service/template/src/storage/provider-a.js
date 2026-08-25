'use strict';

// Provider A: permissive object store. Containers are created on demand and
// names are accepted as-is.

const containers = new Map();

// Each container keeps only the most recent blobs so the long-running
// process's memory stays bounded.
const MAX_BLOBS_PER_CONTAINER = 200;

function createClient() {
  return {
    provider: 'provider-a',
    async uploadBlob(containerName, blobName, body) {
      if (!containers.has(containerName)) containers.set(containerName, new Map());
      const container = containers.get(containerName);
      container.set(blobName, body);
      while (container.size > MAX_BLOBS_PER_CONTAINER) {
        container.delete(container.keys().next().value);
      }
      return `provider-a://${containerName}/${blobName}`;
    },
  };
}

module.exports = { createClient };
