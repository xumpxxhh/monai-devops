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

export type PauseRequestedListener = (options: PauseRunOptions) => void | Promise<void>;
export type ResumeRequestedListener = () => void | Promise<void>;
export type CancelRequestedListener = (options: CancelRunOptions) => void | Promise<void>;

export class RunHandle {
  private status: RunControlStatus = 'running';
  private abortReason: AbortSchedulingReason = 'none';
  private readonly inFlightStepIds = new Set<string>();
  /** 已级联暂停的嵌套 workflow 步骤：不阻塞 pausing → paused */
  private readonly nestedPausedStepIds = new Set<string>();
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
  private pauseAbortInFlight = false;
  private readonly pauseListeners = new Set<PauseRequestedListener>();
  private readonly resumeListeners = new Set<ResumeRequestedListener>();
  private readonly cancelListeners = new Set<CancelRequestedListener>();

  constructor(readonly workflowRunId: string) {
    this.completionPromise = new Promise<void>((resolve) => {
      this.resolveCompletion = resolve;
    });
  }

  /** 订阅 pause 请求（供 workflow 步骤级联到活跃子 run） */
  onPauseRequested(listener: PauseRequestedListener): () => void {
    this.pauseListeners.add(listener);
    return () => {
      this.pauseListeners.delete(listener);
    };
  }

  /** 订阅 resume 请求 */
  onResumeRequested(listener: ResumeRequestedListener): () => void {
    this.resumeListeners.add(listener);
    return () => {
      this.resumeListeners.delete(listener);
    };
  }

  /**
   * 订阅 cancel 请求（级联 cancel 子 run）。
   * 设计文档仅点名 pause/resume 订阅接口；cancel 级联同属 §5.4，故一并提供。
   */
  onCancelRequested(listener: CancelRequestedListener): () => void {
    this.cancelListeners.add(listener);
    return () => {
      this.cancelListeners.delete(listener);
    };
  }

  /** 标记嵌套子 run 已暂停，允许父 run 在步骤仍 in-flight 时进入 paused */
  markNestedPaused(stepId: string): void {
    if (!this.inFlightStepIds.has(stepId)) return;
    this.nestedPausedStepIds.add(stepId);
    this.checkPausingToPaused();
  }

  clearNestedPaused(stepId: string): void {
    this.nestedPausedStepIds.delete(stepId);
  }

  private async notifyListeners<T>(
    listeners: ReadonlySet<(arg: T) => void | Promise<void>>,
    arg: T,
  ): Promise<void> {
    const tasks = [...listeners].map((listener) => Promise.resolve(listener(arg)));
    await Promise.all(tasks);
  }

  private async notifyVoidListeners(
    listeners: ReadonlySet<() => void | Promise<void>>,
  ): Promise<void> {
    const tasks = [...listeners].map((listener) => Promise.resolve(listener()));
    await Promise.all(tasks);
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

  isPauseAbortInFlight(): boolean {
    return this.pauseAbortInFlight;
  }

  isInFlightAbortActive(): boolean {
    return this.cancelMode === 'hard' || this.pauseAbortInFlight;
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
    this.nestedPausedStepIds.delete(stepId);
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
    return this.runControlOp(async () => {
      const previousStatus = this.status;
      if (TERMINAL_STATUSES.has(previousStatus)) {
        return {
          workflowRunId: this.workflowRunId,
          action: 'cancel' as const,
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

      await this.notifyListeners(this.cancelListeners, options);

      return {
        workflowRunId: this.workflowRunId,
        action: 'cancel' as const,
        previousStatus,
        currentStatus: this.status,
        mode: this.cancelMode,
        inFlightSteps: this.getInFlightSteps(),
      };
    });
  }

  requestPause(options: PauseRunOptions = {}): Promise<RunControlResult> {
    const abortInFlight = options.abortInFlight ?? false;
    const waitInFlight = abortInFlight ? true : (options.waitInFlight ?? true);
    return this.runControlOp(async () => {
      const previousStatus = this.status;
      if (TERMINAL_STATUSES.has(previousStatus) || previousStatus === 'cancelling') {
        return {
          workflowRunId: this.workflowRunId,
          action: 'pause' as const,
          previousStatus,
          currentStatus: previousStatus,
          inFlightSteps: this.getInFlightSteps(),
        };
      }
      if (previousStatus === 'paused' || previousStatus === 'pausing') {
        return {
          workflowRunId: this.workflowRunId,
          action: 'pause' as const,
          previousStatus,
          currentStatus: previousStatus,
          inFlightSteps: this.getInFlightSteps(),
        };
      }

      if (abortInFlight) {
        this.pauseAbortInFlight = true;
        for (const controller of this.stepAbortControllers.values()) {
          controller.abort();
        }
      }

      const blockingInFlight = [...this.inFlightStepIds].filter(
        (id) => !this.nestedPausedStepIds.has(id),
      );
      if (waitInFlight && blockingInFlight.length > 0) {
        this.status = 'pausing';
      } else {
        this.status = 'paused';
        this.notifyPaused();
      }

      await this.notifyListeners(this.pauseListeners, options);
      // 级联暂停后子 run 可能已 markNestedPaused，再检查一次 pausing → paused
      this.checkPausingToPaused();

      return {
        workflowRunId: this.workflowRunId,
        action: 'pause' as const,
        previousStatus,
        currentStatus: this.status,
        inFlightSteps: this.getInFlightSteps(),
      };
    });
  }

  requestResume(): Promise<RunControlResult> {
    return this.runControlOp(async () => {
      const previousStatus = this.status;
      if (
        TERMINAL_STATUSES.has(previousStatus) ||
        previousStatus === 'cancelling' ||
        previousStatus === 'running'
      ) {
        return {
          workflowRunId: this.workflowRunId,
          action: 'resume' as const,
          previousStatus,
          currentStatus: previousStatus,
          inFlightSteps: this.getInFlightSteps(),
        };
      }

      this.status = 'running';
      this.pauseAbortInFlight = false;
      const resolvers = this.resumeResolvers;
      this.resumeResolvers = [];
      for (const resolve of resolvers) {
        resolve();
      }

      await this.notifyVoidListeners(this.resumeListeners);

      return {
        workflowRunId: this.workflowRunId,
        action: 'resume' as const,
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
    if (this.status !== 'pausing') return;
    const blocking = [...this.inFlightStepIds].filter((id) => !this.nestedPausedStepIds.has(id));
    if (blocking.length === 0) {
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
