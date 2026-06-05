import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { MinHeap } from '../utils/min-heap.js';

describe('MinHeap', () => {
  it('starts empty', () => {
    const heap = new MinHeap<number>((a, b) => a - b);
    assert.equal(heap.size, 0);
    assert.equal(heap.isEmpty(), true);
    assert.equal(heap.peek(), undefined);
    assert.equal(heap.pop(), undefined);
  });

  it('peek returns minimum without removing', () => {
    const heap = new MinHeap<number>((a, b) => a - b);
    heap.push(3);
    heap.push(1);
    heap.push(2);

    assert.equal(heap.peek(), 1);
    assert.equal(heap.size, 3);
    assert.equal(heap.pop(), 1);
    assert.equal(heap.size, 2);
  });

  it('pops elements in ascending order', () => {
    const heap = new MinHeap<number>((a, b) => a - b);
    const input = [4, 1, 7, 3, 8, 2, 5, 6, 0, 9];
    for (const n of input) heap.push(n);

    const sorted: number[] = [];
    while (!heap.isEmpty()) {
      sorted.push(heap.pop()!);
    }

    assert.deepEqual(
      sorted,
      [...input].sort((a, b) => a - b),
    );
  });

  it('handles single element push and pop', () => {
    const heap = new MinHeap<string>((a, b) => a.localeCompare(b));
    heap.push('only');
    assert.equal(heap.pop(), 'only');
    assert.equal(heap.isEmpty(), true);
  });

  it('uses custom compare for object priority', () => {
    type Item = { id: string; priority: number };
    const heap = new MinHeap<Item>((a, b) => a.priority - b.priority);

    heap.push({ id: 'c', priority: 3 });
    heap.push({ id: 'a', priority: 1 });
    heap.push({ id: 'b', priority: 2 });

    assert.deepEqual(
      [heap.pop()!, heap.pop()!, heap.pop()!].map((x) => x.id),
      ['a', 'b', 'c'],
    );
  });
});
