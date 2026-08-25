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

function createClient() {
  return {
    provider: 'provider-b',
    async uploadBlob(containerName, blobName, body) {
      if (!CONTAINER_NAME_RULE.test(containerName)) {
        throw new InvalidResourceName(containerName);
      }
      // Containers are auto-created on first write.
      if (!containers.has(containerName)) containers.set(containerName, new Map());
      containers.get(containerName).set(blobName, body);
      return `provider-b://${containerName}/${blobName}`;
    },
  };
}

module.exports = { createClient, InvalidResourceName };
