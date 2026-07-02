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
  WorkflowValidationError,
  type WorkflowDefinition,
  type WorkflowLifecycleEvent,
  type WorkflowRunResult,
} from '@monai-devops/core-engine';
import {
  serializeWorkflowEvent,
  serializeWorkflowRunResult,
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

export interface SubmitRunOptions {
  priority?: number;
  traceId?: string;
  failFast?: boolean;
  maxParallelSteps?: number;
}

@Injectable()
export class RunManagerService implements OnModuleInit {
  private readonly logger = new Logger(RunManagerService.name);

  constructor(
    private readonly engineService: EngineService,
    @Inject(RUN_REPOSITORY) private readonly runRepository: RunRepository,
    private readonly runStream: RunStreamService,
    private readonly config: ConfigService,
  ) {}

  onModuleInit(): void {
    this.engineService.onEvent((event) => this.handleEngineEvent(event));
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
      runId,
      traceId,
      priority: options.priority,
    });

    return { runId, status: 'queued' as const };
  }

  async getRun(runId: string): Promise<RunRecord | undefined> {
    return this.runRepository.findById(runId);
  }

  async listRuns(filter: Parameters<RunRepository['list']>[0]) {
    return this.runRepository.list(filter);
  }

  async getEvents(runId: string): Promise<RunRecord['events'] | undefined> {
    const record = await this.runRepository.findById(runId);
    return record?.events;
  }

  async cancelRun(runId: string) {
    const record = await this.runRepository.findById(runId);
    if (!record) {
      throw new HttpException('Run 不存在', HttpStatus.NOT_FOUND);
    }

    if (
      record.status === 'finished' ||
      record.status === 'failed' ||
      record.status === 'rejected'
    ) {
      return { runId, status: record.status, cancelled: undefined };
    }

    const cancelledSteps = this.engineService.cancelQueuedSteps(runId);
    this.logger.log(`Run ${runId} best-effort cancel (${cancelledSteps} queued steps cancelled)`);

    if (record.status === 'queued' || record.status === 'running') {
      await this.runRepository.update(runId, {
        status: 'cancelled',
        cancelled: 'best-effort',
        finishedAt: new Date(),
      });
    }

    return { runId, status: 'cancelled', cancelled: 'best-effort' as const };
  }

  async deleteRun(runId: string): Promise<boolean> {
    const record = await this.runRepository.findById(runId);
    if (!record) return false;
    if (record.status === 'queued' || record.status === 'running') {
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

    if (record.result && (record.status === 'finished' || record.status === 'failed')) {
      this.runStream.send(client, { type: 'done', result: record.result });
    }

    return { ok: true };
  }

  private async executeRun(
    runId: string,
    workflow: WorkflowDefinition,
    context: { runId: string; traceId: string; priority?: number },
  ): Promise<void> {
    try {
      const result = await this.engineService.runWorkflow(workflow, context);
      await this.finalizeIfNeeded(runId, result);
    } catch (error) {
      if (error instanceof WorkflowValidationError) {
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
    if (!record || record.status === 'finished' || record.status === 'failed') {
      return;
    }

    const serialized = serializeWorkflowRunResult(result);
    await this.runRepository.update(runId, {
      status: result.success ? 'finished' : 'failed',
      finishedAt: new Date(),
      result: serialized,
      counts: this.countsFromResult(result),
    });
    this.runStream.fanOut(runId, { type: 'done', result: serialized });
  }

  private async handleEngineEvent(event: WorkflowLifecycleEvent): Promise<void> {
    const runId = event.meta.runId;
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

    if (event.type === 'workflow:finished') {
      const serializedResult = serializeWorkflowRunResult(event.result);
      await this.runRepository.update(runId, {
        status: event.result.success ? 'finished' : 'failed',
        finishedAt: new Date(),
        result: serializedResult,
        counts: this.countsFromResult(event.result),
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
