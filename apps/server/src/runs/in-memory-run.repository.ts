import { Inject, Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  canMergeStreamLogs,
  mergeStreamLogInto,
} from '../common/serialization/merge-stream-log-event.js';
import {
  type RunListFilter,
  type RunRecord,
  type RunRepository,
  type RunStatus,
  RUN_REPOSITORY,
} from './runs.repository.js';

const ACTIVE_STATUSES: RunStatus[] = ['queued', 'running', 'pausing', 'paused'];

/** 缓冲超限时优先保留的生命周期事件 */
const LIFECYCLE_EVENT_TYPES = new Set([
  'workflow:start',
  'workflow:finished',
  'workflow:cancelled',
  'workflow:paused',
  'workflow:resumed',
  'step:queued',
  'step:start',
  'step:finished',
]);

@Injectable()
export class InMemoryRunRepository implements RunRepository {
  private readonly records = new Map<string, RunRecord>();
  private readonly accessOrder: string[] = [];

  constructor(private readonly config: ConfigService) {}

  async save(record: RunRecord): Promise<void> {
    this.evictIfNeeded();
    this.records.set(record.runId, structuredClone(record));
    this.touch(record.runId);
  }

  async update(runId: string, patch: Partial<RunRecord>): Promise<RunRecord | undefined> {
    const existing = this.records.get(runId);
    if (!existing) return undefined;

    const updated: RunRecord = {
      ...existing,
      ...patch,
      events: patch.events ?? existing.events,
      counts: patch.counts ?? existing.counts,
    };
    this.records.set(runId, updated);
    this.touch(runId);
    return structuredClone(updated);
  }

  async findById(runId: string): Promise<RunRecord | undefined> {
    const record = this.records.get(runId);
    if (!record) return undefined;
    this.touch(runId);
    return structuredClone(record);
  }

  async list(filter: RunListFilter): Promise<{ items: RunRecord[]; total: number }> {
    let items = Array.from(this.records.values());

    if (filter.status) {
      items = items.filter((record) => record.status === filter.status);
    }
    if (filter.workflowId) {
      items = items.filter((record) => record.workflowId === filter.workflowId);
    }
    if (filter.search?.trim()) {
      const keyword = filter.search.trim().toLowerCase();
      items = items.filter(
        (record) =>
          record.runId.toLowerCase().includes(keyword) ||
          record.workflowId.toLowerCase().includes(keyword) ||
          record.workflowSnapshot.name.toLowerCase().includes(keyword),
      );
    }

    items.sort((a, b) => {
      const aActive = ACTIVE_STATUSES.includes(a.status) ? 1 : 0;
      const bActive = ACTIVE_STATUSES.includes(b.status) ? 1 : 0;
      if (aActive !== bActive) return bActive - aActive;
      return b.createdAt.getTime() - a.createdAt.getTime();
    });

    const total = items.length;
    const start = (filter.page - 1) * filter.pageSize;
    const pageItems = items
      .slice(start, start + filter.pageSize)
      .map((record) => structuredClone(record));

    return { items: pageItems, total };
  }

  async appendEvent(runId: string, event: RunRecord['events'][number]): Promise<void> {
    const record = this.records.get(runId);
    if (!record) return;

    const last = record.events.length > 0 ? record.events[record.events.length - 1] : undefined;
    if (last && canMergeStreamLogs(last, event)) {
      mergeStreamLogInto(last, event);
    } else {
      record.events.push(event);
      const limit = this.config.get<number>('RUN_HISTORY_LIMIT', 500);
      if (record.events.length > limit) {
        this.trimEvents(record.events, limit);
      }
    }
    this.touch(runId);
  }

  /** 超限时优先裁剪 plugin:log，尽量保留生命周期事件 */
  private trimEvents(events: RunRecord['events'], limit: number): void {
    while (events.length > limit) {
      const logIndex = events.findIndex((event) => event.type === 'plugin:log');
      if (logIndex >= 0) {
        events.splice(logIndex, 1);
        continue;
      }

      const disposableIndex = events.findIndex(
        (event) => !LIFECYCLE_EVENT_TYPES.has(String(event.type)),
      );
      if (disposableIndex >= 0) {
        events.splice(disposableIndex, 1);
        continue;
      }

      events.shift();
    }
  }

  async delete(runId: string): Promise<boolean> {
    const deleted = this.records.delete(runId);
    const index = this.accessOrder.indexOf(runId);
    if (index >= 0) this.accessOrder.splice(index, 1);
    return deleted;
  }

  async countActive(): Promise<number> {
    return Array.from(this.records.values()).filter((record) =>
      ACTIVE_STATUSES.includes(record.status),
    ).length;
  }

  async countByStatus(status: RunStatus): Promise<number> {
    return Array.from(this.records.values()).filter((record) => record.status === status).length;
  }

  private touch(runId: string): void {
    const index = this.accessOrder.indexOf(runId);
    if (index >= 0) this.accessOrder.splice(index, 1);
    this.accessOrder.push(runId);
  }

  private evictIfNeeded(): void {
    const limit = this.config.get<number>('RUN_HISTORY_LIMIT', 500);
    while (this.records.size >= limit && this.accessOrder.length > 0) {
      const oldest = this.accessOrder.shift();
      if (!oldest) break;
      const record = this.records.get(oldest);
      if (record && !ACTIVE_STATUSES.includes(record.status)) {
        this.records.delete(oldest);
      } else if (record) {
        this.accessOrder.push(oldest);
        break;
      }
    }
  }
}

export function provideRunRepository() {
  return {
    provide: RUN_REPOSITORY,
    useClass: InMemoryRunRepository,
  };
}

@Injectable()
export class RunRepositoryAccessor {
  constructor(@Inject(RUN_REPOSITORY) readonly repository: RunRepository) {}
}
