import { describe, expect, it } from 'vitest';
import { getAncestorIds, validateDag } from './dag-utils';

describe('getAncestorIds', () => {
  it('collects direct and indirect ancestors', () => {
    const steps = [
      { id: 'a' },
      { id: 'b', dependsOn: ['a'] },
      { id: 'c', dependsOn: ['b'] },
      { id: 'd', dependsOn: ['a'] },
    ];
    expect([...getAncestorIds('c', steps)].sort()).toEqual(['a', 'b']);
    expect([...getAncestorIds('d', steps)].sort()).toEqual(['a']);
    expect([...getAncestorIds('a', steps)]).toEqual([]);
  });
});

describe('validateDag', () => {
  it('detects cycles', () => {
    const result = validateDag([
      { id: 'a', dependsOn: ['b'] },
      { id: 'b', dependsOn: ['a'] },
    ]);
    expect(result.valid).toBe(false);
  });
});
