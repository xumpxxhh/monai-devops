import { HttpException, HttpStatus, Inject, Injectable } from '@nestjs/common';
import {
  normalizeWorkflowIds,
  type WorkflowDraft,
} from '../common/validation/normalize-workflow-ids.js';
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

  async create(draft: WorkflowDraft): Promise<WorkflowRecord> {
    const definition = normalizeWorkflowIds(draft);
    this.engineService.validateWorkflow(definition);

    const nameConflict = await this.workflowRepository.findByName(definition.name);
    if (nameConflict) {
      throw new HttpException(`工作流名称「${definition.name}」已存在`, HttpStatus.CONFLICT);
    }

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

  async update(id: string, draft: WorkflowDraft): Promise<WorkflowRecord> {
    const existing = await this.workflowRepository.findById(id);
    if (!existing) {
      throw new HttpException('Workflow 不存在', HttpStatus.NOT_FOUND);
    }

    const knownStepIds = new Set(existing.definition.steps.map((s) => s.id));
    const definition = normalizeWorkflowIds(draft, { workflowId: id, knownStepIds });
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

  validate(draft: WorkflowDraft) {
    const definition = normalizeWorkflowIds(draft);
    this.engineService.validateWorkflow(definition);
    return { valid: true };
  }

  async triggerRun(id: string, options: SubmitRunOptions = {}) {
    const record = await this.get(id);
    return this.runManager.submitRun(record.definition, options);
  }
}
