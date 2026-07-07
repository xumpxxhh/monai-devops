/**
 * Step 级资源等待队列
 *
 * 当步骤需要的 resourceType 暂无空闲槽位时，将 acquire 请求挂起并按优先级排队，
 * 直到 resourceManager 释放或新注册资源后通过 notifyResourceAvailable 唤醒。
 *
 * 与 workflow 级 scheduler 的区别：
 * - scheduler：调度整次 workflow 任务（scheduleWorkflow）
 * - 本模块：调度单个 step 对物理资源槽位的 acquire（engine onStepStart 调用）
 *
 * 调度规则（每个 resourceType 独立小顶堆）：
 * - priority 数值越小越优先
 * - 同 priority 按 enqueuedAt FIFO
 *
 * 取消语义：cancel / destroy 仅标记 cancelled，项浮至堆顶时才 reject（惰性删除，见 CE-009）。
 *
 * @module resource/wait-queue
 */

import { ResourceQueueCancelledError } from '../errors.js';
import type { createResourceManager } from './index.js';
import { MinHeap } from '../utils/min-heap.js';

export interface ResourceAcquireRequest {
  /** 全局唯一，engine 使用 `${workflowRunId}:${stepId}` */
  id: string;
  workflowRunId: string;
  resourceType: string;
  /** 越小越优先；来源通常为 step.priority ?? context.priority ?? 0 */
  priority: number;
  /** 测试可注入以固定 FIFO 顺序；生产路径默认 new Date() */
  enqueuedAt?: Date;
  /**
   * 入堆后、尝试分配前触发（engine 用于 step:queued 观察者事件）。
   * processQueue 会 await 其 settle 后再分配，因此 observer 落库可能拖慢 acquire。
   */
  onQueued?: () => void | Promise<void>;
}

export interface ResourceAcquireResult {
  resourceId: string;
  /** 步骤结束时调用；归还资源并唤醒同 type 的下一个等待者 */
  release: () => void;
}

/** 等待队列仅依赖池的分配/释放能力，不耦合 registerResource 等 API */
export type ResourcePoolHandle = Pick<
  ReturnType<typeof createResourceManager>,
  'hasAvailable' | 'allocateResource' | 'releaseResource'
>;

export interface ResourceWaitQueueOptions {
  resourceManager: ResourcePoolHandle;
}

/** 堆内等待项；resolve/reject 在 processQueue 完成分配或取消时触发 */
interface QueueEntry {
  id: string;
  workflowRunId: string;
  resourceType: string;
  priority: number;
  enqueuedAt: Date;
  /** 惰性取消标记：true 时浮至堆顶后 reject，不立即从堆中删除 */
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

export function createResourceWaitQueue(options: ResourceWaitQueueOptions) {
  const { resourceManager } = options;

  /** 按 resourceType 隔离的优先级堆；不同类型互不争抢 */
  const heaps = new Map<string, MinHeap<QueueEntry>>();
  /** id → entry，供 cancelByWorkflowRunId 按 run 扫描（堆本身不支持按 run 删除） */
  const pending = new Map<string, QueueEntry>();
  /**
   * 已 acquire 成功、尚未 release 的计数（按 type）。
   * 与 heap.size 不同：heap 只含「还在等槽位」的项，不含已拿到资源正在执行的 step。
   */
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

  /**
   * 尝试从堆顶开始连续分配，直到无可用资源或堆空。
   *
   * 调用时机：acquire 入堆后、release 归还后、registerResource 触发 notify、cancel 标记后。
   */
  function processQueue(resourceType: string): void {
    const heap = getHeap(resourceType);

    while (!heap.isEmpty()) {
      const top = heap.peek()!;

      // 惰性取消：仅当 cancelled 项成为堆顶时才 pop 并 reject，避免 O(n) 堆内删除
      if (top.cancelled) {
        heap.pop();
        pending.delete(top.id);
        top.reject(new ResourceQueueCancelledError());
        continue;
      }

      // 池内该 type 无 available 槽位，后续堆项同样无法分配，停止本轮
      if (!resourceManager.hasAvailable(resourceType)) {
        break;
      }

      const entry = heap.pop()!;
      const allocated = resourceManager.allocateResource(resourceType);

      // hasAvailable 与 allocate 之间可能有并发释放/占用，分配失败则原样压回堆顶并结束
      if (!allocated) {
        heap.push(entry);
        break;
      }

      pending.delete(entry.id);
      runningCount.set(resourceType, getRunningCount(resourceType) + 1);

      const release = (): void => {
        resourceManager.releaseResource(allocated.id);
        runningCount.set(resourceType, Math.max(0, getRunningCount(resourceType) - 1));
        // 归还后立即尝试唤醒下一个等待者
        processQueue(resourceType);
      };

      entry.resolve({
        resourceId: allocated.id,
        release,
      });
    }
  }

  /**
   * 请求占用一个 resourceType 槽位。
   *
   * 有槽位时 Promise 尽快 resolve；无槽位时挂起直至 release / register 唤醒。
   * 失败路径：cancelByWorkflowRunId / destroy → ResourceQueueCancelledError。
   */
  function acquire(req: ResourceAcquireRequest): Promise<ResourceAcquireResult> {
    const enqueuedAt = req.enqueuedAt ?? new Date();

    return new Promise<ResourceAcquireResult>((resolve, reject) => {
      const entry: QueueEntry = {
        id: req.id,
        workflowRunId: req.workflowRunId,
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

      // 先完成 onQueued（如 observer 落库），再尝试分配；即使随后立即可用也会先触发 onQueued（CE-008）
      void Promise.resolve(req.onQueued?.()).finally(() => {
        processQueue(req.resourceType);
      });
    });
  }

  /**
   * 取消指定 run 下所有仍在堆中等待的 acquire（不含已 resolve、持有资源的 step）。
   * 返回被取消的排队项数量；engine 在 failFast / cancelRun 时调用。
   */
  function cancelByWorkflowRunId(workflowRunId: string): number {
    const affectedTypes = new Set<string>();
    let count = 0;

    for (const entry of pending.values()) {
      if (entry.workflowRunId === workflowRunId && !entry.cancelled) {
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
        // 含已 cancelled 但未浮至堆顶的项（CE-009）
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

  /** 拒绝所有 pending acquire；engine.destroy 时调用 */
  function destroy(): void {
    for (const entry of pending.values()) {
      entry.cancelled = true;
      entry.reject(new ResourceQueueCancelledError('资源等待队列已销毁'));
    }
    pending.clear();
    heaps.clear();
    runningCount.clear();
  }

  /** 由 resourceManager.onResourceAvailable 回调触发，尝试分配等待中的 step */
  function notifyResourceAvailable(resourceType: string): void {
    processQueue(resourceType);
  }

  return {
    acquire,
    cancelByWorkflowRunId,
    getQueueStatus,
    notifyResourceAvailable,
    destroy,
  };
}
