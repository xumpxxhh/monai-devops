/**
 * 单 Run 控制态
 * @module executor/run-handle
 */

import type { WorkflowRunMeta } from '../observer/index.js';
import type {
  AbortSchedulingReason,
  CancelRunOptions,
  PauseRunOptions,
  RunControlMode,
  RunControlResult,
  RunControlStatus,
  RunStatusSnapshot,
} from './types.js';

const TERMINAL_STATUSES: ReadonlySet<RunControlStatus> = new Set([
  'cancelled',
  'finished',
  'failed',
]);

export class RunHandle {
  private status: RunControlStatus = 'running';
  private abortReason: AbortSchedulingReason = 'none';
  private readonly inFlightStepIds = new Set<string>();
  private totalSteps = 0;
  private completedSteps = 0;
  private runMeta: WorkflowRunMeta | undefined;
  private resumeResolvers: Array<() => void> = [];
  private pausedWaiters: Array<() => void> = [];
  private readonly completionPromise: Promise<void>;
  private resolveCompletion!: () => void;
  private controlChain: Promise<void> = Promise.resolve();
  private stepAbortControllers = new Map<string, AbortController>();
  private cancelMode: RunControlMode = 'best-effort';

  constructor(readonly workflowRunId: string) {
    this.completionPromise = new Promise<void>((resolve) => {
      this.resolveCompletion = resolve;
    });
  }

  setRunMeta(meta: WorkflowRunMeta): void {
    this.runMeta = meta;
  }

  getRunMeta(): WorkflowRunMeta | undefined {
    return this.runMeta;
  }

  setTotalSteps(total: number): void {
    this.totalSteps = total;
  }

  incrementCompleted(): void {
    this.completedSteps += 1;
  }

  getStatus(): RunControlStatus {
    return this.status;
  }

  getAbortReason(): AbortSchedulingReason {
    return this.abortReason;
  }

  getCancelMode(): RunControlMode {
    return this.cancelMode;
  }

  getSnapshot(): RunStatusSnapshot {
    return {
      workflowRunId: this.workflowRunId,
      status: this.status,
      inFlightSteps: [...this.inFlightStepIds],
      progress:
        this.totalSteps > 0
          ? { completed: this.completedSteps, total: this.totalSteps }
          : undefined,
    };
  }

  trackInFlight(stepId: string): AbortSignal | undefined {
    this.inFlightStepIds.add(stepId);
    const controller = new AbortController();
    this.stepAbortControllers.set(stepId, controller);
    return controller.signal;
  }

  untrackInFlight(stepId: string): void {
    this.inFlightStepIds.delete(stepId);
    this.stepAbortControllers.delete(stepId);
  }

  getInFlightSteps(): string[] {
    return [...this.inFlightStepIds];
  }

  shouldStopScheduling(): boolean {
    return this.abortReason !== 'none';
  }

  isPaused(): boolean {
    return this.status === 'paused';
  }

  isPausing(): boolean {
    return this.status === 'pausing';
  }

  async waitUntilResumed(): Promise<void> {
    if (!this.isPaused()) return;
    await new Promise<void>((resolve) => {
      this.resumeResolvers.push(resolve);
    });
  }

  private runControlOp<T>(fn: () => T | Promise<T>): Promise<T> {
    const result = this.controlChain.then(fn);
    this.controlChain = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }

  private unblockWaiters(): void {
    const resolvers = this.resumeResolvers;
    this.resumeResolvers = [];
    for (const resolve of resolvers) {
      resolve();
    }
  }

  requestCancel(options: CancelRunOptions = {}): Promise<RunControlResult> {
    return this.runControlOp(() => {
      const previousStatus = this.status;
      if (TERMINAL_STATUSES.has(previousStatus)) {
        return {
          workflowRunId: this.workflowRunId,
          action: 'cancel',
          previousStatus,
          currentStatus: previousStatus,
          mode: options.mode ?? 'best-effort',
          inFlightSteps: this.getInFlightSteps(),
        };
      }

      this.cancelMode = options.mode ?? 'best-effort';
      this.abortReason = 'user_cancel';
      if (previousStatus !== 'cancelling') {
        this.status = 'cancelling';
      }
      this.unblockWaiters();

      if (this.cancelMode === 'hard') {
        for (const controller of this.stepAbortControllers.values()) {
          controller.abort();
        }
      }

      return {
        workflowRunId: this.workflowRunId,
        action: 'cancel',
        previousStatus,
        currentStatus: this.status,
        mode: this.cancelMode,
        inFlightSteps: this.getInFlightSteps(),
      };
    });
  }

