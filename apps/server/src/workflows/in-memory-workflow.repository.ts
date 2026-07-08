import { Inject, Injectable } from '@nestjs/common';
import type { WorkflowDefinition } from '@monai-devops/core-engine';
import {
  type WorkflowListFilter,
  type WorkflowRecord,
  type WorkflowRepository,
  WORKFLOW_REPOSITORY,
} from './workflows.repository.js';

const INITIAL_WORKFLOW_DEFINITION: WorkflowDefinition = {
  id: 'new-workflow',
  name: '新工作流',
  steps: [
    {
      id: '73007350-ccd2-45fd-ac91-985b44fe22de',
      name: '步骤 1',
      plugin: 'test-plugin',
      config: { type: 'unit' },
      dependsOn: [],
    },
    {
      id: '5e1af888-f173-4f5b-b226-77b1db6140d7',
      name: '步骤 2',
      plugin: 'test-plugin',
      config: { type: 'integration' },
      dependsOn: ['73007350-ccd2-45fd-ac91-985b44fe22de'],
    },
    {
      id: '0ea2dadf-7686-43ba-8598-e1de1022626e',
      name: '步骤 3',
      plugin: 'test-plugin',
      config: { type: 'integration' },
      dependsOn: ['73007350-ccd2-45fd-ac91-985b44fe22de'],
    },
    {
      id: '238a443f-50f7-410e-9c7d-07930e542953',
      name: '步骤 4',
      plugin: 'test-plugin',
      config: { type: 'e2e' },
      dependsOn: ['0ea2dadf-7686-43ba-8598-e1de1022626e', '5e1af888-f173-4f5b-b226-77b1db6140d7'],
    },
  ],
};

@Injectable()
export class InMemoryWorkflowRepository implements WorkflowRepository {
  private readonly records = new Map<string, WorkflowRecord>([
    (() => {
      const now = new Date();
      const record: WorkflowRecord = {
        id: INITIAL_WORKFLOW_DEFINITION.id,
        definition: structuredClone(INITIAL_WORKFLOW_DEFINITION),
        createdAt: now,
        updatedAt: now,
      };
      return [record.id, record] as const;
    })(),
  ]);

  async save(record: WorkflowRecord): Promise<void> {
    this.records.set(record.id, structuredClone(record));
  }

  async findById(id: string): Promise<WorkflowRecord | undefined> {
    const record = this.records.get(id);
    return record ? structuredClone(record) : undefined;
  }

  async findByName(name: string): Promise<WorkflowRecord | undefined> {
    const normalized = name.trim().toLowerCase();
    if (!normalized) return undefined;

    for (const record of this.records.values()) {
      if (record.definition.name.trim().toLowerCase() === normalized) {
        return structuredClone(record);
      }
    }
    return undefined;
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
