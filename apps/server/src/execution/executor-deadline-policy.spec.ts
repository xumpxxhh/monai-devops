import {
  resolveExecutorAttemptDeadlineMs,
  resolveExecutorCancelGraceMs,
} from './executor-deadline-policy.js';

describe('executor attempt deadline policy', () => {
  it('uses a bounded default and accepts an explicit duration', () => {
    expect(resolveExecutorAttemptDeadlineMs(undefined)).toBe(300_000);
    expect(resolveExecutorAttemptDeadlineMs('12000')).toBe(12_000);
  });

  it('rejects invalid or unbounded values', () => {
    for (const value of ['NaN', '9999', '86400001', '1.5', '-1']) {
      expect(() => resolveExecutorAttemptDeadlineMs(value)).toThrow();
    }
  });
});

describe('executor cancellation grace policy', () => {
  it('defaults to immediate fencing and bounds cooperative grace', () => {
    expect(resolveExecutorCancelGraceMs(undefined)).toBe(0);
    expect(resolveExecutorCancelGraceMs('5000')).toBe(5_000);
    expect(() => resolveExecutorCancelGraceMs('30001')).toThrow();
  });
});
