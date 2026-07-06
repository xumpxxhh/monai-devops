/**
 * 活跃 Run 注册表
 * @module executor/run-registry
 */

import { RunAlreadyActiveError } from '../errors.js';
import { RunHandle } from './run-handle.js';
import type { RunControlStatus, RunStatusSnapshot } from './types.js';

export class RunRegistry {
  private readonly active = new Map<string, RunHandle>();
  private readonly terminalCache = new Map<string, RunControlStatus>();

  register(workflowRunId: string): RunHandle {
    if (this.active.has(workflowRunId)) {
      throw new RunAlreadyActiveError(workflowRunId);
    }
    const handle = new RunHandle(workflowRunId);
    this.active.set(workflowRunId, handle);
    return handle;
  }

  get(workflowRunId: string): RunHandle | undefined {
    return this.active.get(workflowRunId);
  }

  unregister(workflowRunId: string): void {
    const handle = this.active.get(workflowRunId);
    if (handle) {
      const status = handle.getStatus();
      if (status === 'finished' || status === 'failed' || status === 'cancelled') {
        this.terminalCache.set(workflowRunId, status);
      }
      this.active.delete(workflowRunId);
    }
  }

  getStatus(workflowRunId: string): RunStatusSnapshot | undefined {
    const handle = this.active.get(workflowRunId);
    if (handle) {
      return handle.getSnapshot();
    }
    const cached = this.terminalCache.get(workflowRunId);
    if (cached) {
      return {
        workflowRunId,
        status: cached,
        inFlightSteps: [],
      };
    }
    return undefined;
  }

  getAllActive(): RunHandle[] {
    return [...this.active.values()];
  }

  async destroyAll(): Promise<void> {
    const handles = this.getAllActive();
    await Promise.all(
      handles.map(async (handle) => {
        const result = await handle.requestDestroy();
        if (result.currentStatus === 'cancelling') {
          void result;
        }
      }),
    );
    await Promise.all(handles.map((h) => h.awaitCompletion()));
  }
}
