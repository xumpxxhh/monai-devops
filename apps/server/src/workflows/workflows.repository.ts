import type { WorkflowDefinition } from '@monai-devops/core-engine';
import { type PaginatedResult } from '../common/dto/pagination.dto.js';

export interface WorkflowRecord {
  id: string;
  definition: WorkflowDefinition;
  createdAt: Date;
  updatedAt: Date;
  createdBy?: bigint;
  ownerWorkflowId?: string;
}

export type WorkflowImportMode = 'reference' | 'copy';

export interface WorkflowImportRecord {
  id: string;
  parentWorkflowId: string;
  childWorkflowId: string;
  stepId: string;
  mode: WorkflowImportMode;
  createdAt: Date;
  childWorkflowName?: string;
  childWorkflowUpdatedAt?: Date;
  /** 子工作流 definition.stateSchema（有则返回，供父侧配置 inputState） */
  childStateSchema?: Record<string, unknown>;
}

export interface WorkflowListFilter {
  search?: string;
  page: number;
  pageSize: number;
  /** 默认 true：公开列表排除私有拷贝 */
  publicOnly?: boolean;
}

export interface WorkflowRepository {
  save(record: WorkflowRecord): Promise<void>;
  findById(id: string): Promise<WorkflowRecord | undefined>;
  findByName(name: string): Promise<WorkflowRecord | undefined>;
  list(filter: WorkflowListFilter): Promise<PaginatedResult<WorkflowRecord>>;
  update(id: string, definition: WorkflowDefinition): Promise<WorkflowRecord | undefined>;
  delete(id: string): Promise<boolean>;
  listImports(parentWorkflowId: string): Promise<WorkflowImportRecord[]>;
  findImportById(importId: string): Promise<WorkflowImportRecord | undefined>;
  createImport(record: WorkflowImportRecord): Promise<WorkflowImportRecord>;
  updateImportStepIds(
    parentWorkflowId: string,
    stepIdByImportId: Map<string, string>,
  ): Promise<void>;
  deleteUnusedImports(parentWorkflowId: string, keepImportIds: ReadonlySet<string>): Promise<void>;
  listReferencingParents(childWorkflowId: string): Promise<Array<{ id: string; name: string }>>;
  resolveWorkflowByImportId(importId: string): Promise<WorkflowDefinition | undefined>;
}

export const WORKFLOW_REPOSITORY = Symbol('WORKFLOW_REPOSITORY');
