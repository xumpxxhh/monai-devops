/**
 * 比较函数：返回值 < 0 表示 a 优先于 b（更靠近堆顶）
 */
export type CompareFn<T> = (a: T, b: T) => number;

/**
 * 小顶堆：堆顶为 compare 意义下最小的元素
 */
export class MinHeap<T> {
  private readonly heap: T[] = [];

  constructor(private readonly compare: CompareFn<T>) {}

  get size(): number {
    return this.heap.length;
  }

  isEmpty(): boolean {
    return this.heap.length === 0;
  }

  push(value: T): void {
    this.heap.push(value);
    this.bubbleUp(this.heap.length - 1);
  }

  pop(): T | undefined {
    if (this.heap.length === 0) return undefined;
    if (this.heap.length === 1) return this.heap.pop();

    const top = this.heap[0];
    this.heap[0] = this.heap.pop()!;
    this.bubbleDown(0);
    return top;
  }

  peek(): T | undefined {
    return this.heap[0];
  }

  private parent(i: number): number {
    return (i - 1) >> 1;
  }

  private leftChild(i: number): number {
    return (i << 1) + 1;
  }

  private rightChild(i: number): number {
    return (i << 1) + 2;
  }

  private less(i: number, j: number): boolean {
    return this.compare(this.heap[i]!, this.heap[j]!) < 0;
  }

  private bubbleUp(i: number): void {
    while (i > 0) {
      const p = this.parent(i);
      if (!this.less(i, p)) break;
      this.swap(i, p);
      i = p;
    }
  }

  private bubbleDown(i: number): void {
    const n = this.heap.length;
    while (true) {
      const left = this.leftChild(i);
      const right = this.rightChild(i);
      let smallest = i;

      if (left < n && this.less(left, smallest)) smallest = left;
      if (right < n && this.less(right, smallest)) smallest = right;
      if (smallest === i) break;
      this.swap(i, smallest);
      i = smallest;
    }
  }

  private swap(i: number, j: number): void {
    const tmp = this.heap[i]!;
    this.heap[i] = this.heap[j]!;
    this.heap[j] = tmp;
  }
}
