/**
 * Step 级资源调度队列
 * @module resource-scheduler
 */

import { ResourceQueueCancelledError } from '../errors.js';
import type { createResourceManager } from '../resource/index.js';
import { MinHeap } from '../utils/min-heap.js';

export interface ResourceAcquireRequest {
  /** 全局唯一，建议 `${runId}:${stepId}` */
  id: string;
  runId: string;
  resourceType: string;
  priority: number;
  enqueuedAt?: Date;
  /** 进入资源堆时触发（由调用方注入，用于 observer 等） */
  onQueued?: () => void | Promise<void>;
}

export interface ResourceAcquireResult {
  resourceId: string;
  release: () => void;
}

export type ResourceManager = Pick<
  ReturnType<typeof createResourceManager>,
  'hasAvailable' | 'allocateResource' | 'releaseResource'
>;

export interface ResourceStepSchedulerOptions {
  resourceManager: ResourceManager;
}

interface QueueEntry {
  id: string;
  runId: string;
  resourceType: string;
  priority: number;
  enqueuedAt: Date;
  cancelled: boolean;
  onQueued?: () => void | Promise<void>;
  resolve: (result: ResourceAcquireResult) => void;
  reject: (error: Error) => void;
}

function compareQueueEntry(a: QueueEntry, b: QueueEntry): number {
  const byPriority = a.priority - b.priority;
  if (byPriority !== 0) return byPriority;
  return a.enqueuedAt.getTime() - b.enqueuedAt.getTime();
}

export function createResourceStepScheduler(options: ResourceStepSchedulerOptions) {
  const { resourceManager } = options;

  const heaps = new Map<string, MinHeap<QueueEntry>>();
  const pending = new Map<string, QueueEntry>();
  const runningCount = new Map<string, number>();

  function getHeap(resourceType: string): MinHeap<QueueEntry> {
    let heap = heaps.get(resourceType);
    if (!heap) {
      heap = new MinHeap<QueueEntry>(compareQueueEntry);
      heaps.set(resourceType, heap);
    }
    return heap;
  }

  function getRunningCount(resourceType: string): number {
    return runningCount.get(resourceType) ?? 0;
  }

  function processQueue(resourceType: string): void {
    const heap = getHeap(resourceType);

    while (!heap.isEmpty()) {
      const top = heap.peek()!;
      if (top.cancelled) {
        heap.pop();
        pending.delete(top.id);
        top.reject(new ResourceQueueCancelledError());
        continue;
      }

      if (!resourceManager.hasAvailable(resourceType)) {
        break;
      }

      const entry = heap.pop()!;
      const allocated = resourceManager.allocateResource(resourceType);

      if (!allocated) {
        heap.push(entry);
        break;
      }

      pending.delete(entry.id);
      runningCount.set(resourceType, getRunningCount(resourceType) + 1);

      const release = (): void => {
        resourceManager.releaseResource(allocated.id);
        runningCount.set(resourceType, Math.max(0, getRunningCount(resourceType) - 1));
        processQueue(resourceType);
      };

      entry.resolve({
        resourceId: allocated.id,
        release,
      });
    }
  }

  function acquire(req: ResourceAcquireRequest): Promise<ResourceAcquireResult> {
    const enqueuedAt = req.enqueuedAt ?? new Date();

    return new Promise<ResourceAcquireResult>((resolve, reject) => {
      const entry: QueueEntry = {
        id: req.id,
        runId: req.runId,
        resourceType: req.resourceType,
        priority: req.priority,
        enqueuedAt,
        cancelled: false,
        onQueued: req.onQueued,
        resolve,
        reject,
      };

      pending.set(req.id, entry);
      getHeap(req.resourceType).push(entry);

      void Promise.resolve(req.onQueued?.()).finally(() => {
        processQueue(req.resourceType);
      });
    });
  }

  function cancelByRunId(runId: string): number {
    const affectedTypes = new Set<string>();
    let count = 0;

    for (const entry of pending.values()) {
      if (entry.runId === runId && !entry.cancelled) {
        entry.cancelled = true;
        affectedTypes.add(entry.resourceType);
        count++;
      }
    }

    for (const resourceType of affectedTypes) {
      processQueue(resourceType);
    }

    return count;
  }

  function getQueueStatus(resourceType?: string) {
    if (resourceType !== undefined) {
      const heap = heaps.get(resourceType);
      return {
        resourceType,
        queueLength: heap?.size ?? 0,
        runningCount: getRunningCount(resourceType),
      };
    }

    const types = new Set([...heaps.keys(), ...runningCount.keys()]);
    const byType: Record<string, { queueLength: number; runningCount: number }> = {};

    for (const type of types) {
      byType[type] = {
        queueLength: heaps.get(type)?.size ?? 0,
        runningCount: getRunningCount(type),
      };
    }

    return { byType };
  }

  function destroy(): void {
    for (const entry of pending.values()) {
      entry.cancelled = true;
      entry.reject(new ResourceQueueCancelledError('资源调度器已销毁'));
    }
    pending.clear();
    heaps.clear();
    runningCount.clear();
  }

  function notifyResourceAvailable(resourceType: string): void {
    processQueue(resourceType);
  }

  return {
    acquire,
    cancelByRunId,
    getQueueStatus,
    notifyResourceAvailable,
    destroy,
  };
}
