import { randomUUID } from 'node:crypto';
import {
  HttpException,
  HttpStatus,
  Inject,
  Injectable,
  Logger,
  OnModuleInit,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  parseState,
  StepStatuses,
  WorkflowRunIdValidationError,
  WorkflowValidationError,
  type WorkflowDefinition,
  type WorkflowLifecycleEvent,
  type WorkflowRunResult,
} from '@monai-devops/core-engine';
import {
  serializeWorkflowEvent,
  serializeWorkflowRunResult,
  runStatusFromWorkflowResult,
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

const NON_DELETABLE_STATUSES: RunRecord['status'][] = ['queued', 'running', 'paused', 'pausing'];

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
export class RunManagerService implements OnModuleInit {
  private readonly logger = new Logger(RunManagerService.name);
  private readonly eventChains = new Map<string, Promise<void>>();
  /** 仅处理本服务 submit/save 过的顶层 run，避免直连引擎的旁路调用误打仓储 */
  private readonly managedRunIds = new Set<string>();
  /** 嵌入子执行 childRunId → 顶层 API runId；子 run 不落表，事件写入并推流到 root */
  private readonly childRootRunIds = new Map<string, string>();

  constructor(
    private readonly engineService: EngineService,
    @Inject(RUN_REPOSITORY) private readonly runRepository: RunRepository,
    private readonly runStream: RunStreamService,
    private readonly config: ConfigService,
  ) {}

  onModuleInit(): void {
    // 不向引擎回传 Promise：持久化串行在 eventChains 内完成，避免 DB 延迟/失败阻塞 core-engine
    this.engineService.onEvent((event) => {
      void this.enqueueEngineEvent(event);
    });
    this.engineService.setEmbeddedRunHooks({
      onChildRunStart: (childRunId, childDefinition, ctx) =>
        this.onChildRunStart(childRunId, childDefinition, ctx),
      onChildRunFinished: (childRunId, result) => this.onChildRunFinished(childRunId, result),
    });
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

    await this.runRepository.save(record);
    this.managedRunIds.add(runId);
    this.logger.log(`Run ${runId} queued (workflow=${normalized.id}, traceId=${traceId})`);

    void this.executeRun(runId, normalized, {
      traceId,
      priority: options.priority,
      initialState: options.initialState,
    });

    return { runId, status: 'queued' as const };
  }

  async getRun(runId: string): Promise<RunRecord | undefined> {
    const record = await this.runRepository.findById(runId);
    if (!record) return undefined;
    const engineStatus = this.engineService.getRunStatus(runId);
    return mergeEngineControlStatus(record, engineStatus);
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
    const controlResult = await this.engineService.cancelRun(runId, mode);
    this.logger.log(
      `Run ${runId} cancel requested (${controlResult.previousStatus} -> ${controlResult.currentStatus}, mode=${mode})`,
    );

    if (controlResult.currentStatus === 'unknown' && record.status === 'queued') {
      await this.runRepository.update(runId, {
        status: 'cancelled',
        cancelled: mode,
        finishedAt: new Date(),
      });
      return { runId, status: 'cancelled' as const, cancelled: mode };
    }

    if (
      controlResult.currentStatus === 'cancelling' ||
      controlResult.currentStatus === 'cancelled'
    ) {
      if (controlResult.currentStatus === 'cancelling') {
        await this.runRepository.update(runId, {
          status: 'running',
          cancelled: mode,
        });
      }
      return {
        runId,
        status:
          controlResult.currentStatus === 'cancelled'
            ? ('cancelled' as const)
            : ('running' as const),
        cancelled: mode,
        inFlightSteps: controlResult.inFlightSteps,
      };
    }

    return {
      runId,
      status: record.status,
      cancelled: undefined,
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

    const result = await this.engineService.pauseRun(runId, options);
    if (result.currentStatus === 'paused' || result.currentStatus === 'pausing') {
      await this.runRepository.update(runId, {
        status: result.currentStatus === 'paused' ? 'paused' : 'pausing',
      });
    }

    return { runId, status: result.currentStatus, inFlightSteps: result.inFlightSteps };
  }

  async resumeRun(runId: string) {
    const record = await this.runRepository.findById(runId);
    if (!record) {
      throw new HttpException('Run 不存在', HttpStatus.NOT_FOUND);
    }

    if (!['paused', 'pausing'].includes(record.status)) {
      throw new HttpException(`无法继续状态为 ${record.status} 的 Run`, HttpStatus.CONFLICT);
    }

    const result = await this.engineService.resumeRun(runId);
    if (result.currentStatus === 'running') {
      await this.runRepository.update(runId, { status: 'running' });
    }

    return { runId, status: result.currentStatus };
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
    const existing = await this.runRepository.findById(runId);
    if (existing?.status === 'cancelled') {
      return;
    }

    try {
      const result = await this.engineService.runWorkflow(
        runId,
        workflow,
        {
          traceId: context.traceId,
          priority: context.priority,
        },
        context.initialState !== undefined ? { initialState: context.initialState } : undefined,
      );
      await this.finalizeIfNeeded(runId, result);
    } catch (error) {
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
    const nested = this.isNestedEngineEvent(event);
    const serialized = serializeWorkflowEvent(event);
    await this.runRepository.appendEvent(persistRunId, serialized);

    // 嵌套子执行：只写入父事件流，不改父 Run 的 status/counts/result
    if (nested) {
      this.runStream.fanOut(persistRunId, { type: 'event', event: serialized });
      return;
    }

    if (event.type === 'workflow:start') {
      await this.runRepository.update(persistRunId, {
        status: 'running',
        startedAt: new Date(),
      });
    }

    if (event.type === 'step:finished') {
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
      this.runStream.fanOut(persistRunId, { type: 'event', event: serialized });
    }
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
