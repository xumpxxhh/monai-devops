import { randomUUID } from 'node:crypto';
import { HttpException, HttpStatus, Inject, Injectable, OnModuleInit } from '@nestjs/common';
import { parseState, WorkflowValidationError } from '@monai-devops/core-engine';
import {
  normalizeWorkflowIds,
  type WorkflowDraft,
} from '../common/validation/normalize-workflow-ids.js';
import { collectWorkflowImportRefs } from '../common/validation/validate-workflow.js';
import { EngineService } from '../engine/engine.service.js';
import { RunManagerService, type SubmitRunOptions } from '../runs/run-manager.service.js';
import type { CreateWorkflowImportDto } from './dto/create-workflow-import.dto.js';
import {
  type WorkflowImportRecord,
  type WorkflowListFilter,
  type WorkflowRecord,
  type WorkflowRepository,
  WORKFLOW_REPOSITORY,
} from './workflows.repository.js';

@Injectable()
export class WorkflowsService implements OnModuleInit {
  constructor(
    @Inject(WORKFLOW_REPOSITORY) private readonly workflowRepository: WorkflowRepository,
    private readonly engineService: EngineService,
    private readonly runManager: RunManagerService,
  ) {}

  onModuleInit(): void {
    this.engineService.setResolveWorkflow(async (importId) => {
      const definition = await this.workflowRepository.resolveWorkflowByImportId(importId);
      if (!definition) {
        throw new WorkflowValidationError(`未找到 importId=${importId} 对应的工作流定义`);
      }
      return definition;
    });
  }

  async create(draft: WorkflowDraft): Promise<WorkflowRecord> {
    const definition = normalizeWorkflowIds(draft);
    await this.engineService.validateWorkflow(definition, {
      knownImportIds: new Set(),
    });

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
    return this.workflowRepository.list({ ...filter, publicOnly: filter.publicOnly !== false });
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

    const imports = await this.workflowRepository.listImports(id);
    const knownImportIds = new Set(imports.map((row) => row.id));
    await this.engineService.validateWorkflow(definition, { knownImportIds });

    const { stepIdByImportId } = collectWorkflowImportRefs(definition);
    await this.workflowRepository.updateImportStepIds(id, stepIdByImportId);

    const updated = await this.workflowRepository.update(id, definition);
    if (!updated) {
      throw new HttpException('Workflow 不存在', HttpStatus.NOT_FOUND);
    }
    return updated;
  }

  async remove(id: string): Promise<void> {
    const existing = await this.workflowRepository.findById(id);
    if (!existing) {
      throw new HttpException('Workflow 不存在', HttpStatus.NOT_FOUND);
    }

    if (!existing.ownerWorkflowId) {
      const refs = await this.workflowRepository.listReferencingParents(id);
      if (refs.length > 0) {
        throw new HttpException(
          {
            statusCode: HttpStatus.CONFLICT,
            message: `工作流「${existing.definition.name}」仍被其他工作流引用，无法删除`,
            error: 'Conflict',
            code: 'WORKFLOW_STILL_REFERENCED',
            referencedBy: refs,
          },
          HttpStatus.CONFLICT,
        );
      }
    }

    const deleted = await this.workflowRepository.delete(id);
    if (!deleted) {
      throw new HttpException('Workflow 不存在', HttpStatus.NOT_FOUND);
    }
  }

  async validate(draft: WorkflowDraft) {
    const definition = normalizeWorkflowIds(draft);
    const imports = definition.id ? await this.workflowRepository.listImports(definition.id) : [];
    await this.engineService.validateWorkflow(definition, {
      knownImportIds: new Set(imports.map((row) => row.id)),
    });
    return { valid: true };
  }

  async triggerRun(id: string, options: SubmitRunOptions = {}) {
    const record = await this.get(id);
    if (options.initialState !== undefined) {
      this.assertInitialState(record.definition, options.initialState);
    }
    return this.runManager.submitRun(record.definition, options);
  }

  async listImports(parentWorkflowId: string): Promise<WorkflowImportRecord[]> {
    await this.get(parentWorkflowId);
    return this.workflowRepository.listImports(parentWorkflowId);
  }

  async createImport(
    parentWorkflowId: string,
    body: CreateWorkflowImportDto,
  ): Promise<WorkflowImportRecord> {
    const parent = await this.get(parentWorkflowId);
    const source = await this.workflowRepository.findById(body.childWorkflowId);
    if (!source) {
      throw new HttpException('被导入的工作流不存在', HttpStatus.NOT_FOUND);
    }
    if (source.ownerWorkflowId) {
      throw new HttpException('不能导入私有拷贝工作流', HttpStatus.BAD_REQUEST);
    }
    if (source.id === parent.id) {
      throw new HttpException('不能导入自身', HttpStatus.BAD_REQUEST);
    }

    const existingImports = await this.workflowRepository.listImports(parentWorkflowId);
    const copyPrefix = `${source.definition.name}__copy__`;
    const alreadyImported = existingImports.some((row) => {
      if (row.childWorkflowId === source.id) return true;
      if (row.mode === 'copy' && row.childWorkflowName?.startsWith(copyPrefix)) return true;
      return false;
    });
    if (alreadyImported) {
      throw new HttpException('该工作流已导入', HttpStatus.BAD_REQUEST);
    }

    let childWorkflowId = source.id;
    if (body.mode === 'copy') {
      const copyId = randomUUID();
      const copyName = `${source.definition.name}__copy__${copyId.slice(0, 8)}`;
      const copyDefinition = {
        ...structuredClone(source.definition),
        id: copyId,
        name: copyName,
      };
      const now = new Date();
      await this.workflowRepository.save({
        id: copyId,
        definition: copyDefinition,
        createdAt: now,
        updatedAt: now,
        ownerWorkflowId: parentWorkflowId,
      });
      childWorkflowId = copyId;
    }

    return this.workflowRepository.createImport({
      id: randomUUID(),
      parentWorkflowId,
      childWorkflowId,
      stepId: body.stepId?.trim() ?? '',
      mode: body.mode,
      createdAt: new Date(),
    });
  }

  getStepKinds() {
    return this.engineService.getStepKinds();
  }

  private assertInitialState(definition: WorkflowRecord['definition'], initialState: unknown) {
    if (definition.stateSchema === undefined) {
      throw new WorkflowValidationError(
        `工作流 "${definition.id}" 未声明 stateSchema，不允许传入 initialState`,
      );
    }
    const parsed = parseState(definition.stateSchema, initialState);
    if (!parsed.success) {
      throw new WorkflowValidationError(`initialState 不符合 stateSchema：${parsed.message}`);
    }
  }
}
