import type { WorkflowDefinition } from '@monai-devops/core-engine';
import type {
  SerializedWorkflowLifecycleEvent,
  SerializedWorkflowRunResult,
} from '../common/serialization/serialize-workflow-event.js';
import type { Prisma } from '@prisma/client';
import { Prisma as PrismaNamespace } from '@prisma/client';
import { toInputJson } from '../prisma/prisma-json.js';
import type { Run, RunEvent } from '@prisma/client';
import type { RunRecord, RunStatus } from './runs.repository.js';

export const ACTIVE_RUN_STATUSES: RunStatus[] = ['queued', 'running', 'pausing', 'paused'];

export function isActiveRunStatus(status: RunStatus): boolean {
  return ACTIVE_RUN_STATUSES.includes(status);
}

function asMetadata(value: unknown): Record<string, unknown> {
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }
  return {};
}

export function toRunRecord(run: Run, events: RunEvent[]): RunRecord {
  return {
    runId: run.runId,
    workflowId: run.workflowId,
    workflowSnapshot: run.workflowSnapshot as unknown as WorkflowDefinition,
    status: run.status as RunStatus,
    traceId: run.traceId ?? undefined,
    counts: {
      total: run.countsTotal,
      completed: run.countsCompleted,
      failed: run.countsFailed,
      skipped: run.countsSkipped,
    },
    createdAt: run.createdAt,
    startedAt: run.startedAt ?? undefined,
    finishedAt: run.finishedAt ?? undefined,
    result: (run.result as SerializedWorkflowRunResult | null) ?? undefined,
    events: events.map((event) => event.payload as SerializedWorkflowLifecycleEvent),
    cancelled: (run.cancelled as RunRecord['cancelled']) ?? undefined,
    createdBy: run.createdBy ?? undefined,
    source: run.source ?? undefined,
    metadata: asMetadata(run.metadata),
    parentRunId: run.parentRunId ?? undefined,
  };
}

export function toRunCreateData(record: RunRecord): Prisma.RunCreateInput {
  return {
    runId: record.runId,
    workflowId: record.workflowId,
    workflowName: record.workflowSnapshot.name,
    status: record.status,
    isActive: isActiveRunStatus(record.status),
    traceId: record.traceId ?? null,
    workflowSnapshot: toInputJson(record.workflowSnapshot),
    countsTotal: record.counts.total,
    countsCompleted: record.counts.completed,
    countsFailed: record.counts.failed,
    countsSkipped: record.counts.skipped,
    ...(record.result ? { result: toInputJson(record.result) } : {}),
    cancelled: record.cancelled ?? null,
    createdBy: record.createdBy ?? null,
    source: record.source ?? 'api',
    metadata: toInputJson(record.metadata ?? {}),
    parentRunId: record.parentRunId ?? null,
    createdAt: record.createdAt,
    startedAt: record.startedAt ?? null,
    finishedAt: record.finishedAt ?? null,
  };
}

export function toRunUpdateData(patch: Partial<RunRecord>): Prisma.RunUpdateInput {
  const data: Prisma.RunUpdateInput = {};

  if (patch.workflowId !== undefined) data.workflowId = patch.workflowId;
  if (patch.workflowSnapshot !== undefined) {
    data.workflowSnapshot = toInputJson(patch.workflowSnapshot);
    data.workflowName = patch.workflowSnapshot.name;
  }
  if (patch.status !== undefined) {
    data.status = patch.status;
    data.isActive = isActiveRunStatus(patch.status);
  }
  if (patch.traceId !== undefined) data.traceId = patch.traceId ?? null;
  if (patch.counts !== undefined) {
    data.countsTotal = patch.counts.total;
    data.countsCompleted = patch.counts.completed;
    data.countsFailed = patch.counts.failed;
    data.countsSkipped = patch.counts.skipped;
  }
  if (patch.result !== undefined) {
    data.result = patch.result ? toInputJson(patch.result) : PrismaNamespace.DbNull;
  }
  if (patch.cancelled !== undefined) data.cancelled = patch.cancelled ?? null;
  if (patch.createdBy !== undefined) data.createdBy = patch.createdBy ?? null;
  if (patch.startedAt !== undefined) data.startedAt = patch.startedAt ?? null;
  if (patch.finishedAt !== undefined) data.finishedAt = patch.finishedAt ?? null;
  if (patch.source !== undefined) data.source = patch.source ?? null;
  if (patch.metadata !== undefined) data.metadata = toInputJson(patch.metadata);
  if (patch.parentRunId !== undefined) data.parentRunId = patch.parentRunId ?? null;

  return data;
}
