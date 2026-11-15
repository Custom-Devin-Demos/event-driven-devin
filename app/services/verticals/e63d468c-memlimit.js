const CGROUP_ROOT = '/sys/fs/cgroup';

function readFile(fs, path) {
  if (!Object.prototype.hasOwnProperty.call(fs, path)) {
    const err = new Error(`ENOENT: no such file or directory, open '${path}'`);
    err.code = 'ENOENT';
    throw err;
  }
  return fs[path];
}

function memoryLimitBytes({ env = {}, fs = {}, hostMemBytes }) {
  if (env.MEMORY_LIMIT_BYTES) {
    return parseInt(env.MEMORY_LIMIT_BYTES, 10);
  }
  try {
    return parseInt(readFile(fs, `${CGROUP_ROOT}/memory/memory.limit_in_bytes`), 10);
  } catch (err) {
    if (err.code !== 'ENOENT') throw err;
    return hostMemBytes;
  }
}

module.exports = { memoryLimitBytes, CGROUP_ROOT };
