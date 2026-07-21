import { Body, Controller, Delete, Get, Param, Post, Put, Query } from '@nestjs/common';
import { resolvePagination } from '../common/dto/pagination.dto.js';
import { ListWorkflowsQueryDto } from './dto/list-workflows.query.dto.js';
import { TriggerRunDto } from './dto/trigger-run.dto.js';
import { WorkflowDraftDto } from './dto/workflow-draft.dto.js';
import { WorkflowsService } from './workflows.service.js';

@Controller('workflows')
export class WorkflowsController {
  constructor(private readonly workflowsService: WorkflowsService) {}

  @Get()
  list(@Query() query: ListWorkflowsQueryDto) {
    const pagination = resolvePagination(query);
    return this.workflowsService.list({ search: query.search, ...pagination });
  }

  @Post()
  create(@Body() draft: WorkflowDraftDto) {
    return this.workflowsService.create(draft);
  }

  @Post('validate')
  validate(@Body() draft: WorkflowDraftDto) {
    return this.workflowsService.validate(draft);
  }

  @Get(':id')
  get(@Param('id') id: string) {
    return this.workflowsService.get(id);
  }

  @Put(':id')
  update(@Param('id') id: string, @Body() draft: WorkflowDraftDto) {
    return this.workflowsService.update(id, draft);
  }

  @Delete(':id')
  remove(@Param('id') id: string) {
    return this.workflowsService.remove(id);
  }

  @Post(':id/run')
  run(@Param('id') id: string, @Body() options: TriggerRunDto = {}) {
    return this.workflowsService.triggerRun(id, options);
  }
}
