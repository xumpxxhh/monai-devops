import { HttpException, HttpStatus, Inject, Injectable } from '@nestjs/common';
import type { WorkflowDefinition } from '@monai-devops/core-engine';
import { EngineService } from '../engine/engine.service.js';
import { RunManagerService, type SubmitRunOptions } from '../runs/run-manager.service.js';
import {
  type WorkflowListFilter,
  type WorkflowRecord,
  type WorkflowRepository,
  WORKFLOW_REPOSITORY,
} from './workflows.repository.js';

@Injectable()
export class WorkflowsService {
  constructor(
    @Inject(WORKFLOW_REPOSITORY) private readonly workflowRepository: WorkflowRepository,
    private readonly engineService: EngineService,
    private readonly runManager: RunManagerService,
  ) {}

  async create(definition: WorkflowDefinition): Promise<WorkflowRecord> {
    this.engineService.validateWorkflow(definition);

    const existing = await this.workflowRepository.findById(definition.id);
    if (existing) {
      throw new HttpException(`Workflow ${definition.id} 已存在`, HttpStatus.CONFLICT);
    }

    const now = new Date();
    const record: WorkflowRecord = {
      id: definition.id,
      definition: structuredClone(definition),
      createdAt: now,
      updatedAt: now,
    };
    await this.workflowRepository.save(record);
    return record;
  }

  async list(filter: WorkflowListFilter) {
    return this.workflowRepository.list(filter);
  }

  async get(id: string): Promise<WorkflowRecord> {
    const record = await this.workflowRepository.findById(id);
    if (!record) {
      throw new HttpException('Workflow 不存在', HttpStatus.NOT_FOUND);
    }
    return record;
  }

  async update(id: string, definition: WorkflowDefinition): Promise<WorkflowRecord> {
    if (definition.id !== id) {
      throw new HttpException('路径 id 与 body.id 不一致', HttpStatus.BAD_REQUEST);
    }
    this.engineService.validateWorkflow(definition);

    const updated = await this.workflowRepository.update(id, definition);
    if (!updated) {
      throw new HttpException('Workflow 不存在', HttpStatus.NOT_FOUND);
    }
    return updated;
  }

  async remove(id: string): Promise<void> {
    const deleted = await this.workflowRepository.delete(id);
    if (!deleted) {
      throw new HttpException('Workflow 不存在', HttpStatus.NOT_FOUND);
    }
  }

  validate(definition: WorkflowDefinition) {
    this.engineService.validateWorkflow(definition);
    return { valid: true };
  }

  async triggerRun(id: string, options: SubmitRunOptions = {}) {
    const record = await this.get(id);
    return this.runManager.submitRun(record.definition, options);
  }
}
