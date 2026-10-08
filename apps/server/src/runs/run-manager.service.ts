import { randomUUID } from 'node:crypto';
import {
  HttpException,
  HttpStatus,
  Inject,
  Injectable,
  Logger,
  OnModuleDestroy,
  OnModuleInit,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  getAbortSignal,
  PluginContextKeys,
  PluginFailureCodes,
  type PluginConfig,
  type PluginContext,
  type PluginResult,
} from '@monai-devops/plugin-sdk';
import {
  AttemptStatuses,
  EXECUTOR_PROTOCOL_VERSION,
  WorkflowSuspendedError,
  defaultStateFromSchema,
  isPluginStep,
  parseState,
  resolveRetryPolicy,
  SkipReasons,
  shouldRetryExecution,
  StepStatuses,
  WorkflowRunIdValidationError,
  WorkflowValidationError,
  type WorkflowDefinition,
  type ExecutionIdentity,
  type ExecutorJsonObject,
  type ExecutionCheckpoint,
  type ExecutionWakeCondition,
  type PluginStep,
  type WorkflowLifecycleEvent,
  type WorkflowRunResult,
  type WorkflowResumeSnapshot,
  type WorkflowStep,
} from '@monai-devops/core-engine';
import {
  serializeWorkflowEvent,
  serializeWorkflowRunResult,
  runStatusFromWorkflowResult,
  type SerializedWorkflowLifecycleEvent,
} from '../common/serialization/serialize-workflow-event.js';
import {
  normalizeWorkflowIds,
  type WorkflowDraft,
} from '../common/validation/normalize-workflow-ids.js';
import { EngineService } from '../engine/engine.service.js';
import { RunStreamService } from './run-stream.service.js';
import {
  type RunCounts,
  type RunRecord,
  type RunRepository,
  RUN_REPOSITORY,
} from './runs.repository.js';
import type { RunStatusSnapshot } from '@monai-devops/core-engine';
import {
  EXECUTION_REPOSITORY,
  type ExecutionRepository,
} from '../execution/execution.repository.js';
import { ExecutionLeaseService } from '../execution/execution-lease.service.js';
import { ExecutionControlService } from '../execution/execution-control.service.js';
import {
  authorizeExecutorCapabilities,
  ExecutorCapabilityDeniedError,
} from '../execution/executor-capability-policy.js';
import { resolveExecutorAttemptDeadlineMs } from '../execution/executor-deadline-policy.js';
import { buildRunRecoverySnapshot, RunRecoveryNotReadyError } from './run-recovery-snapshot.js';

export interface SubmitRunOptions {
  priority?: number;
  traceId?: string;
  failFast?: boolean;
  maxParallelSteps?: number;
  initialState?: unknown;
}

export interface CancelRunOptions {
  mode?: 'best-effort' | 'hard';
}

export interface PauseRunOptions {
  waitInFlight?: boolean;
  abortInFlight?: boolean;
}

const TERMINAL_RUN_STATUSES: RunRecord['status'][] = [
  'finished',
  'failed',
  'rejected',
  'cancelled',
];

const NON_DELETABLE_STATUSES: RunRecord['status'][] = [
  'queued',
  'running',
  'waiting',
  'paused',
  'pausing',
];

function mergeEngineControlStatus(record: RunRecord, engine?: RunStatusSnapshot): RunRecord {
  if (!engine || engine.status === 'unknown') {
    return record;
  }

  if (engine.status === 'cancelling') {
    return { ...record, status: 'running', cancelled: 'best-effort' };
  }

  if (engine.status === 'running' || engine.status === 'pausing' || engine.status === 'paused') {
    return { ...record, status: engine.status };
  }

  if (engine.status === 'cancelled' || engine.status === 'finished' || engine.status === 'failed') {
    const statusMap: Record<string, RunRecord['status']> = {
      cancelled: 'cancelled',
      finished: 'finished',
      failed: 'failed',
    };
    return {
      ...record,
      status: statusMap[engine.status] ?? record.status,
      ...(engine.status === 'cancelled' ? { cancelled: 'best-effort' as const } : {}),
    };
  }

  return record;
}

