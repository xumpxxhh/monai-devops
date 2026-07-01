import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Post,
  Put,
  Query,
} from '@nestjs/common';
import { parsePagination } from '../common/dto/pagination.dto.js';
import type { WorkflowDraft } from '../common/validation/normalize-workflow-ids.js';
import type { SubmitRunOptions } from '../runs/run-manager.service.js';
import { WorkflowsService } from './workflows.service.js';

@Controller('workflows')
export class WorkflowsController {
  constructor(private readonly workflowsService: WorkflowsService) {}

  @Get()
  list(
    @Query('search') search?: string,
    @Query('page') page?: string,
    @Query('pageSize') pageSize?: string,
  ) {
    const pagination = parsePagination({ page: Number(page), pageSize: Number(pageSize) });
    return this.workflowsService.list({ search, ...pagination });
  }

  @Post()
  create(@Body() draft: WorkflowDraft) {
    return this.workflowsService.create(draft);
  }

  @Post('validate')
  validate(@Body() draft: WorkflowDraft) {
    return this.workflowsService.validate(draft);
  }

  @Get(':id')
  get(@Param('id') id: string) {
    return this.workflowsService.get(id);
  }

  @Put(':id')
  update(@Param('id') id: string, @Body() draft: WorkflowDraft) {
    return this.workflowsService.update(id, draft);
  }

  @Delete(':id')
  remove(@Param('id') id: string) {
    return this.workflowsService.remove(id);
  }

  @Post(':id/run')
  run(@Param('id') id: string, @Body() options: SubmitRunOptions = {}) {
    return this.workflowsService.triggerRun(id, options);
  }
}
