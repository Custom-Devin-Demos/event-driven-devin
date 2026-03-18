// Mock uuid before importing the module under test
jest.mock('uuid', () => ({
  v4: () => 'test-uuid-1234',
}));

const { createWorkOrder, EQUIPMENT_CLASSES } = require('./industrials');

// Mock dependencies to isolate unit tests
jest.mock('../../telemetry/logger', () => ({
  info: jest.fn(),
  error: jest.fn(),
  warn: jest.fn(),
}));
jest.mock('../../telemetry/datadog', () => ({
  incrementMetric: jest.fn(),
  recordTiming: jest.fn(),
}));
jest.mock('../../telemetry/sentry', () => ({
  Sentry: { captureException: jest.fn() },
}));
jest.mock('../devin-session', () => ({
  createSessionAndAlert: jest.fn().mockResolvedValue({}),
}));

describe('getEquipmentClass (via createWorkOrder)', () => {
  test('should succeed with lowercase category "rotating"', async () => {
    const result = await createWorkOrder({
      equipmentId: 'EQ-001',
      equipmentCategory: 'rotating',
      issueType: 'preventive',
      priority: 'high',
      estimatedHours: 4,
      partsEstimate: 500,
    });
    expect(result.success).toBe(true);
    expect(result.workOrderId).toBeDefined();
    expect(result.costEstimate).toBeDefined();
    expect(result.costEstimate.labor).toBe(340); // 85 * 4
    expect(result.costEstimate.materials).toBe(600); // 500 * 1.2
  });

  test('should succeed with capitalized category "Rotating" (case-insensitive lookup)', async () => {
    const result = await createWorkOrder({
      equipmentId: 'EQ-001',
      equipmentCategory: 'Rotating',
      issueType: 'preventive',
      priority: 'high',
      estimatedHours: 4,
      partsEstimate: 500,
    });
    expect(result.success).toBe(true);
    expect(result.costEstimate.labor).toBe(340);
    expect(result.costEstimate.materials).toBe(600);
  });

  test('should succeed with "electrical" category', async () => {
    const result = await createWorkOrder({
      equipmentId: 'EQ-003',
      equipmentCategory: 'electrical',
      issueType: 'corrective',
      priority: 'medium',
      estimatedHours: 2,
      partsEstimate: 200,
    });
    expect(result.success).toBe(true);
    expect(result.costEstimate.labor).toBe(190); // 95 * 2
    expect(result.costEstimate.materials).toBe(300); // 200 * 1.5
  });

  test('should succeed with "hydraulic" category', async () => {
    const result = await createWorkOrder({
      equipmentId: 'EQ-004',
      equipmentCategory: 'hydraulic',
      issueType: 'emergency',
      priority: 'critical',
      estimatedHours: 3,
      partsEstimate: 1000,
    });
    expect(result.success).toBe(true);
    expect(result.costEstimate.labor).toBe(330); // 110 * 3
    expect(result.costEstimate.materials).toBe(1300); // 1000 * 1.3
  });

  test('should succeed with "structural" category', async () => {
    const result = await createWorkOrder({
      equipmentId: 'EQ-005',
      equipmentCategory: 'structural',
      issueType: 'preventive',
      priority: 'low',
      estimatedHours: 6,
      partsEstimate: 300,
    });
    expect(result.success).toBe(true);
    expect(result.costEstimate.labor).toBe(450); // 75 * 6
    expect(result.costEstimate.materials).toBe(300); // 300 * 1.0
  });

  test('should throw descriptive error for unknown category', async () => {
    await expect(
      createWorkOrder({
        equipmentId: 'EQ-001',
        equipmentCategory: 'unknown-category',
        issueType: 'preventive',
        priority: 'high',
        estimatedHours: 4,
        partsEstimate: 500,
      }),
    ).rejects.toThrow('Unknown equipment category: unknown-category');
  });

  test('should throw for null category', async () => {
    await expect(
      createWorkOrder({
        equipmentId: 'EQ-001',
        equipmentCategory: null,
        issueType: 'preventive',
        priority: 'high',
        estimatedHours: 4,
        partsEstimate: 500,
      }),
    ).rejects.toThrow('Unknown equipment category: null');
  });

  test('should throw for undefined category', async () => {
    await expect(
      createWorkOrder({
        equipmentId: 'EQ-001',
        issueType: 'preventive',
        priority: 'high',
        estimatedHours: 4,
        partsEstimate: 500,
      }),
    ).rejects.toThrow('Unknown equipment category: undefined');
  });
});

describe('EQUIPMENT_CLASSES data integrity', () => {
  test('should have all four equipment categories', () => {
    const categories = EQUIPMENT_CLASSES.map((ec) => ec.category);
    expect(categories).toContain('rotating');
    expect(categories).toContain('electrical');
    expect(categories).toContain('hydraulic');
    expect(categories).toContain('structural');
  });

  test('each class should have required rate fields', () => {
    for (const ec of EQUIPMENT_CLASSES) {
      expect(ec.laborRate).toBeDefined();
      expect(typeof ec.laborRate).toBe('number');
      expect(ec.partsMultiplier).toBeDefined();
      expect(typeof ec.partsMultiplier).toBe('number');
    }
  });
});
