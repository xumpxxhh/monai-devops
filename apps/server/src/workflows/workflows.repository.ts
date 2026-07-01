import type { WorkflowDefinition } from '@monai-devops/core-engine';
import { parsePagination, type PaginatedResult } from '../common/dto/pagination.dto.js';

export interface WorkflowRecord {
  id: string;
  definition: WorkflowDefinition;
  createdAt: Date;
  updatedAt: Date;
}

export interface WorkflowListFilter {
  search?: string;
  page: number;
  pageSize: number;
}

export interface WorkflowRepository {
  save(record: WorkflowRecord): Promise<void>;
  findById(id: string): Promise<WorkflowRecord | undefined>;
  list(filter: WorkflowListFilter): Promise<PaginatedResult<WorkflowRecord>>;
  update(id: string, definition: WorkflowDefinition): Promise<WorkflowRecord | undefined>;
  delete(id: string): Promise<boolean>;
}

export const WORKFLOW_REPOSITORY = Symbol('WORKFLOW_REPOSITORY');
