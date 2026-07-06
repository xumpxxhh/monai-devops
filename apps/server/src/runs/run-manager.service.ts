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
import { validateWorkflowDefinition } from '../common/validation/validate-workflow.js';
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

  constructor(
    private readonly engineService: EngineService,
    @Inject(RUN_REPOSITORY) private readonly runRepository: RunRepository,
    private readonly runStream: RunStreamService,
    private readonly config: ConfigService,
  ) {}

  onModuleInit(): void {
    this.engineService.onEvent((event) => this.enqueueEngineEvent(event));
  }

  private enqueueEngineEvent(event: WorkflowLifecycleEvent): Promise<void> {
    const runId = event.workflowRunId;
    const previous = this.eventChains.get(runId) ?? Promise.resolve();
    const current = previous
      .then(() => this.processEngineEvent(event))
      .catch((error: unknown) => {
        const message = error instanceof Error ? error.message : 'Unknown error';
        this.logger.error(`Failed to process ${event.type} for run ${runId}: ${message}`);
      })
      .finally(() => {
        if (this.eventChains.get(runId) === current) {
          this.eventChains.delete(runId);
        }
      });
    this.eventChains.set(runId, current);
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

    const normalized = normalizeWorkflowIds(workflow);

    try {
      validateWorkflowDefinition(normalized);
    } catch (error) {
      if (error instanceof WorkflowValidationError) {
        throw error;
      }
      throw error;
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
    };

    await this.runRepository.save(record);
    this.logger.log(`Run ${runId} queued (workflow=${normalized.id}, traceId=${traceId})`);

    void this.executeRun(runId, normalized, {
      traceId,
      priority: options.priority,
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
    return this.runRepository.delete(runId);
  }

  async subscribeClientAsync(
    runId: string,
    client: import('ws').WebSocket,
  ): Promise<{ ok: true } | { ok: false; message: string }> {
    const record = await this.runRepository.findById(runId);
    if (!record) {
      return { ok: false, message: `Run ${runId} 不存在` };
    }

    this.runStream.subscribe(runId, client, record.events);

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
    context: { traceId: string; priority?: number },
  ): Promise<void> {
    const existing = await this.runRepository.findById(runId);
    if (existing?.status === 'cancelled') {
      return;
    }

    try {
      const result = await this.engineService.runWorkflow(runId, workflow, context);
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

  private async finalizeIfNeeded(runId: string, result: WorkflowRunResult): Promise<void> {
    const record = await this.runRepository.findById(runId);
    if (
      !record ||
      record.status === 'finished' ||
      record.status === 'failed' ||
      record.status === 'cancelled'
    ) {
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
    this.runStream.fanOut(runId, { type: 'done', result: serialized });
  }

  private async processEngineEvent(event: WorkflowLifecycleEvent): Promise<void> {
    const runId = event.workflowRunId;
    const serialized = serializeWorkflowEvent(event);
    await this.runRepository.appendEvent(runId, serialized);

    if (event.type === 'workflow:start') {
      await this.runRepository.update(runId, {
        status: 'running',
        startedAt: new Date(),
      });
    }

    if (event.type === 'step:finished') {
      const record = await this.runRepository.findById(runId);
      if (record) {
        const counts = { ...record.counts };
        if (event.result.status === StepStatuses.COMPLETED) counts.completed += 1;
        if (event.result.status === StepStatuses.FAILED) counts.failed += 1;
        if (event.result.status === StepStatuses.SKIPPED) counts.skipped += 1;
        await this.runRepository.update(runId, { counts });
      }
    }

    if (event.type === 'workflow:cancelled') {
      await this.runRepository.update(runId, {
        status: 'running',
        cancelled: event.mode,
      });
    }

    if (event.type === 'workflow:paused') {
      await this.runRepository.update(runId, { status: 'paused' });
    }

    if (event.type === 'workflow:resumed') {
      await this.runRepository.update(runId, { status: 'running' });
    }

    if (event.type === 'workflow:finished') {
      const serializedResult = serializeWorkflowRunResult(event.result);
      const status = runStatusFromWorkflowResult(event.result);
      await this.runRepository.update(runId, {
        status,
        finishedAt: new Date(),
        result: serializedResult,
        counts: this.countsFromResult(event.result),
        ...(status === 'cancelled' ? { cancelled: 'best-effort' as const } : {}),
      });
      this.runStream.fanOut(runId, { type: 'done', result: serializedResult });
    } else {
      this.runStream.fanOut(runId, { type: 'event', event: serialized });
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
