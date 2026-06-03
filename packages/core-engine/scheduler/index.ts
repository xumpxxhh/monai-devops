/**
 * 任务调度器
 * @module scheduler
 */

import { MinHeap } from "../utils/min-heap";

/**
 * 任务定义
 */
export interface Task {
  id: string;
  name: string;
  priority: number;
  execute: () => Promise<unknown>;
  createdAt: Date;
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
}

interface QueueEntry {
  task: Task;
  resolve: (result: ScheduleResult) => void;
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
      error: new Error("Max retry attempts reached"),
    };
  }

  function processQueue(): void {
    while (runningTasks < maxConcurrency && !taskQueue.isEmpty()) {
      const entry = taskQueue.pop()!;
      runningTasks++;

      void executeWithRetry(entry.task, retryAttempts, retryDelay)
        .then(entry.resolve)
        .finally(() => {
          runningTasks--;
          processQueue();
        });
    }
  }

  function scheduleTask(task: Task): Promise<ScheduleResult> {
    const promise = new Promise<ScheduleResult>((resolve) => {
      taskQueue.push({ task, resolve });
      processQueue();
    });
    return promise;
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
    getQueueStatus,
  };
}

export const createScheduler = createTaskScheduler;