@Injectable()
export class RunManagerService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(RunManagerService.name);
  private readonly eventChains = new Map<string, Promise<void>>();
  /** 仅处理本服务 submit/save 过的顶层 run，避免直连引擎的旁路调用误打仓储 */
  private readonly managedRunIds = new Set<string>();
  /** 即使失去 lease 也保留至本地执行退出，确保后续步骤不能绕过授权。 */
  private readonly fencedRunIds = new Set<string>();
  /** 嵌入子执行 childRunId → 顶层 API runId；子 run 不落表，事件写入并推流到 root */
  private readonly childRootRunIds = new Map<string, string>();
  private readonly runLeases = new Map<
    string,
    { token: string; timer: ReturnType<typeof setInterval> }
  >();
  private readonly runLeaseOwner: string;
  private readonly runLeaseTtlMs: number;

  constructor(
    private readonly engineService: EngineService,
    @Inject(RUN_REPOSITORY) private readonly runRepository: RunRepository,
    private readonly runStream: RunStreamService,
    private readonly config: ConfigService,
    @Inject(EXECUTION_REPOSITORY) private readonly executionRepository: ExecutionRepository,
    private readonly executionLeases: ExecutionLeaseService,
    private readonly executionControls: ExecutionControlService,
  ) {
    this.runLeaseOwner =
      config.get<string>('EXECUTOR_ID', `server-${process.pid}`) ?? `server-${process.pid}`;
    this.runLeaseTtlMs = Math.max(3_000, config.get<number>('RUN_LEASE_TTL_MS', 30_000) ?? 30_000);
  }

  onModuleDestroy(): void {
    for (const lease of this.runLeases.values()) clearInterval(lease.timer);
    this.runLeases.clear();
    this.managedRunIds.clear();
  }

  private async acquireRunLease(runId: string): Promise<boolean> {
    const token = randomUUID();
    const acquired = await this.runRepository.acquireRunLease(
      runId,
      this.runLeaseOwner,
      token,
      new Date(Date.now() + this.runLeaseTtlMs),
    );
    if (!acquired) return false;
    const timer = setInterval(
      () => {
        void this.heartbeatRunLease(runId, token);
      },
      Math.max(1_000, Math.floor(this.runLeaseTtlMs / 3)),
    );
    timer.unref?.();
    this.runLeases.set(runId, { token, timer });
    return true;
  }

  private async heartbeatRunLease(runId: string, token: string): Promise<boolean> {
    try {
      const renewed = await this.runRepository.heartbeatRunLease(
        runId,
        token,
        new Date(Date.now() + this.runLeaseTtlMs),
      );
      if (!renewed) {
        this.stopRunLease(runId, token);
        this.managedRunIds.delete(runId);
        this.logger.warn(`Run lease lost: ${runId}`);
        void Promise.resolve(this.engineService.cancelRun(runId, 'hard')).catch(
          (error: unknown) => {
            const message = error instanceof Error ? error.message : String(error);
            this.logger.error(`Failed to stop Run after lease loss ${runId}: ${message}`);
          },
        );
      }
      return renewed;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.logger.error(`Run lease heartbeat failed for ${runId}: ${message}`);
      return false;
    }
  }

  private stopRunLease(runId: string, token: string): void {
    const lease = this.runLeases.get(runId);
    if (!lease || lease.token !== token) return;
    clearInterval(lease.timer);
    this.runLeases.delete(runId);
  }

  private async releaseRunLease(runId: string): Promise<void> {
    const lease = this.runLeases.get(runId);
    if (!lease) return;
    this.stopRunLease(runId, lease.token);
    await this.runRepository.releaseRunLease(runId, lease.token);
  }

  onModuleInit(): void {
    this.executionControls.setResumePersistedRun?.((runId) => this.resumePersistedRun(runId));
    // 不向引擎回传 Promise：持久化串行在 eventChains 内完成，避免 DB 延迟/失败阻塞 core-engine
    this.engineService.onEvent((event) => {
      void this.enqueueEngineEvent(event);
    });
    this.engineService.setEmbeddedRunHooks({
      onChildRunStart: (childRunId, childDefinition, ctx) =>
        this.onChildRunStart(childRunId, childDefinition, ctx),
      onChildRunFinished: (childRunId, result) => this.onChildRunFinished(childRunId, result),
    });
    this.engineService.setBeforeStepExecute((step, context) =>
      this.authorizeStepExecution(step, context.runId, context.execution),
    );
    this.engineService.setOnStepWait?.((step, context, checkpoint, condition) =>
      this.registerStepWait(step, context.runId, context.execution, checkpoint, condition),
    );
    this.engineService.setPluginExecutionOverride?.((name, config, context) =>
      this.executeRemoteTestPlugin(name, config, context),
    );
  }

  private remoteTestEnabled(): boolean {
    const enabled = this.config.get<string | boolean>('EXECUTOR_REMOTE_TEST_ENABLED');
    const environment = this.config.get<string>('APP_ENV');
    const workerToken = this.config.get<string>('EXECUTOR_WORKER_HTTP_TOKEN');
    const workerIdentities = this.config.get<string>('EXECUTOR_WORKER_IDENTITIES_JSON');
    return (
      (enabled === true || enabled === 'true') &&
      ((typeof workerToken === 'string' && workerToken.length >= 32) ||
        (typeof workerIdentities === 'string' && workerIdentities.trim().length > 0)) &&
      environment !== 'production' &&
      process.env.NODE_ENV !== 'production'
    );
  }

  private isRemoteStep(step: WorkflowStep, runId: string): boolean {
    return (
      this.remoteTestEnabled() &&
      this.fencedRunIds.has(runId) &&
      isPluginStep(step) &&
      step.plugin === 'test-plugin'
    );
  }

  private async executeRemoteTestPlugin(
    name: string,
    config: PluginConfig,
    context: PluginContext,
  ): Promise<PluginResult | undefined> {
    const runId = context.runId;
    const execution = context.execution as ExecutionIdentity | undefined;
    if (
      name !== 'test-plugin' ||
      typeof runId !== 'string' ||
      !this.managedRunIds.has(runId) ||
      !this.fencedRunIds.has(runId) ||
      !this.remoteTestEnabled()
    ) {
      return undefined;
    }
    if (
      !execution ||
      typeof context.workflowId !== 'string' ||
      typeof context.stepId !== 'string'
    ) {
      throw new Error('Remote test execution identity unavailable');
    }
    const signal = getAbortSignal(context);
    await (this.eventChains.get(runId) ?? Promise.resolve());
    const runLease = this.runLeases.get(runId);
    if (!signal || !runLease || !(await this.heartbeatRunLease(runId, runLease.token))) {
      throw new Error(`Run lease or cancellation signal unavailable for remote step: ${runId}`);
    }
    const plugin = this.engineService.getPlugin(name);
    if (!plugin) throw new Error(`Remote test plugin unavailable: ${name}`);
    if (typeof config.type !== 'string') throw new Error('Remote test plugin type is invalid');
    const run = await this.runRepository.findById(runId);
    const step = run?.workflowSnapshot.steps.find((candidate) => candidate.id === context.stepId);
    if (!step || !isPluginStep(step) || step.plugin !== name) {
      throw new Error(`Remote test step snapshot unavailable: ${context.stepId}`);
    }
    const mayWait = step.mayWait === true;
    if (mayWait && resolveRetryPolicy(step.retryPolicy).maxAttempts < 2) {
      throw new Error('Remote wait requires retryPolicy.maxAttempts >= 2');
    }
    let requiredCapabilities: string[];
    try {
      requiredCapabilities = authorizeExecutorCapabilities(
        plugin,
        step,
        this.config.get<string>('EXECUTOR_ALLOWED_CAPABILITIES') ?? '',
      );
    } catch (error) {
      if (error instanceof ExecutorCapabilityDeniedError) {
        this.logger.warn(
          `Run ${runId} step ${step.id} ${error.code}: ${error.capability} (${error.boundary})`,
        );
        return {
          success: false,
          code: PluginFailureCodes.PLUGIN_CONFIG_INVALID,
          message: error.message,
        };
      }
      throw error;
    }
    const remoteContext = JSON.parse(
      JSON.stringify({
        ...(context[PluginContextKeys.checkpoint] !== undefined
          ? { [PluginContextKeys.checkpoint]: context[PluginContextKeys.checkpoint] }
          : {}),
        ...(context[PluginContextKeys.wakePayload] !== undefined
          ? { [PluginContextKeys.wakePayload]: context[PluginContextKeys.wakePayload] }
          : {}),
      }),
    ) as ExecutorJsonObject;
    const dispatch = {
      protocolVersion: EXECUTOR_PROTOCOL_VERSION,
      runId,
      workflowId: context.workflowId,
      stepId: context.stepId,
      execution,
      plugin: { name, version: plugin.version },
      idempotencyKey: execution.jobId,
      policyVersion: 'experimental-test-v2',
      deadlineAt: new Date(
        Date.now() +
          resolveExecutorAttemptDeadlineMs(this.config.get<string>('EXECUTOR_ATTEMPT_DEADLINE_MS')),
      ).toISOString(),
      requiredCapabilities,
      input: { config: { type: config.type }, context: remoteContext },
    };
    if (!(await this.executionRepository.registerWorkerDispatch(dispatch, runLease.token))) {
      throw new Error(`Remote dispatch registration failed: ${execution.attemptId}`);
    }
    let cancellation: Promise<boolean> | undefined;
    const onAbort = () => {
      cancellation ??= this.executionRepository.cancelWorkerAttempt(
        execution,
        runId,
        runLease.token,
      );
    };
    signal.addEventListener('abort', onAbort, { once: true });
    if (signal.aborted) onAbort();
    try {
      const terminal = await this.executionLeases.awaitWorkerTerminal(
        execution,
        runId,
        runLease.token,
        signal,
      );
      await this.projectWorkerLogsForRun(runId, runLease.token);
      return terminal.result;
    } finally {
      signal.removeEventListener('abort', onAbort);
      if (cancellation) await cancellation;
    }
  }

  private async projectWorkerLogsForRun(runId: string, runLeaseToken: string): Promise<void> {
    await (this.eventChains.get(runId) ?? Promise.resolve());
    if (!(await this.heartbeatRunLease(runId, runLeaseToken))) return;
    const receipts = await this.executionRepository.listWorkerLogsForRun(runId);
    if (receipts.length === 0) return;
    const run = await this.runRepository.findById(runId);
    if (!run) return;
    const events = [...run.events];
    for (const receipt of receipts) {
      if (
        events.some(
          (event) =>
            event.workerAttemptId === receipt.attemptId &&
            typeof event.workerSequence === 'number' &&
            receipt.sequence >= event.workerSequence &&
            receipt.sequence <=
              (typeof event.sequenceEnd === 'number' ? event.sequenceEnd : event.workerSequence),
        )
      )
        continue;
      const step = run.workflowSnapshot.steps.find((candidate) => candidate.id === receipt.stepId);
      if (!step) continue;
      const event: SerializedWorkflowLifecycleEvent = {
        type: 'plugin:log',
        workflowRunId: runId,
        meta: { workflowId: run.workflowId, ...(run.traceId ? { traceId: run.traceId } : {}) },
        step,
        log: receipt.log,
        workerAttemptId: receipt.attemptId,
        workerSequence: receipt.sequence,
        sequence: receipt.sequence,
      };
      const offset = await this.runRepository.appendEvent(runId, event);
      const persisted = offset === undefined ? event : { ...event, offset };
      events.push(persisted);
      this.runStream.fanOut(runId, { type: 'event', event: persisted });
    }
  }

  private async registerStepWait(
    step: PluginStep,
    runId: unknown,
    execution: ExecutionIdentity | undefined,
    checkpoint: ExecutionCheckpoint,
    condition: ExecutionWakeCondition,
  ): Promise<void> {
    if (typeof runId !== 'string' || !execution || !this.managedRunIds.has(runId)) {
      throw new Error(`Run is not managed for waiting step ${step.id}`);
    }
    await (this.eventChains.get(runId) ?? Promise.resolve());
    const runLease = this.runLeases.get(runId);
    if (!runLease || !(await this.heartbeatRunLease(runId, runLease.token))) {
      throw new Error(`Run lease unavailable before waiting: ${runId}`);
    }
    await this.executionLeases.registerWait(execution, checkpoint, condition);
  }

  private async authorizeStepExecution(
    step: WorkflowStep,
    runId: unknown,
    execution: ExecutionIdentity | undefined,
  ): Promise<void> {
    if (typeof runId !== 'string' || !execution || !this.fencedRunIds.has(runId)) return;
    const runLease = this.runLeases.get(runId);
    if (!runLease || !(await this.heartbeatRunLease(runId, runLease.token))) {
      throw new Error(`Run lease unavailable: ${runId}`);
    }
    await this.executionRepository.ensureJob({
      execution,
      runId,
      stepId: step.id,
      idempotencyKey: execution.jobId,
      retryPolicy: resolveRetryPolicy(step.retryPolicy),
    });
    await this.executionRepository.ensureAttempt(execution);
    if (this.isRemoteStep(step, runId)) return;
    await this.executionLeases.start(execution);
    await this.executionRepository.setJobStatus(execution.jobId, AttemptStatuses.RUNNING);
  }

  /** 将嵌入子事件解析到应持久化/推流的顶层 runId */
  private resolvePersistRunId(event: WorkflowLifecycleEvent): string {
    const mapped = this.childRootRunIds.get(event.workflowRunId);
    if (mapped) return mapped;
    if (event.parent) {
      return this.childRootRunIds.get(event.parent.runId) ?? event.parent.runId;
    }
    return event.workflowRunId;
  }

  private isNestedEngineEvent(event: WorkflowLifecycleEvent): boolean {
    return this.childRootRunIds.has(event.workflowRunId) || Boolean(event.parent);
  }

  private clearChildMappingsForRoot(rootRunId: string): void {
    for (const [childId, root] of this.childRootRunIds) {
      if (root === rootRunId) {
        this.childRootRunIds.delete(childId);
      }
    }
  }

  private enqueueEngineEvent(event: WorkflowLifecycleEvent): Promise<void> {
    const persistRunId = this.resolvePersistRunId(event);
    if (!this.managedRunIds.has(persistRunId)) {
      return Promise.resolve();
    }

    const previous = this.eventChains.get(persistRunId) ?? Promise.resolve();
    const current = previous
      .then(() => this.processEngineEvent(event))
      .catch((error: unknown) => {
        const message = error instanceof Error ? error.message : 'Unknown error';
        this.logger.error(`Failed to process ${event.type} for run ${persistRunId}: ${message}`);
      })
      .finally(() => {
        if (this.eventChains.get(persistRunId) === current) {
          this.eventChains.delete(persistRunId);
        }
      });
    this.eventChains.set(persistRunId, current);
    return current;
  }

  async submitRun(workflow: WorkflowDefinition | WorkflowDraft, options: SubmitRunOptions = {}) {
    const maxActiveRuns = this.config.get<number>('MAX_ACTIVE_RUNS', 50);
    const activeCount = await this.runRepository.countActive();
    if (activeCount >= maxActiveRuns) {
      throw new HttpException(
        {
          statusCode: HttpStatus.TOO_MANY_REQUESTS,
          message: `活跃 Run 数已达上限 (${maxActiveRuns})`,
          error: 'TooManyRequests',
          code: 'MAX_ACTIVE_RUNS_EXCEEDED',
        },
        HttpStatus.TOO_MANY_REQUESTS,
      );
    }

    const knownStepIds = new Set(
      workflow.steps.map((step) => step.id?.trim()).filter((id): id is string => Boolean(id)),
    );
    const normalized = normalizeWorkflowIds(workflow, {
      ...(workflow.id?.trim() ? { workflowId: workflow.id.trim() } : {}),
      ...(knownStepIds.size > 0 ? { knownStepIds } : {}),
    });

    try {
      await this.engineService.validateWorkflow(normalized);
    } catch (error) {
      if (error instanceof WorkflowValidationError) {
        throw error;
      }
      throw error;
    }

    if (options.initialState !== undefined) {
      if (normalized.stateSchema === undefined) {
        throw new WorkflowValidationError(
          `工作流 "${normalized.id}" 未声明 stateSchema，不允许传入 initialState`,
        );
      }
      const parsed = parseState(normalized.stateSchema, options.initialState);
      if (!parsed.success) {
        throw new WorkflowValidationError(`initialState 不符合 stateSchema：${parsed.message}`);
      }
    }

    const runId = randomUUID();
    const traceId = options.traceId ?? randomUUID();

    const record: RunRecord = {
      runId,
      workflowId: normalized.id,
      workflowSnapshot: structuredClone(normalized),
      status: 'queued',
      traceId,
      counts: this.initialCounts(normalized),
      createdAt: new Date(),
      events: [],
      source: 'api',
      metadata: {},
    };

    const recoveryState =
      normalized.stateSchema === undefined
        ? undefined
        : options.initialState !== undefined
          ? options.initialState
          : defaultStateFromSchema(normalized.stateSchema);
    await this.runRepository.save(record, recoveryState);
    this.managedRunIds.add(runId);
    this.fencedRunIds.add(runId);
    this.logger.log(`Run ${runId} queued (workflow=${normalized.id}, traceId=${traceId})`);

    void this.executeRun(runId, normalized, {
      traceId,
      priority: options.priority,
      initialState: options.initialState,
    }).catch((error: unknown) => {
      const message = error instanceof Error ? error.message : String(error);
      this.logger.error(`Run ${runId} dispatch failed: ${message}`);
    });

    return { runId, status: 'queued' as const };
  }

  async getRun(runId: string): Promise<RunRecord | undefined> {
    const record = await this.runRepository.findById(runId);
    if (!record) return undefined;
    const engineStatus = this.engineService.getRunStatus(runId);
    return mergeEngineControlStatus(record, engineStatus);
  }

  /** 仅读取并校验恢复输入；不获得 Run 执行权，也不启动工作流。 */
  async loadRecoverySnapshot(runId: string): Promise<WorkflowResumeSnapshot> {
    const run = await this.runRepository.findById(runId);
    if (!run) throw new RunRecoveryNotReadyError(`Run ${runId} 不存在`);
    const jobs = await this.executionRepository.listJobsForRun(runId);
    const initialState = await this.runRepository.getRecoveryState(runId);
    return buildRunRecoverySnapshot(run, jobs, initialState);
  }

  async listRuns(filter: Parameters<RunRepository['list']>[0]) {
    return this.runRepository.list(filter);
  }

  async getEvents(runId: string): Promise<RunRecord['events'] | undefined> {
    const record = await this.runRepository.findById(runId);
    return record?.events;
  }

  /**
   * 子工作流执行不再落独立 Run 行；保留接口兼容，恒返回空列表。
   * 嵌套可观测性见父 run 事件流中的 `parent` / `workflow:iteration:*`。
   */
  async listChildren(parentRunId: string): Promise<RunRecord[]> {
    const parent = await this.runRepository.findById(parentRunId);
    if (!parent) {
      throw new HttpException('Run 不存在', HttpStatus.NOT_FOUND);
    }
    return [];
  }

  async cancelRun(runId: string, options: CancelRunOptions = {}) {
    const record = await this.runRepository.findById(runId);
    if (!record) {
      throw new HttpException('Run 不存在', HttpStatus.NOT_FOUND);
    }

    if (TERMINAL_RUN_STATUSES.includes(record.status)) {
      return { runId, status: record.status, cancelled: undefined };
    }

    const mode = options.mode ?? 'best-effort';
    const control = await this.executionControls.request(runId, 'cancel', { mode });
    const currentStatus = control.result?.currentStatus;
    this.logger.log(`Run ${runId} cancel command ${control.commandId} is ${control.status}`);
    return {
      runId,
      status:
        currentStatus === 'cancelled' ||
        ((record.status === 'queued' ||
          record.status === 'waiting' ||
          record.status === 'paused') &&
          control.status === 'applied')
          ? ('cancelled' as const)
          : record.status,
      cancelled: mode,
      inFlightSteps: control.result?.inFlightSteps,
      control: { commandId: control.commandId, status: control.status, error: control.error },
    };
  }

  async pauseRun(runId: string, options: PauseRunOptions = {}) {
    const record = await this.runRepository.findById(runId);
    if (!record) {
      throw new HttpException('Run 不存在', HttpStatus.NOT_FOUND);
    }

    if (!['running', 'pausing'].includes(record.status)) {
      throw new HttpException(`无法暂停状态为 ${record.status} 的 Run`, HttpStatus.CONFLICT);
    }

    const control = await this.executionControls.request(runId, 'pause', { ...options });
    return {
      runId,
      status: control.result?.currentStatus ?? record.status,
      inFlightSteps: control.result?.inFlightSteps,
      control: { commandId: control.commandId, status: control.status, error: control.error },
    };
  }

  async resumeRun(runId: string) {
    const record = await this.runRepository.findById(runId);
    if (!record) {
      throw new HttpException('Run 不存在', HttpStatus.NOT_FOUND);
    }

    if (!['paused', 'pausing'].includes(record.status)) {
      throw new HttpException(`无法继续状态为 ${record.status} 的 Run`, HttpStatus.CONFLICT);
    }

    const control = await this.executionControls.request(runId, 'resume');
    return {
      runId,
      status: control.result?.currentStatus ?? record.status,
      control: { commandId: control.commandId, status: control.status, error: control.error },
    };
  }

  async deleteRun(runId: string): Promise<boolean> {
    const record = await this.runRepository.findById(runId);
    if (!record) return false;
    if (NON_DELETABLE_STATUSES.includes(record.status)) {
      throw new HttpException('无法删除进行中的 Run', HttpStatus.CONFLICT);
    }
    const deleted = await this.runRepository.delete(runId);
    if (deleted) {
      this.managedRunIds.delete(runId);
      this.clearChildMappingsForRoot(runId);
    }
    return deleted;
  }

  async subscribeClientAsync(
    runId: string,
    client: import('ws').WebSocket,
    fromEventIndex = 0,
  ): Promise<{ ok: true } | { ok: false; message: string }> {
    const record = await this.runRepository.findById(runId);
    if (!record) {
      return { ok: false, message: `Run ${runId} 不存在` };
    }

    this.runStream.subscribe(runId, client, record.events, fromEventIndex);

    if (
      record.result &&
      (record.status === 'finished' || record.status === 'failed' || record.status === 'cancelled')
    ) {
      this.runStream.send(client, { type: 'done', runId, result: record.result });
    }

    return { ok: true };
  }

  private async executeRun(
    runId: string,
    workflow: WorkflowDefinition,
    context: { traceId: string; priority?: number; initialState?: unknown },
  ): Promise<void> {
    try {
      const existing = await this.runRepository.findById(runId);
      if (!existing || existing.status === 'cancelled') {
        this.managedRunIds.delete(runId);
        this.fencedRunIds.delete(runId);
        return;
      }
      if (!(await this.acquireRunLease(runId))) {
        this.logger.warn(`Run lease unavailable, leaving queued for recovery: ${runId}`);
        this.managedRunIds.delete(runId);
        this.fencedRunIds.delete(runId);
        return;
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.logger.error(`Run lease acquisition failed for ${runId}: ${message}`);
      this.managedRunIds.delete(runId);
      this.fencedRunIds.delete(runId);
      return;
    }

    await this.runLeasedWorkflow(
      runId,
      workflow,
      context,
      context.initialState !== undefined ? { initialState: context.initialState } : undefined,
    );
  }

  /** 仅由恢复扫描调用；先取得 Run lease，再重建快照，绝不重放未授权步骤。 */
  async resumePersistedRun(runId: string, settlePermanent = false): Promise<boolean> {
    if (this.managedRunIds.has(runId)) return false;
    if (!(await this.acquireRunLease(runId))) return false;
    let run: RunRecord | undefined;
    try {
      run = await this.runRepository.findById(runId);
      if (!run) throw new RunRecoveryNotReadyError(`Run ${runId} 不存在`);
      const runLeaseToken = this.runLeases.get(runId)?.token;
      if (!runLeaseToken) throw new RunRecoveryNotReadyError(`Run ${runId} lease 不存在`, false);
      await this.projectWorkerLogsForRun(runId, runLeaseToken);
      await this.executionRepository.projectSettledWorkerAttempts(runId, runLeaseToken);
      const resume = await this.loadRecoverySnapshot(runId);
      this.managedRunIds.add(runId);
      this.fencedRunIds.add(runId);
      void this.runLeasedWorkflow(
        runId,
        run.workflowSnapshot,
        { traceId: run.traceId ?? runId },
        { resume },
      ).catch((error: unknown) => {
        const message = error instanceof Error ? error.message : String(error);
        this.logger.error(`Recovered Run ${runId} failed to settle: ${message}`);
      });
      return true;
    } catch (error) {
      try {
        if (
          settlePermanent &&
          run?.status !== 'paused' &&
          error instanceof RunRecoveryNotReadyError &&
          error.permanent
        ) {
          const token = this.runLeases.get(runId)?.token;
          if (
            token &&
            (await this.runRepository.settleRecoveryBlocked(runId, token, error.message))
          ) {
            const settledRun = await this.runRepository.findById(runId);
            if (settledRun?.result) {
              this.runStream.fanOut(runId, { type: 'done', result: settledRun.result });
            }
            return true;
          }
        }
      } finally {
        await this.releaseRunLease(runId);
      }
      throw error;
    }
  }

  private async runLeasedWorkflow(
    runId: string,
    workflow: WorkflowDefinition,
    context: { traceId: string; priority?: number },
    callOptions?: { initialState?: unknown; resume?: WorkflowResumeSnapshot },
  ): Promise<void> {
    try {
      const result = await this.engineService.runWorkflow(
        runId,
        workflow,
        {
          traceId: context.traceId,
          priority: context.priority,
        },
        callOptions,
      );
      if (!this.runLeases.has(runId)) return;
      await this.finalizeIfNeeded(runId, result);
    } catch (error) {
      if (!this.runLeases.has(runId)) return;
      if (error instanceof WorkflowSuspendedError) {
        await (this.eventChains.get(runId) ?? Promise.resolve());
        await this.runRepository.update(runId, { status: 'waiting' });
        return;
      }
      if (
        error instanceof WorkflowValidationError ||
        error instanceof WorkflowRunIdValidationError
      ) {
        await this.runRepository.update(runId, {
          status: 'rejected',
          finishedAt: new Date(),
        });
        this.runStream.fanOut(runId, {
          type: 'error',
          message: error.message,
        });
        return;
      }

      const message = error instanceof Error ? error.message : '工作流执行失败';
      this.logger.error(
        `Run ${runId} failed: ${message}`,
        error instanceof Error ? error.stack : undefined,
      );
      await this.runRepository.update(runId, {
        status: 'failed',
        finishedAt: new Date(),
      });
      this.runStream.fanOut(runId, { type: 'error', message });
    } finally {
      await this.releaseRunLease(runId);
      this.managedRunIds.delete(runId);
      this.fencedRunIds.delete(runId);
    }
  }

  private async onChildRunStart(
    childRunId: string,
    _childDefinition: WorkflowDefinition,
    ctx: { parentRunId: string; stepId: string; iteration: number },
  ): Promise<void> {
    const rootRunId = this.childRootRunIds.get(ctx.parentRunId) ?? ctx.parentRunId;
    this.childRootRunIds.set(childRunId, rootRunId);
    this.logger.log(
      `Embedded run ${childRunId} mapped to root=${rootRunId} (parent=${ctx.parentRunId}, step=${ctx.stepId}, iter=${ctx.iteration})`,
    );
  }

  private async onChildRunFinished(childRunId: string, _result: WorkflowRunResult): Promise<void> {
    // 映射保留到顶层 run 收尾，避免异步事件链仍需 resolvePersistRunId
    this.logger.debug(`Embedded run ${childRunId} finished (mapping retained until root settles)`);
  }

  private async finalizeIfNeeded(runId: string, result: WorkflowRunResult): Promise<void> {
    // 等本 run 事件链排空后再清映射，避免仍在途的嵌套事件丢 root
    await (this.eventChains.get(runId) ?? Promise.resolve());

    const record = await this.runRepository.findById(runId);
    if (
      !record ||
      record.status === 'finished' ||
      record.status === 'failed' ||
      record.status === 'cancelled'
    ) {
      this.clearChildMappingsForRoot(runId);
      return;
    }

    const serialized = serializeWorkflowRunResult(result);
    const status = runStatusFromWorkflowResult(result);
    await this.runRepository.update(runId, {
      status,
      finishedAt: new Date(),
      result: serialized,
      counts: this.countsFromResult(result),
      ...(status === 'cancelled' ? { cancelled: 'best-effort' as const } : {}),
    });
    this.clearChildMappingsForRoot(runId);
    this.runStream.fanOut(runId, { type: 'done', result: serialized });
  }

  private async processEngineEvent(event: WorkflowLifecycleEvent): Promise<void> {
    const persistRunId = this.resolvePersistRunId(event);
    if (!this.managedRunIds.has(persistRunId)) return;
    if (this.fencedRunIds.has(persistRunId)) {
      const lease = this.runLeases.get(persistRunId);
      if (!lease || !(await this.heartbeatRunLease(persistRunId, lease.token))) return;
    }
    const nested = this.isNestedEngineEvent(event);
    const serialized = serializeWorkflowEvent(event);
    const offset = await this.runRepository.appendEvent(persistRunId, serialized);
    const persistedEvent = offset === undefined ? serialized : { ...serialized, offset };

    // 嵌套子执行：只写入父事件流，不改父 Run 的 status/counts/result
    if (nested) {
      this.runStream.fanOut(persistRunId, { type: 'event', event: persistedEvent });
      return;
    }

    await this.projectExecutionState(event, persistRunId);

    if (event.type === 'workflow:start') {
      const existing = await this.runRepository.findById(persistRunId);
      await this.runRepository.update(persistRunId, {
        status: 'running',
        startedAt: existing?.startedAt ?? new Date(),
      });
    }

    if (event.type === 'step:finished' && !this.willRetry(event)) {
      const record = await this.runRepository.findById(persistRunId);
      if (record) {
        const counts = { ...record.counts };
        if (event.result.status === StepStatuses.COMPLETED) counts.completed += 1;
        if (event.result.status === StepStatuses.FAILED) counts.failed += 1;
        if (event.result.status === StepStatuses.SKIPPED) counts.skipped += 1;
        await this.runRepository.update(persistRunId, { counts });
      }
    }

    if (event.type === 'workflow:cancelled') {
      await this.runRepository.update(persistRunId, {
        status: 'running',
        cancelled: event.mode,
      });
    }

    if (event.type === 'workflow:paused') {
      await this.runRepository.update(persistRunId, { status: 'paused' });
    }

    if (event.type === 'workflow:resumed') {
      await this.runRepository.update(persistRunId, { status: 'running' });
    }

    if (event.type === 'workflow:finished') {
      const serializedResult = serializeWorkflowRunResult(event.result);
      const status = runStatusFromWorkflowResult(event.result);
      await this.runRepository.update(persistRunId, {
        status,
        finishedAt: new Date(),
        result: serializedResult,
        counts: this.countsFromResult(event.result),
        ...(status === 'cancelled' ? { cancelled: 'best-effort' as const } : {}),
      });
      this.clearChildMappingsForRoot(persistRunId);
      this.runStream.fanOut(persistRunId, { type: 'done', result: serializedResult });
    } else {
      this.runStream.fanOut(persistRunId, { type: 'event', event: persistedEvent });
    }
  }

  private async projectExecutionState(
    event: WorkflowLifecycleEvent,
    persistRunId: string,
  ): Promise<void> {
    if (
      event.type !== 'step:queued' &&
      event.type !== 'step:start' &&
      event.type !== 'step:finished'
    ) {
      return;
    }
    const execution =
      event.execution ?? (event.type === 'step:finished' ? event.result.execution : undefined);
    if (!execution) return;

    await this.executionRepository.ensureJob({
      execution,
      runId: persistRunId,
      stepId: event.step.id,
      idempotencyKey: execution.jobId,
      retryPolicy: resolveRetryPolicy(event.step.retryPolicy),
    });
    await this.executionRepository.ensureAttempt(execution);

    if (event.type === 'step:queued') {
      await this.executionRepository.setJobStatus(execution.jobId, AttemptStatuses.QUEUED);
      return;
    }

    if (event.type === 'step:start') {
      if (this.isRemoteStep(event.step, persistRunId)) return;
      await this.executionLeases.start(execution);
      await this.executionRepository.setJobStatus(execution.jobId, AttemptStatuses.RUNNING);
      return;
    }

    const terminalStatus =
      event.result.status === StepStatuses.COMPLETED
        ? AttemptStatuses.SUCCEEDED
        : event.result.status === StepStatuses.FAILED
          ? AttemptStatuses.FAILED
          : event.result.skipReason === SkipReasons.USER_CANCELLED ||
              event.result.skipReason === SkipReasons.PAUSE_INTERRUPTED
            ? AttemptStatuses.CANCELLED
            : AttemptStatuses.SKIPPED;
    this.executionLeases.stop(execution.attemptId);

    let transitioned = false;
    for (const from of [AttemptStatuses.RUNNING, AttemptStatuses.LEASED, AttemptStatuses.QUEUED]) {
      transitioned = await this.executionRepository.transitionAttempt(
        execution.attemptId,
        from,
        terminalStatus,
        event.result.reason ?? event.result.skipReason ?? event.result.failureKind,
      );
      if (transitioned) break;
    }
    if (transitioned) {
      await this.executionRepository.setJobStatus(
        execution.jobId,
        this.willRetry(event) ? AttemptStatuses.QUEUED : terminalStatus,
      );
    }
  }

  private willRetry(event: Extract<WorkflowLifecycleEvent, { type: 'step:finished' }>): boolean {
    const attempt = event.execution?.attempt ?? event.result.execution?.attempt ?? 0;
    return shouldRetryExecution(event.result, resolveRetryPolicy(event.step.retryPolicy), attempt);
  }

  private initialCounts(workflow: WorkflowDefinition): RunCounts {
    return {
      total: workflow.steps.length,
      completed: 0,
      failed: 0,
      skipped: 0,
    };
  }

  private countsFromResult(result: WorkflowRunResult): RunCounts {
    return {
      total: result.results.length,
      completed: result.results.filter((r) => r.status === StepStatuses.COMPLETED).length,
      failed: result.results.filter((r) => r.status === StepStatuses.FAILED).length,
      skipped: result.results.filter((r) => r.status === StepStatuses.SKIPPED).length,
    };
  }
}
