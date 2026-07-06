/**
 * 任务调度器
 * @module scheduler
 */

import { MinHeap } from '../utils/min-heap.js';

/**
 * 任务定义
 */
export interface Task {
  id: string;
  name: string;
  priority: number;
  execute: () => Promise<unknown>;
  createdAt: Date;
  workflowRunId?: string;
}

/**
 * 调度选项
 */
export interface SchedulerOptions {
  maxConcurrency?: number;
  retryAttempts?: number;
  retryDelay?: number;
}

/**
 * 调度结果
 */
export interface ScheduleResult {
  taskId: string;
  success: boolean;
  result?: unknown;
  error?: Error;
  cancelled?: boolean;
}

interface QueueEntry {
  task: Task;
  resolve: (result: ScheduleResult) => void;
  cancelled: boolean;
}

/**
 * 创建任务调度器
 */
export function createTaskScheduler(options: SchedulerOptions = {}) {
  const { maxConcurrency = 5, retryAttempts = 3, retryDelay = 1000 } = options;

  const taskQueue = new MinHeap<QueueEntry>((a, b) => {
    const byPriority = a.task.priority - b.task.priority;
    if (byPriority !== 0) return byPriority;
    return a.task.createdAt.getTime() - b.task.createdAt.getTime();
  });
  const pendingById = new Map<string, QueueEntry>();
  const workflowRunIdToTaskId = new Map<string, string>();
  let runningTasks = 0;

  async function executeWithRetry(
    task: Task,
    attempts: number,
    delay: number,
  ): Promise<ScheduleResult> {
    for (let i = 0; i < attempts; i++) {
      try {
        const result = await task.execute();
        return {
          taskId: task.id,
          success: true,
          result,
        };
      } catch (error) {
        if (i === attempts - 1) {
          return {
            taskId: task.id,
            success: false,
            error: error as Error,
          };
        }
        await new Promise((resolve) => setTimeout(resolve, delay));
      }
    }
    return {
      taskId: task.id,
      success: false,
      error: new Error('Max retry attempts reached'),
    };
  }

  function processQueue(): void {
    while (runningTasks < maxConcurrency && !taskQueue.isEmpty()) {
      const entry = taskQueue.peek();
      if (!entry || entry.cancelled) {
        taskQueue.pop();
        if (entry) {
          pendingById.delete(entry.task.id);
          if (entry.task.workflowRunId) {
            workflowRunIdToTaskId.delete(entry.task.workflowRunId);
          }
          entry.resolve({
            taskId: entry.task.id,
            success: false,
            cancelled: true,
          });
        }
        continue;
      }

      const popped = taskQueue.pop()!;
      pendingById.delete(popped.task.id);
      runningTasks++;

      void executeWithRetry(popped.task, retryAttempts, retryDelay)
        .then((result) => {
          if (popped.task.workflowRunId) {
            workflowRunIdToTaskId.delete(popped.task.workflowRunId);
          }
          popped.resolve(result);
        })
        .finally(() => {
          runningTasks--;
          processQueue();
        });
    }
  }

  function scheduleTask(task: Task): Promise<ScheduleResult> {
    const promise = new Promise<ScheduleResult>((resolve) => {
      const entry: QueueEntry = { task, resolve, cancelled: false };
      pendingById.set(task.id, entry);
      if (task.workflowRunId) {
        workflowRunIdToTaskId.set(task.workflowRunId, task.id);
      }
      taskQueue.push(entry);
      processQueue();
    });
    return promise;
  }

  function cancelScheduledTask(taskId: string): boolean {
    const entry = pendingById.get(taskId);
    if (!entry) return false;
    entry.cancelled = true;
    if (entry.task.workflowRunId) {
      workflowRunIdToTaskId.delete(entry.task.workflowRunId);
    }
    processQueue();
    return true;
  }

  function cancelScheduledTaskByWorkflowRunId(workflowRunId: string): boolean {
    const taskId = workflowRunIdToTaskId.get(workflowRunId);
    if (!taskId) return false;
    return cancelScheduledTask(taskId);
  }

  function getTaskIdByWorkflowRunId(workflowRunId: string): string | undefined {
    return workflowRunIdToTaskId.get(workflowRunId);
  }

  function getQueueStatus() {
    return {
      queueLength: taskQueue.size,
      runningTasks,
      maxConcurrency,
    };
  }

  return {
    scheduleTask,
    cancelScheduledTask,
    cancelScheduledTaskByWorkflowRunId,
    getTaskIdByWorkflowRunId,
    getQueueStatus,
  };
}

export const createScheduler = createTaskScheduler;
