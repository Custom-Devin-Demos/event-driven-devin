'use strict';

// Provider B object storage. Container naming rules are stricter than
// provider A's: lowercase alphanumerics and hyphens only. The client
// validates names before issuing the request so a failing tick fails fast
// instead of burning a round trip.

const CONTAINER_NAME_RULE = /^[a-z0-9](?:[a-z0-9-]{1,61}[a-z0-9])$/;

class InvalidResourceName extends Error {
  constructor(containerName) {
    super(`container name "${containerName}" is not valid for this provider`);
    this.name = 'InvalidResourceName';
    this.containerName = containerName;
  }
}

const containers = new Map();

// Each container keeps only the most recent blobs so the long-running
// process's memory stays bounded.
const MAX_BLOBS_PER_CONTAINER = 200;

function createClient() {
  return {
    provider: 'provider-b',
    async uploadBlob(containerName, blobName, body) {
      if (!CONTAINER_NAME_RULE.test(containerName)) {
        throw new InvalidResourceName(containerName);
      }
      // Containers are auto-created on first write.
      if (!containers.has(containerName)) containers.set(containerName, new Map());
      const container = containers.get(containerName);
      container.set(blobName, body);
      while (container.size > MAX_BLOBS_PER_CONTAINER) {
        container.delete(container.keys().next().value);
      }
      return `provider-b://${containerName}/${blobName}`;
    },
  };
}

module.exports = { createClient, InvalidResourceName };
