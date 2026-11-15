/* global describe, expect, jest, test, beforeEach */

jest.mock('../app/services/devin-session', () => ({
  createSessionAndAlert: jest.fn().mockResolvedValue(null),
}));

const { createSessionAndAlert } = require('../app/services/devin-session');
const {
  retireNodeGroup, resetCluster, getClusterState, MONITOR,
} = require('../app/services/verticals/e63d468c');

describe('prod-east telemetry-ingest monitor (e63d468c)', () => {
  beforeEach(() => {
    resetCluster();
    createSessionAndAlert.mockClear();
  });

  test('opening state: 2/2 ready on fleet-al2, monitor OK', () => {
    const state = getClusterState();
    expect(state.status).toBe('OK');
    expect(state.replicas).toEqual({ ready: 2, desired: 2 });
    expect(state.pods.every((p) => p.nodeGroup === 'fleet-al2')).toBe(true);
    expect(state.pods[0].logs[0]).toBe('memory limit detected: 256 MiB; sizing cache to 128 MiB');
    expect(state.nodes).toHaveLength(5);
  });

  test('retiring fleet-al2 crash-loops telemetry-ingest and fires one alert', async () => {
    await expect(retireNodeGroup({})).rejects.toMatchObject({ name: 'CrashLoopBackOff' });
    const state = getClusterState();
    expect(state.status).toBe('ALERT');
    expect(state.replicas.ready).toBe(0);
    expect(state.nodes).toHaveLength(3);
    expect(state.pods.every((p) => p.lastState && p.lastState.exitCode === 137)).toBe(true);
    expect(createSessionAndAlert).toHaveBeenCalledTimes(1);
    expect(createSessionAndAlert).toHaveBeenCalledWith(expect.objectContaining({
      service: 'e63d468c-api',
      issueUrl: `https://app.datadoghq.com/monitors/${MONITOR.id}`,
    }));
    expect(createSessionAndAlert.mock.calls[0][0]).not.toHaveProperty('customer');
  });

  test('a second click does not alert again until reset', async () => {
    await expect(retireNodeGroup({})).rejects.toThrow();
    const again = await retireNodeGroup({});
    expect(again.status).toBe('ALERT');
    expect(createSessionAndAlert).toHaveBeenCalledTimes(1);
  });

  test('overlapping clicks roll out once and alert once', async () => {
    const results = await Promise.allSettled([retireNodeGroup({}), retireNodeGroup({})]);
    expect(results.filter((r) => r.status === 'rejected')).toHaveLength(1);
    expect(createSessionAndAlert).toHaveBeenCalledTimes(1);
  });

  test('reset restores the opening state and the failure reproduces again', async () => {
    await expect(retireNodeGroup({})).rejects.toThrow();
    const reset = resetCluster();
    expect(reset.status).toBe('OK');
    expect(reset.replicas.ready).toBe(2);
    expect(reset.retiredAt).toBeNull();
    await expect(retireNodeGroup({})).rejects.toMatchObject({ name: 'CrashLoopBackOff' });
    expect(createSessionAndAlert).toHaveBeenCalledTimes(2);
  });
});
