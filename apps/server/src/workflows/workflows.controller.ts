import { Body, Controller, Delete, Get, Param, Post, Put, Query } from '@nestjs/common';
import { resolvePagination } from '../common/dto/pagination.dto.js';
import { CreateWorkflowImportDto } from './dto/create-workflow-import.dto.js';
import { ListWorkflowsQueryDto } from './dto/list-workflows.query.dto.js';
import { TriggerRunDto } from './dto/trigger-run.dto.js';
import { WorkflowDraftDto } from './dto/workflow-draft.dto.js';
import { WorkflowsService } from './workflows.service.js';

@Controller()
export class WorkflowsController {
  constructor(private readonly workflowsService: WorkflowsService) {}

  @Get('step-kinds')
  listStepKinds() {
    return this.workflowsService.getStepKinds();
  }

  @Get('workflows')
  list(@Query() query: ListWorkflowsQueryDto) {
    const pagination = resolvePagination(query);
    return this.workflowsService.list({ search: query.search, ...pagination });
  }

  @Post('workflows')
  create(@Body() draft: WorkflowDraftDto) {
    return this.workflowsService.create(draft);
  }

  @Post('workflows/validate')
  validate(@Body() draft: WorkflowDraftDto) {
    return this.workflowsService.validate(draft);
  }

  @Get('workflows/:id')
  get(@Param('id') id: string) {
    return this.workflowsService.get(id);
  }

  @Put('workflows/:id')
  update(@Param('id') id: string, @Body() draft: WorkflowDraftDto) {
    return this.workflowsService.update(id, draft);
  }

  @Delete('workflows/:id')
  remove(@Param('id') id: string) {
    return this.workflowsService.remove(id);
  }

  @Post('workflows/:id/run')
  run(@Param('id') id: string, @Body() options: TriggerRunDto = {}) {
    return this.workflowsService.triggerRun(id, options);
  }

  @Get('workflows/:id/imports')
  listImports(@Param('id') id: string) {
    return this.workflowsService.listImports(id);
  }

  @Post('workflows/:id/imports')
  createImport(@Param('id') id: string, @Body() body: CreateWorkflowImportDto) {
    return this.workflowsService.createImport(id, body);
  }
}
