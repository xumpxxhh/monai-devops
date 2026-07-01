import { Inject, Injectable } from '@nestjs/common';
import type { WorkflowDefinition } from '@monai-devops/core-engine';
import {
  type WorkflowListFilter,
  type WorkflowRecord,
  type WorkflowRepository,
  WORKFLOW_REPOSITORY,
} from './workflows.repository.js';

@Injectable()
export class InMemoryWorkflowRepository implements WorkflowRepository {
  private readonly records = new Map<string, WorkflowRecord>();

  async save(record: WorkflowRecord): Promise<void> {
    this.records.set(record.id, structuredClone(record));
  }

  async findById(id: string): Promise<WorkflowRecord | undefined> {
    const record = this.records.get(id);
    return record ? structuredClone(record) : undefined;
  }

  async list(filter: WorkflowListFilter) {
    let items = Array.from(this.records.values());

    if (filter.search?.trim()) {
      const keyword = filter.search.trim().toLowerCase();
      items = items.filter(
        (record) =>
          record.id.toLowerCase().includes(keyword) ||
          record.definition.name.toLowerCase().includes(keyword),
      );
    }

    items.sort((a, b) => b.updatedAt.getTime() - a.updatedAt.getTime());
    const total = items.length;
    const start = (filter.page - 1) * filter.pageSize;

    return {
      items: items.slice(start, start + filter.pageSize).map((record) => structuredClone(record)),
      total,
      page: filter.page,
      pageSize: filter.pageSize,
    };
  }

  async update(id: string, definition: WorkflowDefinition): Promise<WorkflowRecord | undefined> {
    const existing = this.records.get(id);
    if (!existing) return undefined;

    const updated: WorkflowRecord = {
      ...existing,
      definition: structuredClone(definition),
      updatedAt: new Date(),
    };
    this.records.set(id, updated);
    return structuredClone(updated);
  }

  async delete(id: string): Promise<boolean> {
    return this.records.delete(id);
  }
}

export function provideWorkflowRepository() {
  return {
    provide: WORKFLOW_REPOSITORY,
    useClass: InMemoryWorkflowRepository,
  };
}

@Injectable()
export class WorkflowRepositoryAccessor {
  constructor(@Inject(WORKFLOW_REPOSITORY) readonly repository: WorkflowRepository) {}
}