  requestPause(options: PauseRunOptions = {}): Promise<RunControlResult> {
    const waitInFlight = options.waitInFlight ?? true;
    return this.runControlOp(() => {
      const previousStatus = this.status;
      if (TERMINAL_STATUSES.has(previousStatus) || previousStatus === 'cancelling') {
        return {
          workflowRunId: this.workflowRunId,
          action: 'pause',
          previousStatus,
          currentStatus: previousStatus,
          inFlightSteps: this.getInFlightSteps(),
        };
      }
      if (previousStatus === 'paused' || previousStatus === 'pausing') {
        return {
          workflowRunId: this.workflowRunId,
          action: 'pause',
          previousStatus,
          currentStatus: previousStatus,
          inFlightSteps: this.getInFlightSteps(),
        };
      }

      if (waitInFlight && this.inFlightStepIds.size > 0) {
        this.status = 'pausing';
      } else {
        this.status = 'paused';
        this.notifyPaused();
      }

      return {
        workflowRunId: this.workflowRunId,
        action: 'pause',
        previousStatus,
        currentStatus: this.status,
        inFlightSteps: this.getInFlightSteps(),
      };
    });
  }

  requestResume(): Promise<RunControlResult> {
    return this.runControlOp(() => {
      const previousStatus = this.status;
      if (
        TERMINAL_STATUSES.has(previousStatus) ||
        previousStatus === 'cancelling' ||
        previousStatus === 'running'
      ) {
        return {
          workflowRunId: this.workflowRunId,
          action: 'resume',
          previousStatus,
          currentStatus: previousStatus,
          inFlightSteps: this.getInFlightSteps(),
        };
      }

      this.status = 'running';
      const resolvers = this.resumeResolvers;
      this.resumeResolvers = [];
      for (const resolve of resolvers) {
        resolve();
      }

      return {
        workflowRunId: this.workflowRunId,
        action: 'resume',
        previousStatus,
        currentStatus: this.status,
        inFlightSteps: this.getInFlightSteps(),
      };
    });
  }

  requestDestroy(): Promise<RunControlResult> {
    return this.runControlOp(() => {
      const previousStatus = this.status;
      if (TERMINAL_STATUSES.has(previousStatus)) {
        return {
          workflowRunId: this.workflowRunId,
          action: 'cancel',
          previousStatus,
          currentStatus: previousStatus,
          mode: 'best-effort',
          inFlightSteps: this.getInFlightSteps(),
        };
      }

      this.abortReason = 'destroy';
      this.status = 'cancelling';
      this.unblockWaiters();
      for (const controller of this.stepAbortControllers.values()) {
        controller.abort();
      }

      return {
        workflowRunId: this.workflowRunId,
        action: 'cancel',
        previousStatus,
        currentStatus: this.status,
        mode: 'best-effort',
        inFlightSteps: this.getInFlightSteps(),
      };
    });
  }

  setFailFastAbort(): void {
    if (this.abortReason === 'none') {
      this.abortReason = 'fail_fast';
    }
  }

  private notifyPaused(): void {
    const waiters = this.pausedWaiters;
    this.pausedWaiters = [];
    for (const resolve of waiters) {
      resolve();
    }
  }

  waitForPaused(): Promise<void> {
    if (this.isPaused()) return Promise.resolve();
    return new Promise<void>((resolve) => {
      this.pausedWaiters.push(resolve);
    });
  }

  checkPausingToPaused(): void {
    if (this.status === 'pausing' && this.inFlightStepIds.size === 0) {
      this.status = 'paused';
      this.notifyPaused();
    }
  }

  setTerminalStatus(status: 'finished' | 'failed' | 'cancelled'): void {
    this.status = status;
    this.unblockWaiters();
    this.resolveCompletion();
  }

  awaitCompletion(): Promise<void> {
    return this.completionPromise;
  }
}
